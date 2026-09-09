// SPDX-License-Identifier: GPL-3.0-only

//! Ephemeral multipart upload ownership and resource accounting.
//!
//! The default policy starts in memory; the opt-in large profile spools each
//! part under exclusive disk ownership. Small delta completion assembles bytes,
//! while native S3 completion reads ordered relay files without local assembly.
//! Upload IDs are lost on restart; clients must begin a new upload.

use crate::api::S3Error;
use bytes::{Bytes, BytesMut};
use chrono::{DateTime, Duration, Utc};

/// Only explicitly identified pre-mutation capacity gates permit a replay retry.
/// Conversion from an ordinary error is deliberately fail-closed.
#[derive(Debug)]
pub(crate) struct PartUploadFailure {
    pub(crate) error: S3Error,
    pub(crate) unexecuted_capacity: bool,
}

impl PartUploadFailure {
    fn unexecuted_capacity(message: String) -> Self {
        Self {
            error: S3Error::SlowDown(message),
            unexecuted_capacity: true,
        }
    }
}

impl From<S3Error> for PartUploadFailure {
    fn from(error: S3Error) -> Self {
        Self {
            error,
            unexecuted_capacity: false,
        }
    }
}

/// Per-part listing entry used by ListParts. Previously defined in
/// `src/api/xml.rs`; moved here when the axum XML response builders
/// were retired with the legacy S3 adapter. The s3s adapter
/// translates these into its own wire types.
#[derive(Debug, Clone)]
pub struct PartInfo {
    pub part_number: u32,
    pub etag: String,
    pub size: u64,
    pub last_modified: DateTime<Utc>,
}

/// Per-upload entry used by ListMultipartUploads. Same migration
/// story as [`PartInfo`].
#[derive(Debug, Clone)]
pub struct UploadInfo {
    pub key: String,
    pub upload_id: String,
    pub initiated: DateTime<Utc>,
}
use md5::{Digest, Md5};
use parking_lot::RwLock;
use rand::Rng;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
#[cfg(test)]
mod lifecycle_tests;
mod spool;
pub mod wire;
pub(crate) const LARGE_OBJECT_BYTES: u64 = 2 * 1024 * 1024 * 1024;
pub(crate) const LARGE_PART_BYTES: u64 = 16 * 1024 * 1024;
const LARGE_SPOOL_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const LARGE_UPLOADS: usize = 32;
const LARGE_PARTS: usize = 4096;
const LARGE_PARTS_PER_UPLOAD: usize = 256;

#[cfg(test)]
pub(crate) fn test_spool_dir() -> tempfile::TempDir {
    use std::os::unix::fs::PermissionsExt;
    tempfile::Builder::new()
        .permissions(fs::Permissions::from_mode(0o700))
        .tempdir()
        .unwrap()
}

pub(crate) struct NativeRelayAdmission {
    pub engine: std::sync::Weak<crate::deltaglider::DynEngine>,
    pub target: (Box<dyn crate::storage::StorageBackend>, String),
}

/// Drop is terminal only after begin-complete. The owned task never cancels a
/// backend future on client disconnect; panic unwinding also settles locally.
pub(crate) struct CompletionSettlement {
    store: Arc<MultipartStore>,
    upload_id: String,
    armed: bool,
}
impl CompletionSettlement {
    pub(crate) fn new(store: Arc<MultipartStore>, upload_id: String) -> Self {
        Self {
            store,
            upload_id,
            armed: true,
        }
    }

    pub(crate) fn rollback(mut self) {
        // Disarm BEFORE reopening: another worker may immediately acquire the
        // upload on a different thread. Our Drop must not settle that owner.
        self.armed = false;
        self.store.rollback_upload(&self.upload_id);
    }
}
impl Drop for CompletionSettlement {
    fn drop(&mut self) {
        if self.armed {
            self.store.finish_if_completing(&self.upload_id);
        }
    }
}

const RELAY_ROOT_DIR: &str = "deltaglider-mpu-relay";

/// Data for a single uploaded part
enum PartPayload {
    InMemory(Bytes),
    RelayedFile(PathBuf),
}

impl PartPayload {
    fn load_bytes(&self) -> Result<Bytes, S3Error> {
        match self {
            Self::InMemory(bytes) => Ok(bytes.clone()),
            Self::RelayedFile(path) => fs::read(path)
                .map(Bytes::from)
                .map_err(|e| S3Error::InternalError(format!("Failed to read relayed part: {}", e))),
        }
    }
}

struct PartData {
    payload: PartPayload,
    md5_hex: String,
    md5_raw: [u8; 16],
    size: u64,
    uploaded_at: DateTime<Utc>,
}

/// Lifecycle state of a multipart upload. Replaces the old
/// `completed: bool` flag to close a race between `complete()` and
/// `abort()` where the handler could return 204 "aborted" AFTER
/// complete had already validated parts and the subsequent
/// `engine.store*` was about to publish the object (C4 security fix).
///
/// The state machine:
///
/// ```text
///                   upload_part ↻       abort
///                      │                 │
///                      ▼                 ▼
///   [create] ─▶ Open ─▶─ begin_complete ─▶─ Completing
///                │                            │
///                │                            ├── finish_upload ──▶ (removed)
///                │                            └── rollback_upload ──▶ Open
///                │
///                └── abort ──▶ (removed)
/// ```
///
/// Invariants enforced by callers:
/// - `upload_part` rejects unless state is `Open`.
/// - `abort` rejects when state is `Completing` (409 Conflict).
/// - `begin_complete` only returns parts if state was `Open`; atomically
///   flips to `Completing` under the write lock.
/// - `finish_upload` / `rollback_upload` terminate `Completing` state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MultipartState {
    /// Accepting UploadPart calls. Abort is allowed.
    Open,
    /// `begin_complete` has validated and handed off parts; `engine.store*`
    /// is in flight. New UploadParts and aborts are refused.
    Completing,
    Cleaning,
}

/// State for an in-progress multipart upload
struct MultipartUpload {
    upload_id: String,
    bucket: String,
    key: String,
    created_at: DateTime<Utc>,
    /// Latest UploadPart or Create timestamp — drives the idle-TTL sweeper
    /// that reclaims memory from attackers who open uploads and walk away
    /// (C3 DoS fix).
    last_activity: DateTime<Utc>,
    content_type: Option<String>,
    user_metadata: HashMap<String, String>,
    parts: HashMap<u32, PartData>,
    state: MultipartState,
    relay_strategy: RelayStrategy,
    // Retained failed atomic-write reservation (including a partial temporary).
    cleanup_bytes: u64,
    part_owner: Arc<tokio::sync::Mutex<()>>,
    admission: Option<Arc<NativeRelayAdmission>>,
    accepted_limit: u64,
}

enum RelayStrategy {
    InMemory { relay_threshold_bytes: Option<u64> },
    Relayed { relay_dir: PathBuf },
}

/// Result of assembling a completed multipart upload
#[derive(Debug)]
pub struct CompletedUpload {
    pub data: Bytes,
    pub etag: String,
    pub content_type: Option<String>,
    pub user_metadata: HashMap<String, String>,
}

pub enum PassthroughPayload {
    Chunks(Vec<Bytes>),
    RelayedParts(Vec<PathBuf>),
}

pub struct CompletedPassthrough {
    pub payload: PassthroughPayload,
    pub etag: String,
    pub total_size: u64,
    pub content_type: Option<String>,
    pub user_metadata: HashMap<String, String>,
}

/// Summary of one multipart sweeper run.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct MultipartSweepReport {
    pub swept_open_uploads: u64,
    pub swept_completing_uploads: u64,
    pub reclaimed_bytes: u64,
    pub orphan_relay_dirs_removed: u64,
    pub orphan_relay_files_removed: u64,
}

impl MultipartSweepReport {
    pub fn total_uploads_swept(self) -> u64 {
        self.swept_open_uploads + self.swept_completing_uploads
    }
}

/// Internal: validated parts from the shared validation step.
struct ValidatedParts {
    part_data: Vec<Bytes>,
    etag: String,
    total_size: u64,
}

/// Default maximum number of concurrent multipart uploads.
/// Overridable via `DGP_MAX_MULTIPART_UPLOADS` env var.
fn default_max_uploads() -> usize {
    crate::config::env_parse_with_default("DGP_MAX_MULTIPART_UPLOADS", 1000)
}

/// Default global cap on total in-flight multipart bytes across all uploads.
/// Overridable via `DGP_MAX_TOTAL_MULTIPART_BYTES` env var. Protects against
/// the C3 DoS where an attacker opens many uploads and sends many large
/// parts without completing — pre-fix the only cap was `max_object_size`
/// per upload at complete-time, leaving `max_object_size * max_uploads`
/// bytes of RAM reachable.
///
/// Default formula: `max_object_size * (max_uploads / 4)`. The /4 is a
/// safety margin so legitimate multi-uploader workloads still fit while
/// attackers hit the ceiling before they can saturate memory.
fn default_max_total_multipart_bytes(max_object_size: u64, max_uploads: usize) -> u64 {
    // Allow operator override (absolute bytes). Routed through env_parse
    // for consistent warn-on-invalid behaviour.
    if let Some(n) = crate::config::env_parse::<u64>("DGP_MAX_TOTAL_MULTIPART_BYTES") {
        return n;
    }
    // Default: max_object_size * (max_uploads / 4), clamped to at least
    // max_object_size (one full upload must always fit).
    max_object_size.saturating_mul((max_uploads.max(4) / 4) as u64)
}

/// TTL before an idle (no recent UploadPart activity) multipart upload is
/// garbage-collected. Overridable via `DGP_MULTIPART_IDLE_TTL_HOURS`.
/// Default 24h — matches AWS's default abort-incomplete-multipart-upload
/// lifecycle recommendation.
fn default_multipart_idle_ttl_hours() -> i64 {
    crate::config::env_parse_with_default("DGP_MULTIPART_IDLE_TTL_HOURS", 24)
}

