# Multi-backend bucket management — UX gap & solution

**Trigger:** Operator added a second (local, encrypted) storage backend and reported
"no buckets showed up, so I can't use it." Then went to bucket policies, found a
dropdown that reassigns a bucket's backend, set it to a different backend "to create
chaos," and crashed the app.

**PM framing (the user story we're failing):**
> *As an operator who configured a second storage backend, I want to create and
> browse buckets on it, and clearly see which backend each bucket lives on — without
> guessing or risking data.*

---

## What the platform ACTUALLY supports (verified in code)

The capability mostly exists; it's **fragmented and under-explained**, not missing:

| Capability | Where it lives | Exposed to operator? |
|---|---|---|
| Create a bucket on a chosen backend | `createBucketOnBackend` API + Sidebar create-bucket modal backend picker (`Sidebar.tsx:487`) | **Only when** `canAdmin && backends.length > 1` |
| List buckets across all backends | `RoutingBackend::list_buckets` (aggregates, dedupes) | Yes (sidebar list) |
| See which backend a bucket lives on | `getBucketOrigins` → `BucketBackendBadge` (`Sidebar.tsx:363`) | Yes, **admin only**, sidebar badge |
| Pin a bucket to a backend | bucket-policy `backend` field → routing `routes` | Yes, in Buckets policy editor (the dropdown that crashed) |
| Test a backend / see its bucket count | `testS3Connection` (`BackendsPanel`) | Yes, but transient (one-shot alert) |

**Model:** there is no per-backend bucket namespace in the UI. Buckets live in one
flat "virtual" list; a bucket's backend is determined by (1) an explicit bucket-policy
route, else (2) the `default_backend`, else (3) first backend that HEADs the bucket.
New buckets without a policy route land on the **default backend**.

---

## Why the operator's test failed (root cause, not the crash)

Running config: Hetzner (`default_backend`) + a newly-added local FS backend.

1. **A new backend starts empty.** `list_buckets` aggregates all backends; the new one
   contributes 0 buckets. Nothing "shows up" because nothing exists there yet — working
   as designed, but reads as broken.
2. **No path makes the new backend obviously usable.** To get a bucket *onto* it the
   operator must either (a) use the create-bucket modal's backend picker (only visible
   with ≥2 backends, easy to miss), or (b) author a bucket-policy route. Neither is
   surfaced from the Backends panel where they just added the backend — so the natural
   next click ("now use it") has no home.
3. **The bucket-policy backend dropdown is a loaded gun.** It silently *reassigns where
   a bucket routes* with no explanation that this changes the bucket's storage location
   (and on a real backend, can orphan data). The operator reasonably read it as "pick a
   backend for this bucket" and it crashed (the `undefined.trim()` bug, fixed separately
   in `894ace3`).

**Net:** not a missing feature — a **discoverability + safety + empty-state** problem.

---

## Solution (phased, lowest-risk first)

### Phase 1 — Make the existing capability discoverable & safe (small, ship now)

1. **Backends panel: show each backend's bucket count + a "Create bucket here" action.**
   `testS3Connection` already returns the bucket count; surface it persistently per
   backend row (not just in a one-shot test alert), and add a "＋ Create bucket on this
   backend" button that opens the create-bucket modal pre-targeted to that backend. This
   gives the just-added backend an obvious "now use it" path.

2. **Create-bucket modal: always show the backend picker when >1 backend exists**, with
   the default backend preselected and labeled "(default)". Today it's correct but easy
   to miss; make the routing decision explicit at creation time (the one safe moment to
   choose — before any data exists).

