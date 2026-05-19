// SPDX-License-Identifier: GPL-3.0-only

//! `GET /_/api/admin/deltaspace/savings?bucket=X&prefix=Y`
//!
//! Per-prefix savings totals for the SPA's "compression chip" + any
//! future visualisation that wants honest reference-aware numbers
//! without forcing the user to trigger a full bucket scan.
//!
//! Why a dedicated endpoint vs. computing client-side: the SPA can't
//! see `reference.bin` files (the engine hides them from list_objects
//! by design), so any client-side aggregator undercounts stored bytes
//! by one reference per deltaspace. Centralising the math here closes
//! that gap once for every consumer.
//!
//! Cost model: walks `engine.list_objects(prefix)` paginated for the
//! user-visible side, then `engine.list_deltaspace_references(prefix)`
//! for the on-disk reference cost. Result is cached for 30 s per
//! (bucket, prefix) so a casual click-through of a tree doesn't fire a
//! full scan on every navigation. On large prefixes (>100 k objects)
//! the response carries `truncated: true` and the totals are a lower
//! bound — the operator-facing path for that is the bucket-wide scan
//! in `bucket_scan.rs`.

use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use chrono::{DateTime, Utc};
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};

use crate::api::handlers::AppState;
use crate::deltaglider::SavingsTotals;

/// Max objects we'll walk before bailing with `truncated: true`. The
/// per-bucket scan in `bucket_scan.rs` is the path for huge prefixes.
const MAX_LISTING_OBJECTS: usize = 100_000;

/// In-memory cache TTL for savings responses. Tight enough that
/// freshly-uploaded data shows up quickly, loose enough that browsing
/// a tree doesn't fire scans every click.
const CACHE_TTL: Duration = Duration::from_secs(30);

/// Page size for the user-visible LIST walk. Larger than the dashboard
/// scan because we expect smaller scopes (prefix not whole bucket).
const PAGE_SIZE: u32 = 1000;

#[derive(Deserialize)]
pub struct SavingsQuery {
    pub bucket: String,
    /// Default empty = whole bucket (same shape as the bucket scan).
    #[serde(default)]
    pub prefix: String,
}

#[derive(Serialize, Clone)]
pub struct SavingsResponse {
    pub bucket: String,
    pub prefix: String,
    pub totals: SavingsTotals,
    /// Computed savings percentage 0..=99.99, or null when there's
    /// nothing under the prefix yet (avoids the UI showing "0%" for an
    /// empty browse).
    pub savings_percentage: Option<f64>,
    /// True when the walk hit `MAX_LISTING_OBJECTS`; numbers are a
    /// lower bound. The chip should show a `~` and the tooltip should
    /// say "scope truncated".
    pub truncated: bool,
    /// UTC timestamp when this scan finished. The SPA renders a
    /// "Recomputed Xs ago" hint from it.
    pub computed_at: DateTime<Utc>,
}

/// Boxed cache entry. We key by `(bucket, prefix)`; with 30-second TTL
/// plus a 1024-entry cap eviction is trivial (drop the oldest on insert
/// when full).
struct CacheEntry {
    response: SavingsResponse,
    inserted: Instant,
}

/// In-memory cache. The proxy only has one instance running per node,
/// so a per-process Mutex is plenty (no need for a distributed cache —
/// the underlying scans are cheap enough to redo on the rare cache
/// miss across nodes).
pub struct SavingsCache {
    inner: RwLock<std::collections::HashMap<String, CacheEntry>>,
}

impl SavingsCache {
    pub fn new() -> Self {
        Self {
            inner: RwLock::new(std::collections::HashMap::with_capacity(64)),
        }
    }

    fn cache_key(bucket: &str, prefix: &str) -> String {
        format!("{}\x00{}", bucket, prefix)
    }

    fn get(&self, bucket: &str, prefix: &str) -> Option<SavingsResponse> {
        let key = Self::cache_key(bucket, prefix);
        let guard = self.inner.read();
        let entry = guard.get(&key)?;
        if entry.inserted.elapsed() > CACHE_TTL {
            return None;
        }
        Some(entry.response.clone())
    }

    fn put(&self, response: SavingsResponse) {
        let key = Self::cache_key(&response.bucket, &response.prefix);
        let mut guard = self.inner.write();
        // 1024-entry cap; coarse "drop one" eviction is fine for our
        // workload — the cache is per-process and the entries are
        // small (a SavingsResponse is ~120 bytes).
        if guard.len() >= 1024 && !guard.contains_key(&key) {
            if let Some(first) = guard.keys().next().cloned() {
                guard.remove(&first);
            }
        }
        guard.insert(
            key,
            CacheEntry {
                response,
                inserted: Instant::now(),
            },
        );
    }
}

impl Default for SavingsCache {
    fn default() -> Self {
        Self::new()
    }
}

/// `GET /_/api/admin/deltaspace/savings?bucket=X&prefix=Y`
pub async fn get_savings(
    State(state): State<Arc<crate::api::admin::AdminState>>,
    Query(q): Query<SavingsQuery>,
) -> impl IntoResponse {
    // Defensive: empty bucket is meaningless — clients shouldn't ask
    // and the listing path would explode if they did.
    if q.bucket.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "bucket required"})),
        )
            .into_response();
    }

    if let Some(cached) = state.savings_cache.get(&q.bucket, &q.prefix) {
        return (StatusCode::OK, Json(cached)).into_response();
    }

    let response = match compute_savings(&state.s3_state, &q.bucket, &q.prefix).await {
        Ok(r) => r,
        Err(msg) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": msg})),
            )
                .into_response();
        }
    };
    state.savings_cache.put(response.clone());
    (StatusCode::OK, Json(response)).into_response()
}

/// The pure-ish compute path: pages through user-visible objects,
/// then folds in `reference.bin` bytes via the engine helper. The
/// math itself lives in `SavingsTotals` so other call sites stay in
/// lockstep with this one.
async fn compute_savings(
    s3_state: &Arc<AppState>,
    bucket: &str,
    prefix: &str,
) -> Result<SavingsResponse, String> {
    let engine = s3_state.engine.load();
    let mut totals = SavingsTotals::default();
    let mut continuation: Option<String> = None;
    let mut walked: usize = 0;
    let mut truncated = false;

    loop {
        let page = engine
            .list_objects(
                bucket,
                prefix,
                None,
                PAGE_SIZE,
                continuation.as_deref(),
                true,
            )
            .await
            .map_err(|e| e.to_string())?;

        for (_key, meta) in &page.objects {
            totals.accumulate(meta);
            walked += 1;
            if walked >= MAX_LISTING_OBJECTS {
                truncated = true;
                break;
            }
        }

        if truncated || !page.is_truncated {
            break;
        }
        continuation = page.next_continuation_token;
        if continuation.is_none() {
            break;
        }
    }

    // Fold in references for this scope so `totals.stored_bytes`
    // matches what's actually on disk. Failures for individual
    // deltaspaces are logged inside the helper and skipped.
    let refs = engine
        .list_deltaspace_references(bucket, prefix)
        .await
        .map_err(|e| e.to_string())?;
    for meta in &refs {
        totals.accumulate(meta);
    }

    let savings_percentage = totals.savings_percentage();
    Ok(SavingsResponse {
        bucket: bucket.to_string(),
        prefix: prefix.to_string(),
        totals,
        savings_percentage,
        truncated,
        computed_at: Utc::now(),
    })
}
