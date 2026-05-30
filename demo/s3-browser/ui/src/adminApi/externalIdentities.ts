// === External Identities ===
import { throwApiError } from '../errorHandling';
import { adminFetch, fetchJson, safeJson } from './core';

export interface ExternalIdentity {
  id: number;
  user_id: number;
  provider_id: number;
  external_sub: string;
  email?: string;
  display_name?: string;
  last_login?: string;
  raw_claims?: Record<string, unknown>;
  created_at: string;
}

export async function getExternalIdentities(): Promise<ExternalIdentity[]> {
  return fetchJson('/api/admin/ext-auth/identities', 'Load external identities');
}

interface SyncResult {
  users_updated: number;
  memberships_changed: number;
}

export async function syncMemberships(): Promise<SyncResult> {
  const res = await adminFetch('/api/admin/ext-auth/sync-memberships', 'POST');
  if (!res.ok) await throwApiError(res, 'Config sync now');
  return safeJson(res);
}
