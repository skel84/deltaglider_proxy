# S3 Adapter Decision — axum default, s3s research

## Status

**axum is the production default.** s3s remains as a feature-gated
research path. Removal of s3s is deferred pending an empirical
protocol-conformance fixture.

## Context

DeltaGlider Proxy has two S3 protocol implementations:

- **axum** — handler functions in `src/api/handlers/` plus the
  router in `startup.rs::build_s3_router`. Handles every PUT/GET/
  HEAD/DELETE/COPY/multipart and form-POST. ~3500 LOC across the
  handler tree.
- **s3s** — `src/s3_adapter_s3s.rs` (1823 LOC) plus the
  `build_s3s_router` (~400 LOC) and an XML-rewrite middleware
  (`add_s3_request_id`, ~100 LOC) that papers over s3s output gaps.
  Driven by the [`s3s` crate](https://github.com/Nugine/s3s) which
  provides a code-generated S3 protocol surface.

Both are wired in `startup.rs::build_s3_router` based on the
`DGP_S3_ADAPTER` env var, but only when the `s3s-adapter` feature
flag is compiled in.

## What production runs

The Dockerfile builds **without** `--features s3s-adapter`. So
production traffic on dgp.serve.beshu.tech (and every operator who
pulls the official image) hits the axum router unconditionally.

The pre-decision env-var default (`DGP_S3_ADAPTER` defaulted to
`s3s`) was misleading: it gave the impression that s3s was the
production default. It was the **CI-and-feature-flagged-build**
default; production never compiled s3s in.

## Why we keep both for now

- s3s is the only credible exit ramp from carrying our own S3
  protocol implementation forever. The axum side has accumulated
  150+ tests of correctness fixes (multipart, conditional headers,
  Range edge cases, RFC 7232 precedence, SigV4 chunked,
  presigned-form-POST, etc.). Replicating that test corpus on a
  generated protocol surface is the only way to be confident the
  switch is safe.
- s3s keeps being maintained in CI as a parity check: every change
  to the axum handlers gets sanity-checked against s3s for
  protocol-spec drift.
- Killing s3s removes the option to ever switch. We're not ready
  to make that call.

## Why we don't switch to s3s as default

- Multiple correctness regressions surfaced in CI when s3s was
  default: form-POST routing collision (`2abe031` reverted), 4/4
  parity tests fail under naive `.route("/:bucket", post(...))`,
  CreateBucket returning 405 because routing claims method slots.
- s3s output drifts from AWS in three documented ways requiring
  the XML-rewrite middleware. Not a blocker but a sign the
  protocol surface isn't 1:1.
- The architectural review (May 2026) flagged the dual-adapter
  pattern as the single biggest tax on the codebase. Removing it
  is one of the highest-ROI refactors available — but only if we
  pick the empirical winner. Until we have data, "keep axum
  default, leave s3s as research" is the lowest-regret call.

## How to decide for real

A protocol-conformance fixture, deferred to a future PR:

1. Stand up `s3-tests` (the canonical S3 reference test suite) +
   the AWS Java SDK v2 integration tests + boto3 against both
   adapters with `DGP_S3_ADAPTER=axum` and `DGP_S3_ADAPTER=s3s`.
2. Run the same corpus against both.
3. The adapter with fewer real failures wins.
4. The loser is deleted: `s3_adapter_s3s.rs`, `build_s3s_router`,
   `add_s3_request_id`, the 5 conditional-evaluator parallels,
   the 2 `ensure_bucket_exists` parallels, the feature flag.
   Total reclaim: ~2400 LOC.

## What this means for new features

Until removal: every cross-adapter feature must land on **both**
adapters. If the change is axum-only (a typed-IAM thing, an admin
API endpoint, a new metric), it's free. If it's an S3 protocol
change (a header, a status code, a new operation), budget the
work for both implementations + parity tests.

## References

- `src/startup.rs::build_s3_router` (the adapter selector).
- `src/s3_adapter_s3s.rs` (the s3s implementation).
- `tests/s3s_adapter_parity_test.rs` (the parity test suite).
- The architectural review summary (in-session, not committed) —
  flagged this as Move A of the four-move strategic plan.
