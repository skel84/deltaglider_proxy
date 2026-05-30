import { useColors } from '../ThemeContext';
import { formatBytes } from '../utils';
import type { BucketRow } from './AnalyticsSection';

interface FleetHealthGaugeProps {
  bucketRows: BucketRow[];
  opportunities: BucketRow[];
  colors: ReturnType<typeof useColors>;
}

/**
 * Effectiveness tiers — explicit so the UI never has to say
 * "healthy" without defining what that means. The tiers below are
 * chosen so the breakdown maps onto everyday operator intuition:
 *
 *   - EXCELLENT (≥50% saved): delta compression is doing its job
 *     — these buckets are the reason DeltaGlider exists.
 *   - GOOD (20-49%): compressing usefully but with diminishing
 *     returns; still worth it.
 *   - LOW (>0%, <20%): the data isn't very compressible (encrypted,
 *     random, already-compressed payloads). Not a failure — just
 *     the nature of the data.
 *   - NONE (0%, ≥2 objects): something to look at. Either the
 *     reference is wrong or compression is policy-disabled.
 *   - N/A (<2 objects OR 0 bytes): nothing to compare against yet,
 *     compression hasn't had a chance. Excluded from the avg.
 */
type EffectivenessTier = 'excellent' | 'good' | 'low' | 'none' | 'na';

function tierOf(b: BucketRow): EffectivenessTier {
  if (b.totalOriginal === 0 || b.objectCount < 2) return 'na';
  if (b.savingsPercent >= 50) return 'excellent';
  if (b.savingsPercent >= 20) return 'good';
  if (b.savingsPercent > 0) return 'low';
  return 'none';
}

const TIER_META: Record<
  EffectivenessTier,
  { label: string; explanation: string; toneKey: keyof ReturnType<typeof useColors> | 'muted' }
> = {
  excellent: {
    label: 'Excellent',
    explanation: '≥ 50 % saved — delta compression is doing its job.',
    toneKey: 'ACCENT_GREEN',
  },
  good: {
    label: 'Good',
    explanation: '20–49 % saved — compressing usefully.',
    toneKey: 'ACCENT_BLUE_LIGHT',
  },
  low: {
    label: 'Low',
    explanation: '< 20 % saved — data is already compact (encrypted / random / pre-compressed).',
    toneKey: 'ACCENT_AMBER',
  },
  none: {
    label: 'None',
    explanation: '0 % saved across ≥ 2 objects — wrong reference or compression turned off.',
    toneKey: 'ACCENT_RED',
  },
  na: {
    label: 'N/A',
    explanation: 'Fewer than 2 objects or empty — no baseline to compress against. Excluded from the average.',
    toneKey: 'muted',
  },
};

function tierColor(tier: EffectivenessTier, colors: ReturnType<typeof useColors>): string {
  const key = TIER_META[tier].toneKey;
  return key === 'muted' ? colors.TEXT_MUTED : (colors[key] as string);
}

/**
 * Compression-effectiveness gauge.
 *
 *   - The dial value is **bytes-weighted**: each bucket's savingsPct
 *     contributes proportionally to its total original size. A 1.4
 *     TB bucket at 93% dominates a 88 KB bucket at 0%. This matches
 *     the operator's question of "what's my real storage bill
 *     doing", not the naive unweighted mean which over-penalises
 *     trivial buckets.
 *   - The N/A tier (<2 objects or 0 bytes) is excluded from the
 *     average — those buckets have nothing to compare against, so
 *     scoring them is meaningless.
 *   - The dial color reflects the bytes-weighted tier of the
 *     overall fleet, not a binary healthy/unhealthy.
 *   - A tier breakdown below the dial replaces the old "X of N
 *     healthy" line — every bucket is bucketed into a named tier
 *     with a tooltip explaining what each tier means. No more
 *     undefined "healthy".
 *   - Opportunities (compression-policy-OFF warnings) keep their
 *     own list at the bottom, but framed as "operator-set" not
 *     "unhealthy" — these are an intentional decision the operator
 *     made, surfaced for review.
 *
 * Pure SVG. Single stroked circle + stroke-dasharray for the arc.
 */
