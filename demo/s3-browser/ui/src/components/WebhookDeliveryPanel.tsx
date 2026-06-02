/**
 * Webhook delivery panel — edits `advanced.event_delivery` through the
 * Wave 1 section API (`/api/admin/config/section/advanced`), mirroring the
 * other Advanced sub-panels.
 *
 * Secret handling: header VALUES are masked to WEBHOOK_REDACTED_SENTINEL on
 * GET. The value field shows a masked placeholder for an untouched secret;
 * typing replaces it. On save, untouched (sentinel) values pass through and
 * the server restores the real token; removed headers emit explicit `null`
 * (RFC 7396 delete) — both handled in `buildEventDeliveryPayload`.
 *
 * Usability invariants enforced here (usability bugs ARE bugs):
 *  - enabling delivery with no endpoint is blocked with a clear message;
 *  - duration fields hint the accepted format; numeric ranges validated;
 *  - rows use stable ids so remove/re-add with the same key works;
 *  - the masked sentinel is never shown as a real value and never editable
 *    in place without an explicit "replace" gesture;
 *  - dirty-dot + ⌘S + discard all work via useSectionEditor.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Input,
  InputNumber,
  Space,
  Switch,
  Tag,
  Typography,
} from 'antd';
import {
  ApiOutlined,
  DeleteOutlined,
  PlusOutlined,
  SendOutlined,
} from '@ant-design/icons';
import type { SectionApplyResponse } from '../adminApi';
import { fetchEventOutbox } from '../adminApi';
import { useCardStyles } from './shared-styles';
import { useSectionEditor } from '../useSectionEditor';
import { useApplyHandler } from '../useDirtySection';
import { useNavigation } from '../NavigationContext';
import SectionHeader from './SectionHeader';
import FormField from './FormField';
import ApplyDialog from './ApplyDialog';
import { AdvancedDisclosure } from './ruleEditorFields';
import {
  WEBHOOK_REDACTED_SENTINEL,
  DEFAULT_EVENT_DELIVERY,
  normalizeEventDelivery,
  buildEventDeliveryPayload,
  type EventDeliveryConfig,
  type AdvancedSectionWebhookBody,
} from './webhookDeliveryPayload';

const { Text } = Typography;

interface Props {
  onSessionExpired?: () => void;
}

// Stable-id rows for the endpoint + header editors (avoids the array-index
// key bug class — see ConditionPrefixInput / admin_editor_bug_class).
interface UrlRow {
  id: string;
  url: string;
}
interface HeaderRow {
  id: string;
  name: string;
  value: string;
  // True while the value is still the server-masked sentinel (untouched
  // secret). Cleared the moment the operator edits the value.
  masked: boolean;
}

let _rowSeq = 0;
const nextId = () => `r${_rowSeq++}`;

function PanelShell({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        maxWidth: 740,
        margin: '0 auto',
        padding: 'clamp(16px, 3vw, 24px)',
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
      }}
    >
      {children}
    </div>
  );
}

export default function WebhookDeliveryPanel({ onSessionExpired }: Props) {
  const { cardStyle, inputRadius } = useCardStyles();
  const nav = useNavigation();

  const {
    value,
    setValue,
    isDirty,
    discard,
    loading,
    error,
    applyOpen,
    applyResponse,
    applying,
    runApply: editorRunApply,
    cancelApply,
    confirmApply,
  } = useSectionEditor<AdvancedSectionWebhookBody, EventDeliveryConfig>({
    section: 'advanced',
    dirtyKey: 'configuration/advanced/event-delivery',
    initial: DEFAULT_EVENT_DELIVERY,
    onSessionExpired,
    noun: 'webhook delivery',
    pick: (body) => normalizeEventDelivery(body.event_delivery),
    // Guarded runApply below blocks on validation failure, so this only
    // runs for a valid config. Baseline diff for header deletes is computed
    // against the loaded value snapshot (`baselineRef`).
    toPayload: (v) => {
      const res = buildEventDeliveryPayload(v, baselineRef.current);
      return res.ok ? (res.body as AdvancedSectionWebhookBody) : {};
    },
  });

  // Snapshot of the server-loaded value, used to diff header DELETES.
  const baselineRef = useRef<EventDeliveryConfig>(DEFAULT_EVENT_DELIVERY);
  // Local row state derived from `value` on load; we keep rows in component
  // state (with stable ids) and sync back to `value` on every edit.
  const [urlRows, setUrlRows] = useState<UrlRow[]>([]);
  const [headerRows, setHeaderRows] = useState<HeaderRow[]>([]);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const initializedRef = useRef(false);

  // Initialize rows once when the server value first loads.
  useEffect(() => {
    if (loading || initializedRef.current) return;
    initializedRef.current = true;
    baselineRef.current = value;
    setUrlRows(value.webhook_urls.map((url) => ({ id: nextId(), url })));
    setHeaderRows(
      Object.entries(value.webhook_headers).map(([name, v]) => ({
        id: nextId(),
        name,
        value: v,
        masked: v === WEBHOOK_REDACTED_SENTINEL,
      }))
    );
  }, [loading, value]);

  // After a successful apply, re-baseline so the next edit diffs correctly.
  useEffect(() => {
    if (!isDirty && initializedRef.current) {
      baselineRef.current = value;
    }
  }, [isDirty, value]);

  // Live delivery status strip.
  const [outboxCounts, setOutboxCounts] = useState<{
    pending: number;
    failed: number;
    enabled: boolean;
    active: boolean;
  } | null>(null);
  useEffect(() => {
    let alive = true;
    fetchEventOutbox(1)
      .then((r) => {
        if (!alive) return;
        setOutboxCounts({
          pending: r.counts.pending,
          failed: r.counts.failed,
          enabled: r.delivery_enabled,
          active: r.delivery_active,
        });
      })
      .catch(() => {
        /* status strip is best-effort */
      });
    return () => {
      alive = false;
    };
  }, []);

  // Push row state back into the editor value (so dirty + payload track it).
  const syncToValue = (
    nextUrls: UrlRow[],
    nextHeaders: HeaderRow[],
    patch?: Partial<EventDeliveryConfig>
  ) => {
    const webhook_urls = nextUrls.map((r) => r.url.trim()).filter((u) => u.length > 0);
    const webhook_headers: Record<string, string> = {};
    for (const h of nextHeaders) {
      const name = h.name.trim();
      if (name) webhook_headers[name] = h.value;
    }
    setValue({ ...value, ...patch, webhook_urls, webhook_headers });
  };

  const updateUrl = (id: string, url: string) => {
    const next = urlRows.map((r) => (r.id === id ? { ...r, url } : r));
    setUrlRows(next);
    syncToValue(next, headerRows);
  };
  const addUrl = () => {
    const next = [...urlRows, { id: nextId(), url: '' }];
    setUrlRows(next);
    syncToValue(next, headerRows);
  };
  const removeUrl = (id: string) => {
    const next = urlRows.filter((r) => r.id !== id);
    setUrlRows(next);
    syncToValue(next, headerRows);
  };

  const updateHeader = (id: string, patch: Partial<HeaderRow>) => {
    const next = headerRows.map((r) =>
      r.id === id
        ? {
            ...r,
            ...patch,
            // Any value edit unmasks (it's now a real, operator-typed value).
            masked: patch.value !== undefined ? false : r.masked,
          }
        : r
    );
    setHeaderRows(next);
    syncToValue(urlRows, next);
  };
  const addHeader = () => {
    const next = [...headerRows, { id: nextId(), name: '', value: '', masked: false }];
    setHeaderRows(next);
    syncToValue(urlRows, next);
  };
  const removeHeader = (id: string) => {
    const next = headerRows.filter((r) => r.id !== id);
    setHeaderRows(next);
    syncToValue(urlRows, next);
  };

  const setField = (patch: Partial<EventDeliveryConfig>) =>
    setValue({ ...value, ...patch });

  // Guarded apply: validate client-side first; surface inline errors and
  // block the ApplyDialog when invalid.
  const runApply = () => {
    const res = buildEventDeliveryPayload(value, baselineRef.current);
    if (!res.ok) {
      setValidationErrors(res.errors);
      return;
    }
    setValidationErrors([]);
    editorRunApply();
  };
  useApplyHandler('configuration/advanced/event-delivery', runApply, isDirty);

  // Live validation preview (non-blocking) so the operator sees issues early.
  const liveErrors = useMemo(() => {
    if (!isDirty) return [];
    const res = buildEventDeliveryPayload(value, baselineRef.current);
    return res.ok ? [] : res.errors;
  }, [value, isDirty]);

  if (error) return <Alert type="error" showIcon message="Failed to load" description={error} />;
  if (loading)
    return (
      <PanelShell>
        <Text type="secondary">Loading…</Text>
      </PanelShell>
    );

  const shownErrors = validationErrors.length ? validationErrors : liveErrors;

  return (
    <PanelShell>
      {isDirty && (
        <Alert
          type="warning"
          showIcon
          message="Unsaved changes to webhook delivery"
          description="Review the diff in the Apply dialog before persisting. Changes apply live — no restart."
          action={
            <Space>
              <Button size="small" onClick={discard} disabled={applying}>
                Discard
              </Button>
              <Button
                type="primary"
                size="small"
                onClick={runApply}
                disabled={applying}
                loading={applying}
              >
                Apply
              </Button>
            </Space>
          }
        />
      )}

      {shownErrors.length > 0 && (
        <Alert
          type="error"
          showIcon
          message="Fix these before applying"
          description={
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {shownErrors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          }
        />
      )}

      {/* Live delivery status strip */}
      {outboxCounts && (
        <Alert
          type={outboxCounts.active ? 'success' : 'info'}
          showIcon
          message={
            <Space size="middle" wrap>
              <span>
                Delivery:{' '}
                <Tag color={outboxCounts.active ? 'green' : outboxCounts.enabled ? 'orange' : 'default'}>
                  {outboxCounts.active ? 'Active' : outboxCounts.enabled ? 'Enabled (no endpoint)' : 'Disabled'}
                </Tag>
              </span>
              <span>{outboxCounts.pending} pending</span>
              <span>{outboxCounts.failed} failed</span>
              <Button
                type="link"
                size="small"
                style={{ padding: 0 }}
                onClick={() => nav.navigate('admin/diagnostics/event-outbox')}
              >
                View event outbox →
              </Button>
            </Space>
          }
        />
      )}

      {/* Master switch + endpoints */}
      <div style={cardStyle}>
        <SectionHeader
          icon={<SendOutlined />}
          title="Webhook delivery"
          description="Deliver durable object events (create/delete/copy) to HTTP endpoints. The outbox accrues events even while disabled — they deliver once you enable + add an endpoint."
        />
        <div style={{ marginTop: 16 }}>
          <FormField label="Enable delivery" yamlPath="advanced.event_delivery.enabled">
            <Switch checked={value.enabled} onChange={(v) => setField({ enabled: v })} />
          </FormField>

          <FormField
            label="Endpoints"
            yamlPath="advanced.event_delivery.webhook_urls"
            helpText="HTTP(S) URLs that receive a deltaglider.event.v1 JSON payload. An event is marked delivered only after every endpoint returns 2xx."
          >
            <Space direction="vertical" style={{ width: '100%' }}>
              {urlRows.length === 0 && (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  No endpoints. Add one to start delivering.
                </Text>
              )}
              {urlRows.map((row) => (
                <Space.Compact key={row.id} style={{ width: '100%' }}>
                  <Input
                    value={row.url}
                    onChange={(e) => updateUrl(row.id, e.target.value)}
                    placeholder="https://hooks.example.com/deltaglider"
                    style={{ ...inputRadius, fontFamily: 'var(--font-mono)', fontSize: 13 }}
                  />
                  <Button
                    icon={<DeleteOutlined />}
                    onClick={() => removeUrl(row.id)}
                    title="Remove endpoint"
                  />
                </Space.Compact>
              ))}
              <Button icon={<PlusOutlined />} onClick={addUrl} size="small">
                Add endpoint
              </Button>
            </Space>
          </FormField>

          <FormField
            label="Headers"
            yamlPath="advanced.event_delivery.webhook_headers"
            helpText="Static headers sent with every request — e.g. an Authorization bearer token. Values are stored encrypted and shown masked; leave a masked value untouched to keep it."
          >
            <Space direction="vertical" style={{ width: '100%' }}>
              {headerRows.length === 0 && (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  No headers.
                </Text>
              )}
              {headerRows.map((row) => (
                <Space.Compact key={row.id} style={{ width: '100%' }}>
                  <Input
                    value={row.name}
                    onChange={(e) => updateHeader(row.id, { name: e.target.value })}
                    placeholder="Authorization"
                    style={{ ...inputRadius, fontFamily: 'var(--font-mono)', fontSize: 13, width: '40%' }}
                  />
                  <Input
                    value={row.masked ? '' : row.value}
                    onChange={(e) => updateHeader(row.id, { value: e.target.value })}
                    placeholder={row.masked ? '•••••••• (unchanged — type to replace)' : 'Bearer …'}
                    style={{ ...inputRadius, fontFamily: 'var(--font-mono)', fontSize: 13 }}
                  />
                  <Button
                    icon={<DeleteOutlined />}
                    onClick={() => removeHeader(row.id)}
                    title="Remove header"
                  />
                </Space.Compact>
              ))}
              <Button icon={<PlusOutlined />} onClick={addHeader} size="small">
                Add header
              </Button>
            </Space>
          </FormField>
        </div>
      </div>

      {/* Advanced tuning */}
      <div style={cardStyle}>
        <AdvancedDisclosure title="Delivery tuning (retry, retention, batching)">
          <DurationField
            label="Tick interval"
            yamlPath="advanced.event_delivery.tick_interval"
            help="How often the dispatcher wakes to deliver due events."
            value={value.tick_interval}
            placeholder="10s"
            onChange={(v) => setField({ tick_interval: v })}
            inputRadius={inputRadius}
          />
          <NumberField
            label="Batch size"
            yamlPath="advanced.event_delivery.batch_size"
            help="Max events claimed per tick (clamped 1–500)."
            value={value.batch_size}
            min={1}
            max={500}
            onChange={(v) => setField({ batch_size: v })}
          />
          <DurationField
            label="Request timeout"
            yamlPath="advanced.event_delivery.request_timeout"
            help="Per-endpoint HTTP timeout."
            value={value.request_timeout}
            placeholder="5s"
            onChange={(v) => setField({ request_timeout: v })}
            inputRadius={inputRadius}
          />
          <NumberField
            label="Max attempts"
            yamlPath="advanced.event_delivery.max_attempts"
            help="Attempts before an event becomes permanently failed."
            value={value.max_attempts}
            min={1}
            onChange={(v) => setField({ max_attempts: v })}
          />
          <DurationField
            label="Retry base"
            yamlPath="advanced.event_delivery.retry_base"
            help="Initial retry delay; exponential backoff doubles it per attempt."
            value={value.retry_base}
            placeholder="5s"
            onChange={(v) => setField({ retry_base: v })}
            inputRadius={inputRadius}
          />
          <DurationField
            label="Retry max"
            yamlPath="advanced.event_delivery.retry_max"
            help="Ceiling for the backoff delay."
            value={value.retry_max}
            placeholder="5m"
            onChange={(v) => setField({ retry_max: v })}
            inputRadius={inputRadius}
          />
          <DurationField
            label="Stale claim after"
            yamlPath="advanced.event_delivery.stale_claim_after"
            help="In-progress claims older than this are reclaimable (crash recovery)."
            value={value.stale_claim_after}
            placeholder="60s"
            onChange={(v) => setField({ stale_claim_after: v })}
            inputRadius={inputRadius}
          />
          <DurationField
            label="Delivered retention"
            yamlPath="advanced.event_delivery.delivered_retention"
            help="Delivered rows older than this are pruned. 0s keeps them until manually pruned."
            value={value.delivered_retention}
            placeholder="24h"
            onChange={(v) => setField({ delivered_retention: v })}
            inputRadius={inputRadius}
          />
          <NumberField
            label="Delivered max rows"
            yamlPath="advanced.event_delivery.delivered_max_rows"
            help="Cap on retained delivered rows (pending/failed never pruned by this)."
            value={value.delivered_max_rows}
            min={0}
            onChange={(v) => setField({ delivered_max_rows: v })}
          />
          <NumberField
            label="Prune batch"
            yamlPath="advanced.event_delivery.prune_batch"
            help="Max delivered rows pruned per tick."
            value={value.prune_batch}
            min={0}
            onChange={(v) => setField({ prune_batch: v })}
          />
        </AdvancedDisclosure>
      </div>

      <ApplyDialog
        open={applyOpen}
        section="advanced"
        response={applyResponse as SectionApplyResponse | null}
        onApply={confirmApply}
        onCancel={cancelApply}
        loading={applying}
      />
    </PanelShell>
  );
}

function DurationField(props: {
  label: string;
  yamlPath: string;
  help: string;
  value: string;
  placeholder: string;
  onChange: (v: string) => void;
  inputRadius: React.CSSProperties;
}) {
  return (
    <FormField
      label={
        <>
          {props.label} <ApiOutlined style={{ opacity: 0 }} />
        </>
      }
      yamlPath={props.yamlPath}
      helpText={`${props.help} Format: 30s, 5m, 24h.`}
    >
      <Input
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        placeholder={props.placeholder}
        style={{ ...props.inputRadius, fontFamily: 'var(--font-mono)', fontSize: 13, maxWidth: 160 }}
      />
    </FormField>
  );
}

function NumberField(props: {
  label: string;
  yamlPath: string;
  help: string;
  value: number;
  min: number;
  max?: number;
  onChange: (v: number) => void;
}) {
  return (
    <FormField label={props.label} yamlPath={props.yamlPath} helpText={props.help}>
      <InputNumber
        value={props.value}
        min={props.min}
        max={props.max}
        onChange={(v) => props.onChange(typeof v === 'number' ? v : props.min)}
        style={{ maxWidth: 160 }}
      />
    </FormField>
  );
}
