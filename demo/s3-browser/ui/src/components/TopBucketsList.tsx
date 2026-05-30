import { Button } from 'antd';
import { PlayCircleOutlined, StopOutlined, ReloadOutlined } from '@ant-design/icons';
import { useColors } from '../ThemeContext';
import type { AdminConfig } from '../adminApi';
import { formatBytes, ageLabel, dotPattern } from '../utils';
import { fmtNum } from './dashboard/chartDefaults';
import type { BucketRow } from './AnalyticsSection';

interface TopBucketsListProps {
  topBuckets: BucketRow[];
  colors: ReturnType<typeof useColors>;
  config: AdminConfig | null;
  queue: string[];
  scansLoaded: boolean;
  /** Resolve a bucket's backend name from the policy map (caller closure). */
  backendOf: (bucket: string) => string | null;
  onStopOne: (bucket: string) => void;
  onScanOne: (bucket: string) => void;
}

/**
 * Top-N table next to the fleet view. Three columns per row: name +
 * meta · savings/streaming numerics · per-row scan action button.
 * The per-row affordance lets the operator refresh ONE bucket's
 * totals without re-scanning the multi-TB neighbours.
 */
export default function TopBucketsList({
  topBuckets,
  colors,
  config,
  queue,
  scansLoaded,
  backendOf,
  onStopOne,
  onScanOne,
}: TopBucketsListProps) {
  return (
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
                  onClick={() => onStopOne(b.bucket)}
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
                  onClick={() => onStopOne(b.bucket)}
                  title={`Remove ${b.bucket} from scan queue`}
                />
              );
            }
            return (
              <Button
                size="small"
                type="text"
                icon={b.completedAt ? <ReloadOutlined /> : <PlayCircleOutlined />}
                onClick={() => onScanOne(b.bucket)}
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
  );
}
