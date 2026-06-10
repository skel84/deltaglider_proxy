// SPDX-License-Identifier: GPL-3.0-only

//! Admin API for managing named backends (multi-backend routing).

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::Json;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::config::{BackendConfig, NamedBackendConfig};

use super::{audit_log, AdminState};

#[derive(Serialize)]
pub struct BackendListResponse {
    pub backends: Vec<super::config::BackendInfoResponse>,
    pub default_backend: Option<String>,
}

#[derive(Serialize)]
pub struct BucketBackendOriginResponse {
    pub name: String,
    pub creation_date: String,
    pub backend_name: Option<String>,
    pub backend_type: Option<String>,
    pub backend_endpoint: Option<String>,
    pub backend_region: Option<String>,
    pub backend_path: Option<String>,
    pub real_bucket: Option<String>,
}

#[derive(Serialize)]
pub struct BucketOriginListResponse {
    pub buckets: Vec<BucketBackendOriginResponse>,
}

#[derive(Deserialize)]
pub struct CreateBucketOnBackendRequest {
    pub name: String,
    pub backend_name: String,
}

#[derive(Serialize)]
pub struct CreateBucketOnBackendResponse {
    pub success: bool,
    pub bucket: String,
    pub backend_name: String,
}

#[derive(Deserialize)]
pub struct MigrateBucketRequest {
    pub target_backend: String,
    /// Delete the source objects after a verified copy. Default false — the
    /// safe path leaves the source as a copy for the operator to remove later.
    #[serde(default)]
    pub delete_source: bool,
}

#[derive(Serialize)]
pub struct MigrateBucketResponse {
    pub success: bool,
    pub bucket: String,
    pub from_backend: String,
    pub to_backend: String,
    pub objects_copied: u64,
    pub bytes_copied: u64,
    pub source_deleted: bool,
}

#[derive(Deserialize)]
pub struct CreateBackendRequest {
    pub name: String,
    #[serde(rename = "type")]
    pub backend_type: String,
    pub path: Option<String>,
    pub endpoint: Option<String>,
    pub region: Option<String>,
    pub force_path_style: Option<bool>,
    pub access_key_id: Option<String>,
    pub secret_access_key: Option<String>,
    /// Set this backend as the default.
    pub set_default: Option<bool>,
}

#[derive(Serialize)]
pub struct BackendMutationResponse {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub requires_restart: bool,
}

fn build_backend_config(req: &CreateBackendRequest) -> Result<BackendConfig, String> {
    match req.backend_type.as_str() {
        "filesystem" => {
            let path = req.path.as_deref().unwrap_or("./data").to_string();
            Ok(BackendConfig::Filesystem {
                path: std::path::PathBuf::from(path),
            })
        }
        "s3" => {
            // Validate credentials upfront (S3Backend::new will reject them later,
            // but the error is confusing; better to fail early with a clear message)
            if req.access_key_id.as_ref().is_none_or(|s| s.is_empty())
                || req.secret_access_key.as_ref().is_none_or(|s| s.is_empty())
            {
                return Err("S3 backend requires both access_key_id and secret_access_key".into());
            }
            Ok(BackendConfig::S3 {
                endpoint: req.endpoint.clone(),
                region: req
                    .region
                    .clone()
                    .unwrap_or_else(|| "us-east-1".to_string()),
                force_path_style: req.force_path_style.unwrap_or(true),
                access_key_id: req.access_key_id.clone(),
                secret_access_key: req.secret_access_key.clone(),
                allow_local: false,
            })
        }
        other => Err(format!(
            "Unknown backend type: '{other}'. Must be 'filesystem' or 's3'."
        )),
    }
}

