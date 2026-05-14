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

3. **Conditional-header evaluators** — six near-parallel impls between `src/api/handlers/object_helpers.rs` (axum: `evaluate_put_conditionals`, `check_copy_source_conditionals`, `check_conditionals`) and `src/s3_adapter_s3s.rs` (s3s: `evaluate_put_etag_conditionals_s3s`, `evaluate_copy_source_conditionals_s3s`, `evaluate_read_conditionals_s3s`). **Per `docs/plan/s3s-adapter-migration.md` the legacy axum path will be deleted, NOT deduplicated — leave both alone until the migration cleanup phase.**

4. **`with_config_db` helper bypass** — `src/api/admin/mod.rs::with_config_db` exists and is used only in `external_auth.rs` (8×); the same pattern is open-coded in `users.rs` (6×), `groups.rs` (7×), `backup.rs` (3×). Phase 1 (read paths) is a safe mechanical sweep. Phase 2 (write paths) needs a closure-based status mapper extension.

5. **`config.rs` is 4031 lines but only 2216 lines of production code** (1815 lines of inline `#[cfg(test)]`). Splitting prod side adds proportional benefit only if tests move too. Lower priority than the items below.

6. **`apply_config_doc` vs `apply_section` secret preservation duplication** — `document_level.rs::preserve_runtime_secrets` (167 lines, lines 307-465) is fully inlined again inside `section_level.rs::apply_section` (lines 356-466), with `preserve_backend_secrets`/`preserve_backend_encryption_secrets` as separate helpers that the document-level path doesn't use. Both implement the same both-or-neither SigV4 semantics and the same removed-backend warning logic; they MUST stay in lockstep or a section-PUT and a document-APPLY will silently produce different config states. Highest hygiene priority on the admin surface as of 2026-05-14.

7. **`EncryptingBackend` 17 pass-through methods** (encrypting.rs:1419-1510) — pure `self.inner.X(args).await` boilerplate. Same shape as the `impl_storage_backend_for_box!` macro in traits.rs:401. A `delegate_to_inner!` macro covering only the trivial-delegate subset would eliminate ~90 lines without touching the encryption-aware methods. Held back so far because the trait surface keeps growing (each new method must be added in BOTH places); a macro turns the maintenance cost from 2× into 1×. Acceptable as-is for 1 wrapper; medium priority if a second wrapper (e.g. a future quota-enforcing backend) is added.

8. **`adminApi.ts` (1671 LOC)** — frontend has 52 raw `if (!res.ok)` blocks. The `adminFetch + throwApiError` pattern is mostly applied but the wrap function could absorb the OK check. Low-value polish.
