// SPDX-License-Identifier: GPL-3.0-only

//! Shared infrastructure for background job runners.
//!
//! - [`parse_duration_or`] — env-var duration parsing with sensible
//!   defaults (used by replication, lifecycle, event_delivery).
//! - [`PeriodicJob`] + [`spawn_periodic_scheduler`] — the unified
//!   shape for "wake every N seconds, find due rules, lease them,
//!   run them" loops. Currently the replication and lifecycle
//!   schedulers each open-code this pattern in ~200 LOC apiece;
//!   they can migrate onto this primitive incrementally without
//!   changing observable behaviour. Move C of the architectural
//!   plan tracks the migration.

use async_trait::async_trait;
use std::sync::Arc;
use std::time::Duration;
use tracing::{debug, info, warn};

pub(crate) fn parse_duration_or(
    value: &str,
    default: Duration,
    minimum: Duration,
    label: &str,
) -> Duration {
    match humantime::parse_duration(value) {
        Ok(duration) if duration >= minimum => duration,
        Ok(duration) => {
            warn!(
                "{}={} below minimum {}; using {}",
                label,
                humantime::format_duration(duration),
                humantime::format_duration(minimum),
                humantime::format_duration(minimum),
            );
            minimum
        }
        Err(err) => {
            warn!(
                "{}={} invalid: {}; using {}",
                label,
                value,
                err,
                humantime::format_duration(default),
            );
            default
        }
    }
}

// ─────────────────────────────────────────────────────────────────
// Move C: unified periodic-job scheduler
// ─────────────────────────────────────────────────────────────────

/// Outcome of attempting to lease a rule for a single tick.
///
/// The scheduler asks the job impl whether each rule is due AND
/// available to run. The impl is responsible for atomic
/// (check-state, acquire-lease) under whatever locking it owns —
/// see `replication::scheduler::run_due_rules` for the canonical
/// example using `replication_load_state` + `replication_try_acquire_lease`.
#[allow(dead_code)] // Constructed by job-impls (none yet wired); see Move C.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuleLeaseOutcome {
    /// Rule is due and we won the lease. The scheduler will call
    /// `run_rule` next.
    Acquired,
    /// Rule is paused, not yet due, or another instance holds the
    /// lease. Skip this tick.
    Skipped,
    /// State load or lease acquisition failed. The scheduler logs
    /// and skips. Distinguished from `Skipped` so the operator can
    /// monitor lease-system health separately from "no work to do".
    Errored,
}

/// A rule-driven periodic job. Each tick the scheduler:
///
/// 1. Calls `tick_interval()` to find the sleep duration.
/// 2. Calls `is_globally_enabled()` — if false, sleeps another
///    tick without inspecting rules. Lets operators flip the
///    job off via config without bouncing the process.
/// 3. Calls `rules()` to enumerate due-evaluable rules.
/// 4. For each rule: `try_lease(rule)` → if `Acquired`, calls
///    `run_rule(rule)`.
///
/// The two existing implementations (replication, lifecycle)
/// share this shape modulo:
///   - replication uses `Arc<Mutex<ConfigDb>>` unconditionally;
///     lifecycle accepts `Option<Arc<Mutex<ConfigDb>>>` with a
///     process-local fallback (`super::try_acquire_rule`) when
///     no DB is configured. That fallback is implementation
///     detail of the impl's `try_lease` — no change needed here.
///   - replication takes a `RunLease { owner, ttl, heartbeat }`
///     parameter; lifecycle takes a `tick_seconds_for_next_due`
///     parameter for next-due bookkeeping. Both end up inside
///     `run_rule`'s body, so they're impl-private.
#[allow(dead_code)] // available for migration; not yet wired
#[async_trait]
pub trait PeriodicJob: Send + Sync + 'static {
    /// Snapshot of one rule. Job impls own the type — typically
    /// the same struct they use in their config section.
    type Rule: Send;

    /// Human-readable scheduler instance name, e.g.
    /// `"replication-scheduler"`. Used in logs.
    fn job_name(&self) -> &'static str;

    /// Sleep duration before the next tick. Read fresh each tick
    /// from `SharedConfig` so operators can shorten/lengthen
    /// without bouncing.
    async fn tick_interval(&self) -> Duration;

    /// Cheap "is the whole job feature enabled" check, evaluated
    /// every tick. Returning false skips the rules-walk this tick.
    async fn is_globally_enabled(&self) -> bool;

    /// Snapshot of rules to evaluate this tick. Cloned out of
    /// `SharedConfig` under the read lock and returned owned —
    /// the scheduler iterates without holding the config lock.
    async fn rules(&self) -> Vec<Self::Rule>;

    /// Atomic state-check + lease-acquire for a single rule.
    /// Returns the outcome; the scheduler logs/skips/runs based
    /// on it. Impls are responsible for the DB transaction
    /// boundary (one ConfigDb mutex acquisition).
    async fn try_lease(&self, rule: &Self::Rule, instance_id: &str) -> RuleLeaseOutcome;

    /// Run the rule. Lease has been acquired by `try_lease`. Impls
    /// own retry policy, failure-ring updates, heartbeat refresh,
    /// run-history persistence, audit logging, and metrics. Errors
    /// are logged here, not surfaced upward; the scheduler keeps
    /// ticking regardless.
    async fn run_rule(&self, rule: Self::Rule, instance_id: &str);
}

