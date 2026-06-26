/**
 * Verify tab — on-demand source-vs-dest parity audit for a replication rule.
 *
 * State machine: idle → loading → result (in-sync verdict | difference report)
 * → error. The GREEN "Verified in sync" verdict is the deliverable: a bespoke
 * framed panel (NOT a generic AntD success Alert) — a soft green halo around a
 * large ✓, the matched count as the visual anchor, an honest provenance footnote.
 *
 * Owns its own state via a useMutation (no poll, no auto-run on mount); it does
 * NOT touch the editable Definition form.
 */
import { Alert, Button, Table, Tag, Typography } from 'antd';
import {
  CheckOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import type { FindingKind, ParityFinding, ParityOutcome, Verifier } from '../../adminApi';
import { parityKindMeta } from '../../jobsView';
import { useVerifyParity } from '../../queries/jobs';
import { useColors } from '../../ThemeContext';
import { timeAgo } from '../../utils';

const { Text } = Typography;

interface Props {
  ruleName: string;
}

/** Human label for the metadata source that produced a finding. */
function verifierLabel(v: Verifier | undefined): string | null {
  switch (v) {
    case 'sha256':
      return 'sha-256';
    case 'etag_size':
      return 'etag + size';
    case 'size_only':
      return 'size only';
    default:
      return null;
  }
}

/** Severity drives the halo + headline color: clean → green, mismatch → red, else amber. */
type Tone = 'green' | 'amber' | 'red';

function toneFor(o: ParityOutcome): Tone {
  if (o.in_sync) return 'green';
  if (o.checksum_mismatch > 0) return 'red';
  return 'amber';
}

export default function VerifyTab({ ruleName }: Props) {
  const c = useColors();
  const verify = useVerifyParity();
  const data = verify.data;

  const run = () => verify.mutate(ruleName);

  // ── idle ──────────────────────────────────────────────────────────────────
  if (verify.isIdle && !data) {
    return (
      <div style={{ padding: '8px 4px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
          <SafetyCertificateOutlined style={{ fontSize: 18, color: c.ACCENT_BLUE }} />
          <Text strong style={{ fontSize: 15 }}>
            Verify replication parity
          </Text>
        </div>
        <Text style={{ display: 'block', color: c.TEXT_SECONDARY, lineHeight: 1.5, marginBottom: 4 }}>
          Verify that every object in the source exists on the destination with a matching checksum.
        </Text>
        <Text type="secondary" style={{ display: 'block', fontSize: 12.5, marginBottom: 18 }}>
          Compares logical SHA-256 + size from metadata — no downloads.
        </Text>
        <Button type="primary" icon={<SafetyCertificateOutlined />} onClick={run}>
          Run verification
        </Button>
      </div>
    );
  }

  // ── loading ───────────────────────────────────────────────────────────────
  if (verify.isPending) {
    return <LoadingBlock c={c} />;
  }

  // ── error ─────────────────────────────────────────────────────────────────
  if (verify.isError) {
    return (
      <div style={{ padding: '8px 4px' }}>
        <Alert
          type="error"
          showIcon
          message="Verification failed"
          description={verify.error?.message || 'The parity audit could not complete.'}
          style={{ borderRadius: 8, marginBottom: 16 }}
        />
        <Button icon={<ReloadOutlined />} onClick={run}>
          Retry
        </Button>
      </div>
    );
  }

  // ── result ────────────────────────────────────────────────────────────────
  if (!data) return <LoadingBlock c={c} />;
  return <ParityResult outcome={data} onReverify={run} c={c} />;
}

function LoadingBlock({ c }: { c: ReturnType<typeof useColors> }) {
  // LoadingState chrome (StatePlaceholders exports only LoadingState); the import
  // would create a cycle of generic spinners, so reuse its visual contract inline.
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        padding: 56,
      }}
    >
      <span className="dg-verify-spinner" aria-hidden />
      <Text type="secondary" style={{ fontSize: 12.5 }}>
        Comparing source and destination…
      </Text>
      <style>{`
        .dg-verify-spinner {
          width: 28px; height: 28px; border-radius: 50%;
          border: 3px solid ${c.BORDER};
          border-top-color: ${c.ACCENT_BLUE};
          animation: dg-verify-spin 0.7s linear infinite;
        }
        @keyframes dg-verify-spin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}

// ── The verdict panel ─────────────────────────────────────────────────────────

function ParityResult({
  outcome,
  onReverify,
  c,
}: {
  outcome: ParityOutcome;
  onReverify: () => void;
  c: ReturnType<typeof useColors>;
}) {
  const tone = toneFor(outcome);
  const inSync = outcome.in_sync;

  const haloColor =
    tone === 'green' ? c.ACCENT_GREEN : tone === 'red' ? c.ACCENT_RED : c.ACCENT_AMBER;
  const glow =
    tone === 'green'
      ? c.GLOW_GREEN
      : tone === 'red'
        ? 'rgba(251,113,133,0.30)'
        : 'rgba(251,191,36,0.30)';

  const totalDiffs =
    outcome.missing_on_dest +
    outcome.orphan_on_dest +
    outcome.checksum_mismatch +
    outcome.unverifiable;

  const scannedDate = new Date(outcome.scanned_at * 1000);
  const scannedAbsolute = scannedDate.toLocaleString();

  return (
    <div style={{ padding: '4px 2px' }}>
      {/* Framed verdict panel on elevated bg */}
      <div
        style={{
          background: c.BG_ELEVATED,
          border: `1px solid ${c.BORDER}`,
          borderRadius: 14,
          padding: '32px 24px 26px',
          textAlign: 'center',
          boxShadow: c.ELEV_SHADOW,
        }}
      >
        {/* Halo + glyph */}
        <div
          style={{
            width: 96,
            height: 96,
            margin: '0 auto 18px',
            borderRadius: '50%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: `radial-gradient(circle at center, ${glow} 0%, transparent 70%)`,
          }}
        >
          <div
            style={{
              width: 72,
              height: 72,
              borderRadius: '50%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: `${haloColor}1f`,
              border: `1.5px solid ${haloColor}66`,
            }}
          >
            {inSync ? (
              <CheckOutlined style={{ fontSize: 40, color: haloColor }} />
            ) : (
              <WarningOutlined style={{ fontSize: 38, color: haloColor }} />
            )}
          </div>
        </div>

        {/* Headline */}
        <div style={{ fontSize: 21, fontWeight: 700, color: c.TEXT_PRIMARY, marginBottom: 8 }}>
          {inSync
            ? outcome.truncated
              ? 'Verified in sync (scanned portion)'
              : 'Verified in sync'
            : `${totalDiffs.toLocaleString()} difference${totalDiffs === 1 ? '' : 's'} found`}
        </div>

        {/* Body line */}
        {inSync ? (
          <div style={{ fontSize: 14, color: c.TEXT_SECONDARY, lineHeight: 1.55, maxWidth: 440, margin: '0 auto' }}>
            All{' '}
            <span style={{ color: haloColor, fontWeight: 700 }}>
              {outcome.matched.toLocaleString()}
            </span>{' '}
            objects match by checksum. No missing files, no extras.
          </div>
        ) : (
          <div style={{ fontSize: 14, color: c.TEXT_SECONDARY, lineHeight: 1.55, maxWidth: 460, margin: '0 auto' }}>
            {outcome.matched.toLocaleString()} of {outcome.source_objects.toLocaleString()} source
            objects match. The destination is not an exact mirror.
          </div>
        )}

        {/* Difference chips (only when not in sync) */}
        {!inSync && (
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 8,
              justifyContent: 'center',
              marginTop: 16,
            }}
          >
            {outcome.missing_on_dest > 0 && (
              <Chip color={c.ACCENT_AMBER} text={`${outcome.missing_on_dest.toLocaleString()} missing on destination`} />
            )}
            {outcome.orphan_on_dest > 0 && (
              <Chip color={c.ACCENT_BLUE} text={`${outcome.orphan_on_dest.toLocaleString()} extra on destination`} />
            )}
            {outcome.checksum_mismatch > 0 && (
              <Chip color={c.ACCENT_RED} text={`${outcome.checksum_mismatch.toLocaleString()} checksum mismatch`} />
            )}
            {outcome.unverifiable > 0 && (
              <Chip color={c.TEXT_MUTED} text={`${outcome.unverifiable.toLocaleString()} matched on size only`} />
            )}
          </div>
        )}

        {/* Provenance footnote */}
        <div
          style={{ fontSize: 12, color: c.TEXT_MUTED, marginTop: 18 }}
          title={`Scanned at ${scannedAbsolute}`}
        >
          Checked {timeAgo(scannedDate)} · logical SHA-256 + size, from metadata
        </div>

        <div style={{ marginTop: 18 }}>
          <Button icon={<ReloadOutlined />} onClick={onReverify}>
            {inSync ? 'Re-verify' : 'Verify again'}
          </Button>
        </div>
      </div>

      {/* Truncation note */}
      {outcome.truncated && (
        <Alert
          type="info"
          showIcon
          style={{ borderRadius: 8, marginTop: 14 }}
          message="Scan capped"
          description={`The audit stopped after the first ${(
            outcome.source_objects + outcome.dest_objects
          ).toLocaleString()} objects. Counts and findings cover only the scanned portion.`}
        />
      )}

      {/* Unverifiable-only case: nothing is missing/extra/corrupt, but some
          objects could only be size-matched (foreign, no logical SHA-256). */}
      {!inSync &&
        outcome.unverifiable > 0 &&
        outcome.missing_on_dest === 0 &&
        outcome.orphan_on_dest === 0 &&
        outcome.checksum_mismatch === 0 && (
          <Alert
            type="info"
            showIcon
            style={{ borderRadius: 8, marginTop: 14 }}
            message="Some objects matched on size only"
            description="These objects weren't written through the proxy, so no logical SHA-256 is available — write them through the proxy for full checksum parity."
          />
        )}

      {/* Findings table */}
      {!inSync && <FindingsTable outcome={outcome} c={c} />}
    </div>
  );
}

function Chip({ color, text }: { color: string; text: string }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 12.5,
        fontWeight: 600,
        padding: '3px 11px',
        borderRadius: 999,
        color,
        background: `${color}1a`,
        border: `1px solid ${color}40`,
      }}
    >
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: color }} />
      {text}
    </span>
  );
}

function FindingsTable({
  outcome,
  c,
}: {
  outcome: ParityOutcome;
  c: ReturnType<typeof useColors>;
}) {
  // Concat the per-category samples (each capped at 100 server-side).
  const rows: ParityFinding[] = [
    ...outcome.missing_samples,
    ...outcome.orphan_samples,
    ...outcome.mismatch_samples,
  ];
  const shown = rows.length;
  const totalDiffsExclUnverifiable =
    outcome.missing_on_dest + outcome.orphan_on_dest + outcome.checksum_mismatch;
  const capped = shown < totalDiffsExclUnverifiable;

  return (
    <div style={{ marginTop: 18 }}>
      <Text strong style={{ display: 'block', fontSize: 13.5, marginBottom: 8 }}>
        Differences
      </Text>
      <Table<ParityFinding>
        dataSource={rows}
        rowKey={(f) => `${f.kind}:${f.key}`}
        size="small"
        pagination={false}
        locale={{ emptyText: 'No sampled differences' }}
        columns={[
          {
            title: 'Object',
            render: (_: unknown, f) => (
              <Text
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 12,
                  display: 'inline-block',
                  maxWidth: 260,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  verticalAlign: 'bottom',
                }}
                title={f.key}
              >
                {f.key}
              </Text>
            ),
          },
          {
            title: 'Issue',
            width: 150,
            render: (_: unknown, f) => {
              const kind: FindingKind = f.kind;
              const meta = parityKindMeta(kind);
              return <Tag color={meta.color}>{meta.label}</Tag>;
            },
          },
          {
            title: 'Detail',
            render: (_: unknown, f) => {
              const vl = verifierLabel(f.verifier);
              return (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {f.detail}
                  {vl && <span style={{ color: c.TEXT_MUTED }}> · {vl}</span>}
                </Text>
              );
            },
          },
        ]}
      />
      {capped && (
        <Text type="secondary" style={{ display: 'block', fontSize: 12, marginTop: 8, color: c.TEXT_MUTED }}>
          Showing first {shown.toLocaleString()} of {totalDiffsExclUnverifiable.toLocaleString()} differences
        </Text>
      )}
    </div>
  );
}