3. **Bucket-policy backend dropdown: guard it.** It currently silently reassigns routing.
   - Add inline help: "Routing only. Changing this points the bucket at a different
     backend; existing objects are NOT moved and may become unreachable."
   - On change to a non-empty bucket, require a confirm ("This bucket has objects on
     `<current>`. Re-routing to `<new>` will not move them. Continue?").
   - (Crash already fixed.)

4. **Empty-backend empty-state.** When a backend has 0 buckets, the Backends panel row
   should say so with the create affordance, so "no buckets" reads as "empty, here's how
   to populate it" instead of "broken."

### Phase 2 — Clarify the mental model (medium)

5. **Surface bucket→backend origin in the main browser, not just an admin-only sidebar
   badge.** A small backend chip on each bucket row (all roles, read-only) so operators
   always know where a bucket lives.

6. **Optional: group the sidebar bucket list by backend** (collapsible headers) when >1
   backend is configured, so the multi-backend topology is visible at a glance and an
   empty backend appears as an empty group rather than vanishing.

### Phase 3 — Close the data-mobility gap (larger, needs design)

7. The bucket-policy dropdown implies you can "move a bucket between backends," but
   re-routing doesn't move data. Either (a) rename/scope it to make clear it's routing-
   only, or (b) build a real "migrate bucket to backend `X`" action (copy objects via the
   engine, then re-route) — reusing the existing `transfer.rs` retrieve→store primitive.
   This is the honest version of what the operator *thought* the dropdown did.

---

## Status

- **Phases 1 + 2: SHIPPED** on branch `unwind-simpleselect` (commit `abce945`).
  Per-backend bucket counts + "Create bucket here" + empty-state, extracted
  `CreateBucketModal`, the re-route confirm guard, and the admin-only origin chip
  in the browser header. Reused existing APIs only; browser-verified.
- **The crash** (`undefined.trim()` on the re-route dropdown): fixed in `894ace3`.
- **A real backend bug surfaced & fixed** (`8c39c18`): the admin bucket-origins API
  mis-attributed every bucket to the default backend because the
  `Box<dyn StorageBackend>` blanket impl didn't forward `list_bucket_origins` (fell
  through to the default that drops backend attribution). Forwarded + 2 regression
  tests. This is why a bucket created on a non-default backend showed up under the
  default before the fix.
- **Phase 3: NOT implemented — needs explicit go-ahead.** It moves prod data; the
  cross-backend-copy mechanism (below) must be reviewed before building, and it
  should not be auto-run against real storage unreviewed.

## Phase 3 — Migrate bucket to backend X (detailed design, pending approval)

**The core problem:** `transfer::copy_object_with_retries` copies between *virtual*
bucket names through the engine router. A same-name cross-backend move
(`bucket` on A → `bucket` on B) can't be expressed directly: while the route points
`bucket → A`, you cannot also address `bucket → B`. And the explicit-route-wins rule
(`routing.rs:148`) means the instant you flip `bucket → B`, the source objects on A
become unreachable by that name. So **copy must happen before the flip**, addressing
the two backends under two distinct virtual names.

**Recommended mechanism — transient staging bucket on the target:**
1. Pre-flight: confirm `bucket` exists, `target_backend` exists and differs from the
   current backend, enumerate source objects (engine LIST) and record a count/size
   manifest.
2. Create a transient virtual bucket `__dgmigrate_<bucket>_<ts>` with an explicit
   route to `target_backend` **aliased to the real bucket name** (`real_bucket =
   bucket`), so objects land in the real `bucket` on the target backend. (Reuses the
   `create_bucket_on_backend` route+rebuild+rollback flow.)
3. For each source object, `copy_object_with_retries` with
   `source_bucket=bucket` (still → A), `destination_bucket=__dgmigrate_…` (→ B/bucket).
   Stamp `dg-migration` provenance. Idempotent/resumable: skip keys already present +
   verified on the target.
4. Verify: every source key exists on the target with matching size/ETag.
5. Flip `bucket`'s policy route to `target_backend`; remove the transient route;
   rebuild engine; persist. (Same rollback discipline as `create_bucket_on_backend`.)
6. Optional `delete_source` (default OFF): delete source objects on A only after the
   flip + verify. Default keeps them as a safety copy for the operator to remove later.
7. On any failure before the flip: drop the transient route, leave source untouched.

**Surface:**
- New endpoint `POST /_/api/admin/buckets/{bucket}/migrate`
  `{ target_backend, delete_source? }` in `backends.rs` (next to
  `create_bucket_on_backend`), wired in `demo.rs` + `mod.rs`. Long-running →
  return a job id + progress poll, or stream NDJSON; at minimum make it resumable.
- Client `migrateBucket(...)` in `adminApi/backends.ts`; a "Migrate" action on the
  BucketCard backend control / BackendsPanel row that lists target backends and shows
  object count + progress. Invalidate `qk.backends.origins()` + `.list()` + the bucket
  list on success.
- Tests: routing-level migration (copy across backends preserves data), and a
  failure-mid-migration test asserting the route is NOT flipped and no data is lost.

**Risk:** this is the only phase that mutates object data across real backends. Build
behind a confirm, default `delete_source=false`, and verify against a non-prod backend
pair before exposing it. Recommend reviewing this mechanism before implementation.
