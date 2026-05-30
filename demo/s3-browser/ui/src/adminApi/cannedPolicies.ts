// === Canned Policies ===
import { adminFetch, safeJson } from './core';
import type { IamPermission } from './users';

export interface CannedPolicy {
  name: string;
  description: string;
  permissions: IamPermission[];
}

export async function getCannedPolicies(): Promise<CannedPolicy[]> {
  try {
    const res = await adminFetch('/api/admin/policies');
    if (!res.ok) return [];
    return safeJson(res);
  } catch {
    return [];
  }
}
