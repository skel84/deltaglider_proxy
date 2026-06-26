// SPDX-License-Identifier: GPL-3.0-only

//! Per-rule replication actions (run-now / pause / resume), consumed by
//! the unified jobs API (`api/admin/jobs.rs`) under
//! `POST /_/api/admin/jobs/replication:<rule>/{run-now,pause,resume}`.
//! Listing, runs, and failures live in the jobs module.

use super::AdminState;
use crate::replication;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde::Serialize;
use std::sync::Arc;
use tracing::info;

/// Response for run-now.
#[derive(Debug, Serialize)]
pub struct RunNowResponse {
    pub run_id: i64,
    pub status: String,
    pub objects_scanned: i64,
    pub objects_copied: i64,
    pub objects_skipped: i64,
    pub bytes_copied: i64,
    pub errors: i64,
}

/// Trigger an immediate synchronous run of a rule. Used by the admin
/// UI + integration tests. Honours the paused flag: a paused rule
/// returns 409 Conflict.
pub async fn run_now(
    Path(name): Path<String>,
    State(state): State<Arc<AdminState>>,
) -> Result<Json<RunNowResponse>, (StatusCode, String)> {
    // Snapshot config first, release the lock immediately so we don't
    // hold it across the (potentially long) replication run.
    let repl = {
        let cfg = state.config.read().await;
        cfg.replication.clone()
    };
    let rule = repl
        .rules
        .iter()
        .find(|r| r.name == name)
        .cloned()
        .ok_or_else(|| (StatusCode::NOT_FOUND, "rule not found".to_string()))?;

    // M2 fix: respect both the global kill-switch (`replication.enabled`)
    // and the per-rule `enabled` flag. Pre-fix, an admin-triggered
    // `run-now` would copy objects even with `enabled=false` — making
    // the flag misleading documentation rather than an actual gate.
    if !repl.enabled {
        return Err((
            StatusCode::CONFLICT,
            "replication is globally disabled (storage.replication.enabled = false)".to_string(),
        ));
    }
    if !rule.enabled {
        return Err((
            StatusCode::CONFLICT,
            format!(
                "rule '{}' is disabled (set enabled: true in YAML to run it)",
                rule.name
            ),
        ));
    }

    // Same deferral the scheduler and event consumer apply: run-now must
    // not write into a destination a maintenance job is rewriting.
    if state
        .s3_state
        .maintenance_gate
        .is_busy(&rule.destination.bucket)
    {
        return Err((
            StatusCode::CONFLICT,
            format!(
                "destination bucket '{}' has an active maintenance job — run the rule \
                 again when it finishes",
                rule.destination.bucket
            ),
        ));
    }

    let db_arc = state
        .config_db
        .as_ref()
        .ok_or_else(|| {
            (
                StatusCode::SERVICE_UNAVAILABLE,
                "config DB not available".to_string(),
            )
        })?
        .clone();

    let lease_owner = format!("run-now:{}", uuid::Uuid::new_v4());

    // Short lock for the precheck + lease acquisition only — run_rule
    // acquires the lock itself at each sync boundary (see its doc comment).
    {
        let db = db_arc.lock().await;
        let now = replication::current_unix_seconds();
        let _ = db.replication_ensure_state(&rule.name, now);
        // Acquire the lease FIRST, then re-check `paused` while still holding
        // the same DB lock. The lease is the true serialization anchor: making
        // it the first mutation closes the check-then-act window where a
        // concurrent pause/resume could toggle the flag between a standalone
        // paused check and lease acquisition. Both the read and the lease grant
        // happen under one uninterrupted lock hold, so the decision is atomic.
        let acquired = db
            .replication_try_acquire_lease(
                &rule.name,
                &lease_owner,
                now,
                replication::scheduler::lease_ttl_secs(&repl),
            )
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("{}", e)))?;
        if !acquired {
            return Err((
                StatusCode::CONFLICT,
                "rule is already running; wait for the current run to finish".to_string(),
            ));
        }
        // Paused check after we own the lease — if the rule is paused, release
        // the lease we just took so a later resume+run isn't blocked by a
        // dangling lease, and return 409.
        if let Ok(Some(st)) = db.replication_load_state(&rule.name) {
            if st.paused {
                let _ = db.replication_release_lease(&rule.name, &lease_owner);
                return Err((
                    StatusCode::CONFLICT,
                    "rule is paused; resume it before running".to_string(),
                ));
            }
        }
    }

    info!("Replication run-now via admin API: rule='{}'", name);

    let engine = state.s3_state.engine.load().clone();
    let run_result = replication::run_rule(
        db_arc.clone(),
        &engine,
        &rule,
        repl.max_failures_retained,
        replication::scheduler::object_timeout(&repl),
        repl.object_skip_after_failures,
        "run-now",
        Some(replication::RunLease {
            owner: lease_owner.clone(),
            ttl_secs: replication::scheduler::lease_ttl_secs(&repl),
            heartbeat_secs: replication::scheduler::heartbeat_secs(&repl),
        }),
        replication::RunConcurrency {
            transfers: repl.transfers,
            upload_concurrency: repl.upload_concurrency,
        },
    )
    .await;

    {
        let db = db_arc.lock().await;
        let _ = db.replication_release_lease(&rule.name, &lease_owner);
    }

    let (run_id, outcome) =
        run_result.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("{}", e)))?;

    crate::audit::audit_log(
        "replication_run_now",
        "admin",
        &name,
        &HeaderMap::new(),
        &rule.source.bucket,
        &rule.source.prefix,
    );

    Ok(Json(RunNowResponse {
        run_id,
        status: outcome.status,
        objects_scanned: outcome.totals.objects_scanned,
        objects_copied: outcome.totals.objects_copied,
        objects_skipped: outcome.totals.objects_skipped,
        bytes_copied: outcome.totals.bytes_copied,
        errors: outcome.totals.errors,
    }))
}

