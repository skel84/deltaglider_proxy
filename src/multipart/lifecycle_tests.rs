// SPDX-License-Identifier: GPL-3.0-only
use super::*;
use std::sync::atomic::Ordering;

fn store() -> (MultipartStore, tempfile::TempDir) {
    let dir = crate::multipart::test_spool_dir();
    (
        MultipartStore::new(1024)
            .with_large_spool(dir.path())
            .unwrap(),
        dir,
    )
}

#[test]
fn failed_terminal_deletion_keeps_reservations_and_retries() {
    for terminal in ["finish", "abort", "expiry", "purge"] {
        let (store, _dir) = store();
        let id = store
            .create("bucket", "archive.gz", None, HashMap::new())
            .unwrap();
        let etag = store
            .upload_part(
                &id,
                "bucket",
                "archive.gz",
                1,
                Bytes::from_static(b"retained"),
            )
            .unwrap();
        store.fail_cleanup.store(true, Ordering::Relaxed);
        match terminal {
            "finish" => {
                store
                    .complete_passthrough(&id, "bucket", "archive.gz", &[(1, etag)])
                    .unwrap();
                store.finish_upload(&id);
            }
            "abort" => assert!(store.abort(&id, "bucket", "archive.gz").is_err()),
            "expiry" => {
                store.cleanup_expired(std::time::Duration::ZERO, std::time::Duration::ZERO);
            }
            "purge" => assert!(store.purge_uploads_for_bucket("bucket").is_err()),
            _ => unreachable!(),
        }
        assert_eq!(store.in_flight_bytes(), 8);
        assert_eq!(store.count_uploads(), 1);
        assert!(store.abort(&id, "bucket", "archive.gz").is_err());
        assert!(store
            .upload_part(&id, "bucket", "archive.gz", 2, Bytes::new())
            .is_err());
        assert!(store
            .complete_passthrough(&id, "bucket", "archive.gz", &[(1, "bad".into())])
            .is_err());
        store.fail_cleanup.store(false, Ordering::Relaxed);
        let report = store.cleanup_expired(
            std::time::Duration::from_secs(3600),
            std::time::Duration::ZERO,
        );
        assert_eq!(report.reclaimed_bytes, 8);
        assert_eq!(store.in_flight_bytes(), 0);
        assert_eq!(store.count_uploads(), 0);
    }
}

#[test]
fn terminal_deletion_io_error_retains_bytes_until_repaired() {
    let (store, _dir) = store();
    let id = store
        .create("bucket", "archive.gz", None, HashMap::new())
        .unwrap();
    store
        .upload_part(
            &id,
            "bucket",
            "archive.gz",
            1,
            Bytes::from_static(b"retained"),
        )
        .unwrap();
    let upload_dir = store.relay_root.join(&id);
    let temporary = store.relay_root.join("repair");
    // Produce a real remove_dir_all ENOTDIR failure, including when tests run
    // as root. Move the same bytes, without extra disk copies or fault flags.
    fs::rename(upload_dir.join("part-00001.bin"), &temporary).unwrap();
    fs::remove_dir(&upload_dir).unwrap();
    fs::rename(&temporary, &upload_dir).unwrap();
    assert!(store.abort(&id, "bucket", "archive.gz").is_err());
    assert_eq!(store.in_flight_bytes(), 8);
    assert_eq!(store.count_uploads(), 1);
    assert_eq!(fs::read(&upload_dir).unwrap(), b"retained");
    assert!(store
        .upload_part(&id, "bucket", "archive.gz", 2, Bytes::new())
        .is_err());
    fs::rename(&upload_dir, &temporary).unwrap();
    fs::create_dir(&upload_dir).unwrap();
    fs::rename(&temporary, upload_dir.join("part-00001.bin")).unwrap();
    store.cleanup_expired(
        std::time::Duration::from_secs(3600),
        std::time::Duration::ZERO,
    );
    assert_eq!(store.in_flight_bytes(), 0);
    assert_eq!(store.count_uploads(), 0);
    assert!(!upload_dir.exists());
}

