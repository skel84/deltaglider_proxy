// SPDX-License-Identifier: GPL-3.0-only

//! Per-bucket WRITE gate for maintenance jobs.
//!
//! While a bucket has an active job, S3 **write** requests
//! (PUT/POST/DELETE — uploads, multipart ops, deletes) are rejected with
//! `503 SlowDown` so SDKs back off and retry after the job finishes.
//! **Reads stay up**: the engine's read path serves mixed
//! encrypted/plaintext state transparently, and keeping GET/HEAD/LIST
//! available means public download buckets see zero downtime.
//!
//! Blocking writes is a CORRECTNESS requirement, not UX: the worker
//! rewrites objects via retrieve→store, and a client PUT landing between
//! those two steps would be silently overwritten with stale bytes.
//!
//! ## Why not the admission chain
//!
//! The admission chain is an immutable artifact compiled from config and
//! rebuilt WHOLESALE by `rebuild_bucket_derived_snapshots` on every
//! config apply — a dynamic per-bucket block injected there would
//! silently vanish on the next unrelated apply mid-job. This gate is a
//! separate, permanent middleware layer on the S3 router whose CONTENTS
//! (the busy set) are swapped lock-free; config applies cannot disturb
//! it. The admin router never passes through it, so the job's own engine
//! calls and the admin API stay unblocked (admin object WRITE endpoints
//! check the gate explicitly instead).
//!
//! ## In-flight write draining
//!
//! A write admitted moments BEFORE the gate armed could still land after
//! the worker rewrote that key. The gate therefore counts in-flight S3
//! writes per bucket; the worker waits for the gated bucket's counter to
//! reach zero before scanning anything (bounded by the server's request
//! timeout — no request can legitimately outlive it).

use std::collections::HashSet;
use std::sync::Arc;

use arc_swap::ArcSwap;
use axum::body::Body;
use axum::http::{Method, Request};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use dashmap::DashMap;

/// Lock-free busy-bucket set + per-bucket in-flight write counters.
#[derive(Debug)]
pub struct MaintenanceGate {
    busy: ArcSwap<HashSet<String>>,
    inflight_writes: DashMap<String, i64>,
}

impl Default for MaintenanceGate {
    fn default() -> Self {
        Self {
            busy: ArcSwap::from_pointee(HashSet::new()),
            inflight_writes: DashMap::new(),
        }
    }
}

impl MaintenanceGate {
    pub fn new() -> Self {
        Self::default()
    }

    /// Is this bucket currently gated? (Bucket names compare lowercased —
    /// the same normalization the routing layer uses.)
    pub fn is_busy(&self, bucket: &str) -> bool {
        self.busy.load().contains(&bucket.to_ascii_lowercase())
    }

    /// Add a bucket to the busy set (idempotent).
    pub fn set_busy(&self, bucket: &str) {
        let key = bucket.to_ascii_lowercase();
        let current = self.busy.load();
        if current.contains(&key) {
            return;
        }
        let mut next = HashSet::clone(&current);
        next.insert(key);
        self.busy.store(Arc::new(next));
    }

    /// Remove a bucket from the busy set (idempotent).
    pub fn clear(&self, bucket: &str) {
        let key = bucket.to_ascii_lowercase();
        let current = self.busy.load();
        if !current.contains(&key) {
            return;
        }
        let mut next = HashSet::clone(&current);
        next.remove(&key);
        self.busy.store(Arc::new(next));
    }

    /// Number of S3 write requests currently in flight for `bucket`.
    pub fn inflight_writes(&self, bucket: &str) -> i64 {
        self.inflight_writes
            .get(&bucket.to_ascii_lowercase())
            .map(|v| *v)
            .unwrap_or(0)
    }

    fn write_started(&self, bucket: &str) {
        *self
            .inflight_writes
            .entry(bucket.to_ascii_lowercase())
            .or_insert(0) += 1;
    }

    fn write_finished(&self, bucket: &str) {
        let key = bucket.to_ascii_lowercase();
        if let Some(mut v) = self.inflight_writes.get_mut(&key) {
            *v -= 1;
            if *v <= 0 {
                drop(v);
                // Best-effort cleanup; a racing increment simply re-creates
                // the entry, counts stay correct because entry() starts at 0.
                self.inflight_writes.remove_if(&key, |_, v| *v <= 0);
            }
        }
    }
}

/// First path segment of an S3 request = the bucket (lowercased).
/// Root-level requests (ListBuckets, health) have no bucket.
fn bucket_from_path(path: &str) -> Option<String> {
    let trimmed = path.trim_start_matches('/');
    if trimmed.is_empty() {
        return None;
    }
    let bucket = trimmed.split('/').next().unwrap_or(trimmed);
    if bucket.is_empty() {
        None
    } else {
        Some(bucket.to_ascii_lowercase())
    }
}

fn is_write_method(method: &Method) -> bool {
    matches!(*method, Method::PUT | Method::POST | Method::DELETE)
}

/// Axum middleware on the S3 router: 503-SlowDown writes to busy buckets,
/// count in-flight writes for everything else. Reads always pass.
pub async fn maintenance_gate_middleware(request: Request<Body>, next: Next) -> Response {
    let Some(gate) = request.extensions().get::<Arc<MaintenanceGate>>().cloned() else {
        // Gate not wired (shouldn't happen in production) — never block.
        return next.run(request).await;
    };

    if !is_write_method(request.method()) {
        return next.run(request).await;
    }
    let Some(bucket) = bucket_from_path(request.uri().path()) else {
        return next.run(request).await;
    };

    if gate.is_busy(&bucket) {
        return crate::api::errors::S3Error::SlowDown(format!(
            "bucket '{bucket}' is temporarily read-only: maintenance (re-encryption) in progress"
        ))
        .into_response();
    }

    gate.write_started(&bucket);
    let response = next.run(request).await;
    gate.write_finished(&bucket);
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn busy_set_round_trips_case_insensitively() {
        let g = MaintenanceGate::new();
        assert!(!g.is_busy("pippo"));
        g.set_busy("Pippo");
        assert!(g.is_busy("pippo"));
        assert!(g.is_busy("PIPPO"));
        g.set_busy("pippo"); // idempotent
        g.clear("pipPO");
        assert!(!g.is_busy("pippo"));
        g.clear("pippo"); // idempotent
    }

    #[test]
    fn inflight_write_counter_tracks_and_cleans_up() {
        let g = MaintenanceGate::new();
        assert_eq!(g.inflight_writes("b"), 0);
        g.write_started("b");
        g.write_started("B");
        assert_eq!(g.inflight_writes("b"), 2);
        g.write_finished("b");
        assert_eq!(g.inflight_writes("b"), 1);
        g.write_finished("b");
        assert_eq!(g.inflight_writes("b"), 0);
        assert!(g.inflight_writes.is_empty(), "zeroed entries are removed");
    }

    #[test]
    fn bucket_from_path_shapes() {
        assert_eq!(bucket_from_path("/"), None);
        assert_eq!(bucket_from_path(""), None);
        assert_eq!(bucket_from_path("/Bucket"), Some("bucket".into()));
        assert_eq!(
            bucket_from_path("/bucket/key/with/slashes"),
            Some("bucket".into())
        );
    }

    #[test]
    fn write_method_classification() {
        assert!(is_write_method(&Method::PUT));
        assert!(is_write_method(&Method::POST));
        assert!(is_write_method(&Method::DELETE));
        assert!(!is_write_method(&Method::GET));
        assert!(!is_write_method(&Method::HEAD));
        assert!(!is_write_method(&Method::OPTIONS));
    }
}
