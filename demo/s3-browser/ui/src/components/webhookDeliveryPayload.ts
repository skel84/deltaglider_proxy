/**
 * Pure payload + validation helpers for the Webhook delivery panel
 * (`event_delivery`). No React / antd imports so the Node regression
 * script can transpile-and-import it directly.
 *
 * ## The two correctness hazards this module owns
 *
 * 1. **Header-delete null.** The server applies RFC 7396 merge-patch to
 *    `webhook_headers`: an absent key is PRESERVED, only an explicit JSON
 *    `null` deletes it. So removing a header in the UI must emit
 *    `{ "<removed-key>": null }` — diffing the edited map against the
 *    BASELINE map. Without this, "delete header" is silently a no-op.
 *
 * 2. **Secret round-trip.** The server masks each header VALUE to
 *    `WEBHOOK_REDACTED_SENTINEL` on GET (keeping the key). A value left as
 *    the sentinel means "unchanged" — we pass it through and the server
 *    restores the real token. A retyped value overwrites. The UI must
 *    never let the operator save the literal sentinel as a real value, and
 *    must never display a real token (it only ever sees the sentinel).
 *
 * 3. **Legacy `webhook_url`.** The backend has both `webhook_url`
 *    (singleton) and `webhook_urls` (list). The UI surfaces ONE endpoint
 *    list bound to `webhook_urls`; on load we fold any legacy single
 *    `webhook_url` into the list, and on save we always write `webhook_urls`
 *    and clear `webhook_url` (→ explicit `null`) so the two never drift.
 */

export const WEBHOOK_REDACTED_SENTINEL = '__redacted__';

export interface EventDeliveryConfig {
  enabled: boolean;
  webhook_urls: string[];
  webhook_headers: Record<string, string>;
  tick_interval: string;
  batch_size: number;
  request_timeout: string;
  max_attempts: number;
  retry_base: string;
  retry_max: string;
  stale_claim_after: string;
  delivered_retention: string;
  delivered_max_rows: number;
  prune_batch: number;
}

/** Defaults mirror `EventDeliveryConfig::default` in src/config_sections.rs. */
export const DEFAULT_EVENT_DELIVERY: EventDeliveryConfig = {
  enabled: false,
  webhook_urls: [],
  webhook_headers: {},
  tick_interval: '10s',
  batch_size: 50,
  request_timeout: '5s',
  max_attempts: 8,
  retry_base: '5s',
  retry_max: '5m',
  stale_claim_after: '60s',
  delivered_retention: '24h',
  delivered_max_rows: 10000,
  prune_batch: 100,
};

/** The wire shape of `event_delivery` as the server GET returns it. */
export interface EventDeliveryWire {
  enabled?: boolean;
  webhook_url?: string | null;
  webhook_urls?: string[];
  webhook_headers?: Record<string, string>;
  tick_interval?: string;
  batch_size?: number;
  request_timeout?: string;
  max_attempts?: number;
  retry_base?: string;
  retry_max?: string;
  stale_claim_after?: string;
  delivered_retention?: string;
  delivered_max_rows?: number;
  prune_batch?: number;
}

export interface AdvancedSectionWebhookBody {
  event_delivery?: EventDeliveryWire;
}

/**
 * Normalize a server `event_delivery` body to the local editing shape:
 * fill defaults for absent fields and FOLD a legacy single `webhook_url`
 * into the `webhook_urls` list (deduped, legacy first).
 */
export function normalizeEventDelivery(
  raw: EventDeliveryWire | undefined
): EventDeliveryConfig {
  const d = DEFAULT_EVENT_DELIVERY;
  const ed = raw ?? {};
  const urls: string[] = [];
  if (typeof ed.webhook_url === 'string' && ed.webhook_url.trim()) {
    urls.push(ed.webhook_url.trim());
  }
  for (const u of ed.webhook_urls ?? []) {
    const t = (u ?? '').trim();
    if (t && !urls.includes(t)) urls.push(t);
  }
  return {
    enabled: ed.enabled ?? d.enabled,
    webhook_urls: urls,
    webhook_headers: { ...(ed.webhook_headers ?? {}) },
    tick_interval: ed.tick_interval ?? d.tick_interval,
    batch_size: ed.batch_size ?? d.batch_size,
    request_timeout: ed.request_timeout ?? d.request_timeout,
    max_attempts: ed.max_attempts ?? d.max_attempts,
    retry_base: ed.retry_base ?? d.retry_base,
    retry_max: ed.retry_max ?? d.retry_max,
    stale_claim_after: ed.stale_claim_after ?? d.stale_claim_after,
    delivered_retention: ed.delivered_retention ?? d.delivered_retention,
    delivered_max_rows: ed.delivered_max_rows ?? d.delivered_max_rows,
    prune_batch: ed.prune_batch ?? d.prune_batch,
  };
}