/// GET /api/admin/backends — list all named backends.
///
/// When `cfg.backends` is empty but `cfg.backend` holds a configured
/// singleton, we synthesise a `"default"` entry (`is_synthesized:
/// true`) so the admin UI's Backends panel reflects the operator's
/// working backend regardless of whether their YAML uses the legacy
/// singleton `backend:` shape or the named-list `backends:` shape.
///
/// Without this synthesis the panel shows "no named backends" while
/// the proxy is happily serving from the configured singleton — an
/// inconsistency operators have reported as a phantom "where did my
/// backend go?" moment. The same synthesis also lives in
/// `GET /config`'s `backends[]` projection; both endpoints now agree.
pub async fn list_backends(State(state): State<Arc<AdminState>>) -> impl IntoResponse {
    let cfg = state.config.read().await;
    let backends: Vec<super::config::BackendInfoResponse> = if cfg.backends.is_empty() {
        vec![super::config::BackendInfoResponse::synthesized_default(
            &cfg,
        )]
    } else {
        cfg.backends
            .iter()
            .map(super::config::BackendInfoResponse::from)
            .collect()
    };

    Json(BackendListResponse {
        backends,
        default_backend: cfg.default_backend.clone(),
    })
}

/// GET /api/admin/buckets — list buckets with resolved backend origin.
///
/// The S3-compatible ListBuckets XML stays conservative; this JSON endpoint is
/// for the admin UI, which needs provider badges and tooltips. The browser still
/// merges this onto the SigV4-filtered ListBuckets result so bucket visibility
/// semantics do not change for non-admin IAM users.
pub async fn list_bucket_origins(
    State(state): State<Arc<AdminState>>,
) -> Result<Json<BucketOriginListResponse>, (StatusCode, String)> {
    let cfg = state.config.read().await;
    let backend_infos: Vec<super::config::BackendInfoResponse> = if cfg.backends.is_empty() {
        vec![super::config::BackendInfoResponse::synthesized_default(
            &cfg,
        )]
    } else {
        cfg.backends
            .iter()
            .map(super::config::BackendInfoResponse::from)
            .collect()
    };
    let default_backend = cfg
        .default_backend
        .clone()
        .or_else(|| backend_infos.first().map(|b| b.name.clone()));
    drop(cfg);

    let backend_by_name: std::collections::HashMap<_, _> = backend_infos
        .iter()
        .map(|backend| (backend.name.as_str(), backend))
        .collect();
    let bucket_list = state
        .s3_state
        .engine
        .load()
        .list_bucket_origins()
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("failed to list bucket origins: {e}"),
            )
        })?;

    let buckets = bucket_list
        .into_iter()
        .map(|bucket| {
            let backend_name = bucket
                .backend_name
                .clone()
                .or_else(|| default_backend.clone());
            let backend = backend_name
                .as_deref()
                .and_then(|name| backend_by_name.get(name).copied());
            BucketBackendOriginResponse {
                name: bucket.name,
                creation_date: bucket.creation_date.to_rfc3339(),
                backend_name,
                backend_type: backend.map(|b| b.backend_type.clone()),
                backend_endpoint: backend.and_then(|b| b.endpoint.clone()),
                backend_region: backend.and_then(|b| b.region.clone()),
                backend_path: backend.and_then(|b| b.path.clone()),
                real_bucket: bucket.real_bucket,
            }
        })
        .collect();

    Ok(Json(BucketOriginListResponse { buckets }))
}