/// Request-body admission, independent of retained multipart state. The permit
/// must remain owned until the body is handed to the store (or dropped).
/// These opt-in controls do not enable large-object relay or raise any size cap.
pub(crate) struct MultipartIngress {
    max_part_bytes: Option<u64>,
    bodies: Option<std::sync::Arc<tokio::sync::Semaphore>>,
}

impl MultipartIngress {
    fn from_env() -> Self {
        Self::new(
            crate::config::env_parse("DGP_MPU_MAX_PART_BYTES"),
            crate::config::env_parse("DGP_MPU_MAX_BUFFERED_PARTS"),
        )
    }

    pub(crate) fn new(max_part_bytes: Option<u64>, buffered_parts: Option<usize>) -> Self {
        Self {
            max_part_bytes,
            bodies: buffered_parts.map(|n| {
                std::sync::Arc::new(tokio::sync::Semaphore::new(
                    n.min(tokio::sync::Semaphore::MAX_PERMITS),
                ))
            }),
        }
    }

    pub(crate) fn part_limit(&self, object_limit: u64) -> u64 {
        self.max_part_bytes
            .unwrap_or(object_limit)
            .min(object_limit)
    }

    pub(crate) fn acquire(&self) -> Result<Option<tokio::sync::OwnedSemaphorePermit>, S3Error> {
        self.bodies
            .as_ref()
            .map(|bodies| {
                bodies.clone().try_acquire_owned().map_err(|_| {
                    S3Error::SlowDown("Multipart request body capacity reached".to_string())
                })
            })
            .transpose()
    }

    /// UploadPartCopy currently hydrates the entire source, including delta
    /// reconstruction, even for a small requested range. It cannot participate
    /// in the bounded-body contract. Refuse before ANY source retrieval.
    pub(crate) fn check_copy_supported(&self) -> Result<(), S3Error> {
        if self.max_part_bytes.is_some() || self.bodies.is_some() {
            return Err(S3Error::InvalidRequest(
                "UploadPartCopy is unavailable with multipart ingress bounds; use UploadPart"
                    .to_string(),
            ));
        }
        Ok(())
    }
}

/// Thread-safe in-memory store for multipart upload state
pub struct MultipartStore {
    pub(crate) ingress: MultipartIngress,
    relay_root: PathBuf,
    spool: Option<spool::Spool>,
    #[cfg(test)]
    fail_cleanup: std::sync::atomic::AtomicBool,
    pub(crate) completions: Arc<tokio::sync::Semaphore>,
    pub(crate) wire_bodies: Arc<tokio::sync::Semaphore>,
    uploads: RwLock<HashMap<String, MultipartUpload>>,
    max_object_size: u64,
    max_uploads: usize,
    /// Global in-flight bytes across all uploads. Kept consistent with
    /// the sum of retained part sizes plus cleanup/temporary bytes — updated under the
    /// same write lock that mutates the parts map. Checked before each
    /// UploadPart accepts bytes (C3 DoS fix).
    in_flight_bytes: std::sync::atomic::AtomicU64,
    max_total_multipart_bytes: u64,
    idle_ttl: Duration,
}

impl MultipartStore {
    pub fn new(max_object_size: u64) -> Self {
        let max_uploads = default_max_uploads();
        let max_total_multipart_bytes =
            default_max_total_multipart_bytes(max_object_size, max_uploads);
        let idle_ttl_hours = default_multipart_idle_ttl_hours();
        Self {
            ingress: MultipartIngress::from_env(),
            relay_root: relay_root_dir().join(uuid::Uuid::new_v4().to_string()),
            spool: None,
            #[cfg(test)]
            fail_cleanup: std::sync::atomic::AtomicBool::new(false),
            completions: Arc::new(tokio::sync::Semaphore::new(1)),
            wire_bodies: Arc::new(tokio::sync::Semaphore::new(2)),
            uploads: RwLock::new(HashMap::new()),
            max_object_size,
            max_uploads,
            in_flight_bytes: std::sync::atomic::AtomicU64::new(0),
            max_total_multipart_bytes,
            idle_ttl: Duration::hours(idle_ttl_hours),
        }
    }

    /// Fixed, opt-in disk profile. Existing general PUT/delta engine caps stay
    /// unchanged. Startup fails closed on lock/reclamation/config errors.
    pub fn with_large_spool(mut self, path: &Path) -> std::io::Result<Self> {
        let spool = spool::Spool::open(path)?;
        self.relay_root = spool.root.clone();
        self.spool = Some(spool);
        self.max_object_size = LARGE_OBJECT_BYTES;
        self.max_total_multipart_bytes = LARGE_SPOOL_BYTES;
        self.max_uploads = LARGE_UPLOADS;
        self.ingress = MultipartIngress::new(Some(LARGE_PART_BYTES), Some(2));
        Ok(self)
    }

    pub fn large_profile(&self) -> bool {
        self.spool.is_some()
    }

    pub(crate) fn pin_admission(
        &self,
        id: &str,
        admission: Option<Arc<NativeRelayAdmission>>,
        small_limit: u64,
    ) {
        let mut uploads = self.uploads.write();
        if let Some(upload) = uploads.get_mut(id) {
            upload.accepted_limit = if admission.is_some() {
                LARGE_OBJECT_BYTES
            } else {
                small_limit
                    .min(self.max_object_size)
                    .min(if self.large_profile() {
                        64 * 1024 * 1024
                    } else {
                        u64::MAX
                    })
            };
            upload.admission = admission;
        }
    }

    pub(crate) fn acquire_part_owner(
        &self,
        id: &str,
    ) -> Result<Option<tokio::sync::OwnedMutexGuard<()>>, S3Error> {
        if !self.large_profile() {
            return Ok(None);
        }
        let uploads = self.uploads.read();
        let upload = uploads
            .get(id)
            .ok_or_else(|| S3Error::NoSuchUpload(id.into()))?;
        upload
            .part_owner
            .clone()
            .try_lock_owned()
            .map(Some)
            .map_err(|_| S3Error::SlowDown("Another part is being admitted for this upload".into()))
    }

    pub(crate) fn admission(&self, id: &str) -> Option<Arc<NativeRelayAdmission>> {
        self.uploads
            .read()
            .get(id)
            .and_then(|u| u.admission.clone())
    }

    /// Limit the next body BEFORE collecting it; the insertion rechecks under
    /// the write lock, so concurrent requests cannot overcommit accepted state.
    pub(crate) fn remaining_part_bytes(
        &self,
        id: &str,
        bucket: &str,
        key: &str,
        part: u32,
    ) -> Result<u64, S3Error> {
        let uploads = self.uploads.read();
        let u = uploads
            .get(id)
            .filter(|u| u.bucket == bucket && u.key == key)
            .ok_or_else(|| S3Error::NoSuchUpload(id.into()))?;
        if u.state != MultipartState::Open {
            return Err(S3Error::InvalidRequest("Upload is not open".into()));
        }
        let retained = u.parts.values().map(|p| p.size).sum::<u64>()
            - u.parts.get(&part).map_or(0, |p| p.size);
        Ok(u.accepted_limit.saturating_sub(retained))
    }

    /// Test-only constructor with custom caps. Not part of the stable API.
    #[cfg(test)]
    pub(crate) fn new_for_test(
        max_object_size: u64,
        max_total_multipart_bytes: u64,
        idle_ttl: Duration,
    ) -> Self {
        Self {
            ingress: MultipartIngress::new(None, None),
            relay_root: relay_root_dir().join(uuid::Uuid::new_v4().to_string()),
            spool: None,
            #[cfg(test)]
            fail_cleanup: std::sync::atomic::AtomicBool::new(false),
            completions: Arc::new(tokio::sync::Semaphore::new(1)),
            wire_bodies: Arc::new(tokio::sync::Semaphore::new(2)),
            uploads: RwLock::new(HashMap::new()),
            max_object_size,
            max_uploads: 1000,
            in_flight_bytes: std::sync::atomic::AtomicU64::new(0),
            max_total_multipart_bytes,
            idle_ttl,
        }
    }

    /// Snapshot the global in-flight byte counter. Test-only observability.
    #[cfg(test)]
    pub(crate) fn in_flight_bytes(&self) -> u64 {
        self.in_flight_bytes
            .load(std::sync::atomic::Ordering::Relaxed)
    }

    /// Create a new multipart upload, returns the upload ID.
    /// Returns `S3Error::SlowDown` if the maximum number of concurrent uploads is reached.
    pub fn create(
        &self,
        bucket: &str,
        key: &str,
        content_type: Option<String>,
        user_metadata: HashMap<String, String>,
    ) -> Result<String, S3Error> {
        self.create_with_relay_policy(bucket, key, content_type, user_metadata, None, false)
    }

    /// Create a new multipart upload with optional relay policy.
    /// - `relay_threshold_bytes`: when set, promote in-memory parts to relayed
    ///   files once cumulative uploaded bytes exceed this threshold.
    /// - `always_relay_passthrough`: start directly in relay mode.
    #[allow(clippy::too_many_arguments)]
    pub fn create_with_relay_policy(
        &self,
        bucket: &str,
        key: &str,
        content_type: Option<String>,
        user_metadata: HashMap<String, String>,
        relay_threshold_bytes: Option<u64>,
        always_relay_passthrough: bool,
    ) -> Result<String, S3Error> {
        let now = Utc::now();

        // Cryptographically random upload ID (matches AWS S3 behavior).
        let mut random_bytes = [0u8; 16];
        rand::rngs::OsRng.fill(&mut random_bytes);
        let upload_id = hex::encode(random_bytes); // 32 hex chars

        let mut uploads = self.uploads.write();

        // Enforce maximum concurrent uploads to prevent resource exhaustion
        if uploads.len() >= self.max_uploads {
            return Err(S3Error::SlowDown(format!(
                "Too many concurrent multipart uploads (max {})",
                self.max_uploads
            )));
        }

        if self.large_profile()
            && (key.len() > 1024
                || bucket.len() > 63
                || content_type.as_ref().map_or(0, |s| s.len()) > 1024
                || user_metadata.len() > 64
                || user_metadata
                    .iter()
                    .map(|(k, v)| k.len() + v.len())
                    .sum::<usize>()
                    > 8192)
        {
            return Err(S3Error::InvalidArgument(
                "Multipart metadata budget exceeded".into(),
            ));
        }
        let upload = MultipartUpload {
            cleanup_bytes: 0,
            part_owner: Arc::new(tokio::sync::Mutex::new(())),
            admission: None,
            accepted_limit: self.max_object_size,
            upload_id: upload_id.clone(),
            bucket: bucket.to_string(),
            key: key.to_string(),
            created_at: now,
            last_activity: now,
            content_type,
            user_metadata,
            parts: HashMap::new(),
            state: MultipartState::Open,
            relay_strategy: if always_relay_passthrough || self.large_profile() {
                RelayStrategy::Relayed {
                    relay_dir: self.relay_root.join(&upload_id),
                }
            } else {
                RelayStrategy::InMemory {
                    relay_threshold_bytes,
                }
            },
        };

        uploads.insert(upload_id.clone(), upload);
        Ok(upload_id)
    }

