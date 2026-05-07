---
name: hot-dry-hotspots
description: Files and modules where DRY violations keep re-emerging in deltaglider_proxy
type: project
---

Areas with chronic duplication risk in this repo. Worth re-checking on any maintenance pass.

**Why:** during the v0.9.11 hygiene review (2026-05-07) several near-identical code blocks were spread across files with no shared helper, even when the helper existed. Same pattern keeps cropping up because parallel S3 surfaces (axum + s3s adapter) and parallel admin handlers each grow independently.

**How to apply:** on any review or refactor that touches these files, check the listed counterparts before adding new logic.

1. **SigV4 integrity check (`SignedPayloadHash`)** — the canonical verifier now lives at `src/api/auth.rs::SignedPayloadHash::verify_against_body`. If you see a new `requires_chunk_signature_verification` + `is_verifiable_hex` + `ConstantTimeEq::ct_eq` block anywhere, point at this method instead.

2. **Bucket existence checks** — single helper at `src/api/handlers/mod.rs::ensure_bucket_exists` (pub(crate)). The s3s adapter has its own `ensure_bucket_exists_s3s` for type reasons; keep them in sync.

3. **Conditional-header evaluators** — six near-parallel impls between `src/api/handlers/object_helpers.rs` (axum: `evaluate_put_conditionals`, `check_copy_source_conditionals`, `check_conditionals`) and `src/s3_adapter_s3s.rs` (s3s: `evaluate_put_etag_conditionals_s3s`, `evaluate_copy_source_conditionals_s3s`, `evaluate_read_conditionals_s3s`). Inline `etag_matches` closure repeated 4×. Refactor candidate when the s3s adapter graduates from feature-gated.

4. **`with_config_db` helper bypass** — `src/api/admin/mod.rs::with_config_db` exists and is used only in `external_auth.rs` (8×); the same pattern is open-coded in `users.rs` (6×), `groups.rs` (7×), `backup.rs` (3×). Phase 1 (read paths) is a safe mechanical sweep. Phase 2 (write paths) needs a closure-based status mapper extension.

5. **`config.rs` is 4008 lines** — split into `src/config/{mod,defaults,encryption,env,io,validate}.rs` plus `tests.rs`. Inline tests are ~1810 LOC of the file.

6. **`adminApi.ts` (1574 LOC, 78 fns)** — frontend has 45 raw `if (!res.ok) await throwApiError(res, 'X')` blocks; `safeJson` already encapsulates this but is bypassed. Low-value polish.