/// POST /api/admin/buckets — create a bucket pinned to a named backend.
///
/// This is intentionally admin-only and separate from the public S3
/// `PUT /{bucket}` API. S3 has no portable "backend hint" concept; the admin
/// UI needs an explicit control when multiple backends exist.
pub async fn create_bucket_on_backend(
    State(state): State<Arc<AdminState>>,
    headers: HeaderMap,
    Json(body): Json<CreateBucketOnBackendRequest>,
) -> Result<Json<CreateBucketOnBackendResponse>, (StatusCode, String)> {
    let bucket = body.name.trim().to_string();
    if bucket.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            "Bucket name cannot be empty".into(),
        ));
    }
    let backend_name = body.backend_name.trim().to_string();
    if backend_name.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            "backend_name cannot be empty".into(),
        ));
    }

    let mut cfg = state.config.write().await;

    let backend_exists = if cfg.backends.is_empty() {
        backend_name == "default"
    } else {
        cfg.backends.iter().any(|b| b.name == backend_name)
    };
    if !backend_exists {
        return Err((
            StatusCode::BAD_REQUEST,
            format!("Unknown backend '{}'", backend_name),
        ));
    }

    // Buckets are keyed by virtual bucket name, normalized lowercase.
    let bucket_key = bucket.to_ascii_lowercase();
    let old_policy = cfg.buckets.get(&bucket_key).cloned();
    let mut policy = old_policy.clone().unwrap_or_default();
    policy.backend = if cfg.backends.is_empty() {
        None
    } else {
        Some(backend_name.clone())
    };
    cfg.buckets.insert(bucket_key.clone(), policy);

    if let Err(e) = super::config::rebuild_engine(
        &state,
        &cfg,
        &format!(
            "Bucket '{}' routed to backend '{}', engine rebuilt",
            bucket, backend_name
        ),
    )
    .await
    {
        if let Some(previous) = old_policy {
            cfg.buckets.insert(bucket_key, previous);
        } else {
            cfg.buckets.remove(&bucket_key);
        }
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to rebuild engine: {e}"),
        ));
    }

    if let Err(e) = state.s3_state.engine.load().create_bucket(&bucket).await {
        // Roll back routing if create failed (e.g. already exists / backend error).
        if let Some(previous) = old_policy {
            cfg.buckets.insert(bucket_key.clone(), previous);
        } else {
            cfg.buckets.remove(&bucket_key);
        }
        let _ = super::config::rebuild_engine(
            &state,
            &cfg,
            &format!(
                "Bucket create failed for '{}', reverted backend routing",
                bucket
            ),
        )
        .await;
        return Err((StatusCode::BAD_REQUEST, e.to_string()));
    }

    let persist_path = super::config::active_config_path(&state);
    if let Err(e) = cfg.persist_to_file(&persist_path) {
        tracing::warn!("Failed to persist config to {}: {}", persist_path, e);
    }
    drop(cfg);

    audit_log(
        "admin_create_bucket",
        "admin",
        &format!("{bucket}@{backend_name}"),
        &headers,
    );

    Ok(Json(CreateBucketOnBackendResponse {
        success: true,
        bucket,
        backend_name,
    }))
}

