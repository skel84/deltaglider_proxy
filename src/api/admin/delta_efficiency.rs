//! Delta efficiency diagnostics: scan deltaspaces and report bad
//! reference choices.
//!
//! Motivated by the v0.9.17 prod incident where
//! `s3://beshu/ror/builds/1.70.0-pre5/` had 22 GB of deltas that delta-
//! encoded at **0.01 % savings** because the first uploaded file in the
//! prefix happened to be a Kibana ZIP (`compression=store`), and every
//! subsequent ES plugin (`compression=deflate`) was deltaed against it
//! for ≈ 99.99 % size of original. Re-uploading via the proxy with a
//! sensible seed brought it from 22 GB → 569 MB (−97.4 %).
//!
//! This module surfaces such cases proactively: on demand it walks
//! the deltaspaces in a bucket, computes per-prefix size statistics,
//! and classifies each prefix into a coarse health bucket.
//!
//! ## Concurrency model
//!
//! Mirrors [`crate::usage_scanner::UsageScanner`] — same
//! background-task + cache + dedup shape so an operator clicking
//! "Scan" doesn't accidentally fan out a dozen parallel scans on a
//! flaky page-reload, and so a fresh page-load on a previously
//! scanned bucket gets an instant answer from cache.
//!
//! - [`DeltaEfficiencyScanner::get`]: read cached result for a
//!   `(bucket, min_deltas)` pair if present and not stale.
//! - [`DeltaEfficiencyScanner::is_scanning`]: tell the UI whether to
//!   poll vs. show empty-state.
//! - [`DeltaEfficiencyScanner::enqueue_scan`]: spawn a background
//!   scan if not already running. RAII-cleaned dedup key (panic-safe,
//!   same fix as `usage_scanner::ScanInProgressGuard`).
//!
//! ## Pure-function core
//!
//! [`classify_deltaspace`] takes only `(reference_size, &[delta_size])`
//! and returns an [`Efficiency`] verdict. No I/O, fully unit-testable
//! against a truth table of real prod scenarios.

use axum::{extract::State, http::StatusCode, response::IntoResponse, Json};
use chrono::{DateTime, Utc};
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tracing::{debug, warn};

use super::AdminState;
use crate::api::handlers::AppState;
use crate::types::StorageInfo;

/// Cache TTL — five minutes mirrors `UsageScanner` so an operator
/// reloading the diagnostics tab doesn't kick off duplicate work.
const CACHE_TTL_SECS: i64 = 300;

// ─── Pure-function core ──────────────────────────────────────────────

/// Coarse health classification for a single deltaspace.
///
/// Thresholds chosen empirically from the prod audit:
///
/// * **Excellent**: median delta ≤ 200 KB AND ≤ 5 % of reference. The
///   reference is well-chosen and most siblings are close-cousins.
/// * **Good**: median ≤ 1 MB OR ≤ 20 % of reference. Healthy: deltas
///   are clearly compressing the file.
/// * **Fair**: median ≤ 50 % of reference. Common when a single
///   deltaspace mixes multiple variants (e.g. ES 6/7/8/9 plugins);
///   structurally bounded by inherent file dissimilarity.
/// * **Poor**: median > 50 % of reference. Strongly suggests a wrong
///   reference baseline — the prefix should be re-uploaded with a
///   better seed (or split into smaller deltaspaces).
/// * **NoReference**: there are deltas but no `reference.bin`.
///   Anomalous; check storage backend.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Efficiency {
    Excellent,
    Good,
    Fair,
    Poor,
    NoReference,
}

impl Efficiency {
    /// Operator-actionable message for this verdict.
    pub fn explanation(self) -> &'static str {
        match self {
            Efficiency::Excellent => {
                "Reference is well-chosen; deltas compress to a small fraction of the original."
            }
            Efficiency::Good => {
                "Healthy delta encoding; the reference reasonably represents the prefix."
            }
            Efficiency::Fair => {
                "Acceptable but not great — the prefix likely mixes dissimilar files. \
                 Consider splitting into sub-prefixes by file family if storage matters."
            }
            Efficiency::Poor => {
                "Likely wrong reference: deltas are nearly the size of the originals. \
                 Re-upload the prefix so a better seed is chosen, or split into sub-prefixes."
            }
            Efficiency::NoReference => {
                "Deltas exist but no reference.bin was found in this prefix. \
                 GETs on these objects will fail — investigate immediately."
            }
        }
    }
}