    /// Upload a part, returns the quoted ETag (MD5 hex).
    pub fn upload_part(
        &self,
        upload_id: &str,
        bucket: &str,
        key: &str,
        part_number: u32,
        data: Bytes,
    ) -> Result<String, S3Error> {
        self.upload_part_classified(upload_id, bucket, key, part_number, data)
            .map_err(|failure| failure.error)
    }

    pub(crate) fn upload_part_classified(
        &self,
        upload_id: &str,
        bucket: &str,
        key: &str,
        part_number: u32,
        data: Bytes,
    ) -> Result<String, PartUploadFailure> {
        if !(1..=10000).contains(&part_number) {
            return Err(S3Error::InvalidArgument(
                "Part number must be between 1 and 10000".to_string(),
            )
            .into());
        }

        let md5_raw: [u8; 16] = Md5::digest(&data).into();
        let md5_hex = hex::encode(md5_raw);
        let etag = format!("\"{}\"", md5_hex);
        let size = data.len() as u64;

        let mut uploads = self.uploads.write();
        let total_parts: usize = uploads.values().map(|u| u.parts.len()).sum();
        let upload = uploads
            .get_mut(upload_id)
            .ok_or_else(|| S3Error::NoSuchUpload(upload_id.to_string()))?;

        // Validate bucket+key match
        if upload.bucket != bucket || upload.key != key {
            return Err(S3Error::NoSuchUpload(upload_id.to_string()).into());
        }

        // C4 security fix: parts can only be uploaded while the upload is
        // Open. Once CompleteMultipartUpload has started (state=Completing),
        // accepting new parts would race with the in-flight `engine.store*`.
        if upload.state != MultipartState::Open {
            return Err(S3Error::InvalidRequest(
                "Upload is in the process of being completed; no more parts can be added"
                    .to_string(),
            )
            .into());
        }

        // C3 DoS fix: enforce size caps BEFORE buffering the part. Two
        // gates, checked in order:
        //
        // 1. Per-upload cap (max_object_size) — prevents one upload from
        //    assembling more bytes than a single object is allowed to be.
        //    Overwrite semantics: recompute cumulative from existing parts
        //    MINUS the old size of `part_number` (if any) PLUS the new
        //    size. Without the subtraction, re-uploading a part would
        //    double-count.
        //
        // 2. Global cap (max_total_multipart_bytes) — prevents many
        //    uploads from collectively exhausting heap. Rejects with
        //    SlowDown so AWS SDKs back off and retry.
        let old_part_size = upload.parts.get(&part_number).map(|p| p.size).unwrap_or(0);
        let cumulative_after = upload
            .parts
            .values()
            .map(|p| p.size)
            .sum::<u64>()
            .saturating_sub(old_part_size)
            .saturating_add(size);

        if cumulative_after > upload.accepted_limit {
            return Err(S3Error::EntityTooLarge {
                size: cumulative_after,
                max: upload.accepted_limit,
            }
            .into());
        }
        if self.large_profile()
            && (size > LARGE_PART_BYTES
                || (!upload.parts.contains_key(&part_number)
                    && (total_parts >= LARGE_PARTS
                        || upload.parts.len() >= LARGE_PARTS_PER_UPLOAD)))
        {
            return Err(PartUploadFailure::unexecuted_capacity(
                "Multipart part budget reached".into(),
            ));
        }

        // Compute the global delta we'd contribute (signed on overwrite).
        let delta: i64 = size as i64 - old_part_size as i64;
        let relayed = matches!(upload.relay_strategy, RelayStrategy::Relayed { .. });
        if delta > 0 || relayed {
            let new_total = self
                .in_flight_bytes
                .load(std::sync::atomic::Ordering::Relaxed)
                .saturating_add(if relayed { size } else { delta as u64 });
            if new_total > self.max_total_multipart_bytes {
                return Err(PartUploadFailure::unexecuted_capacity(format!(
                    "Multipart in-flight bytes cap reached ({} / {} bytes)",
                    new_total, self.max_total_multipart_bytes
                )));
            }
        }

        let should_promote_to_relay = match &upload.relay_strategy {
            RelayStrategy::InMemory {
                relay_threshold_bytes: Some(threshold),
            } => cumulative_after > *threshold,
            RelayStrategy::InMemory {
                relay_threshold_bytes: None,
            } => false,
            RelayStrategy::Relayed { .. } => false,
        };
        if should_promote_to_relay {
            self.promote_upload_to_relay(upload)?;
        }

        let payload = match &upload.relay_strategy {
            RelayStrategy::InMemory { .. } => PartPayload::InMemory(data),
            RelayStrategy::Relayed { relay_dir } => {
                let path = part_path(relay_dir, part_number);
                if let Some(spool) = &self.spool {
                    spool.check_write(size).map_err(|_| {
                        let message = "Multipart spool capacity unavailable".into();
                        if should_promote_to_relay {
                            // Promotion may already have written existing parts.
                            PartUploadFailure::from(S3Error::SlowDown(message))
                        } else {
                            PartUploadFailure::unexecuted_capacity(message)
                        }
                    })?;
                }
                // Count temporary bytes before touching disk. On any failure the
                // entire upload becomes cleanup-only, including partial files.
                self.in_flight_bytes
                    .fetch_add(size, std::sync::atomic::Ordering::Relaxed);
                upload.cleanup_bytes = size;
                if let Err(e) = write_part_file(&path, &data, self.large_profile()) {
                    upload.state = MultipartState::Cleaning;
                    return Err(e.into());
                }
                self.in_flight_bytes
                    .fetch_sub(size, std::sync::atomic::Ordering::Relaxed);
                upload.cleanup_bytes = 0;
                PartPayload::RelayedFile(path)
            }
        };

        // Overwrite semantics: re-uploading same part_number replaces previous data.
        upload.parts.insert(
            part_number,
            PartData {
                payload,
                md5_hex,
                md5_raw,
                size,
                uploaded_at: Utc::now(),
            },
        );
        upload.last_activity = Utc::now();

        // Update global counter AFTER the insert so concurrent readers see
        // a consistent view (counter ≥ actual bytes in map at any moment).
        if delta >= 0 {
            self.in_flight_bytes
                .fetch_add(delta as u64, std::sync::atomic::Ordering::Relaxed);
        } else {
            self.in_flight_bytes
                .fetch_sub((-delta) as u64, std::sync::atomic::Ordering::Relaxed);
        }

        Ok(etag)
    }

    /// Get the size of a specific uploaded part (for quota pre-check).
    pub fn get_part_size(&self, upload_id: &str, part_number: u32) -> Option<u64> {
        let uploads = self.uploads.read();
        uploads
            .get(upload_id)
            .and_then(|u| u.parts.get(&part_number))
            .map(|p| p.size)
    }

    /// Begin completion: validate parts, atomically transition to
    /// `Completing`, and return the assembled buffer. After this call
    /// the upload is reserved — new UploadParts AND abort are refused
    /// (409) until the caller invokes `finish_upload` or
    /// `rollback_upload`. This closes the C4 complete/abort race.
    ///
    /// On validation failure the state is NOT changed (upload stays
    /// `Open` so the client can retry with corrected part metadata).
    pub fn complete(
        &self,
        upload_id: &str,
        bucket: &str,
        key: &str,
        requested_parts: &[(u32, String)], // (part_number, etag)
    ) -> Result<CompletedUpload, S3Error> {
        let mut uploads = self.uploads.write();

        // Refuse if the upload is already Completing — only one complete
        // may be in flight at a time. Double-complete returns 404 to
        // preserve the prior contract.
        if let Some(u) = uploads.get(upload_id) {
            if u.state != MultipartState::Open {
                return Err(S3Error::InvalidRequest(
                    "Upload is already being completed".to_string(),
                ));
            }
        }

        let (validated, upload) =
            self.validate_parts(&uploads, upload_id, bucket, key, requested_parts, true)?;

        let mut assembled = BytesMut::new();
        for part in &validated.part_data {
            assembled.extend_from_slice(part);
        }

        let result = CompletedUpload {
            data: assembled.freeze(),
            etag: validated.etag,
            content_type: upload.content_type.clone(),
            user_metadata: upload.user_metadata.clone(),
        };

        // Flip to Completing under the same write lock that performed the
        // validation — atomic with respect to `abort` and `upload_part`.
        if let Some(u) = uploads.get_mut(upload_id) {
            u.state = MultipartState::Completing;
            u.last_activity = Utc::now();
        }

        Ok(result)
    }

