/**
 * AnalyticsSection — cost + storage savings view.
 *
 * Shares the DashboardGrid / Panel primitives with MetricsPage so
 * both tabs read as one tool. Four rows:
 *   - Scan-status banner: cache age + Re-scan-all / Stop controls.
 *   - KPI strip: Total Storage · Space Saved · Savings % · Est. Monthly Savings.
 *   - Storage by bucket horizontal bar + Top-5 table.
 *   - Session savings time-series + Compression opportunities.
 *
 * Data path (post v0.10):
 *   - On mount, call `getAllBucketScans()` once. That returns every
 *     bucket the server has a cached scan for, loaded from
 *     `.deltaglider_scans/<bucket>.json` on disk — survives restarts.
 *     KPIs render IMMEDIATELY off this cache; no spinner unless
 *     truly cold.
 *   - In parallel, `listBuckets()` learns the FULL bucket roster so
 *     we know which buckets have NO cache yet ("unscanned").
 *   - The user can click **Re-scan all** to walk every bucket
 *     sequentially via SSE. Each bucket streams progress; on `done`
 *     we re-pull `getAllBucketScans()` so the panels reflect the
 *     newly-persisted totals. The next bucket in the queue starts.
 *   - **Stop** cancels the bucket that's currently streaming. The
 *     queue is dropped. Whatever was already persisted stays
 *     persisted — there is no "rollback".
 *
 * No TTL: S3 is write-mostly, the cache is fine until the user
 * explicitly re-scans. The banner shows oldest + newest scan age so
 * staleness is never invisible.
 */
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Button } from 'antd';
import { XAxis, YAxis, ResponsiveContainer, Tooltip as RechartsTooltip, AreaChart, Area } from 'recharts';
import { ClockCircleOutlined, PlayCircleOutlined, StopOutlined, ReloadOutlined } from '@ant-design/icons';
import { useColors } from '../ThemeContext';
import { listBuckets } from '../s3client';
import type { AdminConfig } from '../adminApi';
import {
  getAllBucketScans,
  startBucketScan,
  stopBucketScan,
  subscribeBucketScan,
  type BucketScanResult,
  type BucketScanProgress,
} from '../adminApi';
import { formatBytes, ageLabel, dotPattern } from '../utils';
import { summarizeScopeSavings } from '../savings';
import DashboardGrid from './dashboard/DashboardGrid';
import Panel from './dashboard/Panel';
import { CHART_PALETTE, chartTooltipStyle, axisTickStyle, fmtNum } from './dashboard/chartDefaults';
import HeroSavingsPanel from './HeroSavingsPanel';
import ByTheNumbersGrid from './ByTheNumbersGrid';
import FleetHealthGauge from './FleetHealthGauge';
import TopBucketsSortSelect from './TopBucketsSortSelect';
import { SORT_LABELS, type TopBucketsSortKey } from './topBucketsSort';

/** Row shape consumed by chart + table. Derived from cache + live progress. */
export interface BucketRow {
  bucket: string;
  totalOriginal: number;
  totalStored: number;
  savings: number;
  savingsPercent: number;
  objectCount: number;
  /** ISO completion date — null when this bucket has no cached scan yet. */
  completedAt: string | null;
  /** True while this bucket's SSE feed is open. */
  scanning: boolean;
  /** Per-bucket live progress, only set while `scanning`. */
  progress?: BucketScanProgress;
}

interface Props {
  config: AdminConfig | null;
}

// COST_PRESETS now lives in HeroSavingsPanel.tsx (sole consumer).