/// Pure classifier: given a reference size and a list of delta sizes
/// (any units, but they must be the same), decide the verdict.
///
/// `min_deltas` lets the caller skip prefixes too small to draw a
/// signal from (e.g. 1-delta prefix is just whatever the second
/// upload happened to be).
pub fn classify_deltaspace(
    reference_size: Option<u64>,
    delta_sizes: &[u64],
    min_deltas: usize,
) -> Option<Efficiency> {
    if delta_sizes.len() < min_deltas {
        return None;
    }
    let Some(ref_size) = reference_size else {
        if delta_sizes.is_empty() {
            return None;
        }
        return Some(Efficiency::NoReference);
    };
    if ref_size == 0 {
        return Some(Efficiency::NoReference);
    }

    let median = median_u64(delta_sizes);
    // Ratio: median delta as a fraction of the reference. ≥1 means
    // the delta is at least as big as the reference (the prefix is
    // basically uncompressible against this baseline).
    let ratio = median as f64 / ref_size as f64;

    // Poor: median delta ≥ 50 % of reference. The reference is wrong.
    if ratio >= 0.50 {
        return Some(Efficiency::Poor);
    }
    // Fair: 20–50 %. Multi-variant deltaspace — structural floor.
    if ratio >= 0.20 {
        return Some(Efficiency::Fair);
    }
    // Excellent: tiny absolute median AND tiny ratio.
    if median <= 200 * 1024 && ratio <= 0.05 {
        return Some(Efficiency::Excellent);
    }
    // Good: anything else under 20 %.
    Some(Efficiency::Good)
}

fn median_u64(values: &[u64]) -> u64 {
    if values.is_empty() {
        return 0;
    }
    let mut sorted: Vec<u64> = values.to_vec();
    sorted.sort_unstable();
    sorted[sorted.len() / 2]
}

// ─── I/O layer: types ─────────────────────────────────────────────────

/// Per-prefix efficiency report row, returned over the admin API.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeltaspaceReport {
    pub bucket: String,
    pub prefix: String,
    pub deltas: usize,
    pub passthrough: usize,
    pub reference_bytes: Option<u64>,
    pub total_delta_bytes: u64,
    pub total_original_bytes: u64,
    pub median_delta_bytes: u64,
    pub max_delta_bytes: u64,
    pub savings_bytes: i64, // total_original - (reference + total_delta)
    pub efficiency: Efficiency,
    /// Operator-facing explanation derived from `efficiency`.
    /// Inlined here so the frontend doesn't need to duplicate the
    /// classification text.
    pub explanation: String,
}

/// Top-level response. Sorted with worst-efficiency first by default.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EfficiencyResponse {
    pub bucket: String,
    pub scanned_deltaspaces: usize,
    pub reported_deltaspaces: usize,
    pub min_deltas: usize,
    pub reports: Vec<DeltaspaceReport>,
    /// When this scan was completed. The frontend uses this to render
    /// "scanned 2m ago" so the operator knows whether the data is fresh.
    pub computed_at: DateTime<Utc>,
    /// True when this response was served from cache rather than freshly
    /// computed. Lets the UI render a "cached — re-scan?" affordance.
    #[serde(default)]
    pub cached: bool,
}

// ─── Background scanner with cache + dedup ──────────────────────────

/// Background scanner. Same `Arc<RwLock<...>>` shape as
/// [`UsageScanner`](crate::usage_scanner::UsageScanner) — one cache
/// (`bucket|min_deltas` → `EfficiencyResponse`), one dedup set.
pub struct DeltaEfficiencyScanner {
    cache: Arc<RwLock<HashMap<String, EfficiencyResponse>>>,
    scanning: Arc<RwLock<HashSet<String>>>,
}

impl Default for DeltaEfficiencyScanner {
    fn default() -> Self {
        Self::new()
    }
}

/// RAII guard mirroring `UsageScanner::ScanInProgressGuard` — clears
/// the dedup entry on drop, including drop-on-panic. Without this, a
/// panic in the scan future would leave the bucket permanently marked
/// "in progress" until process restart (E-P1-2 class of bug).
struct ScanInProgressGuard {
    scanner: Arc<DeltaEfficiencyScanner>,
    key: String,
}

impl Drop for ScanInProgressGuard {
    fn drop(&mut self) {
        self.scanner.scanning.write().remove(&self.key);
    }
}