    /// Begin-complete variant optimized for passthrough storage.
    ///
    /// Relay mode returns ordered source paths without an assembly file. The
    /// completion owner must retain the upload until the backend is quiescent.
    pub fn complete_passthrough(
        &self,
        upload_id: &str,
        bucket: &str,
        key: &str,
        requested_parts: &[(u32, String)],
    ) -> Result<CompletedPassthrough, S3Error> {
        let mut uploads = self.uploads.write();

        if let Some(u) = uploads.get(upload_id) {
            if u.state != MultipartState::Open {
                return Err(S3Error::InvalidRequest(
                    "Upload is already being completed".to_string(),
                ));
            }
        }

        let hydrate_part_data = uploads
            .get(upload_id)
            .map(|u| matches!(u.relay_strategy, RelayStrategy::InMemory { .. }))
            .ok_or_else(|| S3Error::NoSuchUpload(upload_id.to_string()))?;
        let (validated, upload) = self.validate_parts(
            &uploads,
            upload_id,
            bucket,
            key,
            requested_parts,
            hydrate_part_data,
        )?;

        let payload = match &upload.relay_strategy {
            RelayStrategy::InMemory { .. } => PassthroughPayload::Chunks(validated.part_data),
            RelayStrategy::Relayed { relay_dir: _ } => {
                let ordered_paths = ordered_relay_part_paths(requested_parts, upload)?;
                PassthroughPayload::RelayedParts(ordered_paths)
            }
        };

        let result = CompletedPassthrough {
            payload,
            etag: validated.etag,
            total_size: validated.total_size,
            content_type: upload.content_type.clone(),
            user_metadata: upload.user_metadata.clone(),
        };

        if let Some(u) = uploads.get_mut(upload_id) {
            u.state = MultipartState::Completing;
            u.last_activity = Utc::now();
        }

        Ok(result)
    }

    /// Roll the upload back to `Open` after a failed engine.store*.
    /// The client is expected to retry CompleteMultipartUpload with the
    /// same part set — this matches S3's behaviour when the backing
    /// store rejects a complete.
    ///
    /// Idempotent: if the upload was already removed (e.g. via a
    /// concurrent abort after rollback), does nothing.
    pub fn rollback_upload(&self, upload_id: &str) {
        if let Some(u) = self.uploads.write().get_mut(upload_id) {
            if u.state == MultipartState::Completing {
                u.state = MultipartState::Open;
            }
        }
    }

    /// Finalise a completed upload after `engine.store*` succeeds.
    /// Removes the upload from the map. This is the terminal state.
    /// Semantically equivalent to the previous `remove_upload`.
    ///
    /// Also releases the upload's bytes from the global in-flight counter
    /// so new uploads can reclaim headroom (C3 DoS fix).
    pub fn finish_upload(&self, upload_id: &str) {
        let mut uploads = self.uploads.write();
        self.cleanup_locked(&mut uploads, upload_id);
    }

    fn finish_if_completing(&self, id: &str) {
        let mut uploads = self.uploads.write();
        if uploads
            .get(id)
            .is_some_and(|u| u.state == MultipartState::Completing)
        {
            self.cleanup_locked(&mut uploads, id);
        }
    }

    // Never remove state/accounting before deletion succeeds. Retrying cleanup
    // cannot restart publication, and failed cleanup still consumes upload slots.
    fn cleanup_locked(&self, uploads: &mut HashMap<String, MultipartUpload>, id: &str) -> u64 {
        let Some(u) = uploads.get_mut(id) else {
            return 0;
        };
        u.state = MultipartState::Cleaning;
        #[cfg(test)]
        if self.fail_cleanup.load(std::sync::atomic::Ordering::Relaxed) {
            return 0;
        }
        if cleanup_relay_dir_for_upload(u).is_err() {
            return 0;
        }
        let u = uploads.remove(id).expect("entry held under write lock");
        self.release_bytes(&u)
    }

    /// Return the sum of all part sizes for this upload — used by the
    /// in-flight counter on release paths.
    fn release_bytes(&self, upload: &MultipartUpload) -> u64 {
        let freed: u64 = upload.parts.values().map(|p| p.size).sum::<u64>() + upload.cleanup_bytes;
        if freed > 0 {
            self.in_flight_bytes
                .fetch_sub(freed, std::sync::atomic::Ordering::Relaxed);
        }
        freed
    }