/// POST /api/admin/buckets/{bucket}/migrate — move a bucket's objects to a
/// different backend, then re-route the bucket to that backend.
///
/// Re-routing alone orphans data (the explicit route wins, so the old
/// backend's objects become unreachable by the bucket name). This endpoint
/// does the honest version: it copies every object to the target FIRST, while
/// both backends are still addressable under distinct virtual names, verifies,
/// and only then flips the route. Mechanism:
///
///   1. Resolve the bucket's CURRENT backend; reject if target == current.
///   2. Create a transient virtual bucket `__dgmigrate_<bucket>_<n>` routed to
///      the target backend, ALIASED to the real bucket name — so writes land in
///      the real `<bucket>` on the target. (Engine rebuilt so the route is live.)
///   3. Copy each source object → the transient bucket via the shared
///      `transfer::copy_object_with_retries` (preserves metadata/ETag, stamps
///      `dg-migration` provenance). Idempotent: skip keys already on the target.
///   4. Verify every source key exists on the target.
///   5. Flip `<bucket>`'s route to the target backend; drop the transient route;
///      rebuild + persist.
///   6. `delete_source` (default false): only after the flip + verify, delete the
///      source objects. Off by default — the source stays as a safety copy.
///
/// Any failure BEFORE the flip leaves the source untouched and rolls the
/// transient route back. This is the only admin op that moves object data, so
/// it's deliberately conservative.
pub async fn migrate_bucket(
    State(state): State<Arc<AdminState>>,
    Path(bucket): Path<String>,
    headers: HeaderMap,
    Json(body): Json<MigrateBucketRequest>,
) -> Result<Json<MigrateBucketResponse>, (StatusCode, String)> {
    let bucket = bucket.trim().to_string();
    let bucket_key = bucket.to_ascii_lowercase();
    let target_backend = body.target_backend.trim().to_string();
    if bucket.is_empty() || target_backend.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            "bucket and target_backend are required".into(),
        ));
    }

    // ── Resolve current backend + validate target (under the config lock) ──
    let (from_backend, transient_key) = {
        let cfg = state.config.read().await;
        if !cfg.backends.is_empty() && !cfg.backends.iter().any(|b| b.name == target_backend) {
            return Err((
                StatusCode::BAD_REQUEST,
                format!("Unknown target backend '{}'", target_backend),
            ));
        }
        // Current backend = explicit policy route, else the default.
        let from_backend = cfg
            .buckets
            .get(&bucket_key)
            .and_then(|p| p.backend.clone())
            .or_else(|| cfg.default_backend.clone())
            .unwrap_or_else(|| "default".to_string());
        if from_backend == target_backend {
            return Err((
                StatusCode::BAD_REQUEST,
                format!(
                    "Bucket '{}' is already on backend '{}'",
                    bucket, target_backend
                ),
            ));
        }
        // Pick a transient virtual-bucket name that isn't already taken.
        let mut n = 0u32;
        let transient_key = loop {
            let candidate = format!("__dgmigrate_{}_{}", bucket_key, n);
            if !cfg.buckets.contains_key(&candidate) {
                break candidate;
            }
            n += 1;
        };
        (from_backend, transient_key)
    };

    // ── Stage: transient virtual bucket → target backend, aliased to the real
    //    bucket name, so copies land in the real bucket on the target. ──
    {
        let mut cfg = state.config.write().await;
        let policy = crate::bucket_policy::BucketPolicyConfig {
            backend: Some(target_backend.clone()),
            alias: Some(bucket.clone()),
            ..Default::default()
        };
        cfg.buckets.insert(transient_key.clone(), policy);
        if let Err(e) = super::config::rebuild_engine(
            &state,
            &cfg,
            &format!(
                "Migration staging route '{}' → '{}'",
                transient_key, target_backend
            ),
        )
        .await
        {
            cfg.buckets.remove(&transient_key);
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to stage migration: {e}"),
            ));
        }
    }

    // Helper to tear down the transient route on any failure before the flip.
    let teardown_transient = |state: Arc<AdminState>, transient_key: String| async move {
        let mut cfg = state.config.write().await;
        cfg.buckets.remove(&transient_key);
        let _ =
            super::config::rebuild_engine(&state, &cfg, "Migration aborted, staging route removed")
                .await;
    };

    // Ensure the real bucket exists on the TARGET backend before copying into it
    // (the staging route resolves writes to `target/<bucket>`, which won't exist
    // yet on a fresh target). Idempotent: a pre-existing bucket is fine.
    {
        let engine = state.s3_state.engine.load();
        if let Err(e) = engine.create_bucket(&transient_key).await {
            let msg = e.to_string();
            // Tolerate "already exists"; fail on anything else.
            if !msg.to_lowercase().contains("exist") {
                teardown_transient(state.clone(), transient_key).await;
                return Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("Failed to create bucket on target backend: {msg}"),
                ));
            }
        }
    }

    // ── Copy every object: source bucket (→ from_backend) into the transient
    //    bucket (→ target_backend / real bucket). ──
    let engine = state.s3_state.engine.load();
    let provenance_value = format!("{}->{}", from_backend, target_backend);
    let mut objects_copied: u64 = 0;
    let mut bytes_copied: u64 = 0;
    let mut copied_keys: Vec<String> = Vec::new();
    let mut continuation: Option<String> = None;
    loop {
        let page = match engine
            .list_objects(&bucket, "", None, 1000, continuation.as_deref(), false)
            .await
        {
            Ok(p) => p,
            Err(e) => {
                teardown_transient(state.clone(), transient_key).await;
                return Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("Failed to list source bucket: {e}"),
                ));
            }
        };
        for (key, _meta) in &page.objects {
            // Idempotent: skip if already present on the target.
            if engine.head(&transient_key, key).await.is_ok() {
                copied_keys.push(key.clone());
                continue;
            }
            let req = crate::transfer::ObjectTransferRequest {
                source_bucket: &bucket,
                source_key: key,
                destination_bucket: &transient_key,
                destination_key: key,
                provenance: Some(crate::transfer::TransferProvenance {
                    metadata_key: "dg-migration",
                    metadata_value: &provenance_value,
                }),
                operation: "migrate",
            };
            match crate::transfer::copy_object_with_retries(&engine, req).await {
                Ok(outcome) => {
                    objects_copied += 1;
                    bytes_copied += outcome.bytes_copied as u64;
                    copied_keys.push(key.clone());
                }
                Err(e) => {
                    teardown_transient(state.clone(), transient_key).await;
                    return Err((
                        StatusCode::INTERNAL_SERVER_ERROR,
                        format!("Failed to copy object '{}': {e}", key),
                    ));
                }
            }
        }
        match page.next_continuation_token {
            Some(token) => continuation = Some(token),
            None => break,
        }
    }

    // ── Verify: every copied key is readable on the target. ──
    for key in &copied_keys {
        if engine.head(&transient_key, key).await.is_err() {
            teardown_transient(state.clone(), transient_key).await;
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                format!(
                    "Verification failed: '{}' missing on target after copy",
                    key
                ),
            ));
        }
    }

    // ── Flip: route the real bucket to the target, drop the transient route. ──
    {
        let mut cfg = state.config.write().await;
        let old_policy = cfg.buckets.get(&bucket_key).cloned();
        let mut policy = old_policy.clone().unwrap_or_default();
        policy.backend = Some(target_backend.clone());
        cfg.buckets.insert(bucket_key.clone(), policy);
        cfg.buckets.remove(&transient_key);
        if let Err(e) = super::config::rebuild_engine(
            &state,
            &cfg,
            &format!(
                "Bucket '{}' migrated to backend '{}'",
                bucket, target_backend
            ),
        )
        .await
        {
            // Restore both the original bucket route and drop the transient.
            match old_policy {
                Some(prev) => {
                    cfg.buckets.insert(bucket_key.clone(), prev);
                }
                None => {
                    cfg.buckets.remove(&bucket_key);
                }
            }
            let _ = super::config::rebuild_engine(&state, &cfg, "Migration flip failed, reverted")
                .await;
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to re-route after copy: {e}"),
            ));
        }
        let persist_path = super::config::active_config_path(&state);
        if let Err(e) = cfg.persist_to_file(&persist_path) {
            tracing::warn!("Failed to persist config to {}: {}", persist_path, e);
        }
    }

    // ── Optional source cleanup (after the flip + verify). The bucket now
    //    routes to the target; reads come from there. The source objects on the
    //    old backend are addressed by deleting through a fresh transient route
    //    back to the source — skipped here for safety unless requested. ──
    let mut source_deleted = false;
    if body.delete_source {
        // Re-stage a transient route to the SOURCE backend (aliased to the real
        // bucket) so we can delete the now-orphaned source objects by name.
        let cleanup_key = format!("{}__src", transient_key);
        {
            let mut cfg = state.config.write().await;
            let policy = crate::bucket_policy::BucketPolicyConfig {
                backend: Some(from_backend.clone()),
                alias: Some(bucket.clone()),
                ..Default::default()
            };
            cfg.buckets.insert(cleanup_key.clone(), policy);
            let _ =
                super::config::rebuild_engine(&state, &cfg, "Migration source-cleanup route").await;
        }
        let cleanup_engine = state.s3_state.engine.load();
        let mut all_deleted = true;
        for key in &copied_keys {
            if cleanup_engine.delete(&cleanup_key, key).await.is_err() {
                all_deleted = false;
            }
        }
        {
            let mut cfg = state.config.write().await;
            cfg.buckets.remove(&cleanup_key);
            let _ =
                super::config::rebuild_engine(&state, &cfg, "Migration source-cleanup done").await;
            let persist_path = super::config::active_config_path(&state);
            let _ = cfg.persist_to_file(&persist_path);
        }
        source_deleted = all_deleted;
    }

    audit_log(
        "admin_migrate_bucket",
        "admin",
        &format!("{bucket}: {from_backend}->{target_backend} ({objects_copied} objects)"),
        &headers,
    );

    Ok(Json(MigrateBucketResponse {
        success: true,
        bucket,
        from_backend,
        to_backend: target_backend,
        objects_copied,
        bytes_copied,
        source_deleted,
    }))
}