impl DeltaEfficiencyScanner {
    pub fn new() -> Self {
        Self {
            cache: Arc::new(RwLock::new(HashMap::new())),
            scanning: Arc::new(RwLock::new(HashSet::new())),
        }
    }

    fn cache_key(bucket: &str, min_deltas: usize) -> String {
        format!("{bucket}|{min_deltas}")
    }

    /// Read the cached entry for this `(bucket, min_deltas)` pair if
    /// present AND younger than [`CACHE_TTL_SECS`]. Stale entries are
    /// ignored on read; they get overwritten by the next scan.
    pub fn get(&self, bucket: &str, min_deltas: usize) -> Option<EfficiencyResponse> {
        let key = Self::cache_key(bucket, min_deltas);
        let cache = self.cache.read();
        let entry = cache.get(&key)?.clone();
        let age = Utc::now()
            .signed_duration_since(entry.computed_at)
            .num_seconds();
        if age > CACHE_TTL_SECS {
            return None;
        }
        Some(EfficiencyResponse {
            cached: true,
            ..entry
        })
    }

    pub fn is_scanning(&self, bucket: &str, min_deltas: usize) -> bool {
        let key = Self::cache_key(bucket, min_deltas);
        self.scanning.read().contains(&key)
    }

    /// Spawn a background scan if not already running. Returns true
    /// if a new scan was started, false if one was already in flight
    /// (or cache is fresh).
    pub fn enqueue_scan(
        self: &Arc<Self>,
        bucket: String,
        min_deltas: usize,
        s3_state: Arc<AppState>,
    ) -> bool {
        let key = Self::cache_key(&bucket, min_deltas);

        // Dedup: skip if already scanning this (bucket, min_deltas).
        {
            let mut scanning = self.scanning.write();
            if !scanning.insert(key.clone()) {
                debug!(
                    bucket = %bucket,
                    min_deltas,
                    "Delta-efficiency scan already in progress, skipping"
                );
                return false;
            }
        }

        let scanner = Arc::clone(self);
        tokio::spawn(async move {
            debug!(bucket = %bucket, min_deltas, "Starting delta-efficiency scan");

            let _scan_guard = ScanInProgressGuard {
                scanner: scanner.clone(),
                key: key.clone(),
            };

            match Self::do_scan(&s3_state, &bucket, min_deltas).await {
                Ok(entry) => {
                    debug!(
                        bucket = %bucket,
                        scanned = entry.scanned_deltaspaces,
                        reported = entry.reported_deltaspaces,
                        "Delta-efficiency scan complete"
                    );
                    scanner.cache.write().insert(key.clone(), entry);
                }
                Err(e) => {
                    warn!(
                        bucket = %bucket,
                        min_deltas,
                        error = %e,
                        "Delta-efficiency scan failed"
                    );
                }
            }
            // _scan_guard drops here, removing the dedup key.
        });

        true
    }