    /// Shared validation for complete variants.
    ///
    /// Looks up the upload, validates part ordering and ETags, enforces size limits,
    /// and computes the S3-compatible multipart ETag. Returns validated part data
    /// and a reference to the upload (for content_type / user_metadata).
    fn validate_parts<'a>(
        &self,
        uploads: &'a HashMap<String, MultipartUpload>,
        upload_id: &str,
        bucket: &str,
        key: &str,
        requested_parts: &[(u32, String)],
        hydrate_part_data: bool,
    ) -> Result<(ValidatedParts, &'a MultipartUpload), S3Error> {
        let upload = uploads
            .get(upload_id)
            .ok_or_else(|| S3Error::NoSuchUpload(upload_id.to_string()))?;
        if upload.bucket != bucket || upload.key != key {
            return Err(S3Error::NoSuchUpload(upload_id.to_string()));
        }

        if requested_parts.is_empty() {
            return Err(S3Error::InvalidPart(
                "You must specify at least one part".to_string(),
            ));
        }

        // Validate ascending order
        for window in requested_parts.windows(2) {
            if window[0].0 >= window[1].0 {
                return Err(S3Error::InvalidPartOrder);
            }
        }

        // Validate each part exists and ETags match; compute total size
        let mut total_size: u64 = 0;
        let mut md5_concat = Vec::new();
        let mut part_data = Vec::with_capacity(requested_parts.len());

        for (part_number, requested_etag) in requested_parts {
            let part = upload.parts.get(part_number).ok_or_else(|| {
                S3Error::InvalidPart(format!("Part {} has not been uploaded", part_number))
            })?;

            // Normalize ETags for comparison (strip quotes)
            let requested_clean = requested_etag.trim_matches('"');
            if requested_clean != part.md5_hex {
                return Err(S3Error::InvalidPart(format!(
                    "ETag mismatch for part {}: expected \"{}\", got \"{}\"",
                    part_number, part.md5_hex, requested_clean
                )));
            }

            total_size += part.size;
            if total_size > self.max_object_size {
                return Err(S3Error::InvalidArgument(format!(
                    "Assembled object size {} exceeds maximum {}",
                    total_size, self.max_object_size
                )));
            }

            md5_concat.extend_from_slice(&part.md5_raw);
            if hydrate_part_data {
                part_data.push(part.payload.load_bytes()?);
            }
        }

        // S3-compatible multipart ETag: MD5(concat of part MD5 raw bytes)-N
        let final_md5 = Md5::digest(&md5_concat);
        let etag = format!("\"{}-{}\"", hex::encode(final_md5), requested_parts.len());

        Ok((
            ValidatedParts {
                part_data,
                etag,
                total_size,
            },
            upload,
        ))
    }

    /// Abort a multipart upload. Validates bucket+key match.
    ///
    /// C4 security fix: refuse when the upload is already in
    /// `Completing` state. Accepting the abort at that point would
    /// race with the in-flight `engine.store*` and return a 204
    /// "aborted" even though the object actually lands. Clients
    /// should wait for the CompleteMultipartUpload response instead.
    pub fn abort(&self, upload_id: &str, bucket: &str, key: &str) -> Result<(), S3Error> {
        let mut uploads = self.uploads.write();
        let upload = uploads
            .get(upload_id)
            .ok_or_else(|| S3Error::NoSuchUpload(upload_id.to_string()))?;

        if upload.bucket != bucket || upload.key != key {
            return Err(S3Error::NoSuchUpload(upload_id.to_string()));
        }

        if upload.state != MultipartState::Open {
            return Err(S3Error::InvalidRequest(
                "Cannot abort: upload is currently being completed".to_string(),
            ));
        }

        self.cleanup_locked(&mut uploads, upload_id);
        if uploads.contains_key(upload_id) {
            return Err(S3Error::InternalError("Multipart cleanup pending".into()));
        }
        Ok(())
    }

    /// Return the number of in-flight uploads targeting `bucket`.
    /// Used by DeleteBucket (H2) to refuse deletion when MPU state
    /// would be orphaned. Counts uploads in Open AND Completing state
    /// because both would become unreachable after the bucket is gone.
    pub fn count_uploads_for_bucket(&self, bucket: &str) -> usize {
        self.uploads
            .read()
            .values()
            .filter(|u| u.bucket == bucket)
            .count()
    }

    /// Force-remove all uploads targeting `bucket`.
    ///
    /// Used by DeleteBucket when the bucket has no visible objects:
    /// MPU state is internal residue and should not block deletion.
    ///
    /// **Refuses** if any upload is in `Completing` state. A
    /// `Completing` upload is mid-flight on `engine.store_*` and holds
    /// borrowed buffers / relay-dir paths that the handler is still
    /// reading; tearing those down here while the storage write is
    /// in-progress causes a P0-class race (the storage layer's
    /// `create_dir_all` silently recreates the bucket inside the
    /// just-deleted directory tree). The operator gets a clean
    /// `BucketNotEmpty` error and can retry once the multipart
    /// finalises (typically seconds).
    ///
    /// On success: returns the number of `Open` uploads purged.
    /// On refusal: returns `Err(count_completing)` — never partially
    /// purges so the caller's bookkeeping is all-or-nothing.
    pub fn purge_uploads_for_bucket(&self, bucket: &str) -> Result<usize, usize> {
        let mut uploads = self.uploads.write();
        let busy = uploads
            .values()
            .filter(|u| u.bucket == bucket && u.state != MultipartState::Open)
            .count();
        if busy > 0 {
            return Err(busy);
        }
        let ids: Vec<_> = uploads
            .values()
            .filter(|u| u.bucket == bucket)
            .map(|u| u.upload_id.clone())
            .collect();
        for id in &ids {
            self.cleanup_locked(&mut uploads, id);
        }
        let pending = uploads.values().filter(|u| u.bucket == bucket).count();
        if pending > 0 {
            Err(pending)
        } else {
            Ok(ids.len())
        }
    }

    /// List parts for an upload. Validates bucket+key match.
    pub fn list_parts(
        &self,
        upload_id: &str,
        bucket: &str,
        key: &str,
    ) -> Result<Vec<PartInfo>, S3Error> {
        let (parts, _, _) = self.list_parts_paginated(upload_id, bucket, key, 0, 10000)?;
        Ok(parts)
    }

    /// Paginated variant of [`Self::list_parts`] (L1 correctness fix).
    /// Returns `(page, is_truncated, next_part_number_marker)`.
    ///
    /// - `part_number_marker`: return parts with part_number strictly
    ///   greater than this value (0 = from beginning, per S3 spec).
    /// - `max_parts`: cap on returned count; clamp at 10_000 (S3 hard
    ///   limit on parts per upload).
    pub fn list_parts_paginated(
        &self,
        upload_id: &str,
        bucket: &str,
        key: &str,
        part_number_marker: u32,
        max_parts: u32,
    ) -> Result<(Vec<PartInfo>, bool, u32), S3Error> {
        let uploads = self.uploads.read();
        let upload = uploads
            .get(upload_id)
            .ok_or_else(|| S3Error::NoSuchUpload(upload_id.to_string()))?;

        if upload.bucket != bucket || upload.key != key {
            return Err(S3Error::NoSuchUpload(upload_id.to_string()));
        }

        let cap = max_parts.clamp(1, 10_000) as usize;

        let mut all: Vec<PartInfo> = upload
            .parts
            .iter()
            .filter(|(&num, _)| num > part_number_marker)
            .map(|(&num, pd)| PartInfo {
                part_number: num,
                etag: format!("\"{}\"", pd.md5_hex),
                size: pd.size,
                last_modified: pd.uploaded_at,
            })
            .collect();
        all.sort_by_key(|p| p.part_number);

        let is_truncated = all.len() > cap;
        if is_truncated {
            all.truncate(cap);
        }
        let next_marker = all.last().map(|p| p.part_number).unwrap_or(0);
        Ok((all, is_truncated, next_marker))
    }

    /// Paginated ListMultipartUploads (L1 correctness fix).
    /// Returns `(page, is_truncated, next_key_marker, next_upload_id_marker)`.
    ///
    /// - `key_marker` + `upload_id_marker`: tuple-cursor — skip any
    ///   upload whose (key, upload_id) is ≤ (key_marker, upload_id_marker)
    ///   lexicographically. Matches AWS S3 semantics.
    /// - `max_uploads`: cap on returned count, clamped to 1..=1000.
    pub fn list_uploads_paginated(
        &self,
        bucket: Option<&str>,
        prefix: Option<&str>,
        key_marker: &str,
        upload_id_marker: &str,
        max_uploads: u32,
    ) -> (Vec<UploadInfo>, bool, String, String) {
        let uploads = self.uploads.read();
        let cap = max_uploads.clamp(1, 1000) as usize;
        let mut filtered: Vec<UploadInfo> = uploads
            .values()
            .filter(|u| {
                if let Some(b) = bucket {
                    if u.bucket != b {
                        return false;
                    }
                }
                if let Some(p) = prefix {
                    if !u.key.starts_with(p) {
                        return false;
                    }
                }
                // Tuple-cursor skip.
                if !key_marker.is_empty() || !upload_id_marker.is_empty() {
                    let cmp =
                        (u.key.as_str(), u.upload_id.as_str()).cmp(&(key_marker, upload_id_marker));
                    if cmp != std::cmp::Ordering::Greater {
                        return false;
                    }
                }
                true
            })
            .map(|u| UploadInfo {
                key: u.key.clone(),
                upload_id: u.upload_id.clone(),
                initiated: u.created_at,
            })
            .collect();
        filtered.sort_by(|a, b| a.key.cmp(&b.key).then(a.upload_id.cmp(&b.upload_id)));

        let is_truncated = filtered.len() > cap;
        if is_truncated {
            filtered.truncate(cap);
        }
        let (next_key, next_upload_id) = filtered
            .last()
            .map(|u| (u.key.clone(), u.upload_id.clone()))
            .unwrap_or_default();
        (filtered, is_truncated, next_key, next_upload_id)
    }

    /// Remove uploads that have been idle longer than the configured idle
    /// TTL OR have exceeded `max_age` (whichever is stricter). The idle
    /// TTL is measured from `last_activity` (last UploadPart or Create).
    ///
    /// C3 DoS fix: sweeps uploads opened by an attacker who never
    /// completes. Also decrements the global in-flight byte counter so
    /// legitimate callers can reclaim headroom.
    ///
    /// Completing uploads retain sources and accounting until their owner
    /// terminates them. Elapsed time is not evidence that an SDK worker has
    /// stopped reading files. The timeout argument is retained for callers.
    pub fn cleanup_expired(
        &self,
        max_age: std::time::Duration,
        _completing_timeout: std::time::Duration,
    ) -> MultipartSweepReport {
        let now = Utc::now();
        let max_age_cutoff = now - Duration::from_std(max_age).unwrap_or(Duration::hours(1));
        let idle_cutoff = now - self.idle_ttl;
        // Take stricter of the two cutoffs (newer / later = stricter).
        let cutoff = if idle_cutoff > max_age_cutoff {
            idle_cutoff
        } else {
            max_age_cutoff
        };

        let mut uploads = self.uploads.write();
        let ids: Vec<_> = uploads
            .values()
            .filter(|u| {
                u.state == MultipartState::Cleaning
                    || (u.state == MultipartState::Open && u.last_activity <= cutoff)
            })
            .map(|u| u.upload_id.clone())
            .collect();
        let mut report = MultipartSweepReport::default();
        for id in ids {
            report.reclaimed_bytes += self.cleanup_locked(&mut uploads, &id);
            if !uploads.contains_key(&id) {
                report.swept_open_uploads += 1;
            }
        }
        report
    }

    /// Startup hardening: remove orphan relay temp artifacts that don't belong
    /// to currently tracked relayed uploads.
    pub fn sweep_orphan_relay_artifacts(&self) -> MultipartSweepReport {
        let uploads = self.uploads.write();
        let active_relay_dirs: HashSet<PathBuf> = uploads
            .values()
            .filter_map(|u| match &u.relay_strategy {
                RelayStrategy::Relayed { relay_dir } => Some(relay_dir.clone()),
                RelayStrategy::InMemory { .. } => None,
            })
            .collect();
        let (dirs_removed, files_removed) =
            cleanup_orphan_relay_entries_at(&self.relay_root, &active_relay_dirs);
        MultipartSweepReport {
            orphan_relay_dirs_removed: dirs_removed,
            orphan_relay_files_removed: files_removed,
            ..MultipartSweepReport::default()
        }
    }

    /// Current number of tracked uploads (Open + Completing).
    pub fn count_uploads(&self) -> usize {
        self.uploads.read().len()
    }

    fn promote_upload_to_relay(&self, upload: &mut MultipartUpload) -> Result<(), S3Error> {
        let relay_dir = self.relay_root.join(&upload.upload_id);
        fs::create_dir_all(&relay_dir).map_err(|e| {
            S3Error::InternalError(format!("Failed to create multipart relay directory: {}", e))
        })?;
        upload.relay_strategy = RelayStrategy::Relayed {
            relay_dir: relay_dir.clone(),
        };
        for (part_number, part) in &mut upload.parts {
            if let PartPayload::InMemory(bytes) = &part.payload {
                let path = part_path(&relay_dir, *part_number);
                if let Err(e) = write_part_file(&path, bytes, false) {
                    upload.state = MultipartState::Cleaning;
                    return Err(e);
                }
                part.payload = PartPayload::RelayedFile(path);
            }
        }
        upload.relay_strategy = RelayStrategy::Relayed { relay_dir };
        Ok(())
    }
}

fn relay_root_dir() -> PathBuf {
    std::env::temp_dir().join(RELAY_ROOT_DIR)
}

fn part_path(relay_dir: &Path, part_number: u32) -> PathBuf {
    relay_dir.join(format!("part-{:05}.bin", part_number))
}

fn write_part_file(path: &Path, data: &Bytes, bounded_disk: bool) -> Result<(), S3Error> {
    let parent = path
        .parent()
        .ok_or_else(|| S3Error::InternalError("Multipart relay path has no parent".to_string()))?;
    fs::create_dir_all(parent)
        .map_err(|e| S3Error::InternalError(format!("Failed to create relay directory: {}", e)))?;
    let tmp_path = parent.join("incoming.tmp");
    let mut tmp = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp_path)
        .map_err(|_| S3Error::InternalError("Failed to create relay temporary".into()))?;
    tmp.write_all(data)
        .and_then(|_| tmp.sync_all())
        .map_err(|_| S3Error::InternalError("Failed to write relay temporary".into()))?;
    drop(tmp);
    if bounded_disk {
        spool::Spool::check_allocation(&tmp_path, data.len() as u64)
            .map_err(|_| S3Error::InternalError("Multipart allocation budget exceeded".into()))?;
    }
    fs::rename(&tmp_path, path)
        .map_err(|_| S3Error::InternalError("Failed to persist relay part".into()))?;
    Ok(())
}

fn ordered_relay_part_paths(
    requested_parts: &[(u32, String)],
    upload: &MultipartUpload,
) -> Result<Vec<PathBuf>, S3Error> {
    let mut paths = Vec::with_capacity(requested_parts.len());
    for (part_number, _) in requested_parts {
        let part = upload.parts.get(part_number).ok_or_else(|| {
            S3Error::InvalidPart(format!("Part {} has not been uploaded", part_number))
        })?;
        match &part.payload {
            PartPayload::RelayedFile(path) => paths.push(path.clone()),
            PartPayload::InMemory(_) => {
                return Err(S3Error::InternalError(
                    "Relay upload contains in-memory part unexpectedly".to_string(),
                ))
            }
        }
    }
    Ok(paths)
}