#[test]
fn atomic_overwrite_temporary_failure_is_reserved_until_deleted() {
    let (mut store, _dir) = store();
    store.max_total_multipart_bytes = 12;
    let id = store
        .create("bucket", "archive.gz", None, HashMap::new())
        .unwrap();
    store
        .upload_part(
            &id,
            "bucket",
            "archive.gz",
            1,
            Bytes::from_static(b"old-data"),
        )
        .unwrap();
    // The 8-byte overwrite needs 8 temporary bytes, not a zero-byte delta.
    assert!(store
        .upload_part(
            &id,
            "bucket",
            "archive.gz",
            1,
            Bytes::from_static(b"new-data")
        )
        .is_err());
    let path = store.relay_root.join(&id).join("part-00001.bin");
    assert_eq!(fs::read(&path).unwrap(), b"old-data");
    assert_eq!(store.in_flight_bytes(), 8);
    store.max_total_multipart_bytes = 16;
    // Real rename failure: the old payload remains inside a directory at the
    // destination. The runtime cleanup owner must also retain incoming.tmp.
    let saved = store.relay_root.join(&id).join("saved");
    fs::rename(&path, &saved).unwrap();
    fs::create_dir(&path).unwrap();
    fs::rename(&saved, path.join("old")).unwrap();
    assert!(store
        .upload_part(
            &id,
            "bucket",
            "archive.gz",
            1,
            Bytes::from_static(b"new-data")
        )
        .is_err());
    assert_eq!(store.in_flight_bytes(), 16);
    assert_eq!(
        fs::read(store.relay_root.join(&id).join("incoming.tmp")).unwrap(),
        b"new-data"
    );
    store.fail_cleanup.store(true, Ordering::Relaxed);
    store.cleanup_expired(std::time::Duration::ZERO, std::time::Duration::ZERO);
    assert_eq!(store.in_flight_bytes(), 16);
    assert!(store
        .upload_part(&id, "bucket", "archive.gz", 1, Bytes::new())
        .is_err());
    store.fail_cleanup.store(false, Ordering::Relaxed);
    store.cleanup_expired(std::time::Duration::ZERO, std::time::Duration::ZERO);
    assert_eq!(store.in_flight_bytes(), 0);
    assert!(!store.relay_root.join(&id).exists());
}

#[test]
fn successful_overwrite_releases_only_replaced_reservation() {
    let (mut store, _dir) = store();
    store.max_total_multipart_bytes = 12;
    let id = store
        .create("bucket", "archive.gz", None, HashMap::new())
        .unwrap();
    store
        .upload_part(
            &id,
            "bucket",
            "archive.gz",
            1,
            Bytes::from_static(b"old-data"),
        )
        .unwrap();
    store
        .upload_part(&id, "bucket", "archive.gz", 1, Bytes::from_static(b"new!"))
        .unwrap();
    assert_eq!(store.in_flight_bytes(), 4);
    let path = store.relay_root.join(&id);
    assert_eq!(fs::read(path.join("part-00001.bin")).unwrap(), b"new!");
    assert!(!path.join("incoming.tmp").exists());
    store.abort(&id, "bucket", "archive.gz").unwrap();
}

#[test]
fn profile_bounds_metadata_parts_and_unsupported_threshold_without_create_refusal() {
    let (store, _dir) = store();
    assert!(store
        .create(
            "bucket",
            "archive.gz",
            None,
            HashMap::from([("k".into(), "v".repeat(8193))])
        )
        .is_err());
    let id = store
        .create("bucket", "archive.tar", None, HashMap::new())
        .unwrap();
    store.pin_admission(&id, None, 10);
    store
        .upload_part(
            &id,
            "bucket",
            "archive.tar",
            1,
            Bytes::from_static(b"12345678"),
        )
        .unwrap();
    assert_eq!(
        store
            .remaining_part_bytes(&id, "bucket", "archive.tar", 2)
            .unwrap(),
        2
    );
    assert!(store
        .upload_part(&id, "bucket", "archive.tar", 2, Bytes::from_static(b"123"))
        .is_err());
    for n in 2..=256 {
        store
            .upload_part(&id, "bucket", "archive.tar", n, Bytes::new())
            .unwrap();
    }
    assert!(store
        .upload_part(&id, "bucket", "archive.tar", 257, Bytes::new())
        .is_err());
    assert_eq!(store.in_flight_bytes(), 8);
    store.abort(&id, "bucket", "archive.tar").unwrap();
}

#[tokio::test]
async fn completion_unwind_settles_sources_and_reservations() {
    let (store, _dir) = store();
    let store = Arc::new(store);
    let id = store
        .create("bucket", "archive.gz", None, HashMap::new())
        .unwrap();
    let etag = store
        .upload_part(&id, "bucket", "archive.gz", 1, Bytes::from_static(b"data"))
        .unwrap();
    store
        .complete_passthrough(&id, "bucket", "archive.gz", &[(1, etag)])
        .unwrap();
    let settlement = CompletionSettlement::new(store.clone(), id);
    let worker = tokio::spawn(async move {
        let _settlement = settlement;
        panic!("local unwind");
    });
    assert!(worker.await.unwrap_err().is_panic());
    assert_eq!(store.in_flight_bytes(), 0);
    assert_eq!(store.count_uploads(), 0);
}
