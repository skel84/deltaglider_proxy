import type { IamPermission } from '../adminApi';
import { normalizeResourcePattern } from '../storagePath';

export interface PermissionRow {
  effect: string;
  actions: string[];
  resources: string;
  conditions?: Record<string, Record<string, string | string[]>>;
}

export function permissionsToRows(perms: IamPermission[]): PermissionRow[] {
  return perms.map(p => ({
    effect: p.effect || 'Allow',
    actions: [...p.actions],
    resources: p.resources.join(', '),
    conditions: p.conditions,
  }));
}

export function rowsToPermissions(rows: PermissionRow[]): IamPermission[] {
  return rows
    .filter(r => r.actions.length > 0 && r.resources.trim() !== '')
    .map(r => {
      const perm: IamPermission = {
        id: 0,
        effect: r.effect || 'Allow',
        actions: r.actions,
        resources: r.resources.split(',').map(s => normalizeResourcePattern(s)).filter(Boolean),
      };
      // Only include conditions if at least one is non-empty
      if (r.conditions && Object.keys(r.conditions).length > 0) {
        const cleaned: Record<string, Record<string, string | string[]>> = {};
        for (const [op, kv] of Object.entries(r.conditions)) {
          const cleanedKv: Record<string, string | string[]> = {};
          for (const [k, v] of Object.entries(kv)) {
            if (typeof v === 'string' ? v.trim() : v.length > 0) {
              cleanedKv[k] = v;
            }
          }
          if (Object.keys(cleanedKv).length > 0) {
            cleaned[op] = cleanedKv;
          }
        }
        if (Object.keys(cleaned).length > 0) {
          perm.conditions = cleaned;
        }
      }
      return perm;
    });
}