const DURATION_RE = /^\s*\d+\s*(ns|us|µs|ms|s|m|h|d)\s*$/;
// http(s) URL with a host. Keep it permissive but reject obvious junk.
const URL_RE = /^https?:\/\/[^\s/$.?#].[^\s]*$/i;
// RFC 7230 token chars for header names.
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

interface ValidationResult {
  ok: boolean;
  errors: string[];
  /** Wire body for the section PUT, only present when ok. */
  body?: AdvancedSectionWebhookBody;
}

/**
 * Validate the edited config against the BASELINE (the normalized
 * server-loaded value) and produce the section-PUT body.
 *
 * `baseline` is needed to compute header DELETES (keys present at load but
 * removed now → emit `null`).
 */
export function buildEventDeliveryPayload(
  local: EventDeliveryConfig,
  baseline: EventDeliveryConfig
): ValidationResult {
  const errors: string[] = [];

  const urls = local.webhook_urls.map((u) => u.trim()).filter((u) => u.length > 0);
  for (const u of urls) {
    if (!URL_RE.test(u)) errors.push(`Endpoint "${u}" is not a valid http(s) URL.`);
  }
  // Usability invariant: enabling delivery with no endpoint is a no-op trap.
  if (local.enabled && urls.length === 0) {
    errors.push('Delivery is enabled but no endpoint is set — add at least one webhook URL or turn delivery off.');
  }

  // Header validation + secret-sentinel guard.
  for (const [name, value] of Object.entries(local.webhook_headers)) {
    if (!HEADER_NAME_RE.test(name)) {
      errors.push(`Header name "${name}" contains invalid characters.`);
    }
    if (value === '') {
      errors.push(`Header "${name}" has an empty value.`);
    }
  }

  const durations: Array<[string, string]> = [
    ['tick_interval', local.tick_interval],
    ['request_timeout', local.request_timeout],
    ['retry_base', local.retry_base],
    ['retry_max', local.retry_max],
    ['stale_claim_after', local.stale_claim_after],
    ['delivered_retention', local.delivered_retention],
  ];
  for (const [field, v] of durations) {
    // delivered_retention accepts "0s" to disable pruning; all parse via the RE.
    if (!DURATION_RE.test(v)) {
      errors.push(`${field} "${v}" is not a duration like 30s, 5m, or 24h.`);
    }
  }

  const numbers: Array<[string, number, number]> = [
    ['batch_size', local.batch_size, 1],
    ['max_attempts', local.max_attempts, 1],
    ['delivered_max_rows', local.delivered_max_rows, 0],
    ['prune_batch', local.prune_batch, 0],
  ];
  for (const [field, v, min] of numbers) {
    if (!Number.isFinite(v) || !Number.isInteger(v) || v < min) {
      errors.push(`${field} must be an integer ≥ ${min}.`);
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  // Build webhook_headers patch: current values + explicit null for removed keys.
  const headerPatch: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(local.webhook_headers)) {
    headerPatch[k] = v; // may be the sentinel (= "unchanged", server restores)
  }
  for (const k of Object.keys(baseline.webhook_headers)) {
    if (!(k in local.webhook_headers)) {
      headerPatch[k] = null; // RFC 7396 delete
    }
  }

  const body: AdvancedSectionWebhookBody = {
    event_delivery: {
      enabled: local.enabled,
      // Always write webhook_urls; clear the legacy singleton so they can't drift.
      webhook_url: null,
      webhook_urls: urls,
      webhook_headers: headerPatch as Record<string, string>,
      tick_interval: local.tick_interval.trim(),
      batch_size: local.batch_size,
      request_timeout: local.request_timeout.trim(),
      max_attempts: local.max_attempts,
      retry_base: local.retry_base.trim(),
      retry_max: local.retry_max.trim(),
      stale_claim_after: local.stale_claim_after.trim(),
      delivered_retention: local.delivered_retention.trim(),
      delivered_max_rows: local.delivered_max_rows,
      prune_batch: local.prune_batch,
    },
  };

  return { ok: true, errors: [], body };
}
