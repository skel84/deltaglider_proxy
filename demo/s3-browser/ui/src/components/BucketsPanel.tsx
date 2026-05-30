/**
 * BucketsPanel — Wave 6 of the admin UI revamp (§7.5).
 *
 * Dedicated editor for per-bucket policies:
 *
 *   * **Compression override** — toggle + optional ratio threshold.
 *   * **Backend routing** — pick a named backend to route this
 *     bucket to.
 *   * **Alias** — virtual → real bucket name map.
 *   * **Quota** — soft storage quota in GiB.
 *   * **Anonymous read access (tri-state)** — the §7.5 UX fix:
 *     None / Entire bucket / Specific prefixes.
 *
 * The tri-state replaces the old "Public Prefixes list" that left
 * operators guessing whether an empty-string sentinel meant "no
 * public access" or "entire bucket public" (it's the latter, but
 * nothing in the UI said so). The radio group makes the intent
 * explicit; the backend's `public: true` shorthand handles the
 * entire-bucket case losslessly.
 *
 * Uses the section-level storage Apply flow so dirty-state indicators,
 * beforeunload, and Cmd/Ctrl+S behave like the rest of Configuration.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Input,
  InputNumber,
  Modal,
  Radio,
  Select,
  Space,
  Typography,
  message,
} from 'antd';
import {
  CloudOutlined,
  DeleteOutlined,
  ExclamationCircleOutlined,
  PlusOutlined,
} from '@ant-design/icons';
import type { AdminConfig, BackendInfo } from '../adminApi';
import { getAdminConfig, getBackends } from '../adminApi';
import { resolveBackendFor, describeEncryption } from '../encryptionUi';
import { listBuckets } from '../s3client';
import { useColors } from '../ThemeContext';
import { useCardStyles } from './shared-styles';
import SectionHeader from './SectionHeader';
import SimpleSelect from './SimpleSelect';
import SimpleAutoComplete from './SimpleAutoComplete';
import ApplyDialog from './ApplyDialog';
import { formRow } from './ruleEditorHelpers';
import { useApplyHandler } from '../useDirtySection';
import { useSectionEditor } from '../useSectionEditor';
import type { BucketPolicyRow, PrefixEntry } from './bucketPolicyPayload';
import { buildBucketPayload, freshId, policyToRow } from './bucketPolicyPayload';

const { Text } = Typography;

interface Props {
  onSessionExpired?: () => void;
}

type BucketWire = { buckets: AdminConfig['bucket_policies'] };

export default function BucketsPanel({ onSessionExpired }: Props) {
  const { cardStyle, inputRadius } = useCardStyles();

  const {
    value: rows,
    setValue: setRows,
    isDirty: dirty,
    discard,
    applyOpen,
    applyResponse,
    applying,
    runApply: editorRunApply,
    cancelApply,
    confirmApply,
    loading,
    error,
  } = useSectionEditor<BucketWire, BucketPolicyRow[]>({
    section: 'storage',
    initial: [],
    onSessionExpired,
    noun: 'bucket policies',
    // The fetch path also side-loads backends / availableBuckets via a
    // separate effect below; `pick` only owns the row-editing shape.
    pick: (body) => {
      const nextRows = Object.entries(body.buckets || {}).map(([name, p]) =>
        policyToRow(name, p)
      );
      nextRows.sort((a, b) => a.name.localeCompare(b.name));
      return nextRows;
    },
    // `toPayload` re-runs the pure builder. The guarded `runApply`
    // below blocks the apply on validation failure, so this only runs
    // for a valid set of rows; the `{}` fallback is unreachable in
    // practice but keeps the type non-null.
    toPayload: (v) => {
      const res = buildBucketPayload(v);
      return res.ok ? res.body : { buckets: {} };
    },
  });

  const [backends, setBackends] = useState<BackendInfo[]>([]);
  const [defaultBackend, setDefaultBackend] = useState<string | null>(null);
  const [availableBuckets, setAvailableBuckets] = useState<string[]>([]);

  // Side-loaded data (backends, default backend, available buckets) is
  // NOT part of the storage section body — fetch it independently. The
  // section editor owns the row-editing shape + apply pipeline.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [cfg, bs, realBuckets] = await Promise.all([
          getAdminConfig(),
          getBackends().then((r) => r.backends).catch(() => [] as BackendInfo[]),
          listBuckets().catch(() => [] as Array<{ name: string }>),
        ]);
        if (cancelled) return;
        if (!cfg) {
          onSessionExpired?.();
          return;
        }
        // Prefer the /api/admin/config response's `backends` array —
        // it synthesises a "default" entry on the singleton-backend
        // path, so the per-bucket encryption badge works uniformly
        // regardless of YAML shape. Fall back to /api/admin/backends
        // when the primary endpoint doesn't carry backends (legacy
        // response shapes).
        setBackends(cfg.backends && cfg.backends.length > 0 ? cfg.backends : bs);
        setDefaultBackend(cfg.default_backend ?? null);
        setAvailableBuckets(realBuckets.map((b) => b.name));
      } catch (e) {
        if (cancelled) return;
        if (e instanceof Error && e.message.includes('401')) onSessionExpired?.();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [onSessionExpired]);

  // Guarded apply: run the client-side duplicate-name check first and
  // surface the error, otherwise delegate to the section editor's
  // validate → ApplyDialog → PUT flow (which re-derives the same body
  // via `toPayload`, keeping the validate/PUT body byte-identical).
  const runApply = useCallback(async () => {
    const res = buildBucketPayload(rows);
    if (!res.ok) {
      message.error(res.error);
      return;
    }
    await editorRunApply();
  }, [rows, editorRunApply]);

  // ⌘S routes through the guard (registered after the hook's own
  // handler, so this most-recently-mounted one wins the dispatch).
  useApplyHandler('storage', runApply, dirty);

  const updateRow = (id: string, patch: Partial<BucketPolicyRow>) => {
    setRows((cur) => cur.map((r) => (r._id === id ? { ...r, ...patch } : r)));
  };

  const addRow = () => {
    setRows((cur) => [
      ...cur,
      {
        _id: freshId(),
        name: '',
        compression: null,
        max_delta_ratio: null,
        backend: '',
        alias: '',
        publicMode: 'none',
        public_prefixes: [],
        quota_bytes: null,
      },
    ]);
  };

  const deleteRow = (id: string, name: string) => {
    Modal.confirm({
      title: `Remove bucket policy for "${name || '(unnamed)'}"?`,
      icon: <ExclamationCircleOutlined />,
      content: (
        <Text type="secondary" style={{ fontSize: 13 }}>
          The bucket itself is not deleted. Only the per-bucket policy
          overrides go away — compression / quota / public-read
          settings revert to the defaults.
        </Text>
      ),
      okText: 'Remove',
      okButtonProps: { danger: true },
      cancelText: 'Cancel',
      onOk: () => {
        setRows((cur) => cur.filter((r) => r._id !== id));
      },
    });
  };

  if (error) {
    return <Alert type="error" showIcon message="Failed to load" description={error} />;
  }

  return (
    <div
      style={{
        maxWidth: 820,
        margin: '0 auto',
        padding: 'clamp(16px, 3vw, 24px)',
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
      }}
    >
      {dirty && (
        <Alert
          type="warning"
          showIcon
          message="Unsaved changes"
          description="Bucket policies are storage config. Review the section diff before applying."
          action={
            <Space>
              <Button size="small" onClick={discard} disabled={applying}>
                Discard
              </Button>
              <Button
                type="primary"
                size="small"
                onClick={runApply}
                loading={applying}
              >
                Review apply
              </Button>
            </Space>
          }
        />
      )}

      <div style={cardStyle}>
        <SectionHeader
          icon={<CloudOutlined />}
          title="Per-bucket policies"
          description={
            loading
              ? 'Loading...'
              : rows.length === 0
                ? 'No overrides. Buckets use the global compression default and are not publicly readable.'
                : `${rows.length} bucket${rows.length === 1 ? '' : 's'} with custom policies.`
          }
        />

        <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {rows.map((row) => (
            <BucketCard
              key={row._id}
              row={row}
              backends={backends}
              defaultBackend={defaultBackend}
              availableBuckets={availableBuckets.filter(
                (b) => !rows.some((r) => r._id !== row._id && r.name === b)
              )}
              onChange={(patch) => updateRow(row._id, patch)}
              onPrefixesChange={(fn) =>
                setRows((cur) =>
                  cur.map((r) =>
                    r._id === row._id
                      ? { ...r, public_prefixes: fn(r.public_prefixes) }
                      : r
                  )
                )
              }
              onDelete={() => deleteRow(row._id, row.name)}
              inputRadius={inputRadius}
            />
          ))}

          <Button
            icon={<PlusOutlined />}
            onClick={addRow}
            style={{ marginTop: 4, borderRadius: 8, fontFamily: 'var(--font-ui)' }}
            block
            type="dashed"
          >
            Add bucket policy
          </Button>
        </div>

        {dirty && (
          <Button
            type="primary"
            onClick={runApply}
            loading={applying}
            style={{ marginTop: 16, borderRadius: 8, fontWeight: 600 }}
            block
          >
            Review {rows.filter((r) => r.name.trim()).length} bucket polic
            {rows.filter((r) => r.name.trim()).length === 1 ? 'y' : 'ies'}
          </Button>
        )}
      </div>

      <ApplyDialog
        open={applyOpen}
        section="storage"
        response={applyResponse}
        onApply={confirmApply}
        onCancel={cancelApply}
        loading={applying}
      />

      {/* Informational footer about secret bucket policy mechanics */}
      <Text type="secondary" style={{ fontSize: 11, lineHeight: 1.6 }}>
        Per-bucket policies are written to <code>storage.buckets.&lt;name&gt;.*</code> in
        YAML. Entire-bucket public read uses the <code>public: true</code>
        {' '}shorthand; specific prefixes serialise as{' '}
        <code>public_prefixes: [&quot;...&quot;]</code>. The backend round-trips between
        the two forms losslessly.
      </Text>
    </div>
  );
}

