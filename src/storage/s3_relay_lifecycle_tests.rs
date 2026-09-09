// SPDX-License-Identifier: GPL-3.0-only
// Included in s3::tests to use the actual SDK loopback fixture, not a mock backend.
fn relay_request_input<T>(input: T) -> s3s::S3Request<T> {
    s3s::S3Request {
        input,
        method: axum::http::Method::POST,
        uri: axum::http::Uri::from_static("/physical/archive.gz"),
        headers: Default::default(),
        extensions: Default::default(),
        credentials: None,
        region: None,
        service: None,
        trailing_headers: None,
    }
}

fn relay_adapter(
    backend: S3Backend,
    dir: &std::path::Path,
) -> crate::s3_adapter_s3s::DeltaGliderS3Service {
    use crate::{
        api::handlers::AppState,
        storage::{EncryptingBackend, EncryptionConfig},
    };
    use std::sync::Arc;
    let backend: Box<dyn StorageBackend> = Box::new(EncryptingBackend::new(
        backend,
        Arc::new(arc_swap::ArcSwap::from_pointee(EncryptionConfig::default())),
    ));
    let backend: Box<dyn StorageBackend> = Box::new(
        crate::storage::RoutingBackend::new(
            HashMap::from([("s3".into(), Arc::new(backend))]),
            HashMap::from([("physical".into(), ("s3".into(), None))]),
            "s3".into(),
        )
        .unwrap(),
    );
    let engine = crate::deltaglider::DynEngine::new_with_backend(
        Arc::new(backend),
        &crate::config::Config::default(),
        None,
    );
    crate::s3_adapter_s3s::DeltaGliderS3Service::new(Arc::new(AppState {
        engine: arc_swap::ArcSwap::from_pointee(engine),
        multipart: Arc::new(
            crate::multipart::MultipartStore::new(64 * 1024 * 1024)
                .with_large_spool(dir)
                .unwrap(),
        ),
        metrics: Arc::new(crate::metrics::Metrics::new()),
        usage_scanner: Arc::new(crate::usage_scanner::UsageScanner::new()),
        config_db: None,
        bucket_usage: None,
        form_post_replay: Default::default(),
        maintenance_gate: Arc::new(crate::maintenance::gate::MaintenanceGate::new()),
        maintenance_notify: Default::default(),
    }))
}

async fn relay_create(service: &crate::s3_adapter_s3s::DeltaGliderS3Service, key: &str) -> String {
    use s3s::S3;
    let mut input = s3s::dto::CreateMultipartUploadInput::builder();
    input.set_bucket("physical".into()).set_key(key.into());
    service
        .create_multipart_upload(relay_request_input(input.build().unwrap()))
        .await
        .unwrap()
        .output
        .upload_id
        .unwrap()
}

async fn relay_part(
    service: &crate::s3_adapter_s3s::DeltaGliderS3Service,
    id: &str,
    number: i32,
    data: Bytes,
) -> String {
    use s3s::S3;
    let mut input = s3s::dto::UploadPartInput::builder();
    input
        .set_bucket("physical".into())
        .set_key("archive.gz".into())
        .set_upload_id(id.into())
        .set_part_number(number)
        .set_content_length(Some(data.len() as i64))
        .set_body(Some(s3s::dto::StreamingBlob::from(s3s::Body::from(data))));
    service
        .upload_part(relay_request_input(input.build().unwrap()))
        .await
        .unwrap()
        .output
        .e_tag
        .unwrap()
        .into_value()
}

fn relay_complete_input(
    id: &str,
    parts: Vec<(i32, String)>,
) -> s3s::dto::CompleteMultipartUploadInput {
    let mut input = s3s::dto::CompleteMultipartUploadInput::builder();
    input
        .set_bucket("physical".into())
        .set_key("archive.gz".into())
        .set_upload_id(id.into())
        .set_multipart_upload(Some(s3s::dto::CompletedMultipartUpload {
            parts: Some(
                parts
                    .into_iter()
                    .map(|(n, etag)| s3s::dto::CompletedPart {
                        part_number: Some(n),
                        e_tag: Some(s3s::dto::ETag::Strong(etag)),
                        ..Default::default()
                    })
                    .collect(),
            ),
        }));
    input.build().unwrap()
}

