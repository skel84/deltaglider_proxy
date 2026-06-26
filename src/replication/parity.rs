// SPDX-License-Identifier: GPL-3.0-only

//! Source↔destination parity audit for a replication rule.
//!
//! Answers the operator question "is my mirror verified identical?" with
//! an explicit verdict instead of inferring it from `status=succeeded`.
//!
//! The work splits into a PURE diff kernel (`compare_pair` / `diff_parity`)
//! and an async driver (`parity_audit`) that lists both sides via the same
//! `Pager` + `engine.list_objects(..., true)` the workers use. Parity is a
//! metadata compare — `FileMetadata.file_sha256` is the LOGICAL hash even
//! for delta-stored objects, so no downloads or reconstruction happen.
//!
//! The one correctness trap: `FileMetadata::fallback()` leaves
//! `file_sha256` empty for any object NOT written through this proxy (raw
//! foreign dest). A naive sha-compare would false-alarm every foreign
//! object, so the verifier degrades through three tiers (see `compare_pair`).

use crate::config_sections::{ConflictPolicy, ReplicationRule};
use crate::deltaglider::DynEngine;
use crate::types::FileMetadata;
use serde::Serialize;
use std::collections::BTreeMap;
use tracing::warn;

use super::planner::{
    compile_rule_globs, normalize_prefix, rewrite_key, should_replicate, Decision,
};

/// Per-category sample cap surfaced to the UI (exact counts stay unbounded).
pub const SAMPLE_CAP: usize = 100;
/// Hard ceiling on total objects scanned across both sides before we stop
/// and report `truncated=true` (2× usage_scanner's 100k — two prefixes).
pub const MAX_PARITY_OBJECTS: usize = 200_000;
/// Objects per `list_objects` page.
const PAGE_SIZE: u32 = 1000;

/// The comparable shape of one object, distilled from `FileMetadata`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObjState {
    /// Logical SHA-256, empty-string-collapsed to `None` (foreign objects).
    pub sha256: Option<String>,
    /// Logical (hydrated) size in bytes.
    pub size: u64,
    /// `multipart_etag` if present, else `md5` if present (inline — there is
    /// no `FileMetadata::etag()` accessor).
    pub etag: Option<String>,
    /// Part count parsed off a `"...-N"` multipart ETag, if any.
    pub multipart_parts: Option<u32>,
}

impl ObjState {
    /// Build from listing metadata. Mirrors the plan's field derivation.
    pub fn from_metadata(m: &FileMetadata) -> Self {
        let sha256 = (!m.file_sha256.is_empty()).then(|| m.file_sha256.clone());
        let etag = m
            .multipart_etag
            .clone()
            .or_else(|| (!m.md5.is_empty()).then(|| m.md5.clone()));
        let multipart_parts = m
            .multipart_etag
            .as_deref()
            .and_then(|e| e.rsplit_once('-'))
            .and_then(|(_, n)| n.parse::<u32>().ok());
        ObjState {
            sha256,
            size: m.file_size,
            etag,
            multipart_parts,
        }
    }
}

/// Which evidence proved a `Match` (or failed to, for a mismatch).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Verifier {
    /// Strongest: logical SHA-256 + size compared on both sides.
    Sha256,
    /// ETag + size compared (sha missing a side).
    EtagSize,
    /// Only size was comparable.
    SizeOnly,
}

/// The classification of one key across source and destination.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FindingKind {
    Match,
    ChecksumMismatch,
    MissingOnDest,
    OrphanOnDest,
}

/// One per-key finding, carried in the bounded sample vecs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ParityFinding {
    pub key: String,
    pub kind: FindingKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verifier: Option<Verifier>,
    pub unverifiable: bool,
    pub detail: String,
}

