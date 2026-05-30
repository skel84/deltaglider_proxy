/**
 * Pure formatting/status helpers shared by the Lifecycle panel sub-components.
 * Components live in the sibling `.tsx` files (LifecycleMetric / LifecycleRuleFields /
 * LifecycleRuntimeDetails); keeping these pure helpers in a `.ts` sibling avoids the
 * react-refresh/only-export-components lint (prior art: ruleEditorHelpers.ts).
 */

export function fmtDate(value: string): string {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
}

export function statusTone(
  status: string,
  enabled: boolean
): 'success' | 'warning' | 'error' | 'default' {
  if (!enabled) return 'warning';
  if (status === 'failed') return 'error';
  if (status === 'succeeded') return 'success';
  return 'default';
}
