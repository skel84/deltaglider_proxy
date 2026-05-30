// === Whoami / Login-as ===
import { adminFetch, safeJson } from './core';
import type { IamPermission } from './users';

export interface ExternalProviderInfo {
  name: string;
  type: string;
  display_name: string;
}

export interface WhoamiResponse {
  mode: 'bootstrap' | 'iam' | 'open';
  version?: string;
  user: { name: string; access_key_id: string; is_admin: boolean; permissions?: IamPermission[] } | null;
  config_db_mismatch?: boolean;
  external_providers?: ExternalProviderInfo[];
}

export async function whoami(): Promise<WhoamiResponse> {
  try {
    const res = await adminFetch('/api/whoami');
    if (!res.ok) return { mode: 'bootstrap', user: null };
    return await safeJson(res);
  } catch (err) {
    console.warn('whoami request failed:', err);
    return { mode: 'bootstrap', user: null };
  }
}

export async function resolveIamIdentity(accessKeyId: string, secretAccessKey: string): Promise<WhoamiResponse | null> {
  try {
    const res = await adminFetch('/api/iam/identity', 'POST', {
      access_key_id: accessKeyId,
      secret_access_key: secretAccessKey,
    });
    if (!res.ok) return null;
    return await safeJson(res);
  } catch (err) {
    console.warn('IAM identity resolve failed:', err);
    return null;
  }
}

export async function loginAs(accessKeyId: string, secretAccessKey: string): Promise<{ ok: boolean; error?: string }> {
  const res = await adminFetch('/api/admin/login-as', 'POST', {
    access_key_id: accessKeyId,
    secret_access_key: secretAccessKey,
  });
  if (res.ok) return { ok: true };
  return { ok: false, error: 'Admin access denied — invalid credentials or insufficient permissions' };
}

/** IAM non-admin: cookie + server-stored S3 creds (survives hard refresh). */
export async function browserSessionConnect(req: {
  access_key_id: string;
  secret_access_key: string;
  endpoint: string;
  region?: string;
  bucket?: string;
}): Promise<{ ok: boolean; error?: string }> {
  const res = await adminFetch('/api/admin/session/browser-connect', 'POST', {
    access_key_id: req.access_key_id,
    secret_access_key: req.secret_access_key,
    endpoint: req.endpoint,
    region: req.region,
    bucket: req.bucket ?? '',
  });
  if (res.ok) return { ok: true };
  let error = res.status === 429 ? 'Too many attempts' : 'Could not create browser session';
  try {
    const data = (await res.json()) as { error?: string };
    if (data?.error) error = data.error;
  } catch {
    /* keep generic */
  }
  return { ok: false, error };
}

/** Open auth mode only: cookie + anonymous S3 creds for hard refresh. */
export async function openBrowserConnect(req: {
  endpoint: string;
  region?: string;
  bucket?: string;
}): Promise<{ ok: boolean; error?: string }> {
  const res = await adminFetch('/api/admin/session/open-browser-connect', 'POST', {
    endpoint: req.endpoint,
    region: req.region,
    bucket: req.bucket ?? '',
  });
  if (res.ok) return { ok: true };
  let error = res.status === 429 ? 'Too many attempts' : 'Could not start open browser session';
  try {
    const data = (await res.json()) as { error?: string };
    if (data?.error) error = data.error;
  } catch {
    /* keep generic */
  }
  return { ok: false, error };
}
