# Delta-efficiency optimization — adversarial correctness review

Status: review complete, P0+P1 bugs fixed and tested. P2+P3 documented as
latent (no regression vs pre-existing behaviour).

Reviewer: I went through every line I touched in the earlier optimization
pass, plus the surrounding seams it depends on, looking for ways the
shipped code could be wrong even when the tests pass. Each hypothesis
below was verified against the actual code, not just imagined.

---

## P0 — Critical: S3 lite path silently misreports `savings_bytes` as negative on every healthy prefix

**Symptom.** After the optimization landed, opening Delta Efficiency on an
S3-backed bucket showed every healthy prefix with negative savings — the
UI flagged them red as "stored > original", the textbook bad-reference
signal. False alarm on 100% of healthy S3 prefixes.

**Mechanism.**
- `do_scan` now calls `scan_deltaspace_lite`. On S3 the lite override
  returns `FileMetadata` where, for delta entries, `file_size` is the
  on-disk delta size (not the original — no HEAD was fired).
- `build_report_for_prefix` summed `m.file_size` of every delta and
  passthrough into `total_original_bytes`.
- For deltas this double-counted the delta as "original":
  `total_original` becomes ≈ `total_delta` + passthroughs, while
  `stored = reference + total_delta`. The subtraction
  `savings = total_original − stored` ≈ `−reference_bytes` — always
  negative on a healthy compression ratio.

**Concretely** (Excellent prefix: 19.5 MB ref, 49 × 70 KB deltas):

| Path        | `total_original`    | `stored`            | `savings` | UI         |
|-------------|---------------------|---------------------|-----------|------------|
| Old (HEAD)  | 931 MB (real)       | 22.9 MB             | +908 MB   | green      |
| New (lite)  | 3.4 MB              | 22.9 MB             | **−19.5 MB** | RED   |

The classifier's verdict and median ratio are unaffected — they read
`StorageInfo::Delta.delta_size`, which is the same number both ways.
Only `total_original_bytes` and the derived `savings_bytes` go wrong.

**Fix.** Per-backend honest signal:

1. `StorageBackend::scan_deltaspace_lite` now returns a `LiteScanResult
   { metadata, originals_estimated: bool }` struct rather than a bare
   `Vec<FileMetadata>`. Each backend declares whether its lite output
   carries true original sizes.
2. **Filesystem** inherits the default impl which delegates to
   `scan_deltaspace`. That reads xattr inline, so original sizes ARE
   exact — `originals_estimated: false`.