/// PURE three-tier compare of one source/dest pair (both keys present).
///
/// Returns `(kind, verifier, unverifiable, detail)`:
/// 1. Both sha present → compare sha256 + size (strongest).
/// 2. Sha missing a side but both have an etag AND sizes equal → EtagSize,
///    UNLESS multipart part-counts differ (can't prove equality) → fall to 3.
/// 3. Size only: equal → `Match` + `unverifiable`; differ → `ChecksumMismatch`.
///
/// A size difference is ALWAYS a `ChecksumMismatch` (size is authoritative).
pub fn compare_pair(
    src: &ObjState,
    dst: &ObjState,
) -> (FindingKind, Option<Verifier>, bool, String) {
    // Size differs → authoritative mismatch, regardless of tier.
    if src.size != dst.size {
        return (
            FindingKind::ChecksumMismatch,
            None,
            false,
            format!("size differs (src {} vs dst {})", src.size, dst.size),
        );
    }

    // Tier 1: both sha present.
    if let (Some(s), Some(d)) = (&src.sha256, &dst.sha256) {
        if s == d {
            return (
                FindingKind::Match,
                Some(Verifier::Sha256),
                false,
                "sha256 + size match".to_string(),
            );
        }
        return (
            FindingKind::ChecksumMismatch,
            Some(Verifier::Sha256),
            false,
            "sha256 differs".to_string(),
        );
    }

    // Tier 2: etag + size (sha missing a side). Differing multipart
    // part-counts can't prove byte-equality → demote to tier 3.
    let parts_conflict = matches!(
        (src.multipart_parts, dst.multipart_parts),
        (Some(a), Some(b)) if a != b
    );
    if !parts_conflict {
        if let (Some(se), Some(de)) = (&src.etag, &dst.etag) {
            if se == de {
                return (
                    FindingKind::Match,
                    Some(Verifier::EtagSize),
                    false,
                    "etag + size match".to_string(),
                );
            }
            return (
                FindingKind::ChecksumMismatch,
                Some(Verifier::EtagSize),
                false,
                "etag differs at equal size".to_string(),
            );
        }
    }

    // Tier 3: size only. Equal here (size diff handled above) → Match but
    // unverifiable (we couldn't prove byte-equality).
    (
        FindingKind::Match,
        Some(Verifier::SizeOnly),
        true,
        "matched on size only — write through the proxy for checksum parity".to_string(),
    )
}

/// Exact diff counts plus bounded per-category sample vecs.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ParityDiff {
    pub matched: u64,
    pub checksum_mismatch: u64,
    pub missing_on_dest: u64,
    pub orphan_on_dest: u64,
    /// `Match`es that were only provable by size (subset of `matched`).
    pub unverifiable: u64,
    pub missing_samples: Vec<ParityFinding>,
    pub orphan_samples: Vec<ParityFinding>,
    pub mismatch_samples: Vec<ParityFinding>,
}

