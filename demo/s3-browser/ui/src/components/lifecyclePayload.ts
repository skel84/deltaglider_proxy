/**
 * Pure normalize + validation + payload logic for LifecyclePanel.
 *
 * React-free (no antd / no hooks) so the Node regression script can
 * transpile-and-import it directly, and so the panel can move onto the
 * shared `useSectionEditor` storage-section apply pipeline.
 *
 * `buildLifecyclePayload` mirrors the old in-component `buildPayload`:
 * it normalises rules, validates them, and produces the exact
 * `{ lifecycle }` body sent to /validate and PUT — byte-identical to
 * the pre-refactor builder for the same input.
 */
import type {
  LifecycleConfig,
  LifecycleRuleConfig,
  StorageSectionBody,
} from '../adminApi';
import { normalizePrefix } from '../storagePath';

export const DEFAULT_LIFECYCLE: LifecycleConfig = {
  enabled: false,
  tick_interval: '1h',
  max_failures_retained: 100,
  rules: [],
};

export function emptyRule(existing: LifecycleRuleConfig[]): LifecycleRuleConfig {
  let n = existing.length + 1;
  let name = `expire-old-${n}`;
  while (existing.some((r) => r.name === name)) {
    n += 1;
    name = `expire-old-${n}`;
  }
  return {
    name,
    enabled: false,
    bucket: '',
    prefix: '',
    action: 'delete',
    expire_after: '30d',
    include_globs: [],
    exclude_globs: ['.deltaglider/**'],
    batch_size: 100,
  };
}

export function actionKind(action: LifecycleRuleConfig['action']): 'delete' | 'transition' {
  return typeof action === 'object' && action?.type ? 'transition' : 'delete';
}

function normalizeAction(
  action: LifecycleRuleConfig['action']
): LifecycleRuleConfig['action'] {
  if (actionKind(action) === 'delete' || typeof action !== 'object') return 'delete';
  return {
    type: 'transition',
    destination: {
      bucket: action.destination?.bucket?.trim() || '',
      prefix: normalizePrefix(action.destination?.prefix || ''),
    },
    delete_source_after_success: Boolean(action.delete_source_after_success),
  };
}

export function actionLabel(
  action: LifecycleRuleConfig['action'] | string | undefined
): string {
  return actionKind(action as LifecycleRuleConfig['action']) === 'transition'
    ? 'archive/move'
    : 'delete';
}

export function normalizeLifecycle(
  input: Partial<LifecycleConfig> | undefined
): LifecycleConfig {
  const cfg = { ...DEFAULT_LIFECYCLE, ...(input || {}) };
  return {
    ...cfg,
    rules: (cfg.rules || []).map((rule) => ({
      ...emptyRule([]),
      ...rule,
      action: normalizeAction(rule.action),
      prefix: rule.prefix || '',
      include_globs: rule.include_globs || [],
      exclude_globs: rule.exclude_globs || ['.deltaglider/**'],
      batch_size: rule.batch_size || 100,
    })),
  };
}

type LifecyclePayloadResult =
  | { ok: true; body: StorageSectionBody }
  | { ok: false; error: string };

/**
 * Normalise + validate lifecycle rules, then build the `{ lifecycle }`
 * storage-section body. Identical validation order to the pre-refactor
 * in-component `buildPayload`.
 */
export function buildLifecyclePayload(
  lifecycle: LifecycleConfig
): LifecyclePayloadResult {
  const normalizedRules = lifecycle.rules.map((rule) => ({
    ...rule,
    action: normalizeAction(rule.action),
    name: rule.name.trim(),
    bucket: rule.bucket.trim(),
    prefix: normalizePrefix(rule.prefix),
    expire_after: rule.expire_after.trim(),
    batch_size: rule.batch_size || 100,
  }));
  const names = normalizedRules.map((r) => r.name).filter(Boolean);
  const duplicate = names.find((name, idx) => names.indexOf(name) !== idx);
  if (duplicate) {
    return { ok: false, error: `Duplicate rule name: ${duplicate}` };
  }
  for (const rule of normalizedRules) {
    if (!rule.name) {
      return { ok: false, error: 'Every lifecycle rule needs a name.' };
    }
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(rule.name)) {
      return {
        ok: false,
        error: `Rule ${rule.name}: names must match [A-Za-z0-9_.-]{1,64}.`,
      };
    }
    if (!rule.bucket) {
      return { ok: false, error: `Rule ${rule.name}: bucket is required.` };
    }
    if (!rule.expire_after) {
      return { ok: false, error: `Rule ${rule.name}: expire_after is required.` };
    }
    if (actionKind(rule.action) === 'transition') {
      const action = rule.action as Exclude<
        LifecycleRuleConfig['action'],
        'delete' | undefined
      >;
      if (!action.destination.bucket.trim()) {
        return {
          ok: false,
          error: `Rule ${rule.name}: transition destination bucket is required.`,
        };
      }
    }
  }
  return {
    ok: true,
    body: {
      lifecycle: {
        ...lifecycle,
        rules: normalizedRules,
      },
    },
  };
}
