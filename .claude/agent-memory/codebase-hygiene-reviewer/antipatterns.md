---
name: antipatterns-to-flag
description: Anti-patterns to call out aggressively in deltaglider_proxy reviews
type: feedback
---

Anti-patterns this codebase has fought before and shouldn't reintroduce.

**Why:** CLAUDE.md already calls these out as "don't reintroduce" patterns; the v0.9.11 hygiene review confirmed several variants are still creeping back in. Keep flagging them on PRs.

**How to apply:** in any review touching these areas, reject silently.

1. **Test-only admin endpoints.** `POST /api/admin/config/sync-now` exists only because there's a real operator use case (force pull after known-good change on another instance). It happens to enable HA tests. The bar is "do operators actually need this?" — never "would this make my test easier?"

2. **Helper wrappers that hide post-mutation ordering.** `with_config_db` deliberately stops at "lock the DB and run a closure"; ordering of `rebuild_iam_index → trigger_config_sync → audit_log` stays explicit at every call site because getting it wrong is how split-brain happens. Don't let someone fold those into a "nicer" helper.

3. **Integration tests for logic a unit test would cover.** Curated `--test` lists exist in `.github/workflows/ci.yml` for a reason. Before adding any new `tests/*_test.rs` file, ask: does this need TestServer + SigV4 + storage? If not, push the logic into a pure helper and unit-test it (see `classify_s3_error`, `validate_bucket_name`, `is_ip_format` for prior art).

4. **Duplicating defaults across config_sections.rs and config.rs.** The `config.rs` defaults are now `pub(crate)` and reused (commit `0742780`). Don't re-introduce `default_*` duplicates in the sectioned shape.

5. **Replacing xdelta3 CLI subprocess with FFI/crate.** Architecture decision in CLAUDE.md — non-negotiable. Keeps wire-format compat with the original Python toolchain and avoids C linkage.

6. **Sharing types across "different serdes" rationalizations.** If two structs serialize differently for "different reasons," ask whether one should serde-flatten the other or whether `#[serde(rename = "...")]` solves it. The flat `Config` ↔ sectioned `SectionedConfig` boundary is the legitimate exception, with a documented `into_flat` / `from_flat` round-trip.
