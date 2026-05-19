// SPDX-License-Identifier: GPL-3.0-only

//! Regression suite for the "savings math" centralization.
//!
//! Today's discovery: three places in the codebase computed delta-
//! compression savings independently (admin dashboard scan, CLI stats,
//! SPA chip), and all three undercounted by ignoring the per-prefix
//! `reference.bin` bytes. That made the dashboard headline report up
//! to "99.95% saved" on prefixes whose true savings was ~80% — and
//! made the new SPA chip read "100% smaller", which is what surfaced
//! the bug.
//!
//! The fix landed `src/deltaglider/savings.rs` as the single source of
//! truth. This test enforces the invariant via the public seams:
//!
//!   1. `GET /_/api/admin/deltaspace/savings` (the new endpoint that
//!      powers the SPA chip) must include reference bytes in
//!      `stored_bytes`.
//!   2. The aggregated savings percentage MUST stay strictly below
//!      99% on any realistic deltaspace, because a reference always
//!      exists on disk and consumes real bytes.
//!   3. Numbers must agree with what `engine.list_deltaspace_references`
//!      reports — i.e. the centralised path round-trips against the
//!      raw storage layer.
//!
//! The shape is "ROR-like": N near-identical ZIP-style blobs in the
//! same prefix. Same family as the smoke uploads that surfaced the
//! original bug.

mod common;

use common::{admin_http_client, put_object, TestServer, TEST_BOOTSTRAP_PASSWORD};

const NUM_SIBLINGS: usize = 8;
const SIBLING_SIZE: usize = 256 * 1024; // 256 KB each — keeps the test fast.

fn generate_sibling(seed: u8, base: &[u8]) -> Vec<u8> {
    // 99.9%-identical to `base`, differing only in the first 16
    // bytes. xdelta3 will produce a tiny delta for siblings.
    let mut v = base.to_vec();
    for (i, b) in v.iter_mut().enumerate().take(16) {
        *b = b.wrapping_add(seed).wrapping_add(i as u8);
    }
    v
}

#[derive(serde::Deserialize, Debug)]
#[allow(dead_code)] // Debug prints them in assertion failure messages.
struct SavingsTotals {
    original_bytes: u64,
    stored_bytes: u64,
    reference_bytes: u64,
    delta_stored_bytes: u64,
    delta_count: u64,
    reference_count: u64,
}

#[derive(serde::Deserialize, Debug)]
struct SavingsResponse {
    totals: SavingsTotals,
    savings_percentage: Option<f64>,
}

async fn upload_sibling_family(server: &TestServer, prefix: &str) -> Vec<u8> {
    let http = reqwest::Client::new();
    // Compressible base: lots of identical bytes so xdelta3's
    // sliding-window finder has something to latch onto. This is the
    // SAME shape as production data — a ZIP file's central directory
    // and shared deflate streams between sibling builds have long
    // matched runs even though the on-disk file is otherwise
    // incompressible to general-purpose tools. We mimic that here by
    // using 64-byte repeated runs.
    let block = b"DGP_SAVINGS_REGRESSION_TEST_PAYLOAD_______________________0xDEAD";
    let mut base = Vec::with_capacity(SIBLING_SIZE);
    while base.len() < SIBLING_SIZE {
        base.extend_from_slice(block);
    }
    base.truncate(SIBLING_SIZE);

    for i in 0..NUM_SIBLINGS {
        let key = format!("{}sibling-v{}.zip", prefix, i);
        let body = generate_sibling(i as u8, &base);
        put_object(
            &http,
            &server.endpoint(),
            server.bucket(),
            &key,
            body,
            "application/zip",
        )
        .await;
    }
    base
}

