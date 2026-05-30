import { useColors } from '../ThemeContext';
import { formatBytes, dotPattern } from '../utils';
import type { BucketRow } from './AnalyticsSection';

interface BucketFleetListProps {
  bucketRows: BucketRow[];
  colors: ReturnType<typeof useColors>;
}

/**
 * Bucket fleet view — one row per bucket with TWO bars:
 *  - **Ratio bar** (always full-width): the kept|saved split in the
 *    same teal+dotted style as the hero panel. Tells the viewer "how
 *    well is THIS bucket compressing" regardless of its absolute size.
 *  - **Footprint bar** (scale-relative): a thin under-bar showing this
 *    bucket's original-size share of the largest bucket. Preserves the
 *    magnitude story.
 * Sorted by original size, descending (caller pre-sorts bucketRows).
 */
export default function BucketFleetList({ bucketRows, colors }: BucketFleetListProps) {
  return (
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
  );
}
