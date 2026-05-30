// === External Auth (OAuth/OIDC) ===
import { throwApiError } from '../errorHandling';
import { adminFetch, fetchJson, safeJson } from './core';

export interface AuthProvider {
  id: number;
  name: string;
  provider_type: string;
  enabled: boolean;
  priority: number;
  display_name?: string;
  client_id?: string;
  client_secret?: string;
  issuer_url?: string;
  scopes: string;
  extra_config?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

interface CreateAuthProviderRequest {
  name: string;
  provider_type: string;
  enabled?: boolean;
  priority?: number;
  display_name?: string;
  client_id?: string;
  client_secret?: string;
  issuer_url?: string;
  scopes?: string;
  extra_config?: Record<string, unknown>;
}

interface UpdateAuthProviderRequest {
  name?: string;
  provider_type?: string;
  enabled?: boolean;
  priority?: number;
  display_name?: string;
  client_id?: string;
  client_secret?: string;
  issuer_url?: string;
  scopes?: string;
  extra_config?: Record<string, unknown>;
}

export interface ProviderTestResult {
  success: boolean;
  issuer?: string;
  authorization_endpoint?: string;
  error?: string;
}

export async function getAuthProviders(): Promise<AuthProvider[]> {
  return fetchJson('/api/admin/ext-auth/providers', 'Load auth providers');
}

export async function createAuthProvider(req: CreateAuthProviderRequest): Promise<AuthProvider> {
  const res = await adminFetch('/api/admin/ext-auth/providers', 'POST', req);
  if (!res.ok) await throwApiError(res, 'Create auth provider');
  return safeJson(res);
}

export async function updateAuthProvider(id: number, req: UpdateAuthProviderRequest): Promise<AuthProvider> {
  const res = await adminFetch(`/api/admin/ext-auth/providers/${id}`, 'PUT', req);
  if (!res.ok) await throwApiError(res, 'Update auth provider');
  return safeJson(res);
}

export async function deleteAuthProvider(id: number): Promise<void> {
  const res = await adminFetch(`/api/admin/ext-auth/providers/${id}`, 'DELETE');
  if (!res.ok) await throwApiError(res, 'Delete auth provider');
}

export async function testAuthProvider(id: number): Promise<ProviderTestResult> {
  const res = await adminFetch(`/api/admin/ext-auth/providers/${id}/test`, 'POST');
  if (!res.ok) await throwApiError(res, 'Test auth provider');
  return safeJson(res);
}