async fn wait_relay_condition(mut condition: impl AsyncFnMut() -> bool) {
    tokio::time::timeout(std::time::Duration::from_secs(30), async {
        while !condition().await {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn relay_creation_capacity_refusal_preserves_retry_and_existing_uploads() {
    use crate::api::auth::{ReplayCache, UnexecutedReplayAdmission};
    use s3s::S3;
    let (backend, remote, server) = relay_fixture().await;
    let dir = crate::multipart::test_spool_dir();
    let service = relay_adapter(backend, dir.path());
    let cache = ReplayCache::default();
    let make_request = || {
        let mut input = s3s::dto::CreateMultipartUploadInput::builder();
        input
            .set_bucket("physical".into())
            .set_key("archive.gz".into());
        let mut request = relay_request_input(input.build().unwrap());
        request
            .extensions
            .insert(UnexecutedReplayAdmission::for_test(
                cache.clone(),
                "creation-retry",
            ));
        request
    };
    let mut ids = Vec::new();
    let mut refused = false;
    // Bounded fixture fill: exercise the real capacity gate, not a mock error.
    for _ in 0..64 {
        match service.create_multipart_upload(make_request()).await {
            Ok(response) => {
                ids.push(response.output.upload_id.unwrap());
                assert!(cache.contains_key("creation-retry"));
            }
            Err(error) => {
                assert_eq!(error.code(), &s3s::S3ErrorCode::SlowDown);
                refused = true;
                break;
            }
        }
    }
    assert!(refused, "fixture must reach the actual refusal gate");
    assert!(!cache.contains_key("creation-retry"));
    assert_eq!(service.state().multipart.count_uploads(), ids.len());
    assert_eq!(remote.lock().await.creates, 0);
    // Make room without altering any other upload; retry can now create once.
    service
        .state()
        .multipart
        .abort(&ids[0], "physical", "archive.gz")
        .unwrap();
    service
        .create_multipart_upload(make_request())
        .await
        .unwrap();
    assert_eq!(service.state().multipart.count_uploads(), ids.len());
    assert!(
        cache.contains_key("creation-retry"),
        "executed creation stays protected"
    );
    server.abort();
}

#[tokio::test]
async fn relay_completion_capacity_rejection_releases_only_unexecuted_replay() {
    use crate::api::auth::{ReplayCache, UnexecutedReplayAdmission};
    use s3s::S3;
    let (backend, remote, server) = relay_fixture().await;
    let dir = crate::multipart::test_spool_dir();
    let service = relay_adapter(backend, dir.path());
    let id = relay_create(&service, "archive.gz").await;
    let etag = relay_part(&service, &id, 1, Bytes::from_static(b"retained")).await;
    let cache = ReplayCache::default();
    let make_request = || {
        let mut request = relay_request_input(relay_complete_input(&id, vec![(1, etag.clone())]));
        request
            .extensions
            .insert(UnexecutedReplayAdmission::for_test(
                cache.clone(),
                "synthetic",
            ));
        request
    };
    let permit = service
        .state()
        .multipart
        .completions
        .clone()
        .acquire_owned()
        .await
        .unwrap();
    let error = service
        .complete_multipart_upload(make_request())
        .await
        .unwrap_err();
    assert_eq!(error.code(), &s3s::S3ErrorCode::SlowDown);
    assert!(!cache.contains_key("synthetic"));
    assert_eq!(
        remote.lock().await.creates,
        0,
        "rejection must precede backend effects"
    );
    assert_eq!(service.state().multipart.in_flight_bytes(), 8);
    assert_eq!(service.state().multipart.count_uploads(), 1);
    drop(permit);
    service
        .complete_multipart_upload(make_request())
        .await
        .unwrap();
    assert!(
        cache.contains_key("synthetic"),
        "executed mutation retains replay protection"
    );
    assert_eq!(service.state().multipart.in_flight_bytes(), 0);
    assert_eq!(service.state().multipart.count_uploads(), 0);
    server.abort();
}

#[tokio::test]
async fn relay_owned_client_drop_holds_create_abort_expiry_reservations() {
    use s3s::S3;
    use std::sync::Arc;
    let (backend, remote, server) = relay_fixture().await;
    let create = Arc::new(tokio::sync::Semaphore::new(0));
    let abort = Arc::new(tokio::sync::Semaphore::new(0));
    {
        let mut state = remote.lock().await;
        state.pause_create = Some(create.clone());
        state.pause_abort = Some(abort.clone());
        state.fail = true;
    }
    let dir = crate::multipart::test_spool_dir();
    let service = relay_adapter(backend, dir.path());
    let id = relay_create(&service, "archive.gz").await;
    let etag = relay_part(&service, &id, 1, Bytes::from_static(b"retained")).await;
    let input = relay_complete_input(&id, vec![(1, etag)]);
    let replay_cache = crate::api::auth::ReplayCache::default();
    let mut request = relay_request_input(input);
    request
        .extensions
        .insert(crate::api::auth::UnexecutedReplayAdmission::for_test(
            replay_cache.clone(),
            "in-flight",
        ));
    let caller = tokio::spawn({
        let service = service.clone();
        async move { service.complete_multipart_upload(request).await }
    });
    wait_relay_condition(async || remote.lock().await.creates == 1).await;
    caller.abort();
    let _ = caller.await;
    let store = &service.state().multipart;
    let check_owned = || {
        assert!(replay_cache.contains_key("in-flight"));
        store.cleanup_expired(std::time::Duration::ZERO, std::time::Duration::ZERO);
        assert_eq!(store.in_flight_bytes(), 8);
        assert_eq!(store.count_uploads(), 1);
        assert!(store.completions.clone().try_acquire_owned().is_err());
        assert!(store.abort(&id, "physical", "archive.gz").is_err());
        assert!(store.purge_uploads_for_bucket("physical").is_err());
        assert_eq!(
            std::fs::read(dir.path().join("data").join(&id).join("part-00001.bin")).unwrap(),
            b"retained"
        );
    };
    check_owned();
    create.add_permits(1);
    wait_relay_condition(async || remote.lock().await.aborts == 1).await;
    check_owned();
    abort.add_permits(1);
    wait_relay_condition(async || store.count_uploads() == 0).await;
    assert_eq!(store.in_flight_bytes(), 0);
    assert!(store.completions.clone().try_acquire_owned().is_ok());
    assert_eq!(remote.lock().await.completes, 0);
    assert!(
        replay_cache.contains_key("in-flight"),
        "failed storage work must retain replay protection"
    );
    server.abort();
    let _ = server.await;
}

async fn generated_relay_integrity(size: u64) {
    use s3s::S3;
    use sha2::{Digest, Sha256};
    let (mut backend, remote, server) = relay_fixture().await;
    backend.native_encryption = NativeEncryptionConfig::SseS3;
    remote.lock().await.digest_only = true;
    let dir = crate::multipart::test_spool_dir();
    let service = relay_adapter(backend, dir.path());
    let id = relay_create(&service, "archive.gz").await;
    let chunk = Bytes::from(
        (0..16 * 1024 * 1024)
            .map(|i| (i % 251) as u8)
            .collect::<Vec<_>>(),
    );
    let mut expected = Sha256::new();
    let mut parts = Vec::new();
    let mut remaining = size;
    while remaining > 0 {
        let data = chunk.slice(..remaining.min(chunk.len() as u64) as usize);
        expected.update(&data);
        remaining -= data.len() as u64;
        let n = parts.len() as i32 + 1;
        parts.push((n, relay_part(&service, &id, n, data).await));
    }
    assert_eq!(service.state().multipart.in_flight_bytes(), size);
    use std::os::unix::fs::MetadataExt;
    let mut allocated = 0u64;
    let mut logical = 0u64;
    let mut files = 0usize;
    for entry in std::fs::read_dir(dir.path().join("data").join(&id)).unwrap() {
        let metadata = entry.unwrap().metadata().unwrap();
        allocated += metadata.blocks() * 512;
        logical += metadata.len();
        files += 1;
    }
    // No complete-object assembly or retained overwrite temporary in the spool.
    assert_eq!(logical, size);
    assert_eq!(files, parts.len());
    eprintln!("relay resource evidence: payload_bytes={size} source_files={files} allocated_file_bytes={allocated}");
    let expected = hex::encode(expected.finalize());
    service
        .complete_multipart_upload(relay_request_input(relay_complete_input(&id, parts)))
        .await
        .unwrap();
    let state = remote.lock().await;
    assert_eq!(state.received, size);
    assert_eq!(hex::encode(state.digest.clone().finalize()), expected);
    assert_eq!(state.metadata_sha, expected);
    assert_eq!(state.native_sse, "AES256");
    assert_eq!(state.completes, 1);
    assert_eq!(state.aborts, 0);
    assert_eq!(service.state().multipart.in_flight_bytes(), 0);
    assert_eq!(service.state().multipart.count_uploads(), 0);
    assert_eq!(
        std::fs::read_dir(dir.path().join("data")).unwrap().count(),
        0
    );
    server.abort();
    let _ = server.await;
}

#[tokio::test]
async fn relay_generated_large_stream_integrity_and_native_sse() {
    generated_relay_integrity(80 * 1024 * 1024 + 123).await;
}

#[tokio::test]
#[ignore = "local resource contract: writes/reads 2 GiB; run explicitly"]
async fn relay_generated_two_gib_stream_integrity_and_cleanup() {
    generated_relay_integrity(crate::multipart::LARGE_OBJECT_BYTES).await;
}

#[tokio::test]
async fn relay_hot_reload_refuses_old_admission_before_body_acceptance() {
    use s3s::S3;
    let (backend, remote, server) = relay_fixture().await;
    let dir = crate::multipart::test_spool_dir();
    let service = relay_adapter(backend, dir.path());
    let id = relay_create(&service, "archive.gz").await;
    let etag = relay_part(&service, &id, 1, Bytes::from_static(b"old")).await;
    let (replacement, replacement_remote, replacement_server) = relay_fixture().await;
    let replacement_dir = crate::multipart::test_spool_dir();
    let replacement = relay_adapter(replacement, replacement_dir.path());
    service
        .state()
        .engine
        .store(replacement.state().engine.load_full());
    let mut input = s3s::dto::UploadPartInput::builder();
    input
        .set_bucket("physical".into())
        .set_key("archive.gz".into())
        .set_upload_id(id.clone())
        .set_part_number(2)
        .set_content_length(Some(3))
        .set_body(Some(s3s::dto::StreamingBlob::from(s3s::Body::from(
            Bytes::from_static(b"new"),
        ))));
    assert_eq!(
        service
            .upload_part(relay_request_input(input.build().unwrap()))
            .await
            .unwrap_err()
            .code(),
        &s3s::S3ErrorCode::InvalidRequest
    );
    assert_eq!(
        service
            .complete_multipart_upload(relay_request_input(relay_complete_input(
                &id,
                vec![(1, etag)]
            )))
            .await
            .unwrap_err()
            .code(),
        &s3s::S3ErrorCode::InvalidRequest
    );
    assert_eq!(service.state().multipart.in_flight_bytes(), 3);
    assert_eq!(remote.lock().await.creates, 0);
    assert_eq!(replacement_remote.lock().await.creates, 0);
    service
        .state()
        .multipart
        .abort(&id, "physical", "archive.gz")
        .unwrap();
    server.abort();
    replacement_server.abort();
    let _ = server.await;
    let _ = replacement_server.await;
}

#[tokio::test]
async fn relay_reload_during_completion_uses_admitted_native_sse_target() {
    use s3s::S3;
    use std::sync::Arc;
    let (mut backend, remote, server) = relay_fixture().await;
    backend.native_encryption = NativeEncryptionConfig::SseS3;
    let pause = Arc::new(tokio::sync::Semaphore::new(0));
    remote.lock().await.pause_create = Some(pause.clone());
    let dir = crate::multipart::test_spool_dir();
    let service = relay_adapter(backend, dir.path());
    let id = relay_create(&service, "archive.gz").await;
    let etag = relay_part(&service, &id, 1, Bytes::from_static(b"native-sse-bytes")).await;
    let caller = tokio::spawn({
        let service = service.clone();
        let input = relay_complete_input(&id, vec![(1, etag)]);
        async move {
            service
                .complete_multipart_upload(relay_request_input(input))
                .await
        }
    });
    wait_relay_condition(async || remote.lock().await.creates == 1).await;
    let (replacement, replacement_remote, replacement_server) = relay_fixture().await;
    let replacement_dir = crate::multipart::test_spool_dir();
    let replacement = relay_adapter(replacement, replacement_dir.path());
    service
        .state()
        .engine
        .store(replacement.state().engine.load_full());
    pause.add_permits(1);
    caller.await.unwrap().unwrap();
    let state = remote.lock().await;
    assert_eq!(state.native_sse, "AES256");
    assert_eq!(state.bodies.concat(), b"native-sse-bytes");
    assert_eq!(state.completes, 1);
    assert_eq!(replacement_remote.lock().await.creates, 0);
    assert_eq!(service.state().multipart.in_flight_bytes(), 0);
    server.abort();
    replacement_server.abort();
    let _ = server.await;
    let _ = replacement_server.await;
}

#[tokio::test]
async fn relay_admission_cannot_bypass_compression_or_proxy_encryption() {
    use crate::storage::{EncryptingBackend, EncryptionConfig, EncryptionKey};
    use std::sync::Arc;
    let (backend, remote, server) = relay_fixture().await;
    let config = Arc::new(arc_swap::ArcSwap::from_pointee(EncryptionConfig::default()));
    let backend: Box<dyn StorageBackend> =
        Box::new(EncryptingBackend::new(backend, config.clone()));
    let engine = crate::deltaglider::DynEngine::new_with_backend(
        Arc::new(backend),
        &crate::config::Config::default(),
        None,
    );
    assert!(engine
        .native_relay_target("physical", "archive.gz")
        .is_some());
    assert!(engine
        .native_relay_target("physical", "archive.tar")
        .is_none());
    config.store(Arc::new(EncryptionConfig {
        // Local fixture only; never used for external calls.
        key: Some(EncryptionKey::from_hex(&"01".repeat(32)).unwrap()),
        ..Default::default()
    }));
    assert!(engine
        .native_relay_target("physical", "archive.gz")
        .is_none());
    assert_eq!(remote.lock().await.creates, 0);
    server.abort();
    let _ = server.await;
}