fn cleanup_relay_dir_for_upload(upload: &MultipartUpload) -> std::io::Result<()> {
    if let RelayStrategy::Relayed { relay_dir } = &upload.relay_strategy {
        match fs::remove_dir_all(relay_dir) {
            Ok(()) => (),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

fn cleanup_orphan_relay_entries_at(
    relay_root: &Path,
    active_relay_dirs: &HashSet<PathBuf>,
) -> (u64, u64) {
    let mut dirs_removed = 0u64;
    let mut files_removed = 0u64;
    let Ok(entries) = fs::read_dir(relay_root) else {
        return (0, 0);
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if active_relay_dirs.contains(&path) {
                continue;
            }
            if fs::remove_dir_all(&path).is_ok() {
                dirs_removed += 1;
            }
        } else if fs::remove_file(&path).is_ok() {
            files_removed += 1;
        }
    }
    (dirs_removed, files_removed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_create_and_upload_part() {
        let store = MultipartStore::new(100 * 1024 * 1024);
        let upload_id = store
            .create("bucket", "key.bin", None, HashMap::new())
            .unwrap();

        let data = Bytes::from(vec![0u8; 1024]);
        let etag = store
            .upload_part(&upload_id, "bucket", "key.bin", 1, data)
            .unwrap();
        assert!(etag.starts_with('"'));
        assert!(etag.ends_with('"'));
    }

    #[test]
    fn test_complete_roundtrip() {
        let store = MultipartStore::new(100 * 1024 * 1024);
        let upload_id = store
            .create("bucket", "key.bin", None, HashMap::new())
            .unwrap();

        let part1 = Bytes::from(vec![1u8; 100]);
        let part2 = Bytes::from(vec![2u8; 200]);
        let etag1 = store
            .upload_part(&upload_id, "bucket", "key.bin", 1, part1.clone())
            .unwrap();
        let etag2 = store
            .upload_part(&upload_id, "bucket", "key.bin", 2, part2.clone())
            .unwrap();

        let result = store
            .complete(&upload_id, "bucket", "key.bin", &[(1, etag1), (2, etag2)])
            .unwrap();

        assert_eq!(result.data.len(), 300);
        assert_eq!(&result.data[..100], &[1u8; 100]);
        assert_eq!(&result.data[100..], &[2u8; 200]);
        assert!(result.etag.ends_with("-2\""));
    }

    #[test]
    fn test_abort() {
        let store = MultipartStore::new(100 * 1024 * 1024);
        let upload_id = store
            .create("bucket", "key.bin", None, HashMap::new())
            .unwrap();
        store.abort(&upload_id, "bucket", "key.bin").unwrap();

        let result = store.upload_part(
            &upload_id,
            "bucket",
            "key.bin",
            1,
            Bytes::from(vec![0u8; 10]),
        );
        assert!(result.is_err());
    }

    #[test]
    fn test_bucket_key_mismatch() {
        let store = MultipartStore::new(100 * 1024 * 1024);
        let upload_id = store
            .create("bucket-a", "key.bin", None, HashMap::new())
            .unwrap();

        let result = store.upload_part(
            &upload_id,
            "bucket-b",
            "key.bin",
            1,
            Bytes::from(vec![0u8; 10]),
        );
        assert!(result.is_err());
    }

    #[test]
    fn test_invalid_part_number() {
        let store = MultipartStore::new(100 * 1024 * 1024);
        let upload_id = store
            .create("bucket", "key.bin", None, HashMap::new())
            .unwrap();

        let result = store.upload_part(
            &upload_id,
            "bucket",
            "key.bin",
            0,
            Bytes::from(vec![0u8; 10]),
        );
        assert!(result.is_err());

        let result = store.upload_part(
            &upload_id,
            "bucket",
            "key.bin",
            10001,
            Bytes::from(vec![0u8; 10]),
        );
        assert!(result.is_err());
    }

    #[test]
    fn test_list_parts() {
        let store = MultipartStore::new(100 * 1024 * 1024);
        let upload_id = store
            .create("bucket", "key.bin", None, HashMap::new())
            .unwrap();

        for i in 1..=3 {
            store
                .upload_part(
                    &upload_id,
                    "bucket",
                    "key.bin",
                    i,
                    Bytes::from(vec![i as u8; 100]),
                )
                .unwrap();
        }

        let parts = store.list_parts(&upload_id, "bucket", "key.bin").unwrap();
        assert_eq!(parts.len(), 3);
        assert_eq!(parts[0].part_number, 1);
        assert_eq!(parts[1].part_number, 2);
        assert_eq!(parts[2].part_number, 3);
    }

    #[test]
    fn test_overwrite_part() {
        let store = MultipartStore::new(100 * 1024 * 1024);
        let upload_id = store
            .create("bucket", "key.bin", None, HashMap::new())
            .unwrap();

        let etag1 = store
            .upload_part(
                &upload_id,
                "bucket",
                "key.bin",
                1,
                Bytes::from(vec![1u8; 100]),
            )
            .unwrap();
        let etag2 = store
            .upload_part(
                &upload_id,
                "bucket",
                "key.bin",
                1,
                Bytes::from(vec![2u8; 100]),
            )
            .unwrap();

        assert_ne!(etag1, etag2);

        let parts = store.list_parts(&upload_id, "bucket", "key.bin").unwrap();
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0].etag, etag2);
    }

    #[test]
    fn test_complete_with_zero_parts() {
        let store = MultipartStore::new(100 * 1024 * 1024);
        let upload_id = store
            .create("bucket", "key.bin", None, HashMap::new())
            .unwrap();
        store
            .upload_part(
                &upload_id,
                "bucket",
                "key.bin",
                1,
                Bytes::from(vec![1u8; 100]),
            )
            .unwrap();

        // Complete with empty parts list should fail
        let result = store.complete(&upload_id, "bucket", "key.bin", &[]);
        assert!(result.is_err(), "complete with zero parts should fail");
    }

    #[test]
    fn test_complete_with_wrong_etag() {
        let store = MultipartStore::new(100 * 1024 * 1024);
        let upload_id = store
            .create("bucket", "key.bin", None, HashMap::new())
            .unwrap();
        store
            .upload_part(
                &upload_id,
                "bucket",
                "key.bin",
                1,
                Bytes::from(vec![1u8; 100]),
            )
            .unwrap();

        // Complete with wrong etag should fail
        let result = store.complete(
            &upload_id,
            "bucket",
            "key.bin",
            &[(1, "\"wrong_etag\"".to_string())],
        );
        assert!(result.is_err(), "complete with wrong etag should fail");
    }

    #[test]
    fn test_complete_with_non_contiguous_parts() {
        let store = MultipartStore::new(100 * 1024 * 1024);
        let upload_id = store
            .create("bucket", "key.bin", None, HashMap::new())
            .unwrap();

        let part1 = Bytes::from(vec![1u8; 100]);
        let part3 = Bytes::from(vec![3u8; 100]);
        let etag1 = store
            .upload_part(&upload_id, "bucket", "key.bin", 1, part1)
            .unwrap();
        let etag3 = store
            .upload_part(&upload_id, "bucket", "key.bin", 3, part3)
            .unwrap();

        // Parts 1 and 3 (skip 2) — should succeed per S3 spec
        let result = store
            .complete(&upload_id, "bucket", "key.bin", &[(1, etag1), (3, etag3)])
            .unwrap();
        assert_eq!(result.data.len(), 200);
        assert_eq!(&result.data[..100], &[1u8; 100]);
        assert_eq!(&result.data[100..], &[3u8; 100]);
    }

    #[test]
    fn test_max_uploads_limit() {
        let store = MultipartStore::new(100 * 1024 * 1024);
        // Override max_uploads for testing
        let store = MultipartStore {
            max_uploads: 3,
            ..store
        };

        // Create 3 uploads (at limit)
        for i in 0..3 {
            store
                .create("bucket", &format!("key{}.bin", i), None, HashMap::new())
                .unwrap();
        }

        // 4th upload should fail
        let result = store.create("bucket", "key3.bin", None, HashMap::new());
        assert!(result.is_err());
    }

    // === C4 security fix: state-machine tests ===

    fn seed_upload(store: &MultipartStore) -> String {
        let upload_id = store
            .create("bucket", "key.bin", None, HashMap::new())
            .unwrap();
        let data = Bytes::from(vec![0u8; 100]);
        store
            .upload_part(&upload_id, "bucket", "key.bin", 1, data)
            .unwrap();
        upload_id
    }

    #[test]
    fn test_complete_flips_state_to_completing() {
        let store = MultipartStore::new(100 * 1024 * 1024);
        let upload_id = seed_upload(&store);
        let etag = {
            let u = store.uploads.read();
            let p = u.get(&upload_id).unwrap().parts.get(&1).unwrap();
            format!("\"{}\"", p.md5_hex)
        };

        // Before complete → Open.
        assert_eq!(
            store.uploads.read().get(&upload_id).unwrap().state,
            MultipartState::Open
        );

        store
            .complete(&upload_id, "bucket", "key.bin", &[(1, etag)])
            .unwrap();

        // After complete, upload stays in map but as Completing.
        assert_eq!(
            store.uploads.read().get(&upload_id).unwrap().state,
            MultipartState::Completing
        );
    }

    #[test]
    fn test_abort_refused_when_completing() {
        let store = MultipartStore::new(100 * 1024 * 1024);
        let upload_id = seed_upload(&store);
        let etag = {
            let u = store.uploads.read();
            let p = u.get(&upload_id).unwrap().parts.get(&1).unwrap();
            format!("\"{}\"", p.md5_hex)
        };

        store
            .complete(&upload_id, "bucket", "key.bin", &[(1, etag)])
            .unwrap();

        let err = store.abort(&upload_id, "bucket", "key.bin").unwrap_err();
        assert!(matches!(err, S3Error::InvalidRequest(_)));
        // Upload still in map, still Completing.
        assert_eq!(
            store.uploads.read().get(&upload_id).unwrap().state,
            MultipartState::Completing
        );
    }

    /// C-P0-1 regression: `purge_uploads_for_bucket` must NOT remove
    /// uploads that are in `Completing` state. Doing so would tear down
    /// state that the in-flight `engine.store_*` handler still has
    /// borrowed paths/buffers for; the storage layer's `create_dir_all`
    /// would then race to resurrect a bucket the operator just deleted.
    ///
    /// Pre-fix: `purge_uploads_for_bucket` silently removed Completing
    /// uploads and returned a usize. Post-fix: it returns
    /// `Err(count_completing)` when any Completing upload targets the
    /// bucket; `delete_bucket` translates that to `BucketNotEmpty`.
    #[test]
    fn test_purge_for_bucket_refuses_when_completing() {
        let store = MultipartStore::new(100 * 1024 * 1024);

        // One Open upload in `bucket-a` — would be safe to purge alone.
        let _ = seed_upload(&store); // bucket="bucket", key="key.bin"

        // Second upload, drive it into Completing.
        let upload_b = store
            .create("bucket", "other.bin", None, HashMap::new())
            .unwrap();
        store
            .upload_part(
                &upload_b,
                "bucket",
                "other.bin",
                1,
                Bytes::from_static(b"x"),
            )
            .unwrap();
        let etag = {
            let u = store.uploads.read();
            let p = u.get(&upload_b).unwrap().parts.get(&1).unwrap();
            format!("\"{}\"", p.md5_hex)
        };
        store
            .complete(&upload_b, "bucket", "other.bin", &[(1, etag)])
            .unwrap();
        assert_eq!(
            store.uploads.read().get(&upload_b).unwrap().state,
            MultipartState::Completing,
            "second upload should be Completing"
        );

        // Purge must refuse, with the count of Completing uploads as
        // the error payload. Nothing must be removed (all-or-nothing).
        let result = store.purge_uploads_for_bucket("bucket");
        assert_eq!(result, Err(1), "must refuse with completing count");
        assert_eq!(
            store.uploads.read().len(),
            2,
            "must not have partially purged"
        );
    }

    /// Sister test: when ALL uploads for the bucket are `Open`, purge
    /// proceeds and returns the count purged. Sanity check that the new
    /// signature didn't break the happy path.
    #[test]
    fn test_purge_for_bucket_proceeds_when_all_open() {
        let store = MultipartStore::new(100 * 1024 * 1024);
        let _ = seed_upload(&store);
        let _ = store
            .create("bucket", "other.bin", None, HashMap::new())
            .unwrap();
        // Different bucket — must NOT be purged.
        let _ = store
            .create("other-bucket", "elsewhere.bin", None, HashMap::new())
            .unwrap();

        let result = store.purge_uploads_for_bucket("bucket");
        assert_eq!(result, Ok(2), "purges Open uploads in target bucket");
        assert_eq!(
            store.uploads.read().len(),
            1,
            "leaves the other-bucket upload alone"
        );
    }

    #[test]
    fn test_upload_part_refused_when_completing() {
        let store = MultipartStore::new(100 * 1024 * 1024);
        let upload_id = seed_upload(&store);
        let etag = {
            let u = store.uploads.read();
            let p = u.get(&upload_id).unwrap().parts.get(&1).unwrap();
            format!("\"{}\"", p.md5_hex)
        };
        store
            .complete(&upload_id, "bucket", "key.bin", &[(1, etag)])
            .unwrap();

        let err = store
            .upload_part(
                &upload_id,
                "bucket",
                "key.bin",
                2,
                Bytes::from(vec![0u8; 50]),
            )
            .unwrap_err();
        assert!(matches!(err, S3Error::InvalidRequest(_)));
    }

    #[test]
    fn test_rollback_upload_returns_to_open() {
        let store = MultipartStore::new(100 * 1024 * 1024);
        let upload_id = seed_upload(&store);
        let etag = {
            let u = store.uploads.read();
            let p = u.get(&upload_id).unwrap().parts.get(&1).unwrap();
            format!("\"{}\"", p.md5_hex)
        };
        store
            .complete(&upload_id, "bucket", "key.bin", &[(1, etag)])
            .unwrap();

        // Simulate engine.store* failure → rollback.
        store.rollback_upload(&upload_id);

        assert_eq!(
            store.uploads.read().get(&upload_id).unwrap().state,
            MultipartState::Open
        );

        // Client can now retry Complete or abort.
        store.abort(&upload_id, "bucket", "key.bin").unwrap();
    }

    #[test]
    fn test_finish_upload_removes_entry() {
        let store = MultipartStore::new(100 * 1024 * 1024);
        let upload_id = seed_upload(&store);
        let etag = {
            let u = store.uploads.read();
            let p = u.get(&upload_id).unwrap().parts.get(&1).unwrap();
            format!("\"{}\"", p.md5_hex)
        };
        store
            .complete(&upload_id, "bucket", "key.bin", &[(1, etag)])
            .unwrap();

        store.finish_upload(&upload_id);

        assert!(store.uploads.read().get(&upload_id).is_none());
    }

    #[test]
    fn test_double_complete_returns_conflict() {
        let store = MultipartStore::new(100 * 1024 * 1024);
        let upload_id = seed_upload(&store);
        let etag = {
            let u = store.uploads.read();
            let p = u.get(&upload_id).unwrap().parts.get(&1).unwrap();
            format!("\"{}\"", p.md5_hex)
        };

        store
            .complete(&upload_id, "bucket", "key.bin", &[(1, etag.clone())])
            .unwrap();
        let err = store
            .complete(&upload_id, "bucket", "key.bin", &[(1, etag)])
            .unwrap_err();
        assert!(
            matches!(err, S3Error::InvalidRequest(_)),
            "double-complete should return InvalidRequest while in Completing, got {:?}",
            err
        );
    }

    #[test]
    fn test_validation_failure_does_not_change_state() {
        // If complete() fails validation (wrong etag), state must stay Open
        // so the client can retry with correct metadata.
        let store = MultipartStore::new(100 * 1024 * 1024);
        let upload_id = seed_upload(&store);

        let err = store
            .complete(
                &upload_id,
                "bucket",
                "key.bin",
                &[(1, "\"wrong-etag\"".to_string())],
            )
            .unwrap_err();
        assert!(matches!(err, S3Error::InvalidPart(_)));
        assert_eq!(
            store.uploads.read().get(&upload_id).unwrap().state,
            MultipartState::Open,
            "validation failure must leave upload Open for retry"
        );
    }

    #[test]
    fn test_abort_while_open_drops_upload() {
        // Baseline: abort on an Open upload still works normally.
        let store = MultipartStore::new(100 * 1024 * 1024);
        let upload_id = seed_upload(&store);
        store.abort(&upload_id, "bucket", "key.bin").unwrap();
        assert!(store.uploads.read().get(&upload_id).is_none());
    }

    // === C3 DoS fix: size-cap + global-counter + TTL sweeper tests ===

    #[test]
    fn test_upload_part_rejects_when_cumulative_exceeds_max_object_size() {
        // max_object_size = 1 KiB. Upload 700 B + 200 B → OK, 300 B → rejected.
        let store = MultipartStore::new(1024);
        let upload_id = store.create("bucket", "key", None, HashMap::new()).unwrap();
        store
            .upload_part(&upload_id, "bucket", "key", 1, Bytes::from(vec![0u8; 700]))
            .unwrap();
        store
            .upload_part(&upload_id, "bucket", "key", 2, Bytes::from(vec![0u8; 200]))
            .unwrap();
        let err = store
            .upload_part(&upload_id, "bucket", "key", 3, Bytes::from(vec![0u8; 300]))
            .unwrap_err();
        assert!(
            matches!(err, S3Error::EntityTooLarge { size, max } if size == 1200 && max == 1024),
            "got {:?}",
            err
        );
    }

    #[test]
    fn test_upload_part_overwrite_adjusts_cumulative_correctly() {
        // Overwrite a 1000 B part with 200 B — cumulative goes DOWN, not up.
        let store = MultipartStore::new(1500);
        let upload_id = store.create("bucket", "key", None, HashMap::new()).unwrap();
        store
            .upload_part(&upload_id, "bucket", "key", 1, Bytes::from(vec![0u8; 1000]))
            .unwrap();
        // Add 400 more via a second part — total 1400, under cap.
        store
            .upload_part(&upload_id, "bucket", "key", 2, Bytes::from(vec![0u8; 400]))
            .unwrap();
        // Now overwrite part 1 with 200 B. New cumulative = 200 + 400 = 600.
        store
            .upload_part(&upload_id, "bucket", "key", 1, Bytes::from(vec![0u8; 200]))
            .unwrap();
        // Counter should reflect the overwrite.
        assert_eq!(store.in_flight_bytes(), 600);
    }

    #[test]
    fn test_upload_part_respects_global_byte_cap() {
        // Tight global cap: 2 KiB total across all uploads.
        let store = MultipartStore::new_for_test(10 * 1024, 2 * 1024, Duration::hours(24));
        let id_a = store.create("b", "a", None, HashMap::new()).unwrap();
        let id_b = store.create("b", "b", None, HashMap::new()).unwrap();

        // Fill upload A to 1 KiB.
        store
            .upload_part(&id_a, "b", "a", 1, Bytes::from(vec![0u8; 1024]))
            .unwrap();
        // Fill upload B to 1 KiB (total now 2 KiB = cap).
        store
            .upload_part(&id_b, "b", "b", 1, Bytes::from(vec![0u8; 1024]))
            .unwrap();
        // Next byte anywhere → SlowDown.
        let err = store
            .upload_part_classified(&id_a, "b", "a", 2, Bytes::from(vec![0u8; 1]))
            .unwrap_err();
        assert!(matches!(err.error, S3Error::SlowDown(_)), "got {:?}", err);
        assert!(err.unexecuted_capacity);
        assert_eq!(store.get_part_size(&id_a, 2), None);
        assert_eq!(store.in_flight_bytes(), 2048);
        store.abort(&id_b, "b", "b").unwrap();
        store
            .upload_part_classified(&id_a, "b", "a", 2, Bytes::from_static(b"x"))
            .unwrap();
        assert_eq!(store.get_part_size(&id_a, 2), Some(1));
    }

    #[test]
    fn unavailable_spool_refusal_can_retry_without_mutation() {
        let dir = test_spool_dir();
        let mut store = MultipartStore::new(1024)
            .with_large_spool(dir.path())
            .unwrap();
        let id = store.create("b", "key", None, HashMap::new()).unwrap();
        // Exercise the real statvfs refusal, with all upload prerequisites
        // valid, without consuming the host filesystem's free space.
        let root = store.spool.as_ref().unwrap().root.clone();
        store.spool.as_mut().unwrap().root = root.join("unavailable");
        let failure = store
            .upload_part_classified(&id, "b", "key", 1, Bytes::from_static(b"x"))
            .unwrap_err();
        assert!(failure.unexecuted_capacity);
        assert_eq!(store.in_flight_bytes(), 0);
        assert_eq!(store.uploads.read()[&id].state, MultipartState::Open);
        assert_eq!(store.get_part_size(&id, 1), None);
        store.spool.as_mut().unwrap().root = root;
        store
            .upload_part_classified(&id, "b", "key", 1, Bytes::from_static(b"x"))
            .unwrap();
        assert_eq!(store.get_part_size(&id, 1), Some(1));
        store.abort(&id, "b", "key").unwrap();
        assert_eq!(store.in_flight_bytes(), 0);
    }

    #[test]
    fn part_write_failure_is_not_an_unexecuted_capacity_refusal() {
        let dir = test_spool_dir();
        let store = MultipartStore::new(1024)
            .with_large_spool(dir.path())
            .unwrap();
        let id = store.create("b", "key", None, HashMap::new()).unwrap();
        let path = {
            let uploads = store.uploads.read();
            let RelayStrategy::Relayed { relay_dir } = &uploads[&id].relay_strategy else {
                panic!("fixture must use actual disk relay");
            };
            part_path(relay_dir, 1)
        };
        // An owned directory at the part-file path forces the real write to
        // fail after cleanup accounting begins, without filling the disk.
        fs::create_dir_all(&path).unwrap();
        let failure = store
            .upload_part_classified(&id, "b", "key", 1, Bytes::from_static(b"x"))
            .unwrap_err();
        assert!(!failure.unexecuted_capacity);
        assert_eq!(store.uploads.read()[&id].state, MultipartState::Cleaning);
        assert_eq!(store.get_part_size(&id, 1), None);
    }

    #[test]
    fn test_abort_releases_in_flight_bytes() {
        let store = MultipartStore::new_for_test(10 * 1024, 2 * 1024, Duration::hours(24));
        let id = store.create("b", "a", None, HashMap::new()).unwrap();
        store
            .upload_part(&id, "b", "a", 1, Bytes::from(vec![0u8; 1024]))
            .unwrap();
        assert_eq!(store.in_flight_bytes(), 1024);

        store.abort(&id, "b", "a").unwrap();
        assert_eq!(
            store.in_flight_bytes(),
            0,
            "abort must release bytes to the global counter"
        );
    }

    #[test]
    fn test_finish_upload_releases_in_flight_bytes() {
        let store = MultipartStore::new_for_test(10 * 1024, 10 * 1024, Duration::hours(24));
        let id = store.create("b", "k", None, HashMap::new()).unwrap();
        let data = Bytes::from(vec![0u8; 500]);
        let etag = store.upload_part(&id, "b", "k", 1, data).unwrap();
        assert_eq!(store.in_flight_bytes(), 500);

        store.complete(&id, "b", "k", &[(1, etag)]).unwrap();
        // Still in map (Completing) — counter unchanged.
        assert_eq!(store.in_flight_bytes(), 500);

        store.finish_upload(&id);
        assert_eq!(store.in_flight_bytes(), 0);
    }

    #[test]
    fn test_cleanup_expired_idle_ttl_sweeps_and_releases_bytes() {
        // Tiny idle TTL so we can trip it synchronously.
        let store = MultipartStore::new_for_test(10 * 1024, 10 * 1024, Duration::milliseconds(1));
        let id = store.create("b", "k", None, HashMap::new()).unwrap();
        store
            .upload_part(&id, "b", "k", 1, Bytes::from(vec![0u8; 700]))
            .unwrap();
        assert_eq!(store.in_flight_bytes(), 700);

        // Sleep past the idle TTL.
        std::thread::sleep(std::time::Duration::from_millis(5));
        let report = store.cleanup_expired(
            std::time::Duration::from_secs(3600),
            std::time::Duration::from_secs(3600),
        );
        assert_eq!(report.swept_open_uploads, 1);

        assert!(
            store.uploads.read().get(&id).is_none(),
            "idle upload should have been swept"
        );
        assert_eq!(
            store.in_flight_bytes(),
            0,
            "sweep must release bytes to the global counter"
        );
    }

    #[test]
    fn test_cleanup_expired_preserves_recent_completing_upload() {
        // Completing uploads should survive until completing_timeout elapses.
        let store = MultipartStore::new_for_test(10 * 1024, 10 * 1024, Duration::hours(24));
        let id = store.create("b", "k", None, HashMap::new()).unwrap();
        let etag = store
            .upload_part(&id, "b", "k", 1, Bytes::from(vec![0u8; 100]))
            .unwrap();
        store.complete(&id, "b", "k", &[(1, etag)]).unwrap();

        let report = store.cleanup_expired(
            std::time::Duration::from_secs(3600),
            std::time::Duration::from_secs(3600),
        );
        assert_eq!(report.swept_completing_uploads, 0);

        assert!(
            store.uploads.read().get(&id).is_some(),
            "recent Completing uploads must be preserved"
        );
    }

    #[test]
    fn test_cleanup_expired_retains_timed_out_completion_reservations() {
        let store = MultipartStore::new_for_test(10 * 1024, 10 * 1024, Duration::hours(24));
        let id = store.create("b", "k", None, HashMap::new()).unwrap();
        let etag = store
            .upload_part(&id, "b", "k", 1, Bytes::from(vec![0u8; 100]))
            .unwrap();
        store.complete(&id, "b", "k", &[(1, etag)]).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));

        let report = store.cleanup_expired(
            std::time::Duration::from_secs(3600),
            std::time::Duration::from_millis(1),
        );
        assert_eq!(report.swept_completing_uploads, 0);
        assert_eq!(store.in_flight_bytes(), 100);
        assert!(store.uploads.read().get(&id).is_some());
        store.finish_upload(&id);
        assert_eq!(store.in_flight_bytes(), 0);
    }

    #[test]
    fn test_cleanup_orphan_relay_entries_removes_untracked_entries() {
        let dir = tempfile::tempdir().unwrap();
        let active_dir = dir.path().join("active");
        let orphan_dir = dir.path().join("orphan");
        let orphan_file = dir.path().join("stray.tmp");
        fs::create_dir_all(&active_dir).unwrap();
        fs::create_dir_all(&orphan_dir).unwrap();
        fs::write(orphan_dir.join("part-00001.bin"), b"orphan").unwrap();
        fs::write(&orphan_file, b"stray").unwrap();

        let mut active = HashSet::new();
        active.insert(active_dir.clone());
        let (dirs_removed, files_removed) = cleanup_orphan_relay_entries_at(dir.path(), &active);

        assert_eq!(dirs_removed, 1);
        assert_eq!(files_removed, 1);
        assert!(active_dir.exists(), "active relay dir must be preserved");
        assert!(!orphan_dir.exists(), "orphan relay dir must be removed");
        assert!(!orphan_file.exists(), "orphan relay file must be removed");
    }

    #[test]
    fn test_relay_promotion_on_threshold_cross() {
        let store = MultipartStore::new(10 * 1024);
        let id = store
            .create_with_relay_policy("b", "k", None, HashMap::new(), Some(512), false)
            .unwrap();

        store
            .upload_part(&id, "b", "k", 1, Bytes::from(vec![0u8; 256]))
            .unwrap();
        {
            let uploads = store.uploads.read();
            let upload = uploads.get(&id).unwrap();
            assert!(matches!(
                upload.relay_strategy,
                RelayStrategy::InMemory { .. }
            ));
        }

        store
            .upload_part(&id, "b", "k", 2, Bytes::from(vec![1u8; 300]))
            .unwrap();
        let uploads = store.uploads.read();
        let upload = uploads.get(&id).unwrap();
        assert!(matches!(
            upload.relay_strategy,
            RelayStrategy::Relayed { .. }
        ));
        let part1 = upload.parts.get(&1).unwrap();
        let part2 = upload.parts.get(&2).unwrap();
        assert!(matches!(part1.payload, PartPayload::RelayedFile(_)));
        assert!(matches!(part2.payload, PartPayload::RelayedFile(_)));
    }

    #[test]
    fn test_complete_passthrough_returns_relayed_file_payload() {
        let store = MultipartStore::new(10 * 1024);
        let id = store
            .create_with_relay_policy("b", "k", None, HashMap::new(), None, true)
            .unwrap();
        let e1 = store
            .upload_part(&id, "b", "k", 1, Bytes::from_static(b"hello"))
            .unwrap();
        let e2 = store
            .upload_part(&id, "b", "k", 2, Bytes::from_static(b"world"))
            .unwrap();

        let completed = store
            .complete_passthrough(&id, "b", "k", &[(1, e1), (2, e2)])
            .unwrap();
        assert_eq!(completed.total_size, 10);
        match completed.payload {
            PassthroughPayload::RelayedParts(paths) => {
                assert_eq!(paths.len(), 2);
                let mut data = Vec::new();
                for path in paths {
                    data.extend_from_slice(&std::fs::read(path).unwrap());
                }
                assert_eq!(data, b"helloworld");
            }
            PassthroughPayload::Chunks(_) => {
                panic!("expected relayed part payload for always-relay upload")
            }
        }
    }
}
