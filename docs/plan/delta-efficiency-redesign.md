# Delta Efficiency Panel — redesign proposal

Author: senior product design
Status: proposal, awaiting approval
Targets: `demo/s3-browser/ui/src/components/DeltaEfficiencyPanel.tsx`,
`src/api/admin/delta_efficiency.rs`

---

## 1. What's wrong with the current display

`DeltaEfficiencyPanel.tsx`:

- **L290–356 (`ReportsTable`) is a 10-column flat HTML table sorted
  worst-first.** Every prefix gets one row. On 141 ReadonlyREST
  versions that's 141 lines of monospace text — the eye cannot see
  that 1.34–1.40 form a *cliff* and that 1.14.1 / 1.16.7 / 1.28.1 are
  *isolated outliers*. Both look identical: a single "Fair" tag in a
  sea of "Excellent".
- **L162–179 summary** counts verdicts and a `totalWasted` for
  poor/no-ref only. It hides the most informative quantity — the
  **ratio distribution** — and it can't surface "8 of 141 prefixes
  regressed in the last week" because the panel has no time axis.
- **L304–314 column choice is engineer-shaped, not operator-shaped.**
  Reference bytes, median, max, total stored, original, saved,
  explanation — seven numeric columns for one decision ("re-baseline?").
  The actual decision driver (`median / reference` *ratio*) is
  computable from two of them but never shown directly.
- **L318: `key={bucket/prefix}` and L322 `prefix`** is the whole UI for
  identity. There is no version axis even though prefixes here are
  conventionally `…/builds/1.34.0/…`. The cliff is invisible.
- **L252–272 verdict-count tags repeat what the table already shows**
  and steal the most valuable horizontal real estate from the actual
  finding. `≈ 22 GB wasted` is great; the five-colour `5 poor / 12 fair
  / …` chip row is noise.
- **No filter / no sort UI.** The operator who lands here wanting to
  see *only the 6 prefixes that regressed* has to eyeball 141 rows.

## 2. What the operator is actually doing

Job-to-be-done, in order:

1. **Triage** — is anything broken in this bucket right now?
2. **Locate** — which prefix family?
3. **Diagnose timing** — when did it start regressing? Was it one
   release (one-off) or a sustained shift (cliff)?
4. **Decide** — re-baseline by re-uploading? Split prefix? Ignore?

The current table answers #1 and #2 and is silent on #3 and #4.
**#3 is the most valuable signal we are throwing away.** A 6× ratio
cliff that holds for six consecutive minor versions reads completely
differently from a single 2.4× dip surrounded by 48× neighbours, and
the right action is opposite (re-baseline a *family* vs. accept one
unlucky release).

## 3. Proposed layout

Single page, three horizontal bands, top to bottom. Above the fold
must answer Q1 (is anything wrong?) and Q2 (where?).

```
┌─ Controls (unchanged: bucket picker, min-deltas, Scan/Re-scan) ─┐
├─ A. HEALTH HEADLINE  (1 line, 60px tall) ──────────────────────┤
│   "6 prefixes regressed · est. 2.1 GB recoverable · 135 OK"    │
├─ B. RATIO TIMELINE  (the new hero, 280px tall) ────────────────┤
│   X = lexicographic prefix order (≈ version order)             │
│   Y = log10(ratio) — one dot per prefix, colour = verdict       │
│   Threshold lines at 3× (red), 10× (amber), 50× (green)        │
│   Brush selector at bottom; hover = prefix + ratio + verdict   │
├─ C. PREFIX DETAIL  (drilled-down table, only when row picked) ─┤
│   Replaces today's flat table. See §4.                          │
└─────────────────────────────────────────────────────────────────┘
```

Component tree (AntD 6 + Recharts):

```
<DeltaEfficiencyPanel>
  <ScanControls />              // bucket / min-deltas / Scan
  <HealthHeadline summary />    // counts + recoverable bytes
  <RatioTimeline                // Recharts <ScatterChart>
     data=reports
     onSelectPrefix=setFocus />
  {focus && (
    <PrefixDetailDrawer         // AntD <Drawer placement="right">
      report=reports[focus]
      onClose=...>
      <RatioPerVersionLine />   // sparkline of per-delta ratios
      <DeltaRollupGrid />       // 6 KPIs in a 3×2 grid
      <SuggestedAction />       // copyable re-upload command
    </PrefixDetailDrawer>
  )}
</DeltaEfficiencyPanel>
```

## 4. Key visualization choices