/// Spawn the generic periodic-scheduler loop over a `PeriodicJob`.
///
/// Returns the JoinHandle so the caller can include it in graceful
/// shutdown. The handle is rarely awaited in practice — these
/// loops are meant to run for the process's lifetime.
///
/// The `instance_id` is `format!("{}:{}", job.job_name(), uuid)` so
/// log lines are greppable and lease-owner identifiers are
/// process-unique across HA replicas.
#[allow(dead_code)]
pub fn spawn_periodic_scheduler<J: PeriodicJob>(job: Arc<J>) -> tokio::task::JoinHandle<()> {
    let instance_id = format!("{}:{}", job.job_name(), uuid::Uuid::new_v4());
    let job_name = job.job_name();
    tokio::spawn(async move {
        info!("{} started: instance_id={}", job_name, instance_id);
        loop {
            let tick = job.tick_interval().await;
            tokio::time::sleep(tick).await;

            if !job.is_globally_enabled().await {
                debug!("{} skipped: globally disabled", job_name);
                continue;
            }

            let rules = job.rules().await;
            for rule in rules {
                match job.try_lease(&rule, &instance_id).await {
                    RuleLeaseOutcome::Acquired => {
                        job.run_rule(rule, &instance_id).await;
                    }
                    RuleLeaseOutcome::Skipped => {
                        // Quiet: paused / not due / busy elsewhere.
                    }
                    RuleLeaseOutcome::Errored => {
                        // try_lease already logged the underlying
                        // error; the count of errored leases is
                        // worth a metric, deferred.
                    }
                }
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
    use tokio::sync::Mutex;

    /// A fake job impl that the test drives through one tick to
    /// prove the scheduler shape works. We use a `Mutex<bool>` to
    /// shut the loop down after one iteration so the test
    /// terminates.
    struct ProbeJob {
        ticks: AtomicU32,
        run_calls: AtomicU32,
        rules_seen: AtomicU32,
        rule_count: u32,
        outcome: RuleLeaseOutcome,
        enabled: AtomicBool,
        done: Arc<Mutex<bool>>,
    }

    #[async_trait]
    impl PeriodicJob for ProbeJob {
        type Rule = u32;

        fn job_name(&self) -> &'static str {
            "probe-scheduler"
        }

        async fn tick_interval(&self) -> Duration {
            // Fast tick so the test isn't slow.
            Duration::from_millis(20)
        }

        async fn is_globally_enabled(&self) -> bool {
            self.enabled.load(Ordering::SeqCst)
        }

        async fn rules(&self) -> Vec<u32> {
            self.ticks.fetch_add(1, Ordering::SeqCst);
            (0..self.rule_count).collect()
        }

        async fn try_lease(&self, _rule: &u32, _instance_id: &str) -> RuleLeaseOutcome {
            self.rules_seen.fetch_add(1, Ordering::SeqCst);
            self.outcome
        }

        async fn run_rule(&self, _rule: u32, _instance_id: &str) {
            self.run_calls.fetch_add(1, Ordering::SeqCst);
            *self.done.lock().await = true;
        }
    }

    #[tokio::test]
    async fn scheduler_calls_run_when_lease_acquired() {
        let probe = Arc::new(ProbeJob {
            ticks: AtomicU32::new(0),
            run_calls: AtomicU32::new(0),
            rules_seen: AtomicU32::new(0),
            rule_count: 3,
            outcome: RuleLeaseOutcome::Acquired,
            enabled: AtomicBool::new(true),
            done: Arc::new(Mutex::new(false)),
        });
        let handle = spawn_periodic_scheduler(probe.clone());

        // Wait up to 2s for at least one rule to run.
        let start = std::time::Instant::now();
        while start.elapsed() < Duration::from_secs(2) {
            if probe.run_calls.load(Ordering::SeqCst) >= 3 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        handle.abort();

        assert!(probe.ticks.load(Ordering::SeqCst) >= 1);
        assert!(probe.rules_seen.load(Ordering::SeqCst) >= 3);
        assert_eq!(probe.run_calls.load(Ordering::SeqCst), 3);
    }

    /// `Skipped`/`Errored` outcomes do NOT call `run_rule`.
    #[tokio::test]
    async fn scheduler_skips_when_lease_not_acquired() {
        let probe = Arc::new(ProbeJob {
            ticks: AtomicU32::new(0),
            run_calls: AtomicU32::new(0),
            rules_seen: AtomicU32::new(0),
            rule_count: 2,
            outcome: RuleLeaseOutcome::Skipped,
            enabled: AtomicBool::new(true),
            done: Arc::new(Mutex::new(false)),
        });
        let handle = spawn_periodic_scheduler(probe.clone());
        tokio::time::sleep(Duration::from_millis(100)).await;
        handle.abort();

        assert!(probe.ticks.load(Ordering::SeqCst) >= 1);
        assert!(probe.rules_seen.load(Ordering::SeqCst) >= 2);
        assert_eq!(
            probe.run_calls.load(Ordering::SeqCst),
            0,
            "Skipped/Errored outcomes must not invoke run_rule"
        );
    }

    /// `is_globally_enabled() == false` short-circuits before
    /// rules() is even called this tick.
    #[tokio::test]
    async fn scheduler_short_circuits_when_globally_disabled() {
        let probe = Arc::new(ProbeJob {
            ticks: AtomicU32::new(0),
            run_calls: AtomicU32::new(0),
            rules_seen: AtomicU32::new(0),
            rule_count: 5,
            outcome: RuleLeaseOutcome::Acquired,
            enabled: AtomicBool::new(false), // globally OFF
            done: Arc::new(Mutex::new(false)),
        });
        let handle = spawn_periodic_scheduler(probe.clone());
        tokio::time::sleep(Duration::from_millis(100)).await;
        handle.abort();

        assert_eq!(
            probe.ticks.load(Ordering::SeqCst),
            0,
            "rules() must not be called when globally disabled"
        );
        assert_eq!(probe.run_calls.load(Ordering::SeqCst), 0);
    }
}