/// PURE merge-walk over two sorted maps (keys in the DEST namespace on both
/// sides — the driver pre-rewrites source keys). Classifies each key once.
pub fn diff_parity(
    source: &BTreeMap<String, ObjState>,
    dest: &BTreeMap<String, ObjState>,
) -> ParityDiff {
    let mut out = ParityDiff::default();
    let mut s = source.iter().peekable();
    let mut d = dest.iter().peekable();

    loop {
        match (s.peek(), d.peek()) {
            (Some((sk, sv)), Some((dk, dv))) => {
                match sk.cmp(dk) {
                    std::cmp::Ordering::Equal => {
                        let (kind, verifier, unverifiable, detail) = compare_pair(sv, dv);
                        match kind {
                            FindingKind::Match => {
                                out.matched += 1;
                                if unverifiable {
                                    out.unverifiable += 1;
                                }
                            }
                            FindingKind::ChecksumMismatch => {
                                out.checksum_mismatch += 1;
                                push_capped(
                                    &mut out.mismatch_samples,
                                    ParityFinding {
                                        key: (*sk).clone(),
                                        kind,
                                        verifier,
                                        unverifiable,
                                        detail,
                                    },
                                );
                            }
                            // compare_pair never yields a missing/orphan for a present pair.
                            _ => {}
                        }
                        s.next();
                        d.next();
                    }
                    std::cmp::Ordering::Less => {
                        // Key only on source → missing on dest.
                        out.missing_on_dest += 1;
                        push_capped(
                            &mut out.missing_samples,
                            ParityFinding {
                                key: (*sk).clone(),
                                kind: FindingKind::MissingOnDest,
                                verifier: None,
                                unverifiable: false,
                                detail: "present on source, absent on destination".to_string(),
                            },
                        );
                        s.next();
                    }
                    std::cmp::Ordering::Greater => {
                        out.orphan_on_dest += 1;
                        push_capped(
                            &mut out.orphan_samples,
                            ParityFinding {
                                key: (*dk).clone(),
                                kind: FindingKind::OrphanOnDest,
                                verifier: None,
                                unverifiable: false,
                                detail: "present on destination, absent on source".to_string(),
                            },
                        );
                        d.next();
                    }
                }
            }
            (Some((sk, _)), None) => {
                out.missing_on_dest += 1;
                push_capped(
                    &mut out.missing_samples,
                    ParityFinding {
                        key: (*sk).clone(),
                        kind: FindingKind::MissingOnDest,
                        verifier: None,
                        unverifiable: false,
                        detail: "present on source, absent on destination".to_string(),
                    },
                );
                s.next();
            }
            (None, Some((dk, _))) => {
                out.orphan_on_dest += 1;
                push_capped(
                    &mut out.orphan_samples,
                    ParityFinding {
                        key: (*dk).clone(),
                        kind: FindingKind::OrphanOnDest,
                        verifier: None,
                        unverifiable: false,
                        detail: "present on destination, absent on source".to_string(),
                    },
                );
                d.next();
            }
            (None, None) => break,
        }
    }
    out
}

fn push_capped(v: &mut Vec<ParityFinding>, f: ParityFinding) {
    if v.len() < SAMPLE_CAP {
        v.push(f);
    }
}

/// The serialized audit verdict consumed by the frontend.
#[derive(Debug, Clone, Serialize)]
pub struct ParityOutcome {
    pub rule_name: String,
    pub source_bucket: String,
    pub dest_bucket: String,
    pub source_objects: u64,
    pub dest_objects: u64,
    pub matched: u64,
    pub missing_on_dest: u64,
    pub orphan_on_dest: u64,
    pub checksum_mismatch: u64,
    pub unverifiable: u64,
    pub truncated: bool,
    /// The signal: strict — `unverifiable` counts against it.
    pub in_sync: bool,
    pub scanned_at: i64,
    pub missing_samples: Vec<ParityFinding>,
    pub orphan_samples: Vec<ParityFinding>,
    pub mismatch_samples: Vec<ParityFinding>,
}

/// True when an object listed under a prefix is an internal/marker key we
/// never replicate (so we never count it as an orphan on the dest side).
fn is_skippable_key(key: &str) -> bool {
    key.ends_with('/') || key.starts_with(".deltaglider/") || key.contains("/.deltaglider/")
}