3. **S3** override fires zero HEADs, so `originals_estimated: true`.
4. `build_report_for_prefix` takes a `lite_scan: bool` argument. When
   true, it sums passthrough bytes into `total_original` (still
   honest), excludes delta `file_size` from the sum (since under lite
   it's the delta size, not the original), and sets `savings_bytes = 0`
   as a sentinel. The new `original_size_estimated: bool` field on
   `DeltaspaceReport` propagates the signal to the UI.
5. **UI** suppresses the Original and Saved columns (renders `—`) when
   `original_size_estimated` is true, with a tooltip explaining why.

**Tests added.**
- `build_report_for_prefix_counts_passthrough_under_lite`
- `build_report_for_prefix_counts_originals_under_head_path`
- `build_report_lite_excellent_prefix_does_not_show_negative_savings`
  (explicit regression test — asserts savings ≥ 0)

**Severity rationale.** This would have made the optimization a UX
regression on the exact bucket the case study writeup will reference.
False-positive red on every prefix erodes operator trust in the panel.

---

## P1 — Major: `do_scan` sort order is non-deterministic across runs

**Mechanism.** The optimization replaced the serial for-loop with
`buffer_unordered(8)`. Completion order is now arbitrary. The existing
sort was `(efficiency, total_delta_bytes desc)`. Two prefixes that tie
on both keys would land in different positions on each scan, flipping
their UI row order across page reloads.

**Why it matters.** UI stability across refreshes is part of feeling
deterministic. Rare in practice for two prefixes to tie exactly on
total_delta_bytes — but on filesystem backends with synthetic data
(tests, demos) or buckets where many prefixes are empty/equal, it
fires every time.

**Fix.** Added `.then_with(|| a.prefix.cmp(&b.prefix))` as a tertiary
sort key. Prefix names are unique per scan (they're the HashMap keys
from `list_deltaspaces`), so this always breaks ties deterministically.

**Tests added.** `sort_is_deterministic_for_tied_prefixes` —
hand-builds two reports tied on (Poor, 300, 100) and asserts
`reports[0].prefix == "a"`.

---

## P2 — Latent: silent total-scan failure looks identical to "no reportable prefixes"

**Mechanism.** If every per-prefix `scan_deltaspace_lite` call errors
(e.g. transient S3 outage), `do_scan` returns `Ok(EfficiencyResponse {
reported_deltaspaces: 0, reports: [], scanned_deltaspaces: N, ... })`.
The UI shows the success state "no deltaspaces met the reporting
threshold." There's no surface to the caller that **all** scans failed.

Each failure is logged at `warn` level — useful for operators tailing
logs, invisible in the UI.

**Status.** Pre-existing behaviour. The serial loop had identical
semantics. Not a regression from my change. Worth fixing in a follow-up
(e.g. include a `scan_errors: usize` field in the response and surface
a yellow banner when scanned > reported + N), but out of scope for
this hardening pass.

**Test gap.** No test exercises an all-failure scenario. A future PR
should add one with a backend mock that always errors.

---

## P3 — Latent: nested deltaspaces double-count keys

**Mechanism.** `list_deltaspaces` derives prefixes via `key.rfind('/')`,
producing one prefix per terminating-folder. If the bucket has both
`ror/builds/global.json` (at level 2) and `ror/builds/1.0/foo.delta`
(at level 3), `list_deltaspaces` returns both `"ror/builds"` and
`"ror/builds/1.0"`.

`scan_deltaspace_lite("ror/builds")` lists with prefix
`"ror/builds/"`, which returns `"ror/builds/global.json"` AND
`"ror/builds/1.0/foo.delta"` — the latter is "borrowed" from a deeper
prefix and double-counted.

`list_deltaspace_eligible` only filters subdirectory contents when
`prefix.is_empty()`. For non-empty prefixes, the filter is a no-op.

**Status.** Pre-existing in `scan_deltaspace` too — identical bug, not
a regression. Real-world impact: the migration bucket has strictly
sibling prefixes (`ror/builds/1.0`, `ror/builds/1.1`, …), so the
collision pattern doesn't fire. Documenting for a future fix that adds
proper level-aware filtering (`key[search_prefix.len()..]` must not
contain `/`).

---

## P4 — Documented limitation: encryption-at-rest inflates delta sizes by 28 bytes/blob

**Mechanism.** `EncryptingBackend<S3Backend>` wraps blobs with a
12-byte IV + 16-byte GCM tag. The S3 listing returns ciphertext size.
Lite path takes that as the "delta size".

**Impact on classification.** Median delta classification thresholds:
50% / 20% / 5% × reference. For a 100 KB delta with 28 bytes
overhead, ratio inflation is 0.028%. Cannot push a Good prefix into
Fair or Poor. Safe.

**Status.** Documented in `scan_deltaspace_lite` trait doc, no code
change. The migration scenario doesn't use encryption so this is
purely conservative belt-and-braces.

---

## P5 — Minor: GUI component unmount race during 5-min polling window

**Mechanism.** `fetchOrPoll` loops up to 5 minutes (300s) and calls
`setScanning` / `setResponse` on completion. If the user navigates
away mid-poll, React fires a "state update on unmounted component"
warning, and stale results could clobber a different bucket's view.

**Status.** Pre-existing pattern in this panel. The bump from 60s to
300s widens the window from 5% to 25% of a typical operator session.
Not a regression, but the longer window makes the latent bug fire
more often.

**Fix deferred.** Real fix needs an `AbortController` (or a mounted
flag) threaded through `fetchOrPoll`, plus likely a `useEffect`
cleanup. The redesigned panel (the parallel UX agent's proposal) is
going to rewrite this code path anyway — fixing once in the rewrite
is cleaner than patching twice.

---

## P6 — Minor: `total_original_bytes` JSON precision loss above 2^53 bytes (≈9 PB)

**Mechanism.** Server emits `u64` → JSON number → TS `number` (IEEE 754
double). Above 2^53 (9.007 PB) precision degrades to >1-byte
granularity. For diagnostic display this is fine; the classifier never
uses these values directly.

**Status.** Pre-existing across the codebase. Documented for the
record, not a regression. A future API v2 could move >Number.MAX_SAFE
fields to string.

---

## Bugs ruled out after investigation

These were initial concerns I verified are NOT bugs:

- **`engine.load_full()` vs `engine.load()`.** Correct choice — we need
  owned `Arc<DynEngine>` to clone into `buffer_unordered` futures.
- **Engine swap mid-scan.** Each future holds its own Arc clone; the
  old engine stays alive until the last future drops. ArcSwap
  replacement doesn't affect in-flight scans.
- **Cancellation safety.** `buffer_unordered` futures aren't `spawn`-ed;
  dropping the parent task drops them cleanly. No leak.
- **Zero-byte reference.** Guarded — `ratio_median` returns `None`
  when `r == 0`; classifier returns `NoReference`. Test added.
- **Multiple `Reference` entries in one prefix.** Last-write-wins on
  `reference_bytes`. Doesn't panic. Test added.
- **`ratio_median` NaN/Infinity.** Guarded against zero divisor.
- **PARALLEL_PREFIX_SCANS=8 vs S3 SlowDown.** 8 LISTs in flight per
  bucket is well under typical S3 per-account quotas. Same bound the
  existing `bounded_head_calls` uses.
- **Frontend reading missing `ratio_median` field.** `#[serde(default)]`
  on server + `null | number` on TS. Compatible with both directions.

---

## Test coverage delta

| Pass | Before | After |
|------|--------|-------|
| `cargo test --lib`               | 804 | 809 |
| `cargo test --lib delta_efficiency` | 20  | 25  |

New tests (in addition to the lite/non-lite split):
- `build_report_for_prefix_zero_byte_reference_is_safe`
- `build_report_for_prefix_two_references_uses_last_write`
- `build_report_lite_excellent_prefix_does_not_show_negative_savings`
- `build_report_for_prefix_counts_originals_under_head_path`
- `sort_is_deterministic_for_tied_prefixes`

All green. Clippy clean. Rustfmt clean. TypeScript clean. ESLint clean.

---

## Files changed in this pass (on top of the original optimization)

- `src/storage/traits.rs` — new `LiteScanResult` struct; trait method
  return type changed.
- `src/storage/s3.rs` — lite override returns the struct with
  `originals_estimated: true`.
- `src/storage/routing.rs`, `src/storage/encrypting.rs` — forwarders
  updated for the new return type.
- `src/api/admin/delta_efficiency.rs` —
  `build_report_for_prefix` takes a `lite_scan` flag; new field
  `original_size_estimated` on `DeltaspaceReport`; tertiary sort key;
  tests.
- `demo/s3-browser/ui/src/adminApi.ts` — `DeltaspaceEfficiencyReport`
  gains `original_size_estimated: boolean`; doc-comments warn against
  using `total_original_bytes` / `savings_bytes` without checking
  the flag.
- `demo/s3-browser/ui/src/components/DeltaEfficiencyPanel.tsx` —
  Original/Saved cells render `—` (with tooltip) when
  `original_size_estimated` is true.

Wire format additions are backward compatible (new optional fields,
`#[serde(default)]`).
