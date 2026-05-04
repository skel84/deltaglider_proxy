# Lifecycle Rules (v1)

Delete-only lifecycle expiration for engine-visible objects.

## Scope

v1 only supports expiration delete. No storage-class transitions, no multipart cleanup, and no raw storage scanning. Every deletion goes through `engine.delete`, so DeltaGlider metadata, reference cleanup, encryption wrappers, and event outbox behavior stay on the same path as normal S3 deletes.

Lifecycle is disabled by default. A rule has to be present, the global switch must be `enabled: true`, and the rule itself must be `enabled: true` before automatic scheduler or run-now execution deletes anything. Preview is available even while disabled and stays read-only: it does not create run-history rows or acquire distributed leases.

## YAML Shape

```yaml
storage:
  lifecycle:
    enabled: false                 # default; must be true for run-now/scheduler
    tick_interval: "1h"            # scheduler poll rate, min 60s
    max_failures_retained: 100     # cap returned failure/candidate details

    rules:
      - name: expire-old-builds
        enabled: false             # default; set true to allow execution
        bucket: artifacts
        prefix: "builds/"          # "" = whole bucket
        action: delete             # v1 only
        expire_after: "30d"        # humantime
        batch_size: 100
        include_globs: ["builds/**/*.zip"]
        exclude_globs: [".deltaglider/**", "builds/golden/**"]
```

Rule names use `[A-Za-z0-9_.-]{1,64}` and must be unique.

## Admin API

All endpoints are session-gated.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/_/api/admin/lifecycle` | List configured rules, global status, and per-rule runtime state |
| `POST` | `/_/api/admin/lifecycle/rules/:name/preview` | Dry-run a rule and return candidate keys |
| `POST` | `/_/api/admin/lifecycle/rules/:name/run-now` | Execute a rule synchronously; returns 409 if global/rule disabled or already running |
| `GET` | `/_/api/admin/lifecycle/rules/:name/history?limit=N` | Recent persisted executions, newest first |
| `GET` | `/_/api/admin/lifecycle/rules/:name/failures?limit=N` | Recent per-object failures, newest first |

Run-now response:

```json
{
  "run_id": 42,
  "rule_name": "expire-old-builds",
  "status": "succeeded",
  "objects_scanned": 1200,
  "objects_expired": 17,
  "objects_skipped": 1183,
  "bytes_expired": 448000000,
  "errors": 0,
  "candidates": [
    {
      "bucket": "artifacts",
      "key": "builds/old/app.zip",
      "created_at": "2026-03-01T12:00:00Z",
      "size": 1234
    }
  ],
  "failures": []
}
```

`run_id` is present only for actual executions. `candidates` and response-local `failures` are capped by `max_failures_retained`; counters still reflect the whole run.

Overview response rule entries include runtime state when the config DB is available:

```json
{
  "name": "expire-old-builds",
  "enabled": true,
  "bucket": "artifacts",
  "prefix": "builds/",
  "action": "delete",
  "expire_after": "30d",
  "last_status": "succeeded",
  "last_run_at": 1775140800,
  "next_due_at": 1775144400,
  "objects_expired_lifetime": 17,
  "bytes_expired_lifetime": 448000000,
  "include_globs": ["builds/**/*.zip"],
  "exclude_globs": [".deltaglider/**", "builds/golden/**"]
}
```

History rows include `id`, `triggered_by` (`scheduler` or `run-now`), `started_at`, `finished_at`, object/byte counters, `errors`, and terminal `status`. Failure rows include `run_id`, `bucket`, `object_key`, `occurred_at`, and `error_message`; `run_id` links failures to the execution that observed them.

## Guardrails

Lifecycle skips:

- Directory markers (`folder/`).
- DeltaGlider config-sync/internal prefixes (`.deltaglider/**`, `.dg/**`).
- Storage artifacts if they ever leak through a backend listing (`reference.bin`, `*.delta`).
- Keys excluded by `exclude_globs`.
- Keys outside `include_globs` when includes are configured.
- Keys newer than `expire_after`.

Deletion is idempotent at the object level. Per-object failures are reported in the response and persisted in the config DB with the run id that observed them.

## Runtime State

The config DB stores:

- `lifecycle_state`: current `last_status`, `last_run_at`, `next_due_at`, lifetime expired-object/byte counters, and the active scheduler lease.
- `lifecycle_run_history`: one row per `run-now` or scheduler execution.
- `lifecycle_failures`: recent per-object failures, ring-bounded by `max_failures_retained` per rule.

The scheduler uses a per-rule DB lease so multiple proxy instances sharing the same config DB do not execute the same lifecycle rule concurrently. A boot-time reconciliation marks runs left in `running` by a dead process as `failed` and records an operator-visible failure row.

## Events

When a config DB is available, successful lifecycle deletes append a `LifecycleExpired` event to the durable event outbox with rule name, expiration age, object creation time, and content length.

## Deferred

- Storage-class transitions.
- UI panels beyond config editing and direct API calls.