    /// Walk every deltaspace in `bucket` and build the efficiency
    /// response. Cost: one `list_deltaspaces` call + one
    /// `scan_deltaspace` per prefix. For O(100) prefixes × O(100)
    /// objects this is in seconds — hence the cache.
    async fn do_scan(
        s3_state: &AppState,
        bucket: &str,
        min_deltas: usize,
    ) -> Result<EfficiencyResponse, String> {
        let engine = s3_state.engine.load();
        let storage = engine.storage();
        let prefixes = storage
            .list_deltaspaces(bucket)
            .await
            .map_err(|e| format!("list_deltaspaces failed: {e}"))?;

        let mut reports: Vec<DeltaspaceReport> = Vec::new();
        let scanned = prefixes.len();

        for prefix in prefixes {
            let scan = match storage.scan_deltaspace(bucket, &prefix).await {
                Ok(v) => v,
                Err(e) => {
                    warn!(
                        "delta-efficiency: scan_deltaspace failed for {}/{}: {}",
                        bucket, prefix, e
                    );
                    continue;
                }
            };
            // Partition into reference / deltas / passthroughs.
            let mut reference_bytes: Option<u64> = None;
            let mut delta_sizes: Vec<u64> = Vec::new();
            let mut passthrough_count: usize = 0;
            let mut total_original: u64 = 0;
            for m in &scan {
                match &m.storage_info {
                    StorageInfo::Reference { .. } => {
                        reference_bytes = Some(m.file_size);
                    }
                    StorageInfo::Delta { delta_size, .. } => {
                        delta_sizes.push(*delta_size);
                        total_original = total_original.saturating_add(m.file_size);
                    }
                    StorageInfo::Passthrough => {
                        passthrough_count += 1;
                        total_original = total_original.saturating_add(m.file_size);
                    }
                }
            }

            let Some(efficiency) = classify_deltaspace(reference_bytes, &delta_sizes, min_deltas)
            else {
                continue;
            };

            let total_delta: u64 = delta_sizes.iter().sum();
            let median = median_u64(&delta_sizes);
            let max_delta = delta_sizes.iter().copied().max().unwrap_or(0);
            let stored_bytes = reference_bytes.unwrap_or(0).saturating_add(total_delta);
            let savings = total_original as i64 - stored_bytes as i64;

            reports.push(DeltaspaceReport {
                bucket: bucket.to_string(),
                prefix,
                deltas: delta_sizes.len(),
                passthrough: passthrough_count,
                reference_bytes,
                total_delta_bytes: total_delta,
                total_original_bytes: total_original,
                median_delta_bytes: median,
                max_delta_bytes: max_delta,
                savings_bytes: savings,
                efficiency,
                explanation: efficiency.explanation().to_string(),
            });
        }

        // Sort: worst first (Poor before Fair before Good), tiebreaker
        // by total_delta_bytes desc so the biggest waste rises.
        reports.sort_by(|a, b| {
            let order = |e: Efficiency| match e {
                Efficiency::NoReference => 0,
                Efficiency::Poor => 1,
                Efficiency::Fair => 2,
                Efficiency::Good => 3,
                Efficiency::Excellent => 4,
            };
            order(a.efficiency)
                .cmp(&order(b.efficiency))
                .then_with(|| b.total_delta_bytes.cmp(&a.total_delta_bytes))
        });

        let reported = reports.len();
        Ok(EfficiencyResponse {
            bucket: bucket.to_string(),
            scanned_deltaspaces: scanned,
            reported_deltaspaces: reported,
            min_deltas,
            reports,
            computed_at: Utc::now(),
            cached: false,
        })
    }
}

// ─── Admin API handlers ─────────────────────────────────────────────

#[derive(Deserialize)]
pub struct EfficiencyQuery {
    /// Bucket to scan. Required to bound work per request.
    pub bucket: String,
    /// Skip prefixes with fewer than this many deltas. Default 3.
    #[serde(default)]
    pub min_deltas: Option<usize>,
}

/// `GET /_/api/admin/diagnostics/delta-efficiency?bucket=X&min_deltas=N`
///
/// Returns:
/// * `200 OK` with the full response when a fresh cached result
///   (or one we just computed inline) is available.
/// * `202 Accepted` with `{ scanning: true }` when no fresh cache
///   exists and a background scan is now running. The frontend
///   should poll the same endpoint until it gets a 200.
pub async fn get_delta_efficiency(
    State(state): State<Arc<AdminState>>,
    axum::extract::Query(q): axum::extract::Query<EfficiencyQuery>,
) -> impl IntoResponse {
    let min_deltas = q.min_deltas.unwrap_or(3).max(1);

    // Cache hit → return immediately.
    if let Some(cached) = state.delta_efficiency_scanner.get(&q.bucket, min_deltas) {
        return (StatusCode::OK, Json(cached)).into_response();
    }

    // No fresh cache → enqueue a background scan and tell the caller
    // to poll. Same affordance as `UsageScanner::enqueue_scan` →
    // `get_usage`'s 404+`scanning: true` shape, but we use 202 here
    // because "the work has been accepted" is the more accurate
    // semantic than "not found".
    let started = state.delta_efficiency_scanner.enqueue_scan(
        q.bucket.clone(),
        min_deltas,
        state.s3_state.clone(),
    );
    let scanning = started
        || state
            .delta_efficiency_scanner
            .is_scanning(&q.bucket, min_deltas);

    (
        StatusCode::ACCEPTED,
        Json(serde_json::json!({
            "bucket": q.bucket,
            "min_deltas": min_deltas,
            "scanning": scanning,
            "status": if started { "scan_started" } else { "scan_already_running" },
        })),
    )
        .into_response()
}

#[derive(Deserialize)]
pub struct EfficiencyScanRequest {
    pub bucket: String,
    #[serde(default)]
    pub min_deltas: Option<usize>,
}