/// POST /api/admin/backends — add a new named backend.
pub async fn create_backend(
    State(state): State<Arc<AdminState>>,
    Json(body): Json<CreateBackendRequest>,
) -> impl IntoResponse {
    let name = body.name.trim().to_string();
    if name.is_empty() {
        return (
            axum::http::StatusCode::BAD_REQUEST,
            Json(BackendMutationResponse {
                success: false,
                error: Some("Backend name cannot be empty".into()),
                requires_restart: false,
            }),
        );
    }

    let backend_config = match build_backend_config(&body) {
        Ok(bc) => bc,
        Err(e) => {
            return (
                axum::http::StatusCode::BAD_REQUEST,
                Json(BackendMutationResponse {
                    success: false,
                    error: Some(e),
                    requires_restart: false,
                }),
            );
        }
    };

    let mut cfg = state.config.write().await;

    // Check for duplicate name
    if cfg.backends.iter().any(|b| b.name == name) {
        return (
            axum::http::StatusCode::CONFLICT,
            Json(BackendMutationResponse {
                success: false,
                error: Some(format!("Backend '{}' already exists", name)),
                requires_restart: false,
            }),
        );
    }

    let old_backends = cfg.backends.clone();
    let old_default = cfg.default_backend.clone();

    cfg.backends.push(NamedBackendConfig {
        name: name.clone(),
        backend: backend_config,
        // STEP-1: per-backend encryption config. `CreateBackendRequest`
        // will gain an optional `encryption` field in Step 6 (per the
        // plan); until then new backends default to plaintext (mode:
        // none) — operators configure encryption after creation via
        // the Backends panel or a section-level PATCH.
        encryption: crate::config::BackendEncryptionConfig::default(),
    });

    if body.set_default == Some(true) || cfg.default_backend.is_none() {
        cfg.default_backend = Some(name.clone());
    }

    if let Err(e) = super::config::rebuild_engine(
        &state,
        &cfg,
        &format!("Backend '{}' added, engine rebuilt", name),
    )
    .await
    {
        cfg.backends = old_backends;
        cfg.default_backend = old_default;
        return (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            Json(BackendMutationResponse {
                success: false,
                error: Some(format!("Failed to rebuild engine: {}", e)),
                requires_restart: false,
            }),
        );
    }

    // Persist to the active config file resolved at startup from `--config`
    // or the search-path walk. Hardcoding `DEFAULT_CONFIG_FILENAME` here
    // used to silently redirect admin-API writes to a stale location when
    // the operator had launched with `--config /etc/dgp/config.yaml`,
    // producing a latent "my backend disappears on restart" bug.
    //
    // Note: we do NOT call `trigger_config_sync` here. That helper uploads
    // the SQLCipher IAM database to S3 — a backend mutation changes the
    // TOML/YAML config file, not the IAM DB, so the sync would be a no-op
    // network round-trip. Handlers that DO mutate the IAM DB (users,
    // groups, external_auth, password) are the correct callers.
    let persist_path = super::config::active_config_path(&state);
    if let Err(e) = cfg.persist_to_file(&persist_path) {
        tracing::warn!("Failed to persist config to {}: {}", persist_path, e);
    }

    (
        axum::http::StatusCode::CREATED,
        Json(BackendMutationResponse {
            success: true,
            error: None,
            requires_restart: false,
        }),
    )
}