export default function FleetHealthGauge({ bucketRows, opportunities, colors }: FleetHealthGaugeProps) {
  const scoredRows = bucketRows.filter(b => tierOf(b) !== 'na');
  const naRows = bucketRows.filter(b => tierOf(b) === 'na');
  const totalScoredBytes = scoredRows.reduce((s, b) => s + b.totalOriginal, 0);
  // Bytes-weighted average savings %. Falls back to unweighted if
  // every bucket has 0 bytes (shouldn't happen with the filter above
  // but defensive).
  const weightedAvg = totalScoredBytes > 0
    ? scoredRows.reduce((s, b) => s + (b.savingsPercent * b.totalOriginal), 0) / totalScoredBytes
    : 0;
  const dialTone: EffectivenessTier =
    scoredRows.length === 0 ? 'na'
      : weightedAvg >= 50 ? 'excellent'
        : weightedAvg >= 20 ? 'good'
          : weightedAvg > 0 ? 'low'
            : 'none';
  const tone = tierColor(dialTone, colors);

  // Tier counts across ALL buckets (including N/A).
  const tierCounts: Record<EffectivenessTier, number> = {
    excellent: 0, good: 0, low: 0, none: 0, na: 0,
  };
  bucketRows.forEach(b => { tierCounts[tierOf(b)] += 1; });

  // SVG arc geometry.
  const RADIUS = 56;
  const CIRC = 2 * Math.PI * RADIUS;
  const dash = (Math.max(0, Math.min(100, weightedAvg)) / 100) * CIRC;

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        minHeight: 0,
      }}
    >
      <div style={{ position: 'relative', width: 130, height: 130, marginTop: 2 }}>
        <svg viewBox="0 0 140 140" width="130" height="130" aria-hidden>
          <circle cx={70} cy={70} r={RADIUS} fill="none" stroke={colors.BORDER} strokeWidth={10} />
          <circle
            cx={70} cy={70} r={RADIUS}
            fill="none"
            stroke={tone}
            strokeWidth={10}
            strokeLinecap="round"
            strokeDasharray={`${dash} ${CIRC}`}
            transform="rotate(-90 70 70)"
            style={{
              transition: 'stroke-dasharray 0.6s cubic-bezier(0.16,1,0.3,1), stroke 0.3s',
              filter: `drop-shadow(0 0 6px ${tone}66)`,
            }}
          />
        </svg>
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            fontFamily: 'var(--font-ui)',
            color: colors.TEXT_PRIMARY,
          }}
          aria-label={`Bytes-weighted compression effectiveness ${weightedAvg.toFixed(1)} percent`}
        >
          <div
            style={{
              fontSize: 26,
              fontWeight: 800,
              letterSpacing: '-0.02em',
              fontVariantNumeric: 'tabular-nums',
              color: tone,
              lineHeight: 1,
            }}
          >
            {scoredRows.length > 0 ? weightedAvg.toFixed(0) : '—'}
            {scoredRows.length > 0 && <span style={{ fontSize: 13, marginLeft: 1 }}>%</span>}
          </div>
          <div
            style={{
              fontSize: 9,
              fontWeight: 700,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: colors.TEXT_MUTED,
              marginTop: 2,
              textAlign: 'center',
              lineHeight: 1.2,
            }}
            title="Each bucket's savings weighted by its original size — a 1 TB bucket at 90% counts more than a 1 GB bucket at 90%."
          >
            bytes-weighted<br />average
          </div>
        </div>
      </div>

      {/* Tier breakdown — every bucket is in exactly one tier; the
          row defines what each label means via the title= tooltip. */}
      <div
        style={{
          width: '100%',
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          fontSize: 11,
          fontFamily: 'var(--font-ui)',
        }}
      >
        {(['excellent', 'good', 'low', 'none', 'na'] as EffectivenessTier[])
          .filter(t => tierCounts[t] > 0)
          .map(t => {
            const meta = TIER_META[t];
            return (
              <div
                key={t}
                title={meta.explanation}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 6,
                  padding: '2px 4px',
                  borderRadius: 3,
                  cursor: 'help',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: 2,
                      background: tierColor(t, colors),
                      flexShrink: 0,
                    }}
                  />
                  <span style={{ color: colors.TEXT_PRIMARY, fontWeight: 500 }}>{meta.label}</span>
                </div>
                <span style={{ color: colors.TEXT_MUTED, fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
                  {tierCounts[t]}
                </span>
              </div>
            );
          })}
        {bucketRows.length === 0 && (
          <div style={{ textAlign: 'center', color: colors.TEXT_MUTED, padding: '8px 0' }}>
            Run a scan to populate
          </div>
        )}
      </div>

      {/* Operator-set warnings — different concept from "low ratio".
          A bucket here is one where the operator EXPLICITLY turned
          compression off in the policy. We surface these separately
          because they're a configuration decision, not an effectiveness
          measurement. */}
      {opportunities.length > 0 && (
        <div
          style={{
            width: '100%',
            maxHeight: 60,
            overflow: 'auto',
            fontSize: 10,
            fontFamily: 'var(--font-mono)',
            background: colors.BG_CARD,
            border: `1px solid ${colors.BORDER}`,
            borderRadius: 4,
            padding: '4px 8px',
          }}
        >
          <div
            style={{
              fontSize: 9, fontWeight: 700,
              color: colors.ACCENT_AMBER,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              marginBottom: 2,
              fontFamily: 'var(--font-ui)',
            }}
            title="Buckets with compression explicitly turned off in policy — review whether that's still intended."
          >
            Compression OFF by policy
          </div>
          {opportunities.map(o => (
            <div key={o.bucket} style={{ display: 'flex', justifyContent: 'space-between', gap: 6, color: colors.TEXT_PRIMARY }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }} title={o.bucket}>
                {o.bucket}
              </span>
              <span style={{ color: colors.TEXT_MUTED }}>{formatBytes(o.totalOriginal)}</span>
            </div>
          ))}
        </div>
      )}

      {/* Show NA count as a quiet footer if any buckets are excluded
          from the score (e.g. dgp-conf with 1 object). Defuses the
          "wait, my third bucket isn't counted?" confusion. */}
      {naRows.length > 0 && opportunities.length === 0 && (
        <div
          style={{
            fontSize: 10,
            color: colors.TEXT_MUTED,
            fontFamily: 'var(--font-ui)',
            textAlign: 'center',
          }}
          title={`These buckets have <2 objects or 0 bytes, so compression has nothing to compare against:\n${naRows.map(b => `• ${b.bucket}`).join('\n')}`}
        >
          {naRows.length} bucket{naRows.length === 1 ? '' : 's'} excluded (not enough data)
        </div>
      )}
    </div>
  );
}
