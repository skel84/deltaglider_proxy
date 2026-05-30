/**
 * Pure status-tone helper shared by ReplicationPanel (rule list rows) and
 * ReplicationRuleFields (detail editor header tag). Lives in a `.ts` sibling so
 * the `.tsx` component files don't trip eslint react-refresh/only-export-components.
 */
export function statusTone(
  status: string,
  paused: boolean,
  enabled: boolean
): 'success' | 'warning' | 'error' | 'default' {
  if (paused || !enabled) return 'warning';
  if (status === 'failed') return 'error';
  if (status === 'succeeded') return 'success';
  return 'default';
}
