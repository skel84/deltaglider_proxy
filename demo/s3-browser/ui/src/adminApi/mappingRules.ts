// === Group Mapping Rules ===
import { throwApiError } from '../errorHandling';
import { adminFetch, fetchJson, safeJson } from './core';

export interface MappingRule {
  id: number;
  provider_id: number | null;
  priority: number;
  match_type: string;
  match_field: string;
  match_value: string;
  group_id: number;
  created_at: string;
}

interface CreateMappingRuleRequest {
  provider_id?: number | null;
  priority?: number;
  match_type: string;
  match_field?: string;
  match_value: string;
  group_id: number;
}

interface UpdateMappingRuleRequest {
  provider_id?: number | null;
  priority?: number;
  match_type?: string;
  match_field?: string;
  match_value?: string;
  group_id?: number;
}

export async function getMappingRules(): Promise<MappingRule[]> {
  return fetchJson('/api/admin/ext-auth/mappings', 'Load group mappings');
}

export async function createMappingRule(req: CreateMappingRuleRequest): Promise<MappingRule> {
  const res = await adminFetch('/api/admin/ext-auth/mappings', 'POST', req);
  if (!res.ok) await throwApiError(res, 'Create group mapping');
  return safeJson(res);
}

export async function updateMappingRule(id: number, req: UpdateMappingRuleRequest): Promise<MappingRule> {
  const res = await adminFetch(`/api/admin/ext-auth/mappings/${id}`, 'PUT', req);
  if (!res.ok) await throwApiError(res, 'Update group mapping');
  return safeJson(res);
}

export async function deleteMappingRule(id: number): Promise<void> {
  const res = await adminFetch(`/api/admin/ext-auth/mappings/${id}`, 'DELETE');
  if (!res.ok) await throwApiError(res, 'Delete group mapping');
}

interface MappingPreviewResponse {
  group_ids: number[];
  group_names: string[];
}

export async function previewMapping(email: string): Promise<MappingPreviewResponse> {
  const res = await adminFetch('/api/admin/ext-auth/mappings/preview', 'POST', { email });
  if (!res.ok) await throwApiError(res, 'Mapping preview');
  return safeJson(res);
}