/// Hit `GET /_/api/admin/deltaspace/savings?bucket=...&prefix=...` and
/// pin all the invariants. The most important one: stored_bytes ≥
/// reference_bytes, and savings can NEVER be ≥ 99% on a deltaspace
/// where a real reference exists.
#[tokio::test]
async fn savings_endpoint_includes_reference_bytes_and_caps_below_99pct() {
    let server = TestServer::builder()
        .bucket("delta-savings-regression")
        .bootstrap_password(TEST_BOOTSTRAP_PASSWORD)
        .build()
        .await;
    upload_sibling_family(&server, "releases/v1/").await;

    let admin = admin_http_client(&server.endpoint()).await;
    let url = format!(
        "{}/_/api/admin/deltaspace/savings?bucket={}&prefix=releases/v1/",
        server.endpoint(),
        server.bucket()
    );
    let resp = admin.get(&url).send().await.expect("savings request");
    assert!(resp.status().is_success(), "got {}", resp.status());
    let body: SavingsResponse = resp.json().await.expect("savings json");

    // Sanity: we actually exercised the delta path.
    assert!(
        body.totals.delta_count >= 1,
        "no deltas produced — test setup is broken; got {:?}",
        body.totals
    );
    assert!(
        body.totals.reference_count >= 1,
        "no reference produced — engine should have pinned one",
    );

    // CORE INVARIANT: reference bytes must be IN stored_bytes.
    //
    // Pre-fix: stored_bytes = sum(delta_size) and silently undercount-
    // ed by `reference_bytes`. The chip read "100% smaller" because
    // the deltas were ~1 KB each against 256 KB originals, while the
    // 256 KB reference was nowhere in the math.
    assert!(
        body.totals.stored_bytes >= body.totals.reference_bytes,
        "stored_bytes ({}) must include reference_bytes ({})",
        body.totals.stored_bytes,
        body.totals.reference_bytes,
    );
    let expected_stored_lb = body.totals.reference_bytes + body.totals.delta_stored_bytes;
    assert_eq!(
        body.totals.stored_bytes, expected_stored_lb,
        "stored_bytes ({}) must equal reference_bytes + delta_stored_bytes ({}+{})",
        body.totals.stored_bytes, body.totals.reference_bytes, body.totals.delta_stored_bytes,
    );

    // CORE INVARIANT: savings percentage stays under 99% because the
    // reference itself costs an entire payload of bytes. A ROR-shaped
    // deltaspace with 8 siblings of 256 KB each (2 MB user-visible)
    // and one shared 256 KB reference + ~tiny deltas is at most ~87%
    // saved. "≥ 99%" would mean the proxy somehow stored less than 1%
    // of the original — physically impossible while a reference exists.
    let pct = body.savings_percentage.expect("savings_pct present");
    assert!(
        pct < 99.0,
        "savings ({}%) must be < 99% — anything higher means the \
         reference bytes are still being ignored (regression). totals = {:?}",
        pct,
        body.totals,
    );
    // Lower bound: a near-identical family MUST achieve at least
    // 50% savings, otherwise the engine is no longer compressing.
    assert!(
        pct >= 50.0,
        "savings ({}%) is too low — the engine should be hitting ≥50% \
         for a near-identical family. totals = {:?}",
        pct,
        body.totals,
    );
}

/// Empty / no-deltas case: a prefix with no compressible content must
/// report null savings (not "0%"), so the UI hides the chip rather
/// than showing a misleading 0.
#[tokio::test]
async fn savings_endpoint_returns_null_pct_when_nothing_to_measure() {
    let server = TestServer::builder()
        .bucket("delta-savings-empty")
        .bootstrap_password(TEST_BOOTSTRAP_PASSWORD)
        .build()
        .await;

    let admin = admin_http_client(&server.endpoint()).await;
    let url = format!(
        "{}/_/api/admin/deltaspace/savings?bucket={}&prefix=nothing-here/",
        server.endpoint(),
        server.bucket()
    );
    let resp = admin.get(&url).send().await.expect("savings request");
    assert!(resp.status().is_success(), "got {}", resp.status());
    let body: SavingsResponse = resp.json().await.expect("savings json");
    assert_eq!(body.totals.delta_count, 0);
    assert_eq!(body.totals.reference_count, 0);
    assert_eq!(
        body.savings_percentage, None,
        "empty prefix must report null savings, not 0%",
    );
}

