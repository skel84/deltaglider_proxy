// SPDX-License-Identifier: GPL-3.0-only

//! Phase B: streaming multipart replication copy of a large passthrough
//! object. Exercises the `transfer.rs` streaming branch end-to-end through
//! the replication run-now path on the filesystem backend (the default
//! buffering multipart impl, native=false — still drives create → parts →
//! complete with per-part ranged GETs). Asserts the destination object is
//! byte-identical and correctly sized.
//!
//! The threshold + part size are lowered via env so the test object stays
//! small (~6 MiB) while still routing through `plan_parts` → multipart.

mod common;

use aws_sdk_s3::primitives::ByteStream;
use common::{admin_http_client, TestServer};
use serde_json::Value;

const STREAM_RULE_YAML: &str = "
replication:
  enabled: true
  tick_interval: \"30s\"
  transfers: 2
  upload_concurrency: 2
  rules:
    - name: stream-a-to-b
      enabled: true
      source:
        bucket: stream-src
        prefix: \"\"
      destination:
        bucket: stream-dst
        prefix: \"\"
      interval: \"1h\"
      batch_size: 100
";

/// Deterministic pseudo-random, incompressible body so the object is stored
/// passthrough (not delta-eligible) and the size is large enough to span
/// multiple multipart parts at a 5 MiB part size.
fn big_passthrough_body(len: usize) -> Vec<u8> {
    let mut v = Vec::with_capacity(len);
    let mut x: u64 = 0x1234_5678_9abc_def0;
    while v.len() < len {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        v.extend_from_slice(&x.to_le_bytes());
    }
    v.truncate(len);
    v
}

#[tokio::test]
async fn test_streaming_multipart_copy_large_passthrough() {
    // ~6 MiB object, 1 MiB stream threshold, 5 MiB parts → 2 parts.
    let body = big_passthrough_body(6 * 1024 * 1024);

    let server = TestServer::builder()
        .auth("bootstrap_key", "bootstrap_secret")
        .extra_yaml_storage_section(STREAM_RULE_YAML)
        .env("DGP_STREAM_COPY_THRESHOLD", "1048576") // 1 MiB
        .env("DGP_MULTIPART_PART_SIZE", "5242880") // 5 MiB (S3 min)
        .build()
        .await;

    let client = server.s3_client().await;
    for b in ["stream-src", "stream-dst"] {
        client.create_bucket().bucket(b).send().await.ok();
    }

    // `.bin` is not delta-eligible → stored passthrough → range-able →
    // routes through the streaming multipart copy path.
    client
        .put_object()
        .bucket("stream-src")
        .key("big.bin")
        .body(ByteStream::from(body.clone()))
        .send()
        .await
        .expect("seed large object");

    let admin = admin_http_client(&server.endpoint()).await;
    let resp = admin
        .post(format!(
            "{}/_/api/admin/jobs/replication:stream-a-to-b/run-now",
            server.endpoint()
        ))
        .send()
        .await
        .expect("run-now request");
    assert_eq!(resp.status().as_u16(), 200, "run-now should succeed");
    let outcome: Value = resp.json().await.unwrap();
    assert_eq!(
        outcome["status"].as_str(),
        Some("succeeded"),
        "run status: {outcome}"
    );
    assert_eq!(
        outcome["objects_copied"].as_i64().unwrap_or(-1),
        1,
        "exactly one object copied: {outcome}"
    );

    // Destination object must be byte-identical and correctly sized.
    let got = client
        .get_object()
        .bucket("stream-dst")
        .key("big.bin")
        .send()
        .await
        .expect("dest object present")
        .body
        .collect()
        .await
        .unwrap()
        .into_bytes();
    assert_eq!(got.len(), body.len(), "dest size matches source");
    assert_eq!(&got[..], &body[..], "dest bytes byte-identical to source");
}
