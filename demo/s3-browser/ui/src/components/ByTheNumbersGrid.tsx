import { useColors } from '../ThemeContext';
import { formatBytes } from '../utils';
import { fmtNum } from './dashboard/chartDefaults';
import type { BucketRow } from './AnalyticsSection';

interface ByTheNumbersGridProps {
  bucketRows: BucketRow[];
  colors: ReturnType<typeof useColors>;
}

/**
 * 2×3 grid of derived insights from the latest scan. Every cell
 * always has content (no "no scan running" empty state) — when
 * there's no data we show "—". Each cell is one fact that the
 * operator would otherwise have to compute manually from the
 * bucket list.
 */
export default function ByTheNumbersGrid({ bucketRows, colors }: ByTheNumbersGridProps) {
  const cachedRows = bucketRows.filter(b => b.totalOriginal > 0);
  const largest = cachedRows.length
    ? cachedRows.reduce((m, b) => (b.totalOriginal > m.totalOriginal ? b : m))
    : null;
  const mostSaved = cachedRows.length
    ? cachedRows.reduce((m, b) => (b.savings > m.savings ? b : m))
    : null;
  const bestRatio = cachedRows.length
    ? cachedRows.reduce((m, b) => (b.savingsPercent > m.savingsPercent ? b : m))
    : null;
  const worstRatio = cachedRows.length
    ? cachedRows.reduce((m, b) => (b.savingsPercent < m.savingsPercent ? b : m))
    : null;
  const totalObjects = cachedRows.reduce((s, b) => s + b.objectCount, 0);
  const avgRatio = cachedRows.length
    ? cachedRows.reduce((s, b) => s + b.savingsPercent, 0) / cachedRows.length
    : 0;

  const cells: Array<{
    label: string;
    value: string;
    accent?: string;
    sub?: string;
  }> = [
    {
      label: 'Largest bucket',
      value: largest ? formatBytes(largest.totalOriginal) : '—',
      sub: largest?.bucket,
    },
    {
      label: 'Biggest single saving',
      value: mostSaved ? formatBytes(mostSaved.savings) : '—',
      sub: mostSaved?.bucket,
      accent: colors.ACCENT_GREEN,
    },
    {
      label: 'Best ratio',
      value: bestRatio ? `${bestRatio.savingsPercent.toFixed(1)}%` : '—',
      sub: bestRatio?.bucket,
      accent: colors.ACCENT_GREEN,
    },
    {
      label: 'Worst ratio',
      value: worstRatio ? `${worstRatio.savingsPercent.toFixed(1)}%` : '—',
      sub: worstRatio?.bucket,
      accent: worstRatio && worstRatio.savingsPercent < 20 ? colors.ACCENT_AMBER : undefined,
    },
    {
      label: 'Total objects',
      value: fmtNum(totalObjects),
      sub: `${cachedRows.length} bucket${cachedRows.length === 1 ? '' : 's'} scanned`,
    },
    {
      label: 'Avg ratio',
      value: cachedRows.length ? `${avgRatio.toFixed(1)}%` : '—',
      sub: 'across cached buckets',
    },
  ];

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(3, 1fr)',
        gridTemplateRows: 'repeat(2, 1fr)',
        gap: 12,
        flex: 1,
        minHeight: 0,
      }}
    >
      {cells.map((c, i) => (
        <div
          key={i}
          style={{
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            padding: '10px 12px',
            background: colors.BG_CARD,
            border: `1px solid ${colors.BORDER}`,
            borderRadius: 6,
            minHeight: 0,
          }}
        >
          <div
            style={{
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: colors.TEXT_MUTED,
              fontFamily: 'var(--font-ui)',
            }}
          >
            {c.label}
          </div>
          <div
            style={{
              fontSize: 'clamp(18px, 2vw, 26px)',
              fontWeight: 700,
              color: c.accent ?? colors.TEXT_PRIMARY,
              fontFamily: 'var(--font-ui)',
              fontVariantNumeric: 'tabular-nums',
              letterSpacing: '-0.01em',
              lineHeight: 1.1,
              marginTop: 4,
            }}
          >
            {c.value}
          </div>
          {c.sub && (
            <div
              style={{
                fontSize: 10.5,
                color: colors.TEXT_MUTED,
                fontFamily: 'var(--font-mono)',
                marginTop: 4,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title={c.sub}
            >
              {c.sub}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