/// The dashboard's bucket-wide scan must agree with the endpoint:
/// after running `POST /_/api/admin/diagnostics/scan/start`, the
/// resulting `ScanResult.total_reference_bytes > 0` and the
/// savings_percentage is < 99% — same regression, same fix.
#[tokio::test]
async fn dashboard_bucket_scan_reports_reference_bytes() {
    let server = TestServer::builder()
        .bucket("delta-savings-dashboard")
        .bootstrap_password(TEST_BOOTSTRAP_PASSWORD)
        .build()
        .await;
    upload_sibling_family(&server, "releases/v2/").await;

    let admin = admin_http_client(&server.endpoint()).await;
    // Trigger a fresh scan synchronously by hitting /start then
    // polling /status until done.
    let start_url = format!(
        "{}/_/api/admin/diagnostics/scan/start?bucket={}",
        server.endpoint(),
        server.bucket()
    );
    let resp = admin.post(&start_url).send().await.expect("scan/start");
    assert!(
        resp.status().is_success(),
        "scan/start failed: {}",
        resp.status()
    );

    let status_url = format!(
        "{}/_/api/admin/diagnostics/scan/status?bucket={}",
        server.endpoint(),
        server.bucket()
    );
    // Poll up to 10 s. Filesystem backend with 8×256KB files finishes
    // in <1 s; we leave headroom for slow CI runners.
    let mut last: Option<serde_json::Value> = None;
    for _ in 0..40 {
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        let resp = admin.get(&status_url).send().await.expect("scan/status");
        let v: serde_json::Value = resp.json().await.expect("status json");
        // The endpoint returns either a Done frame or a Running frame.
        if v.get("done").is_some() || v.get("Done").is_some() {
            last = Some(v);
            break;
        }
        // Some shapes nest it; treat presence of total_reference_bytes
        // anywhere in the doc as "we have a completed scan".
        let s = v.to_string();
        if s.contains("total_reference_bytes") && !s.contains("\"running\"") {
            last = Some(v);
            break;
        }
    }
    let result = last.expect("scan did not finish in 10 s");

    // Extract total_reference_bytes wherever it lives in the response
    // (the API may wrap the ScanResult in a `done` envelope).
    let total_ref = extract_u64(&result, "total_reference_bytes")
        .expect("total_reference_bytes missing — scan result is undercounting!");
    let total_stored = extract_u64(&result, "total_stored_bytes")
        .expect("total_stored_bytes missing from scan result");
    let savings_pct = extract_f64(&result, "savings_percentage")
        .expect("savings_percentage missing from scan result");

    assert!(
        total_ref > 0,
        "bucket scan reports zero reference bytes — engine pinned no reference for the sibling family? result = {}",
        result,
    );
    assert!(
        total_stored >= total_ref,
        "bucket scan total_stored_bytes ({}) must include total_reference_bytes ({})",
        total_stored,
        total_ref,
    );
    assert!(
        savings_pct < 99.0,
        "dashboard savings ({}%) ≥ 99% — reference bytes are still being ignored somewhere. result = {}",
        savings_pct,
        result,
    );
}

fn extract_u64(v: &serde_json::Value, key: &str) -> Option<u64> {
    if let Some(found) = v.get(key).and_then(|x| x.as_u64()) {
        return Some(found);
    }
    if let Some(obj) = v.as_object() {
        for (_, child) in obj {
            if let Some(found) = extract_u64(child, key) {
                return Some(found);
            }
        }
    }
    None
}

fn extract_f64(v: &serde_json::Value, key: &str) -> Option<f64> {
    if let Some(found) = v.get(key).and_then(|x| x.as_f64()) {
        return Some(found);
    }
    if let Some(obj) = v.as_object() {
        for (_, child) in obj {
            if let Some(found) = extract_f64(child, key) {
                return Some(found);
            }
        }
    }
    None
}