/// Audit source↔destination parity for a rule (read-only). Gated ONLY on
/// rule existence — auditing a disabled rule before enabling it is valid.
/// No lease, no maintenance-gate: it only lists metadata.
pub async fn verify(
    Path(name): Path<String>,
    State(state): State<Arc<AdminState>>,
) -> Result<Json<replication::ParityOutcome>, (StatusCode, String)> {
    let repl = {
        let cfg = state.config.read().await;
        cfg.replication.clone()
    };
    let rule = repl
        .rules
        .iter()
        .find(|r| r.name == name)
        .cloned()
        .ok_or_else(|| (StatusCode::NOT_FOUND, "rule not found".to_string()))?;

    info!("Replication verify via admin API: rule='{}'", name);

    let engine = state.s3_state.engine.load().clone();
    // Pass the DB mutex so the audit can join the per-object failure ledger.
    // parity_audit locks it ONLY for the synchronous tail query, never across
    // its listing awaits. A None DB still yields a correct (ledger-less) diff.
    let outcome = replication::parity_audit(
        &engine,
        &rule,
        replication::parity::MAX_PARITY_OBJECTS,
        state.config_db.as_deref(),
    )
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    crate::audit::audit_log(
        "replication_verify",
        "admin",
        &name,
        &HeaderMap::new(),
        &rule.source.bucket,
        &rule.source.prefix,
    );

    Ok(Json(outcome))
}

/// Check whether a rule with the given name exists in the live config.
/// M1 fix: previously pause/resume called `replication_ensure_state`
/// before this check, leaving an orphan DB row for ghost rules even
/// though the response was 404. This snapshot-and-find is now the
/// FIRST thing pause/resume do.
async fn rule_in_config(state: &AdminState, name: &str) -> bool {
    let cfg = state.config.read().await;
    cfg.replication.rules.iter().any(|r| r.name == name)
}

pub async fn pause(
    Path(name): Path<String>,
    State(state): State<Arc<AdminState>>,
) -> Result<StatusCode, (StatusCode, String)> {
    if !rule_in_config(&state, &name).await {
        return Err((StatusCode::NOT_FOUND, "rule not found".to_string()));
    }
    let db = state
        .config_db
        .as_ref()
        .ok_or_else(|| {
            (
                StatusCode::SERVICE_UNAVAILABLE,
                "config DB not available".to_string(),
            )
        })?
        .lock()
        .await;
    let _ = db.replication_ensure_state(&name, replication::current_unix_seconds());
    db.replication_set_paused(&name, true)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("{}", e)))?;
    crate::audit::audit_log(
        "replication_pause",
        "admin",
        &name,
        &HeaderMap::new(),
        "",
        "",
    );
    Ok(StatusCode::NO_CONTENT)
}

pub async fn resume(
    Path(name): Path<String>,
    State(state): State<Arc<AdminState>>,
) -> Result<StatusCode, (StatusCode, String)> {
    if !rule_in_config(&state, &name).await {
        return Err((StatusCode::NOT_FOUND, "rule not found".to_string()));
    }
    let db = state
        .config_db
        .as_ref()
        .ok_or_else(|| {
            (
                StatusCode::SERVICE_UNAVAILABLE,
                "config DB not available".to_string(),
            )
        })?
        .lock()
        .await;
    let _ = db.replication_ensure_state(&name, replication::current_unix_seconds());
    db.replication_set_paused(&name, false)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("{}", e)))?;
    crate::audit::audit_log(
        "replication_resume",
        "admin",
        &name,
        &HeaderMap::new(),
        "",
        "",
    );
    Ok(StatusCode::NO_CONTENT)
}
