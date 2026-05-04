//! Pure lifecycle planning functions.

use crate::config_sections::LifecycleRule;
use crate::replication::normalize_prefix;
use crate::types::FileMetadata;
use chrono::{DateTime, Utc};
use globset::{Glob, GlobSet, GlobSetBuilder};

pub const MAX_PAGES_PER_RUN: u32 = 10_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    Delete,
    Skip { reason: SkipReason },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SkipReason {
    NotExpired,
    Excluded,
    DgInternal,
    DirectoryMarker,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlanError {
    InvalidGlob { pattern: String, reason: String },
}

impl std::fmt::Display for PlanError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PlanError::InvalidGlob { pattern, reason } => {
                write!(f, "invalid glob {:?}: {}", pattern, reason)
            }
        }
    }
}

impl std::error::Error for PlanError {}

pub fn compile_rule_globs(rule: &LifecycleRule) -> Result<(GlobSet, GlobSet), PlanError> {
    Ok((
        build_globset(&rule.include_globs)?,
        build_globset(&rule.exclude_globs)?,
    ))
}

fn build_globset(patterns: &[String]) -> Result<GlobSet, PlanError> {
    let mut builder = GlobSetBuilder::new();
    for pattern in patterns {
        match Glob::new(pattern) {
            Ok(glob) => {
                builder.add(glob);
            }
            Err(err) => {
                return Err(PlanError::InvalidGlob {
                    pattern: pattern.clone(),
                    reason: err.to_string(),
                });
            }
        }
    }
    builder.build().map_err(|err| PlanError::InvalidGlob {
        pattern: "<set>".to_string(),
        reason: err.to_string(),
    })
}

pub fn lifecycle_prefix(rule: &LifecycleRule) -> String {
    normalize_prefix(&rule.prefix)
}

/// Decide whether a single engine-visible object should expire.
pub fn plan_object(
    key: &str,
    meta: &FileMetadata,
    expire_before: DateTime<Utc>,
    include_globs: &GlobSet,
    exclude_globs: &GlobSet,
) -> Decision {
    if key.ends_with('/') {
        return Decision::Skip {
            reason: SkipReason::DirectoryMarker,
        };
    }

    if is_internal_key(key) {
        return Decision::Skip {
            reason: SkipReason::DgInternal,
        };
    }

    if exclude_globs.is_match(key) {
        return Decision::Skip {
            reason: SkipReason::Excluded,
        };
    }
    if !include_globs.is_empty() && !include_globs.is_match(key) {
        return Decision::Skip {
            reason: SkipReason::Excluded,
        };
    }

    if meta.created_at <= expire_before {
        Decision::Delete
    } else {
        Decision::Skip {
            reason: SkipReason::NotExpired,
        }
    }
}

/// Defense-in-depth for keys that should never be lifecycle targets.
///
/// Engine listings normally expose user objects, not storage artifacts. This
/// still protects config-sync data and any legacy/raw artifact that might leak
/// through a backend-specific listing path.
pub fn is_internal_key(key: &str) -> bool {
    key == ".deltaglider"
        || key.starts_with(".deltaglider/")
        || key.contains("/.deltaglider/")
        || key == ".dg"
        || key.starts_with(".dg/")
        || key.contains("/.dg/")
        || key.ends_with("/reference.bin")
        || key == "reference.bin"
        || key.ends_with(".delta")
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Duration, TimeZone};

    fn meta_at(ts: i64) -> FileMetadata {
        let mut meta = FileMetadata::new_passthrough(
            "x".to_string(),
            "sha".to_string(),
            "0123456789abcdef0123456789abcdef".to_string(),
            1,
            None,
        );
        meta.created_at = Utc.timestamp_opt(ts, 0).unwrap();
        meta
    }

    fn globs(include: &[&str], exclude: &[&str]) -> (GlobSet, GlobSet) {
        let rule = LifecycleRule {
            name: "expire-old".to_string(),
            enabled: true,
            bucket: "b".to_string(),
            prefix: String::new(),
            action: Default::default(),
            expire_after: "30d".to_string(),
            include_globs: include.iter().map(|s| s.to_string()).collect(),
            exclude_globs: exclude.iter().map(|s| s.to_string()).collect(),
            batch_size: 100,
        };
        compile_rule_globs(&rule).unwrap()
    }

    #[test]
    fn expires_objects_older_than_cutoff() {
        let (inc, exc) = globs(&[], &[]);
        let cutoff = Utc.timestamp_opt(1_000, 0).unwrap();
        assert_eq!(
            plan_object("old.txt", &meta_at(999), cutoff, &inc, &exc),
            Decision::Delete
        );
        assert_eq!(
            plan_object("new.txt", &meta_at(1_001), cutoff, &inc, &exc),
            Decision::Skip {
                reason: SkipReason::NotExpired
            }
        );
    }

    #[test]
    fn honors_include_and_exclude_globs() {
        let (inc, exc) = globs(&["logs/**"], &["logs/keep/**"]);
        let cutoff = Utc.timestamp_opt(1_000, 0).unwrap();
        assert_eq!(
            plan_object("logs/a.txt", &meta_at(1), cutoff, &inc, &exc),
            Decision::Delete
        );
        assert_eq!(
            plan_object("tmp/a.txt", &meta_at(1), cutoff, &inc, &exc),
            Decision::Skip {
                reason: SkipReason::Excluded
            }
        );
        assert_eq!(
            plan_object("logs/keep/a.txt", &meta_at(1), cutoff, &inc, &exc),
            Decision::Skip {
                reason: SkipReason::Excluded
            }
        );
    }

    #[test]
    fn skips_internal_keys_and_directory_markers() {
        let (inc, exc) = globs(&[], &[]);
        let cutoff = Utc.timestamp_opt(1_000, 0).unwrap();
        for key in [
            ".deltaglider/config.db",
            "nested/.deltaglider/config.db",
            ".dg/reference.bin",
            "prefix/.dg/file.delta",
            "reference.bin",
            "prefix/reference.bin",
            "object.delta",
        ] {
            assert_eq!(
                plan_object(key, &meta_at(1), cutoff, &inc, &exc),
                Decision::Skip {
                    reason: SkipReason::DgInternal
                },
                "{key}"
            );
        }
        assert_eq!(
            plan_object("folder/", &meta_at(1), cutoff, &inc, &exc),
            Decision::Skip {
                reason: SkipReason::DirectoryMarker
            }
        );
    }

    #[test]
    fn lifecycle_prefix_normalizes_slashes() {
        let rule = globs(&[], &[]);
        let cutoff = Utc::now() - Duration::days(30);
        assert!(matches!(
            plan_object(
                "a",
                &meta_at(cutoff.timestamp() - 1),
                cutoff,
                &rule.0,
                &rule.1
            ),
            Decision::Delete
        ));

        let cfg_rule = LifecycleRule {
            name: "r".into(),
            enabled: true,
            bucket: "b".into(),
            prefix: "/a//b".into(),
            action: Default::default(),
            expire_after: "1d".into(),
            include_globs: vec![],
            exclude_globs: vec![],
            batch_size: 100,
        };
        assert_eq!(lifecycle_prefix(&cfg_rule), "a/b/");
    }
}