/// Async driver: list both sides, diff, build the outcome.
///
/// SOURCE is filtered through `should_replicate` so the audit covers
/// EXACTLY what replication acts on; each source key is rewritten into the
/// dest namespace. DEST is listed with the same marker/internal skip (but
/// not the source globs — an excluded-but-present dest object is a genuine
/// orphan). Caps total scanned at `MAX_PARITY_OBJECTS`; `truncated=true`
/// rather than hang for huge buckets.
pub async fn parity_audit(
    engine: &DynEngine,
    rule: &ReplicationRule,
    max_objects: usize,
) -> Result<ParityOutcome, String> {
    let (inc, exc) = compile_rule_globs(rule).map_err(|e| e.to_string())?;
    let source_prefix = normalize_prefix(&rule.source.prefix);
    let dest_prefix = normalize_prefix(&rule.destination.prefix);

    let mut source: BTreeMap<String, ObjState> = BTreeMap::new();
    let mut dest: BTreeMap<String, ObjState> = BTreeMap::new();
    let mut truncated = false;
    let mut total: usize = 0;

    // --- Scan SOURCE ---
    let mut pager = crate::job_loop::Pager::fresh();
    'src_pages: while let Some(_page) = pager.begin_page() {
        let page = engine
            .list_objects(
                &rule.source.bucket,
                &source_prefix,
                None,
                PAGE_SIZE,
                pager.token(),
                true,
            )
            .await
            .map_err(|e| format!("list source page failed: {e}"))?;
        for (key, meta) in &page.objects {
            if total >= max_objects {
                truncated = true;
                break 'src_pages;
            }
            // Keep only what replication would act on (dir markers, internal
            // keys, glob excludes all filtered here).
            let decision =
                should_replicate(key, meta, None, ConflictPolicy::SourceWins, &inc, &exc);
            if !matches!(decision, Decision::Copy { .. }) {
                continue;
            }
            let dest_key = rewrite_key(&rule.source.prefix, &rule.destination.prefix, key)
                .map_err(|e| e.to_string())?;
            source.insert(dest_key, ObjState::from_metadata(meta));
            total += 1;
        }
        if !pager.advance(page.is_truncated, page.next_continuation_token) {
            break;
        }
    }
    if pager.truncated_by_page_budget() {
        truncated = true;
    }

    // --- Scan DEST ---
    let mut pager = crate::job_loop::Pager::fresh();
    'dst_pages: while let Some(_page) = pager.begin_page() {
        let page = engine
            .list_objects(
                &rule.destination.bucket,
                &dest_prefix,
                None,
                PAGE_SIZE,
                pager.token(),
                true,
            )
            .await
            .map_err(|e| format!("list dest page failed: {e}"))?;
        for (key, meta) in &page.objects {
            if total >= max_objects {
                truncated = true;
                break 'dst_pages;
            }
            if is_skippable_key(key) {
                continue;
            }
            dest.insert(key.clone(), ObjState::from_metadata(meta));
            total += 1;
        }
        if !pager.advance(page.is_truncated, page.next_continuation_token) {
            break;
        }
    }
    if pager.truncated_by_page_budget() {
        truncated = true;
    }

    if truncated {
        warn!(
            "parity audit for rule '{}' hit the scan cap ({} objects) — result is partial",
            rule.name, max_objects
        );
    }

    let source_objects = source.len() as u64;
    let dest_objects = dest.len() as u64;
    let diff = diff_parity(&source, &dest);

    let in_sync = !truncated
        && diff.missing_on_dest == 0
        && diff.orphan_on_dest == 0
        && diff.checksum_mismatch == 0
        && diff.unverifiable == 0;

    Ok(ParityOutcome {
        rule_name: rule.name.clone(),
        source_bucket: rule.source.bucket.clone(),
        dest_bucket: rule.destination.bucket.clone(),
        source_objects,
        dest_objects,
        matched: diff.matched,
        missing_on_dest: diff.missing_on_dest,
        orphan_on_dest: diff.orphan_on_dest,
        checksum_mismatch: diff.checksum_mismatch,
        unverifiable: diff.unverifiable,
        truncated,
        in_sync,
        scanned_at: super::current_unix_seconds(),
        missing_samples: diff.missing_samples,
        orphan_samples: diff.orphan_samples,
        mismatch_samples: diff.mismatch_samples,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn st(sha: Option<&str>, size: u64, etag: Option<&str>, parts: Option<u32>) -> ObjState {
        ObjState {
            sha256: sha.map(|s| s.to_string()),
            size,
            etag: etag.map(|s| s.to_string()),
            multipart_parts: parts,
        }
    }

    // ─────────────── compare_pair truth table ───────────────

    #[test]
    fn both_sha_equal_is_strong_match() {
        let a = st(Some("abc"), 10, Some("e1"), None);
        let (kind, v, unver, _) = compare_pair(&a, &a);
        assert_eq!(kind, FindingKind::Match);
        assert_eq!(v, Some(Verifier::Sha256));
        assert!(!unver);
    }

    #[test]
    fn sha_differ_is_mismatch() {
        let a = st(Some("abc"), 10, None, None);
        let b = st(Some("xyz"), 10, None, None);
        let (kind, v, _, _) = compare_pair(&a, &b);
        assert_eq!(kind, FindingKind::ChecksumMismatch);
        assert_eq!(v, Some(Verifier::Sha256));
    }

    #[test]
    fn size_differ_is_always_mismatch_no_verifier() {
        let a = st(Some("abc"), 10, Some("e1"), None);
        let b = st(Some("abc"), 11, Some("e1"), None);
        let (kind, v, unver, _) = compare_pair(&a, &b);
        assert_eq!(kind, FindingKind::ChecksumMismatch);
        assert_eq!(v, None);
        assert!(!unver);
    }

    #[test]
    fn etag_equal_match_when_sha_missing_one_side() {
        // dst is foreign (no sha) but both have a matching etag + equal size.
        let a = st(Some("abc"), 10, Some("etag-1"), None);
        let b = st(None, 10, Some("etag-1"), None);
        let (kind, v, unver, _) = compare_pair(&a, &b);
        assert_eq!(kind, FindingKind::Match);
        assert_eq!(v, Some(Verifier::EtagSize));
        assert!(!unver);
    }

    #[test]
    fn etag_differ_at_equal_size_is_mismatch() {
        let a = st(None, 10, Some("etag-a"), None);
        let b = st(None, 10, Some("etag-b"), None);
        let (kind, v, _, _) = compare_pair(&a, &b);
        assert_eq!(kind, FindingKind::ChecksumMismatch);
        assert_eq!(v, Some(Verifier::EtagSize));
    }

    #[test]
    fn multipart_partcount_mismatch_demotes_to_size_only() {
        // Same etag string is impossible across differing part counts, but the
        // demotion must fire BEFORE the etag compare: differing parts can't
        // prove equality, so we fall to size-only → unverifiable match.
        let a = st(None, 10, Some("e-2"), Some(2));
        let b = st(None, 10, Some("e-3"), Some(3));
        let (kind, v, unver, _) = compare_pair(&a, &b);
        assert_eq!(kind, FindingKind::Match);
        assert_eq!(v, Some(Verifier::SizeOnly));
        assert!(unver);
    }

    #[test]
    fn size_only_match_is_unverifiable() {
        // Both foreign, no etag either → size only.
        let a = st(None, 10, None, None);
        let b = st(None, 10, None, None);
        let (kind, v, unver, _) = compare_pair(&a, &b);
        assert_eq!(kind, FindingKind::Match);
        assert_eq!(v, Some(Verifier::SizeOnly));
        assert!(unver);
    }

    #[test]
    fn foreign_empty_sha_both_sides_falls_to_etag_then_size() {
        // Both have etags → etag tier even though both sha empty.
        let a = st(None, 5, Some("z"), None);
        let b = st(None, 5, Some("z"), None);
        let (kind, v, _, _) = compare_pair(&a, &b);
        assert_eq!(kind, FindingKind::Match);
        assert_eq!(v, Some(Verifier::EtagSize));
    }

    // ─────────────── diff_parity ───────────────

    fn map(pairs: &[(&str, ObjState)]) -> BTreeMap<String, ObjState> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect()
    }

    #[test]
    fn diff_all_match() {
        let s = map(&[
            ("a", st(Some("h"), 1, None, None)),
            ("b", st(Some("h2"), 2, None, None)),
        ]);
        let d = s.clone();
        let r = diff_parity(&s, &d);
        assert_eq!(r.matched, 2);
        assert_eq!(r.missing_on_dest, 0);
        assert_eq!(r.orphan_on_dest, 0);
        assert_eq!(r.checksum_mismatch, 0);
        assert_eq!(r.unverifiable, 0);
    }

    #[test]
    fn diff_one_missing() {
        let s = map(&[
            ("a", st(Some("h"), 1, None, None)),
            ("b", st(Some("h2"), 2, None, None)),
        ]);
        let d = map(&[("a", st(Some("h"), 1, None, None))]);
        let r = diff_parity(&s, &d);
        assert_eq!(r.matched, 1);
        assert_eq!(r.missing_on_dest, 1);
        assert_eq!(r.missing_samples.len(), 1);
        assert_eq!(r.missing_samples[0].key, "b");
    }

    #[test]
    fn diff_one_orphan() {
        let s = map(&[("a", st(Some("h"), 1, None, None))]);
        let d = map(&[
            ("a", st(Some("h"), 1, None, None)),
            ("z", st(Some("h3"), 3, None, None)),
        ]);
        let r = diff_parity(&s, &d);
        assert_eq!(r.matched, 1);
        assert_eq!(r.orphan_on_dest, 1);
        assert_eq!(r.orphan_samples[0].key, "z");
    }

    #[test]
    fn diff_one_mismatch() {
        let s = map(&[("a", st(Some("h"), 1, None, None))]);
        let d = map(&[("a", st(Some("DIFFERENT"), 1, None, None))]);
        let r = diff_parity(&s, &d);
        assert_eq!(r.checksum_mismatch, 1);
        assert_eq!(r.matched, 0);
        assert_eq!(r.mismatch_samples[0].key, "a");
    }

    #[test]
    fn diff_empty_empty() {
        let r = diff_parity(&BTreeMap::new(), &BTreeMap::new());
        assert_eq!(r, ParityDiff::default());
    }

    #[test]
    fn diff_source_empty_all_orphan() {
        let d = map(&[
            ("a", st(Some("h"), 1, None, None)),
            ("b", st(Some("h2"), 2, None, None)),
        ]);
        let r = diff_parity(&BTreeMap::new(), &d);
        assert_eq!(r.orphan_on_dest, 2);
        assert_eq!(r.missing_on_dest, 0);
    }

    #[test]
    fn diff_dest_empty_all_missing() {
        let s = map(&[
            ("a", st(Some("h"), 1, None, None)),
            ("b", st(Some("h2"), 2, None, None)),
        ]);
        let r = diff_parity(&s, &BTreeMap::new());
        assert_eq!(r.missing_on_dest, 2);
        assert_eq!(r.orphan_on_dest, 0);
    }

    #[test]
    fn diff_unverifiable_accounting() {
        // One size-only match (unverifiable), one sha match (verifiable).
        let s = map(&[
            ("a", st(None, 1, None, None)),
            ("b", st(Some("h"), 2, None, None)),
        ]);
        let d = map(&[
            ("a", st(None, 1, None, None)),
            ("b", st(Some("h"), 2, None, None)),
        ]);
        let r = diff_parity(&s, &d);
        assert_eq!(r.matched, 2);
        assert_eq!(r.unverifiable, 1);
    }

    #[test]
    fn diff_sample_caps_at_100() {
        let mut s: BTreeMap<String, ObjState> = BTreeMap::new();
        for i in 0..250 {
            s.insert(format!("k{i:04}"), st(Some("h"), 1, None, None));
        }
        let r = diff_parity(&s, &BTreeMap::new());
        assert_eq!(r.missing_on_dest, 250, "exact count is unbounded");
        assert_eq!(r.missing_samples.len(), SAMPLE_CAP, "samples capped at 100");
    }

    // ─────────────── proptest ───────────────

    fn arb_objstate() -> impl Strategy<Value = ObjState> {
        (
            prop::option::of("[a-f0-9]{4}"),
            0u64..1000,
            prop::option::of("[a-z0-9]{1,5}"),
            prop::option::of(1u32..5),
        )
            .prop_map(|(sha, size, etag, parts)| ObjState {
                sha256: sha,
                size,
                etag,
                multipart_parts: parts,
            })
    }

    fn arb_map() -> impl Strategy<Value = BTreeMap<String, ObjState>> {
        prop::collection::btree_map("k[0-9]{1,3}", arb_objstate(), 0..30)
    }

    proptest! {
        #[test]
        fn counts_partition_key_union_exactly_once(s in arb_map(), d in arb_map()) {
            let r = diff_parity(&s, &d);
            // Every key in the union lands in exactly one of: matched+mismatch
            // (intersection), missing (source-only), orphan (dest-only).
            let union: std::collections::BTreeSet<&String> =
                s.keys().chain(d.keys()).collect();
            let intersection = s.keys().filter(|k| d.contains_key(*k)).count() as u64;
            let source_only = s.keys().filter(|k| !d.contains_key(*k)).count() as u64;
            let dest_only = d.keys().filter(|k| !s.contains_key(*k)).count() as u64;

            prop_assert_eq!(r.matched + r.checksum_mismatch, intersection);
            prop_assert_eq!(r.missing_on_dest, source_only);
            prop_assert_eq!(r.orphan_on_dest, dest_only);
            prop_assert_eq!(
                r.matched + r.checksum_mismatch + r.missing_on_dest + r.orphan_on_dest,
                union.len() as u64
            );
            // unverifiable is a subset of matched.
            prop_assert!(r.unverifiable <= r.matched);
        }

        #[test]
        fn samples_never_exceed_cap(s in arb_map(), d in arb_map()) {
            let r = diff_parity(&s, &d);
            prop_assert!(r.missing_samples.len() <= SAMPLE_CAP);
            prop_assert!(r.orphan_samples.len() <= SAMPLE_CAP);
            prop_assert!(r.mismatch_samples.len() <= SAMPLE_CAP);
        }

        #[test]
        fn in_sync_iff_all_zero_and_not_truncated(
            s in arb_map(), d in arb_map(), truncated in any::<bool>()
        ) {
            let r = diff_parity(&s, &d);
            let in_sync = !truncated
                && r.missing_on_dest == 0
                && r.orphan_on_dest == 0
                && r.checksum_mismatch == 0
                && r.unverifiable == 0;
            let all_clean = r.missing_on_dest == 0
                && r.orphan_on_dest == 0
                && r.checksum_mismatch == 0
                && r.unverifiable == 0;
            prop_assert_eq!(in_sync, !truncated && all_clean);
        }
    }

    #[test]
    fn objstate_parses_multipart_part_count() {
        let mut m =
            FileMetadata::new_passthrough("x".into(), "sha".into(), "md5val".into(), 7, None);
        m.multipart_etag = Some("deadbeef-4".to_string());
        let st = ObjState::from_metadata(&m);
        assert_eq!(st.sha256.as_deref(), Some("sha"));
        assert_eq!(st.etag.as_deref(), Some("deadbeef-4"));
        assert_eq!(st.multipart_parts, Some(4));
        assert_eq!(st.size, 7);
    }

    #[test]
    fn objstate_foreign_object_has_no_sha_but_keeps_md5_etag() {
        use crate::types::StorageInfo;
        let m = FileMetadata::fallback(
            "x".into(),
            12,
            "md5val".into(),
            chrono::Utc::now(),
            None,
            StorageInfo::Passthrough,
        );
        let st = ObjState::from_metadata(&m);
        assert_eq!(st.sha256, None);
        assert_eq!(st.etag.as_deref(), Some("md5val"));
        assert_eq!(st.multipart_parts, None);
    }
}