// ── BucketCard ──────────────────────────────────────────────

interface CardProps {
  row: BucketPolicyRow;
  backends: BackendInfo[];
  availableBuckets: string[];
  /**
   * Name of the configured default backend. A bucket with no
   * explicit `backend` override routes here. The per-bucket
   * encryption badge resolves against this when the row's backend
   * field is empty.
   */
  defaultBackend: string | null;
  onChange: (patch: Partial<BucketPolicyRow>) => void;
  /** Apply a functional transform to this row's prefix list, by id,
   *  via the parent's functional setRows — never a stale closure. */
  onPrefixesChange: (fn: (prev: PrefixEntry[]) => PrefixEntry[]) => void;
  onDelete: () => void;
  inputRadius: { borderRadius: number };
}

function BucketCard({
  row,
  backends,
  availableBuckets,
  defaultBackend,
  onChange,
  onPrefixesChange,
  onDelete,
  inputRadius,
}: CardProps) {
  const colors = useColors();

  const isPublic = row.publicMode !== 'none';
  const cardBorder = isPublic ? `${colors.ACCENT_AMBER}66` : colors.BORDER;
  const cardBg = isPublic ? `${colors.ACCENT_AMBER}0a` : colors.BG_ELEVATED;

  return (
    <div
      style={{
        border: `1px solid ${cardBorder}`,
        borderRadius: 10,
        background: cardBg,
        padding: 14,
        transition: 'all 0.15s',
      }}
    >
      {/* Header row: bucket name + backend + delete */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <SimpleAutoComplete
          value={row.name}
          onChange={(v) => onChange({ name: v.toLowerCase().replace(/[^a-z0-9.-]/g, '') })}
          options={availableBuckets}
          placeholder="Bucket name"
          style={{ flex: 1 }}
        />
        {backends.length > 0 && (
          <SimpleSelect
            value={row.backend}
            onChange={(v) => onChange({ backend: v })}
            placeholder="Route to..."
            allowClear
            size="small"
            style={{ width: 170 }}
            options={backends.map((b) => ({
              value: b.name,
              label: b.name,
              sublabel: b.backend_type,
            }))}
          />
        )}
        <Button
          size="small"
          danger
          icon={<DeleteOutlined />}
          onClick={onDelete}
          aria-label={`Remove ${row.name || 'bucket'}`}
        />
      </div>

      {/* Compression + alias + quota row */}
      <div style={formRow(16, { flexWrap: 'wrap', marginBottom: 12 })}>
        <div style={formRow(8, { flexWrap: 'wrap' })}>
          <Text style={{ fontSize: 12, fontFamily: 'var(--font-ui)', color: colors.TEXT_MUTED }}>
            Compression
          </Text>
          <Select
            size="small"
            style={{ minWidth: 200, ...inputRadius }}
            value={
              row.compression === null ? 'inherit' : row.compression ? 'on' : 'off'
            }
            onChange={(v) => {
              if (v === 'inherit') onChange({ compression: null });
              else onChange({ compression: v === 'on' });
            }}
            options={[
              {
                value: 'inherit',
                label: 'Default (on) — no override',
              },
              { value: 'on', label: 'On — explicit in YAML' },
              { value: 'off', label: 'Off — explicit in YAML' },
            ]}
          />
          {row.compression !== false && (
            <>
              <Text style={{ fontSize: 11, color: colors.TEXT_MUTED, marginLeft: 8 }}>
                Ratio:
              </Text>
              <InputNumber
                value={row.max_delta_ratio ?? undefined}
                onChange={(v) => onChange({ max_delta_ratio: v ?? null })}
                min={0}
                max={1}
                step={0.05}
                placeholder="global"
                style={{ width: 80, ...inputRadius }}
                size="small"
              />
            </>
          )}
          {/* Per-bucket encryption-at-rest badge. Resolved via the
             backend this bucket routes to — explicit `row.backend`,
             else `defaultBackend`, else the synthetic "default" entry
             surfaced by the server for the singleton-backend path.
             Each mode gets a distinct label so an operator can tell
             at a glance whether the bucket's storage is proxy-AES,
             SSE-KMS, SSE-S3, or plaintext. */}
          {(() => {
            const info = resolveBackendFor(row.backend, backends, defaultBackend);
            const summary = info?.encryption;
            const { label, tooltip, isEncrypted } = describeEncryption(summary);
            const tone = isEncrypted ? colors.ACCENT_GREEN : colors.TEXT_MUTED;
            return (
              <span
                title={tooltip}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  marginLeft: 12,
                  fontSize: 10,
                  fontWeight: 600,
                  letterSpacing: 0.4,
                  textTransform: 'uppercase',
                  padding: '2px 8px',
                  borderRadius: 10,
                  background: `${tone}22`,
                  color: tone,
                  cursor: 'help',
                }}
              >
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    background: tone,
                  }}
                />
                {label}
              </span>
            );
          })()}
        </div>
        <div style={formRow(6)}>
          <Text style={{ fontSize: 11, color: colors.TEXT_MUTED }}>Alias:</Text>
          <Input
            value={row.alias}
            onChange={(e) => onChange({ alias: e.target.value })}
            placeholder="same as name"
            style={{
              width: 140,
              ...inputRadius,
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
            }}
            size="small"
          />
        </div>
        <div style={formRow(6)}>
          <Text
            style={{
              fontSize: 11,
              color: row.quota_bytes != null ? colors.ACCENT_AMBER : colors.TEXT_MUTED,
            }}
          >
            Quota:
          </Text>
          <InputNumber
            value={
              row.quota_bytes != null
                ? Math.round(row.quota_bytes / (1024 * 1024 * 1024))
                : undefined
            }
            onChange={(v) => onChange({ quota_bytes: v != null ? v * 1024 * 1024 * 1024 : null })}
            min={0}
            placeholder="unlimited"
            style={{ width: 100, ...inputRadius, fontFamily: 'var(--font-mono)', fontSize: 11 }}
            size="small"
            addonAfter="GB"
          />
        </div>
      </div>

      {/* Anonymous read access — tri-state radio group (§7.5). */}
      <div
        style={{
          borderTop: `1px solid ${colors.BORDER}`,
          paddingTop: 10,
        }}
      >
        <Text
          style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: 0.5,
            textTransform: 'uppercase',
            color: isPublic ? colors.ACCENT_AMBER : colors.TEXT_MUTED,
            fontFamily: 'var(--font-ui)',
            display: 'block',
            marginBottom: 8,
          }}
        >
          Anonymous read access
          {isPublic && (
            <span
              style={{
                fontSize: 10,
                marginLeft: 8,
                fontWeight: 500,
                letterSpacing: 0,
                textTransform: 'none',
              }}
            >
              ⚠ publicly readable
            </span>
          )}
        </Text>
        <Radio.Group
          value={row.publicMode}
          onChange={(e) => {
            const mode = e.target.value as BucketPolicyRow['publicMode'];
            // Switching AWAY from prefixes clears them; switching TO
            // prefixes seeds an empty list so the editor appears.
            onChange({
              publicMode: mode,
              public_prefixes:
                mode === 'prefixes'
                  ? row.public_prefixes.length > 0
                    ? row.public_prefixes
                    : [{ id: freshId(), value: '' }]
                  : [],
            });
          }}
          style={formRow(6, { flexDirection: 'column', alignItems: 'stretch' })}
        >
          <Radio value="none" style={{ alignItems: 'flex-start' }}>
            <div>
              <span style={{ fontSize: 13 }}>None (default)</span>
              <Text
                type="secondary"
                style={{ fontSize: 11, display: 'block', marginTop: 1 }}
              >
                Authenticated SigV4 requests only.
              </Text>
            </div>
          </Radio>
          <Radio value="entire" style={{ alignItems: 'flex-start' }}>
            <div>
              <span style={{ fontSize: 13 }}>Entire bucket</span>
              <Text
                type="secondary"
                style={{ fontSize: 11, display: 'block', marginTop: 1 }}
              >
                All GET/HEAD/LIST requests succeed without credentials.
                YAML: <code style={{ fontFamily: 'var(--font-mono)' }}>public: true</code>.
              </Text>
            </div>
          </Radio>
          <Radio value="prefixes" style={{ alignItems: 'flex-start' }}>
            <div style={{ width: '100%' }}>
              <span style={{ fontSize: 13 }}>Specific prefixes</span>
              <Text
                type="secondary"
                style={{ fontSize: 11, display: 'block', marginTop: 1 }}
              >
                Only keys under these prefixes are publicly readable.
                Use a trailing <code>/</code> for directory-aligned matching.
              </Text>
              {row.publicMode === 'prefixes' && (
                <div
                  style={{
                    marginTop: 8,
                    paddingLeft: 16,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 4,
                  }}
                >
                  {row.public_prefixes.map((prefix) => (
                    <div
                      key={prefix.id}
                      style={formRow(4)}
                    >
                      <Input
                        value={prefix.value}
                        onChange={(e) => {
                          const value = e.target.value;
                          onPrefixesChange((prev) =>
                            prev.map((p) =>
                              p.id === prefix.id ? { ...p, value } : p
                            )
                          );
                        }}
                        onBlur={(e) => {
                          const v = e.target.value.trim();
                          if (v && !v.endsWith('/')) {
                            onPrefixesChange((prev) =>
                              prev.map((p) =>
                                p.id === prefix.id ? { ...p, value: v + '/' } : p
                              )
                            );
                          }
                        }}
                        placeholder="e.g. builds/"
                        style={{
                          flex: 1,
                          ...inputRadius,
                          fontFamily: 'var(--font-mono)',
                          fontSize: 11,
                        }}
                        size="small"
                      />
                      <Button
                        type="text"
                        size="small"
                        danger
                        onClick={() => {
                          onPrefixesChange((prev) =>
                            prev.filter((p) => p.id !== prefix.id)
                          );
                        }}
                        style={{ padding: '0 8px', minWidth: 0 }}
                      >
                        ×
                      </Button>
                    </div>
                  ))}
                  <Button
                    type="text"
                    size="small"
                    icon={<PlusOutlined />}
                    onClick={() => {
                      onPrefixesChange((prev) => [
                        ...prev,
                        { id: freshId(), value: '' },
                      ]);
                    }}
                    style={{
                      padding: '0 8px',
                      color: colors.TEXT_MUTED,
                      alignSelf: 'flex-start',
                      fontSize: 11,
                    }}
                  >
                    Add prefix
                  </Button>
                </div>
              )}
            </div>
          </Radio>
        </Radio.Group>
      </div>
    </div>
  );
}