**Band A — Health Headline.** One sentence. Counts only the
**actionable** verdicts (poor + no-reference). Drops the rainbow tag
strip. Format:

> `<bucket>` — **6 prefixes regressed** · est. **2.1 GB**
> recoverable · 135 OK · scanned 2 min ago · `[Re-scan]`

**Band B — Ratio Timeline (the hero).** Recharts `<ScatterChart>`,
log-Y. One dot per prefix. X axis labelled by prefix string, but the
ordering is whatever the server returns (currently
`list_deltaspaces` natural order, which IS lexicographic == roughly
version order for `1.x.y` releases). Threshold reference lines via
`<ReferenceLine y=3>` (poor, red), `y=10` (fair, amber), `y=50`
(green). This makes the v1.34 cliff a visible *step down* and the
1.28.1 outlier a visible *single point dip*. Colour = `efficiency`
verdict, same palette as today.

Why scatter not bar: a bar chart with 141 bars is unreadable; a
scatter on log-Y separates the steady-state band (17–76×) from the
problem area (3–7×) with maximum visual contrast.

Brush selector beneath the chart lets the operator zoom to `1.30–1.40`
when they want to see the cliff in detail.

**Band C — Prefix Detail Drawer.** Opens when a dot is clicked.
Replaces the flat 10-column table. Inside:

- **6-KPI grid** (replaces 7 of today's columns): Ratio (big number,
  the headline metric), Deltas (n=49), Reference size, Median delta,
  Wasted bytes, Verdict tag.
- **Per-version ratio line chart** — small Recharts line of
  `delta_size / reference_size` for each delta in the prefix, ordered
  by `created_at`. Lets the operator see whether ratio drift inside a
  *single* prefix happened mid-way (the bisect signal).
- **Suggested action** — copyable `aws s3 cp --recursive ... | ...`
  one-liner, gated behind a "Show command" disclosure. Today's
  `explanation` text moves here too, demoted from a column.

**Sort and filter defaults:**
- Timeline: no sort UI — the X axis IS the sort. Add a `Filter:
  Regressed only` toggle that dims dots above the 10× line.
- Drawer: per-version chart sorts by `created_at` ascending.

## 5. Backend data the new design needs

The current `DeltaspaceReport` (in `src/api/admin/delta_efficiency.rs`
L168–185) gives us **median / max / total** per prefix. The new design
needs two additions:

1. **`ratio_median: f64`** — already computable on the server
   (`median_delta_bytes / reference_bytes`), but doing the division
   client-side is fine.
2. **`per_delta: Vec<{ key: String, created_at: DateTime<Utc>,
   delta_bytes: u64, ratio: f64 }>` (optional, only populated when
   `?detail=true`)** — needed for Band C's per-version line. The
   server **already has this data** inside `do_scan` (L364–377 already
   iterates `scan` of `FileMetadata`) — it just discards everything
   except the size aggregate. Returning it gated on `?detail=true`
   keeps the default response small. Per-prefix payload would grow
   from ~500 bytes to ~150 bytes × `deltas`, so a 49-delta prefix is
   ~7.5 KB — fine for an on-demand drawer fetch.

If the parallel backend optimisation is touching this code path, we
should land both fields in the same change to avoid a v2 dance.

`scanned_at` per prefix would be nice (it's the cache `computed_at`
today, identical for all rows). Not required for v1.

## 6. What we deliberately drop

- **The five-colour verdict count chip row** (L262–266). Replaced by
  the Headline's single actionable count. The Timeline shows
  distribution visually.
- **Three columns from the flat table**: `Reference`, `Max delta`,
  `Total stored`. Power users get them in the drawer; the table view
  is gone entirely.
- **`Original` and `Saved` columns** (L341–346). Useful in the
  per-bucket cost dashboard (`AnalyticsSection`) — wrong place for
  *diagnostics*. Saved bytes does not help you decide whether to
  re-baseline; ratio does.
- **The `Refresh` button next to `Re-scan`** (L213–230). One CTA. If
  the result is cached, a single button labelled `Re-scan (cached
  2m ago)` is clearer than two adjacent buttons that do almost the
  same thing.
- **`Excellent` count in the headline.** The operator never lands on
  this page to celebrate.

## 7. Out of scope for this redesign

- Cross-bucket overview (today's panel is bucket-scoped; keep it).
- Auto re-baselining ("read-only diagnostic" is a feature, not a gap).
- Historical timeline of scans (would need persisted scan history;
  big lift; defer).