/// DELETE /api/admin/backends/:name — remove a named backend.
pub async fn delete_backend(
    State(state): State<Arc<AdminState>>,
    Path(name): Path<String>,
) -> impl IntoResponse {
    let mut cfg = state.config.write().await;

    // Guard: the synthesised "default" entry surfaced by list_backends
    // when `cfg.backends` is empty is NOT a real named backend — it's
    // a virtual projection of `cfg.backend`. A DELETE on it would
    // otherwise fall into the generic "not found" branch below with
    // a misleading error; surface the specific shape issue instead.
    if name == "default" && cfg.backends.iter().all(|b| b.name != name) {
        return (
            axum::http::StatusCode::CONFLICT,
            Json(BackendMutationResponse {
                success: false,
                error: Some(
                    "Cannot delete the synthesised 'default' backend — it represents the legacy \
                     singleton `cfg.backend`. To move off the singleton, add a named backend \
                     alongside it, then clear the singleton via section PUT on `storage`."
                        .into(),
                ),
                requires_restart: false,
            }),
        );
    }

    // Check if backend exists
    if !cfg.backends.iter().any(|b| b.name == name) {
        return (
            axum::http::StatusCode::NOT_FOUND,
            Json(BackendMutationResponse {
                success: false,
                error: Some(format!("Backend '{}' not found", name)),
                requires_restart: false,
            }),
        );
    }

    // Check if it's the default backend
    if cfg.default_backend.as_deref() == Some(&name) {
        return (
            axum::http::StatusCode::CONFLICT,
            Json(BackendMutationResponse {
                success: false,
                error: Some(
                    "Cannot delete the default backend. Assign a new default first.".into(),
                ),
                requires_restart: false,
            }),
        );
    }

    // Check if any bucket policies route to this backend
    let routed: Vec<String> = cfg
        .buckets
        .iter()
        .filter(|(_, p)| p.backend.as_deref() == Some(&name))
        .map(|(bucket, _)| bucket.clone())
        .collect();
    if !routed.is_empty() {
        return (
            axum::http::StatusCode::CONFLICT,
            Json(BackendMutationResponse {
                success: false,
                error: Some(format!(
                    "Cannot delete '{}': buckets [{}] route to it. Re-route them first.",
                    name,
                    routed.join(", ")
                )),
                requires_restart: false,
            }),
        );
    }

    let old_backends = cfg.backends.clone();
    cfg.backends.retain(|b| b.name != name);

    if let Err(e) = super::config::rebuild_engine(
        &state,
        &cfg,
        &format!("Backend '{}' removed, engine rebuilt", name),
    )
    .await
    {
        cfg.backends = old_backends;
        return (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            Json(BackendMutationResponse {
                success: false,
                error: Some(format!("Failed to rebuild engine: {}", e)),
                requires_restart: false,
            }),
        );
    }

    // Persist to the active config file resolved at startup from `--config`
    // or the search-path walk. Hardcoding `DEFAULT_CONFIG_FILENAME` here
    // used to silently redirect admin-API writes to a stale location when
    // the operator had launched with `--config /etc/dgp/config.yaml`,
    // producing a latent "my backend disappears on restart" bug.
    //
    // Note: we do NOT call `trigger_config_sync` here. That helper uploads
    // the SQLCipher IAM database to S3 — a backend mutation changes the
    // TOML/YAML config file, not the IAM DB, so the sync would be a no-op
    // network round-trip. Handlers that DO mutate the IAM DB (users,
    // groups, external_auth, password) are the correct callers.
    let persist_path = super::config::active_config_path(&state);
    if let Err(e) = cfg.persist_to_file(&persist_path) {
        tracing::warn!("Failed to persist config to {}: {}", persist_path, e);
    }

    (
        axum::http::StatusCode::OK,
        Json(BackendMutationResponse {
            success: true,
            error: None,
            requires_restart: false,
        }),
    )
}