/// `POST /_/api/admin/diagnostics/delta-efficiency/scan` — operator
/// "Re-scan" affordance. Force-enqueues a background scan, ignoring
/// the cache (the cache will be overwritten on completion). Always
/// returns 202.
pub async fn post_delta_efficiency_scan(
    State(state): State<Arc<AdminState>>,
    Json(req): Json<EfficiencyScanRequest>,
) -> impl IntoResponse {
    let min_deltas = req.min_deltas.unwrap_or(3).max(1);
    let started = state.delta_efficiency_scanner.enqueue_scan(
        req.bucket.clone(),
        min_deltas,
        state.s3_state.clone(),
    );
    (
        StatusCode::ACCEPTED,
        Json(serde_json::json!({
            "bucket": req.bucket,
            "min_deltas": min_deltas,
            "status": if started { "scan_started" } else { "scan_already_running" },
        })),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── classify_deltaspace truth table ─────────────────────────────

    #[test]
    fn empty_below_min_returns_none() {
        assert_eq!(classify_deltaspace(Some(1_000_000), &[], 3), None);
        assert_eq!(classify_deltaspace(Some(1_000_000), &[100, 200], 3), None);
    }

    #[test]
    fn no_reference_when_no_ref_but_deltas_exist() {
        assert_eq!(
            classify_deltaspace(None, &[100, 200, 300], 3),
            Some(Efficiency::NoReference)
        );
    }

    #[test]
    fn no_reference_when_zero_size() {
        assert_eq!(
            classify_deltaspace(Some(0), &[100, 200, 300], 3),
            Some(Efficiency::NoReference)
        );
    }

    /// Median delta ≥ 50 % of reference → Poor.
    /// Real prod scenario: pre5 had Kibana zip ref (61 MB) and ES
    /// plugin deltas at 91 MB → ratio > 1.0.
    #[test]
    fn median_at_or_above_half_is_poor() {
        // 91 MB delta, 61 MB ref ⇒ ratio ≈ 1.49 — Poor
        assert_eq!(
            classify_deltaspace(Some(61 * 1024 * 1024), &[91 * 1024 * 1024; 5], 3),
            Some(Efficiency::Poor),
        );
        // Edge: exactly 50 %
        assert_eq!(
            classify_deltaspace(Some(1_000_000), &[500_000; 5], 3),
            Some(Efficiency::Poor),
        );
    }

    /// 20 % ≤ median < 50 % → Fair (typical multi-variant prefix).
    #[test]
    fn median_between_20_and_50_pct_is_fair() {
        // 30 % of reference
        assert_eq!(
            classify_deltaspace(Some(1_000_000), &[300_000; 5], 3),
            Some(Efficiency::Fair),
        );
        // Edge: exactly 20 %
        assert_eq!(
            classify_deltaspace(Some(1_000_000), &[200_000; 5], 3),
            Some(Efficiency::Fair),
        );
    }

    /// < 20 % AND median ≤ 200 KB AND ≤ 5 % → Excellent.
    /// Real prod scenario: ror/builds/.../free with median 70 KB
    /// against 19.5 MB ref → 0.36 % ratio.
    #[test]
    fn small_absolute_and_small_ratio_is_excellent() {
        // 70 KB median against 19.5 MB ref ⇒ ~0.35 % — Excellent
        assert_eq!(
            classify_deltaspace(Some(19_500_000), &[70_000; 49], 3),
            Some(Efficiency::Excellent),
        );
        // Edge: exactly 200 KB / 5 % boundary
        assert_eq!(
            classify_deltaspace(Some(4_000_000), &[200_000; 5], 3),
            Some(Efficiency::Excellent),
        );
    }

    /// ≥ 200 KB median (even at low ratio) is Good, not Excellent.
    /// Real prod scenario: pre6/universal had median 270 KB against
    /// 61 MB ref → 0.4 % ratio — small, but absolute size makes it Good.
    #[test]
    fn large_absolute_but_small_ratio_is_good() {
        // 270 KB median, 61 MB ref ⇒ ratio 0.44 % but absolute > 200 KB
        assert_eq!(
            classify_deltaspace(Some(61 * 1024 * 1024), &[270 * 1024; 188], 3),
            Some(Efficiency::Good),
        );
    }

    /// Real prod scenario: ror/builds/1.70.0-pre5 (after the fix)
    /// 2.1 MB median against 91 MB ref ⇒ ratio ≈ 2.4 % — Good
    /// (cross-major delta; the 2 MB floor is structural).
    #[test]
    fn cross_major_delta_is_good() {
        assert_eq!(
            classify_deltaspace(Some(91 * 1024 * 1024), &[2_182_000; 242], 3),
            Some(Efficiency::Good),
        );
    }

    // ── median_u64 sanity ──────────────────────────────────────────

    #[test]
    fn median_picks_middle_element() {
        assert_eq!(median_u64(&[1, 2, 3]), 2);
        assert_eq!(median_u64(&[3, 1, 2]), 2);
        assert_eq!(median_u64(&[5]), 5);
        assert_eq!(median_u64(&[]), 0);
    }

    // ── Efficiency::explanation ────────────────────────────────────

    #[test]
    fn explanation_is_non_empty_for_every_variant() {
        for e in [
            Efficiency::Excellent,
            Efficiency::Good,
            Efficiency::Fair,
            Efficiency::Poor,
            Efficiency::NoReference,
        ] {
            assert!(!e.explanation().is_empty());
        }
    }

    /// The serde rename should produce stable lowercase JSON that
    /// the frontend type alias `DeltaEfficiency` depends on.
    #[test]
    fn efficiency_serializes_to_lowercase_string() {
        for (variant, expected) in [
            (Efficiency::Excellent, "\"excellent\""),
            (Efficiency::Good, "\"good\""),
            (Efficiency::Fair, "\"fair\""),
            (Efficiency::Poor, "\"poor\""),
            (Efficiency::NoReference, "\"no_reference\""),
        ] {
            let s = serde_json::to_string(&variant).unwrap();
            assert_eq!(s, expected, "JSON for {:?}", variant);
        }
    }

    // ── Cache + dedup behaviour ────────────────────────────────────

    /// Fresh cache entry is returned with `cached: true`.
    #[test]
    fn get_returns_cached_with_flag_set() {
        let scanner = DeltaEfficiencyScanner::new();
        let key = DeltaEfficiencyScanner::cache_key("bucket", 3);
        scanner.cache.write().insert(
            key,
            EfficiencyResponse {
                bucket: "bucket".into(),
                scanned_deltaspaces: 0,
                reported_deltaspaces: 0,
                min_deltas: 3,
                reports: vec![],
                computed_at: Utc::now(),
                cached: false, // stored as false
            },
        );
        let got = scanner.get("bucket", 3).expect("present");
        assert!(got.cached, "get() must mark response as cached");
    }

    /// Stale cache entries are ignored on read.
    #[test]
    fn get_returns_none_when_entry_is_stale() {
        let scanner = DeltaEfficiencyScanner::new();
        let key = DeltaEfficiencyScanner::cache_key("bucket", 3);
        scanner.cache.write().insert(
            key,
            EfficiencyResponse {
                bucket: "bucket".into(),
                scanned_deltaspaces: 0,
                reported_deltaspaces: 0,
                min_deltas: 3,
                reports: vec![],
                computed_at: Utc::now() - chrono::Duration::seconds(CACHE_TTL_SECS + 1),
                cached: false,
            },
        );
        assert!(
            scanner.get("bucket", 3).is_none(),
            "stale cache entry must be ignored"
        );
    }

    /// `is_scanning` reflects the dedup set.
    #[test]
    fn is_scanning_tracks_dedup() {
        let scanner = DeltaEfficiencyScanner::new();
        assert!(!scanner.is_scanning("bucket", 3));
        let key = DeltaEfficiencyScanner::cache_key("bucket", 3);
        scanner.scanning.write().insert(key);
        assert!(scanner.is_scanning("bucket", 3));
        // Different (bucket, min_deltas) combos are independent.
        assert!(!scanner.is_scanning("bucket", 5));
        assert!(!scanner.is_scanning("other", 3));
    }

    /// RAII guard removes its key on drop.
    #[test]
    fn scan_guard_clears_dedup_on_drop() {
        let scanner = Arc::new(DeltaEfficiencyScanner::new());
        let key = DeltaEfficiencyScanner::cache_key("bucket", 3);
        scanner.scanning.write().insert(key.clone());
        assert!(scanner.is_scanning("bucket", 3));
        {
            let _g = ScanInProgressGuard {
                scanner: scanner.clone(),
                key: key.clone(),
            };
            // Still in set during guard's lifetime.
            assert!(scanner.is_scanning("bucket", 3));
        }
        // Cleared on drop.
        assert!(!scanner.is_scanning("bucket", 3));
    }
}