export default function AnalyticsSection({ config }: Props) {
  const colors = useColors();
  const tt = chartTooltipStyle(colors);

  /**
   * The two state slices that together define the analytics view:
   *   - `scans` is the disk-backed cache (server-persisted). Source
   *     of truth for "what totals do I display".
   *   - `liveProgress` is the SSE frame for whatever bucket is being
   *     scanned RIGHT NOW. Renders the per-row pulse and overrides
   *     that one bucket's totals until its scan completes.
   *   - `queue` is the list of buckets remaining in a "Re-scan all"
   *     fan-out. The head of the queue is what `liveProgress` is
   *     tracking; on `done` we shift it and start the next.
   */
  const [scans, setScans] = useState<Record<string, BucketScanResult>>({});
  const [scansLoaded, setScansLoaded] = useState(false);
  const [allBuckets, setAllBuckets] = useState<string[]>([]);
  const [liveProgress, setLiveProgress] = useState<BucketScanProgress | null>(
    null,
  );
  const [queue, setQueue] = useState<string[]>([]);
  /**
   * Top-buckets sort key. Persisted to localStorage so the operator's
   * preference survives reloads — repeatedly re-picking "savings" each
   * visit gets annoying.
   */
  const [topBucketsSort, setTopBucketsSort] = useState<TopBucketsSortKey>(() => {
    const saved = typeof localStorage !== 'undefined' && localStorage.getItem('dgp-top-sort');
    return (saved as TopBucketsSortKey) ?? 'original';
  });
  useEffect(() => {
    if (typeof localStorage !== 'undefined') localStorage.setItem('dgp-top-sort', topBucketsSort);
  }, [topBucketsSort]);
  const unsubRef = useRef<(() => void) | null>(null);

  const [costRate, setCostRate] = useState(() => {
    const saved = localStorage.getItem('dg-cost-per-gb');
    return saved ? parseFloat(saved) : 0.00524;
  });
  // The cost-rate cog popover (and the COST_PRESETS list, and the
  // localStorage setter) all live inside HeroSavingsPanel now —
  // AnalyticsSection just owns the rate value + the save callback so
  // the hero panel can swap presets.

  /**
   * Live scan timeline — one point per SSE frame for the bucket
   * currently being scanned. Resets when a new bucket starts.
   * Powers the "Scan progress" chart that replaces the old session-
   * savings chart (which only made sense for the polling-based
   * /stats fetch we just removed).
   */
  const [scanTimeline, setScanTimeline] = useState<
    Array<{ time: string; objects: number; bytes: number }>
  >([]);

  useEffect(() => {
    if (!liveProgress) {
      setScanTimeline([]);
      return;
    }
    setScanTimeline(prev => {
      const now = new Date().toLocaleTimeString([], {
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      });
      // Reset the timeline when a new bucket takes over.
      if (prev.length > 0 && liveProgress.objects < prev[prev.length - 1].objects) {
        return [{ time: now, objects: liveProgress.objects, bytes: liveProgress.original_bytes }];
      }
      return [...prev, {
        time: now,
        objects: liveProgress.objects,
        bytes: liveProgress.original_bytes,
      }].slice(-60); // keep the last minute-or-so of frames
    });
  }, [liveProgress]);

  const saveCostRate = (rate: number) => {
    setCostRate(rate);
    localStorage.setItem('dg-cost-per-gb', String(rate));
  };

  /**
   * Pull the persisted scan map from the server. Idempotent; cheap.
   * Called on mount, on focus, every 30s (to catch cross-tab work),
   * and after each bucket's scan finishes so the panels reflect the
   * fresh per-bucket totals.
   */
  const refreshScans = useCallback(async () => {
    try {
      const res = await getAllBucketScans();
      setScans(res.buckets);
    } catch {
      // Non-fatal: keep whatever's already on screen.
    } finally {
      setScansLoaded(true);
    }
  }, []);

  // Initial load: bucket list + persisted scans, in parallel.
  useEffect(() => {
    refreshScans();
    listBuckets()
      .then(bs => setAllBuckets(bs.map(b => b.name)))
      .catch(() => setAllBuckets([]));
    const id = window.setInterval(refreshScans, 30_000);
    return () => window.clearInterval(id);
  }, [refreshScans]);

  // Tear down any SSE on unmount so we don't leak listeners.
  useEffect(() => {
    return () => {
      if (unsubRef.current) unsubRef.current();
      unsubRef.current = null;
    };
  }, []);

  /**
   * Wire SSE for a single bucket. On terminal frame, refresh the
   * cache map and shift the queue head — the next effect tick picks
   * up the new head and continues.
   */
  const subscribe = useCallback((bucket: string) => {
    if (unsubRef.current) unsubRef.current();
    unsubRef.current = subscribeBucketScan(
      bucket,
      frame => {
        setLiveProgress(frame);
        if (frame.finished) {
          refreshScans();
          setLiveProgress(null);
          setQueue(q => q.slice(1));
          if (unsubRef.current) unsubRef.current();
          unsubRef.current = null;
        }
      },
      () => {
        // Transport error: tear down so we don't show a ghost bar.
        setLiveProgress(null);
        if (unsubRef.current) unsubRef.current();
        unsubRef.current = null;
      },
    );
  }, [refreshScans]);

  // Follow the queue head. Idempotent — start endpoint just attaches
  // to an in-flight scan if one is already running on the server.
  useEffect(() => {
    if (queue.length === 0) return;
    const head = queue[0];
    startBucketScan(head).catch(() => {
      // Drop this bucket and try the next.
      setQueue(q => q.slice(1));
    });
    subscribe(head);
  }, [queue, subscribe]);

  /**
   * Default action: scan only the buckets that aren't yet cached.
   * Re-running a full scan on a bucket we already have data for is
   * the wasteful pattern this persistent cache exists to avoid (the
   * "beshu" bucket here is 1.4 TB on Hetzner — 30+ min round trip).
   * If everything is already scanned, we fall through to the
   * explicit "Re-scan all" path below.
   */
  const handleScanMissing = useCallback(() => {
    const missing = allBuckets.filter(b => !scans[b]);
    if (missing.length === 0) return;
    setQueue(missing);
  }, [allBuckets, scans]);

  /**
   * Explicit "really redo every bucket" action — only surfaced when
   * the cache is already complete. Useful when the operator suspects
   * the underlying data drifted and wants fresh numbers.
   */
  const handleRescanAll = useCallback(() => {
    if (allBuckets.length === 0) return;
    setQueue(allBuckets);
  }, [allBuckets]);

  /**
   * Scan a single bucket on demand. Used by the per-row Re-scan
   * affordance in the Top Buckets table — operator clicks the row
   * action and only THAT bucket re-runs. Skips the fan-out queue if
   * something else is already running and instead just enqueues this
   * one for after.
   */
  const handleScanOne = useCallback((bucket: string) => {
    setQueue(q => (q.includes(bucket) ? q : [...q, bucket]));
  }, []);

  /**
   * Cancel the currently-running scan if it's THIS bucket. Otherwise
   * remove the bucket from the queued tail.
   */
  const handleStopOne = useCallback((bucket: string) => {
    setQueue(q => {
      if (q[0] === bucket) {
        // Cancel the live one and drop it from the queue. The next
        // queue head will start automatically.
        stopBucketScan(bucket).catch(() => {});
        return q.slice(1);
      }
      return q.filter(b => b !== bucket);
    });
  }, []);

  const handleStop = useCallback(() => {
    const head = queue[0];
    if (head) stopBucketScan(head).catch(() => {});
    setQueue([]);
    setLiveProgress(null);
    if (unsubRef.current) unsubRef.current();
    unsubRef.current = null;
  }, [queue]);

  /**
   * Synthesise per-bucket rows from the cache map + live progress.
   * The "scanning" flag lights up the row whose SSE is open right
   * now (lets the chart paint a subtle progress underline and the
   * table show "scanning…").
   */
  const bucketRows: BucketRow[] = useMemo(() => {
    const rows: BucketRow[] = allBuckets.map(name => {
      const cached = scans[name];
      const isScanning = liveProgress?.bucket === name;
      // While a bucket is being scanned, prefer the LIVE counters so
      // the user sees numbers ticking up rather than yesterday's
      // cached totals.
      const useLive = isScanning && liveProgress;
      const totalOriginal = useLive
        ? liveProgress!.original_bytes
        : (cached?.total_original_bytes ?? 0);
      const totalStored = useLive
        ? liveProgress!.stored_bytes
        : (cached?.total_stored_bytes ?? 0);
      // Route through the canonical scope-savings helper so per-bucket
      // rows share cap + clamp with every other surface. Pre-routing
      // this had its own uncapped formula → a deltaspace with 99.95%
      // raw ratio rendered as 100.0% in the table while the chip
      // (using the helper) showed 99%.
      const scope = summarizeScopeSavings(totalOriginal, totalStored);
      const savings = scope.savedBytes;
      const savingsPercent = scope.pctOneDecimal;
      const objectCount = useLive
        ? liveProgress!.objects
        : (cached?.total_objects ?? 0);
      return {
        bucket: name,
        totalOriginal,
        totalStored,
        savings,
        savingsPercent,
        objectCount,
        completedAt: cached?.completed_at ?? null,
        scanning: !!isScanning,
        progress: isScanning ? liveProgress! : undefined,
      };
    });
    rows.sort((a, b) => b.totalOriginal - a.totalOriginal);
    return rows;
  }, [allBuckets, scans, liveProgress]);

  const totalOriginal = bucketRows.reduce((s, b) => s + b.totalOriginal, 0);
  const totalStored = bucketRows.reduce((s, b) => s + b.totalStored, 0);
  // HeroSavingsPanel + KPI tile + dial all read these. Use the
  // canonical helper for the % — same cap as everything else; use the
  // signed difference for the cost calculation below (which is purely
  // a denomination conversion, not a display).
  const heroSavings = summarizeScopeSavings(totalOriginal, totalStored);
  const totalSavings = heroSavings.savedBytes;
  const savingsPercent = heroSavings.pctOneDecimal;
  const monthlySavings = (totalSavings / (1024 * 1024 * 1024)) * costRate;
  const totalObjects = bucketRows.reduce((s, b) => s + b.objectCount, 0);

  // Cache-age summary: oldest + newest completed_at across cached rows.
  const cachedRows = bucketRows.filter(r => r.completedAt);
  const unscannedCount = bucketRows.length - cachedRows.length;
  const oldestCompletedAt = cachedRows.length
    ? cachedRows.reduce((min, r) =>
        r.completedAt! < min ? r.completedAt! : min, cachedRows[0].completedAt!)
    : null;
  const newestCompletedAt = cachedRows.length
    ? cachedRows.reduce((max, r) =>
        r.completedAt! > max ? r.completedAt! : max, cachedRows[0].completedAt!)
    : null;

  const opportunities = bucketRows.filter(b => {
    const policy =
      config?.bucket_policies?.[b.bucket] ?? config?.bucket_policies?.[b.bucket.toLowerCase()];
    const bucketCompressionOn = policy?.compression ?? true;
    return !bucketCompressionOn && b.totalOriginal > 1024 * 1024;
  });

  // Top-5 table (or fewer if <5 buckets). Renders next to the fleet view.
  /**
   * Resolve a bucket's backend name from the policy map, falling
   * back to the proxy's default_backend. The backend label is shown
   * as a small chip next to the bucket name in Top buckets so the
   * operator can tell at a glance which storage tier a bucket lives
   * on (Hetzner vs AWS vs filesystem etc.).
   */
  const backendOf = (bucket: string): string | null => {
    const policy =
      config?.bucket_policies?.[bucket] ??
      config?.bucket_policies?.[bucket.toLowerCase()];
    return policy?.backend ?? config?.default_backend ?? null;
  };

  /**
   * Sorted top-buckets list. Compares all rows under the chosen
   * sort key — there's no point capping at 5 only to then sort that
   * partial slice. The render still slices to top 5.
   */
  const topBuckets = [...bucketRows]
    .sort((a, b) => {
      switch (topBucketsSort) {
        case 'savings':
          return b.savings - a.savings;
        case 'ratio':
          return b.savingsPercent - a.savingsPercent;
        case 'objects':
          return b.objectCount - a.objectCount;
        case 'recent':
          return (b.completedAt ?? '').localeCompare(a.completedAt ?? '');
        case 'original':
        default:
          return b.totalOriginal - a.totalOriginal;
      }
    })
    .slice(0, 5);

  const isScanning = !!liveProgress || queue.length > 0;

  return (
    <>
      {/*
        Scan-status banner. Lives ABOVE the grid so a "Re-scan in
        progress" pulse doesn't shake the panel heights. The banner
        is the contract with the user:
          - On first paint they see "Cache: N of M buckets · oldest
            scanned X ago". No ghosting, no spinner.
          - Click Re-scan all → banner switches to a live progress
            row with bucket name, objects scanned, bytes seen, Stop.
          - The KPIs and panels below update LIVE per SSE frame so
            you can watch the totals tick up rather than wait for
            the whole bucket to finish.
      */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '10px 14px',
          marginBottom: 12,
          background: colors.BG_CARD,
          border: `1px solid ${colors.BORDER}`,
          borderRadius: 8,
        }}
      >
        <ClockCircleOutlined style={{ color: colors.TEXT_MUTED, fontSize: 14 }} />
        <div style={{ fontSize: 12, color: colors.TEXT_SECONDARY, flex: 1, minWidth: 0 }}>
          {liveProgress ? (
            <>
              <span style={{ color: colors.ACCENT_BLUE, fontWeight: 700 }}>
                Scanning {liveProgress.bucket}
              </span>{' '}
              · {fmtNum(liveProgress.objects)} objects ·{' '}
              {formatBytes(liveProgress.original_bytes)} seen ·{' '}
              {liveProgress.pages_done} pages
              {queue.length > 1 && (
                <span style={{ color: colors.TEXT_MUTED }}>
                  {' '}· {queue.length - 1} more queued
                </span>
              )}
            </>
          ) : cachedRows.length === 0 ? (
            <span>
              No scans yet. Click <strong>Run full scan</strong> — results persist on disk and survive restarts.
            </span>
          ) : (
            <>
              <strong>{cachedRows.length}</strong> of{' '}
              <strong>{bucketRows.length}</strong> buckets scanned · Newest:{' '}
              <span style={{ color: colors.TEXT_PRIMARY }}>{ageLabel(newestCompletedAt)}</span>
              {oldestCompletedAt && oldestCompletedAt !== newestCompletedAt && (
                <>
                  {' '}· Oldest:{' '}
                  <span style={{ color: colors.TEXT_PRIMARY }}>{ageLabel(oldestCompletedAt)}</span>
                </>
              )}
              {unscannedCount > 0 && (
                <span style={{ color: colors.ACCENT_AMBER }}>
                  {' '}· {unscannedCount} unscanned excluded from totals
                </span>
              )}
            </>
          )}
        </div>
        {isScanning ? (
          <Button
            size="small"
            danger
            icon={<StopOutlined />}
            onClick={handleStop}
          >
            Stop
          </Button>
        ) : (
          /*
            Two affordances side-by-side:
            - **Scan missing (N)** is the primary action when any
              bucket is uncached. Doing a full re-scan in that case
              would waste 30+ minutes redoing the 1.4 TB beshu bucket
              just to learn the same number we already have.
            - **Re-scan all** is the explicit "I want fresh numbers
              everywhere" — surfaced as a smaller secondary button.
            When everything is already cached, "Scan missing" hides
            and only "Re-scan all" remains as the primary.
          */
          <div style={{ display: 'flex', gap: 6 }}>
            {unscannedCount > 0 && (
              <Button
                size="small"
                type="primary"
                icon={<PlayCircleOutlined />}
                onClick={handleScanMissing}
                disabled={allBuckets.length === 0 || !scansLoaded}
              >
                Scan missing ({unscannedCount})
              </Button>
            )}
            <Button
              size="small"
              type={unscannedCount === 0 ? 'primary' : 'default'}
              icon={
                cachedRows.length === 0 ? (
                  <PlayCircleOutlined />
                ) : (
                  <ReloadOutlined />
                )
              }
              onClick={handleRescanAll}
              disabled={allBuckets.length === 0 || !scansLoaded}
              title={
                unscannedCount > 0
                  ? 'Force a fresh scan of every bucket, including ones already cached. Expensive — only do this if you suspect data drift.'
                  : undefined
              }
            >
              {cachedRows.length === 0
                ? 'Run full scan'
                : `Re-scan all (${allBuckets.length})`}
            </Button>
          </div>
        )}
      </div>

    <DashboardGrid>
      {/* ── Row 1: HERO ─────────────────────────────────────────
          One 12-col / 3-row panel replaces the old four-card KPI
          strip. The hero composition (HeroSavingsPanel) shows the
          % saved at billboard size, the scale-accurate before/after
          bar, the dollar figure with a count-up animation, and the
          cache-age line — all in one read. Animation fires once per
          session via sessionStorage; honours prefers-reduced-motion.
      */}
      <Panel
        title="Total savings"
        subtitle={
          totalObjects > 0
            ? `${fmtNum(totalObjects)} objects across ${bucketRows.length} bucket${bucketRows.length === 1 ? '' : 's'}`
            : undefined
        }
        colSpan={12}
        rowSpan={3}
        accent="green"
      >
        <HeroSavingsPanel
          totalOriginal={totalOriginal}
          totalStored={totalStored}
          savingsPercent={savingsPercent}
          monthlySavings={monthlySavings}
          costRate={costRate}
          onChangeCostRate={saveCostRate}
          cacheAgeNewest={newestCompletedAt ? ageLabel(newestCompletedAt) : null}
          cacheAgeOldest={oldestCompletedAt ? ageLabel(oldestCompletedAt) : null}
          unscannedCount={unscannedCount}
          liveScanning={!!liveProgress}
        />
      </Panel>

      {/* ── Row 2: Bucket fleet view + Top-5 table ───────────── */}
      {/*
        The old "Storage by bucket" recharts stacked bar collapsed
        into a single line when one bucket dwarfed the rest (beshu @
        1.4 TB next to dgp-conf @ 88 KB → small buckets invisible).
        This replacement gives each bucket TWO bars per row:
         - **Ratio bar** (always full-width): the kept|saved split
           in the same teal+dotted style as the hero panel. Tells the
           viewer "how well is THIS bucket compressing" regardless
           of its absolute size.
         - **Footprint bar** (scale-relative): a thin under-bar
           showing this bucket's original-size share of the largest
           bucket. Preserves the magnitude story.
        Sorted by original size, descending. No overlapping axis
        labels because every bucket name renders ABOVE its row, not
        inside a chart axis.
      */}
      <Panel
        title="Bucket fleet"
        subtitle="Ratio per bucket · footprint relative to largest"
        colSpan={8}
        // Panel height adapts to bucket count: 1 row for 1-2 buckets,
        // 2 rows for 3-6, 3 rows beyond. Avoids the giant empty void
        // beneath the rows when the fleet has only a handful of
        // entries (the rowSpan was always 3 even with 3 buckets).
        rowSpan={(bucketRows.length <= 2 ? 1 : bucketRows.length <= 6 ? 2 : 3) as 1 | 2 | 3}
        empty={bucketRows.length === 0 ? { title: 'No bucket data yet', hint: 'Create a bucket and upload a few objects to populate analytics.' } : undefined}
      >
        {bucketRows.length > 0 && (
          <div
            style={{
              flex: 1,
              minHeight: 0,
              overflow: 'auto',
              display: 'flex',
              flexDirection: 'column',
              // Distribute rows evenly to fill panel height when row
              // count is small — no more dead space at the bottom.
              justifyContent: bucketRows.length <= 4 ? 'space-evenly' : 'flex-start',
              gap: 14,
              paddingRight: 4,
            }}
          >
            {bucketRows.map(b => {
              const isLargest = b.totalOriginal === Math.max(...bucketRows.map(r => r.totalOriginal));
              const maxOriginal = Math.max(1, ...bucketRows.map(r => r.totalOriginal));
              const footprintPct = (b.totalOriginal / maxOriginal) * 100;
              const hasData = b.totalOriginal > 0;
              const keptPct = hasData ? 100 - b.savingsPercent : 0;
              return (
                <div key={b.bucket} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {/* Header: bucket name · ratio % · raw bytes */}
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'baseline',
                      justifyContent: 'space-between',
                      gap: 12,
                      fontFamily: 'var(--font-ui)',
                    }}
                  >
                    <span
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 12,
                        fontWeight: 600,
                        color: colors.TEXT_PRIMARY,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        minWidth: 0,
                        flex: 1,
                      }}
                    >
                      {b.bucket}
                      {isLargest && bucketRows.length > 1 && (
                        <span style={{ marginLeft: 6, fontSize: 9, color: colors.TEXT_FAINT, fontFamily: 'var(--font-ui)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 700 }}>
                          largest
                        </span>
                      )}
                    </span>
                    <span style={{ fontSize: 11, color: colors.TEXT_MUTED, fontVariantNumeric: 'tabular-nums' }}>
                      {hasData ? `${formatBytes(b.totalOriginal)} → ${formatBytes(b.totalStored)}` : '—'}
                    </span>
                    <span
                      style={{
                        fontSize: 13,
                        fontWeight: 700,
                        color: hasData && b.savingsPercent >= 50 ? colors.ACCENT_GREEN : hasData && b.savingsPercent >= 20 ? colors.ACCENT_BLUE_LIGHT : colors.TEXT_PRIMARY,
                        fontVariantNumeric: 'tabular-nums',
                        minWidth: 52,
                        textAlign: 'right',
                      }}
                    >
                      {hasData ? `${b.savingsPercent.toFixed(1)}%` : '—'}
                    </span>
                  </div>
                  {/* Ratio bar — always 100% wide. Communicates compression quality. */}
                  <div
                    style={{
                      width: '100%',
                      height: 14,
                      background: colors.BG_CARD,
                      border: `1px solid ${colors.BORDER}`,
                      borderRadius: 4,
                      overflow: 'hidden',
                      display: 'flex',
                      boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.2)',
                    }}
                    role="img"
                    aria-label={hasData ? `${b.bucket}: ${b.savingsPercent.toFixed(1)}% saved` : `${b.bucket}: no data`}
                  >
                    {hasData && (
                      <>
                        <div
                          style={{
                            width: `${keptPct}%`,
                            background: `linear-gradient(180deg, ${colors.ACCENT_BLUE} 0%, ${colors.ACCENT_BLUE_LIGHT} 100%)`,
                            transition: 'width 0.4s ease-out',
                          }}
                          title={`Kept: ${formatBytes(b.totalStored)}`}
                        />
                        <div
                          style={{
                            width: `${b.savingsPercent}%`,
                            backgroundImage: dotPattern(colors.TEXT_FAINT),
                            transition: 'width 0.4s ease-out',
                          }}
                          title={`Saved: ${formatBytes(b.savings)}`}
                        />
                      </>
                    )}
                  </div>
                  {/* Footprint bar — relative to largest. Magnitude story. */}
                  <div
                    style={{
                      width: '100%',
                      height: 3,
                      background: colors.BG_CARD,
                      borderRadius: 2,
                      overflow: 'hidden',
                    }}
                    title={`${formatBytes(b.totalOriginal)} (${footprintPct.toFixed(1)}% of largest)`}
                  >
                    <div
                      style={{
                        width: `${Math.max(1, footprintPct)}%`,
                        height: '100%',
                        background: colors.TEXT_MUTED,
                        opacity: 0.55,
                        transition: 'width 0.4s ease-out',
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Panel>
      <Panel
        title="Top buckets"
        subtitle={`Sorted by ${SORT_LABELS[topBucketsSort]}`}
        colSpan={4}
        // Mirror Bucket fleet's adaptive height so they end the same
        // row together — no orphan column trailing into empty space.
        rowSpan={(bucketRows.length <= 2 ? 1 : bucketRows.length <= 6 ? 2 : 3) as 1 | 2 | 3}
        empty={topBuckets.length === 0 ? { title: 'No buckets' } : undefined}
        actions={topBuckets.length > 0 ? (
          <TopBucketsSortSelect value={topBucketsSort} onChange={setTopBucketsSort} colors={colors} />
        ) : undefined}
      >
        {topBuckets.length > 0 && (
          <div style={{ flex: 1, overflow: 'auto', fontSize: 12 }}>
            {topBuckets.map((b, i) => (
              <div
                key={b.bucket}
                style={{
                  // Three columns: name + meta · savings/streaming
                  // numerics · per-row action button. The action is
                  // visually quiet (icon-only ghost button) until
                  // hover; we keep it always-visible to avoid the
                  // "where do I click to re-scan this bucket?"
                  // discoverability problem.
                  display: 'grid',
                  gridTemplateColumns: '1fr auto auto',
                  alignItems: 'center',
                  gap: 8,
                  padding: '8px 0',
                  borderTop: i === 0 ? 'none' : `1px solid ${colors.BORDER}`,
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 12,
                    color: colors.TEXT_PRIMARY,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                  }}>
                    {b.bucket}
                    {b.scanning && (
                      <span
                        title="Live scan in progress"
                        style={{
                          width: 6,
                          height: 6,
                          borderRadius: 6,
                          background: colors.ACCENT_BLUE,
                          animation: 'dgScanPulse 1.2s ease-in-out infinite',
                        }}
                      />
                    )}
                    {!b.scanning && !b.completedAt && (
                      <span
                        title="Never scanned — not included in totals"
                        style={{
                          fontSize: 10,
                          color: colors.ACCENT_AMBER,
                          fontFamily: 'var(--font-ui)',
                        }}
                      >
                        unscanned
                      </span>
                    )}
                    {(() => {
                      // Backend chip — shows which named backend the
                      // bucket lives on (Hetzner / AWS / filesystem
                      // etc.). The hover tooltip carries the endpoint
                      // for operators who manage multiple named
                      // backends of the same type.
                      const backendName = backendOf(b.bucket);
                      if (!backendName) return null;
                      const backendMeta = config?.backends?.find(x => x.name === backendName);
                      const tip = backendMeta
                        ? `${backendMeta.backend_type}${backendMeta.endpoint ? ` · ${backendMeta.endpoint}` : ''}`
                        : backendName;
                      return (
                        <span
                          title={tip}
                          style={{
                            fontSize: 9.5,
                            fontWeight: 600,
                            color: colors.TEXT_MUTED,
                            background: colors.BG_CARD,
                            border: `1px solid ${colors.BORDER}`,
                            borderRadius: 3,
                            padding: '1px 5px',
                            fontFamily: 'var(--font-ui)',
                            letterSpacing: '0.02em',
                            textTransform: 'lowercase',
                            cursor: 'help',
                            flexShrink: 0,
                          }}
                        >
                          {backendName}
                        </span>
                      );
                    })()}
                  </div>
                  <div style={{ fontSize: 10.5, color: colors.TEXT_MUTED, marginTop: 2 }}>
                    {/*
                      During a scan the first SSE frame may arrive in
                      <1s but until then `objectCount` is 0; rendering
                      "0 objects · 0 B" is more misleading than
                      "Scanning…" so we suppress numerics in that
                      window. Same logic for the right-hand column.
                    */}
                    {b.scanning && b.objectCount === 0 ? (
                      <span style={{ color: colors.ACCENT_BLUE }}>Scanning…</span>
                    ) : (
                      <>
                        {fmtNum(b.objectCount)} objects · {formatBytes(b.totalOriginal)} original
                        {b.completedAt && (
                          <>
                            {' '}· <span title={new Date(b.completedAt).toLocaleString()}>{ageLabel(b.completedAt)}</span>
                          </>
                        )}
                      </>
                    )}
                  </div>
                </div>
                <div style={{ textAlign: 'right', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, minWidth: 88 }}>
                  {b.scanning && b.objectCount === 0 ? (
                    <div style={{ fontSize: 11, color: colors.TEXT_MUTED, fontStyle: 'italic' }}>
                      streaming
                    </div>
                  ) : (
                    <>
                      <div style={{
                        fontSize: 13,
                        fontWeight: 700,
                        color: b.savingsPercent > 10 ? colors.ACCENT_GREEN : colors.TEXT_PRIMARY,
                        fontFamily: 'var(--font-ui)',
                        fontVariantNumeric: 'tabular-nums',
                      }}>
                        {b.savingsPercent.toFixed(1)}%
                      </div>
                      {/* Tiny inline mini-bar echoing the bigger fleet
                          view — gives the eye a glance-level confirmation
                          of how dramatic this bucket's compression is. */}
                      {b.totalOriginal > 0 && (
                        <div
                          style={{
                            width: 76,
                            height: 4,
                            background: colors.BG_CARD,
                            border: `1px solid ${colors.BORDER}`,
                            borderRadius: 2,
                            overflow: 'hidden',
                            display: 'flex',
                          }}
                        >
                          <div
                            style={{
                              width: `${100 - b.savingsPercent}%`,
                              background: colors.ACCENT_BLUE_LIGHT,
                            }}
                          />
                          <div
                            style={{
                              width: `${b.savingsPercent}%`,
                              backgroundImage: dotPattern(colors.TEXT_FAINT),
                            }}
                          />
                        </div>
                      )}
                      <div style={{ fontSize: 10.5, color: colors.TEXT_MUTED }}>
                        {formatBytes(b.savings)} saved
                      </div>
                    </>
                  )}
                </div>
                {/*
                  Per-row scan affordance. Always visible so users can
                  refresh ONE bucket's totals without re-scanning the
                  multi-TB neighbours. While the bucket is the live SSE
                  target the button becomes Stop; while it's queued
                  (but not yet running) the button cancels its queue
                  entry; otherwise it kicks off a single-bucket scan.
                  Disabled if the bucket is queued behind a different
                  one — clicking again would be a no-op anyway, but
                  showing it disabled signals "already queued".
                */}
                {(() => {
                  const isHeadRunning = b.scanning;
                  const isQueuedNonHead = !isHeadRunning && queue.includes(b.bucket);
                  if (isHeadRunning) {
                    return (
                      <Button
                        size="small"
                        danger
                        icon={<StopOutlined />}
                        onClick={() => handleStopOne(b.bucket)}
                        title={`Stop scanning ${b.bucket}`}
                      />
                    );
                  }
                  if (isQueuedNonHead) {
                    return (
                      <Button
                        size="small"
                        type="default"
                        icon={<StopOutlined />}
                        onClick={() => handleStopOne(b.bucket)}
                        title={`Remove ${b.bucket} from scan queue`}
                      />
                    );
                  }
                  return (
                    <Button
                      size="small"
                      type="text"
                      icon={b.completedAt ? <ReloadOutlined /> : <PlayCircleOutlined />}
                      onClick={() => handleScanOne(b.bucket)}
                      title={
                        b.completedAt
                          ? `Re-scan ${b.bucket} (currently ${ageLabel(b.completedAt)})`
                          : `Scan ${b.bucket}`
                      }
                      disabled={!scansLoaded}
                    />
                  );
                })()}
              </div>
            ))}
          </div>
        )}
      </Panel>

      {/* ── Row 3: By the numbers · Compression health · Live scan ──
          The old row was empty 90% of the time ("No scan running" /
          "Nothing to flag"). Replaced with derived facts that
          ALWAYS have content, plus a live-stream panel that takes
          over the whole row when a scan is actively in flight.
      */}
      {liveProgress ? (
        // Active-scan mode: dedicate the row to the streaming chart.
        <Panel
          title={`Scan progress · ${liveProgress.bucket}`}
          subtitle={`${fmtNum(liveProgress.objects)} objects · ${formatBytes(liveProgress.original_bytes)} seen · ${liveProgress.pages_done} pages`}
          colSpan={12}
          rowSpan={2}
          accent="blue"
          empty={scanTimeline.length < 2 ? { title: 'Streaming…', hint: 'First point lands after a few pages.' } : undefined}
        >
          {scanTimeline.length >= 2 && (
            <div style={{ flex: 1, minHeight: 0 }}>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={scanTimeline} margin={{ top: 8, right: 8, bottom: 0, left: -20 }}>
                  <XAxis dataKey="time" tick={axisTickStyle(colors, true)} axisLine={false} tickLine={false} minTickGap={40} />
                  <YAxis tickFormatter={v => fmtNum(Number(v))} tick={axisTickStyle(colors)} axisLine={false} tickLine={false} width={56} />
                  <RechartsTooltip
                    {...tt}
                    formatter={(v, name) =>
                      name === 'objects'
                        ? [fmtNum(Number(v)), 'Objects']
                        : [formatBytes(Number(v)), 'Bytes']
                    }
                  />
                  <Area type="monotone" dataKey="objects" stroke={CHART_PALETTE[5]} fill={`${CHART_PALETTE[5]}33`} strokeWidth={2} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </Panel>
      ) : (
        <>
          {/* By-the-numbers facts grid — always renders, no empty states. */}
          <Panel
            title="By the numbers"
            subtitle="Derived facts from the latest scan"
            colSpan={8}
            rowSpan={2}
          >
            <ByTheNumbersGrid bucketRows={bucketRows} colors={colors} />
          </Panel>
          {/*
            Compression effectiveness gauge. The dial is BYTES-WEIGHTED
            (a 1.4 TB bucket at 93% dominates a 88 KB bucket at 0%);
            this matches the user's intuition of "how is my storage
            cost behaving" rather than the unweighted average that
            penalises trivial buckets. The subtitle counts the
            operator-policy warnings — buckets where compression is
            explicitly OFF — as a separate signal from compression
            effectiveness, because "compression turned off on
            purpose" is a different category from "compression on
            but ratio is low".
          */}
          <Panel
            title="Compression effectiveness"
            subtitle={
              opportunities.length > 0
                ? `${opportunities.length} bucket${opportunities.length === 1 ? '' : 's'} with compression OFF`
                : 'Bytes-weighted across buckets'
            }
            colSpan={4}
            rowSpan={2}
            accent={opportunities.length > 0 ? 'amber' : undefined}
          >
            <FleetHealthGauge
              bucketRows={bucketRows}
              opportunities={opportunities}
              colors={colors}
            />
          </Panel>
        </>
      )}

      {/*
        Row 4 (Per-bucket savings %) removed — the Bucket fleet panel
        in row 2 now shows the per-bucket ratio with its 100%-wide
        rendering, so a separate distribution chart was redundant.
      */}
    </DashboardGrid>
    </>
  );
}
