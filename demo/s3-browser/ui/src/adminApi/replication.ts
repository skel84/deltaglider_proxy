// === Object Replication ===
import { throwApiError } from '../errorHandling';
import { adminFetch, fetchJson, safeJson } from './core';

export type ReplicationConflictPolicy = 'newer-wins' | 'source-wins' | 'skip-if-dest-exists';

export interface ReplicationEndpoint {
  bucket: string;
  prefix: string;
}

export interface ReplicationRuleConfig {
  name: string;
  enabled: boolean;
  source: ReplicationEndpoint;
  destination: ReplicationEndpoint;
  interval: string;
  batch_size: number;
  replicate_deletes: boolean;
  conflict: ReplicationConflictPolicy;
  include_globs: string[];
  exclude_globs: string[];
}

export interface ReplicationConfig {
  enabled: boolean;
  tick_interval: string;
  lease_ttl: string;
  heartbeat_interval: string;
  max_failures_retained: number;
  rules: ReplicationRuleConfig[];
}

export interface ReplicationRuleOverview {
  name: string;
  enabled: boolean;
  paused: boolean;
  interval: string;
  source_bucket: string;
  source_prefix: string;
  destination_bucket: string;
  destination_prefix: string;
  last_status: string;
  last_run_at: number | null;
  next_due_at: number;
  objects_copied_lifetime: number;
  bytes_copied_lifetime: number;
}

interface ReplicationOverview {
  worker_enabled: boolean;
  tick_interval: string;
  rules: ReplicationRuleOverview[];
}

interface ReplicationRunNowResponse {
  run_id: number;
  status: string;
  objects_scanned: number;
  objects_copied: number;
  objects_skipped: number;
  bytes_copied: number;
  errors: number;
}

export interface ReplicationHistoryEntry {
  id: number;
  triggered_by: 'scheduler' | 'run-now' | 'unknown' | string;
  started_at: number;
  finished_at: number | null;
  objects_scanned: number;
  objects_copied: number;
  objects_skipped: number;
  objects_deleted: number;
  bytes_copied: number;
  errors: number;
  status: string;
}

export interface ReplicationFailureEntry {
  id: number;
  run_id: number | null;
  occurred_at: number;
  source_key: string;
  dest_key: string;
  error_message: string;
}

export async function getReplicationOverview(): Promise<ReplicationOverview> {
  return fetchJson('/api/admin/replication', 'Replication overview');
}

export async function runReplicationNow(rule: string): Promise<ReplicationRunNowResponse> {
  const res = await adminFetch(`/api/admin/replication/rules/${encodeURIComponent(rule)}/run-now`, 'POST');
  if (!res.ok) await throwApiError(res, 'Replication run-now');
  return safeJson(res);
}

export async function pauseReplicationRule(rule: string): Promise<void> {
  const res = await adminFetch(`/api/admin/replication/rules/${encodeURIComponent(rule)}/pause`, 'POST');
  if (!res.ok) await throwApiError(res, 'Replication pause');
}

export async function resumeReplicationRule(rule: string): Promise<void> {
  const res = await adminFetch(`/api/admin/replication/rules/${encodeURIComponent(rule)}/resume`, 'POST');
  if (!res.ok) await throwApiError(res, 'Replication resume');
}

export async function getReplicationHistory(rule: string, limit = 20): Promise<{ runs: ReplicationHistoryEntry[] }> {
  return fetchJson(`/api/admin/replication/rules/${encodeURIComponent(rule)}/history?limit=${encodeURIComponent(limit)}`, 'Replication history');
}

export async function getReplicationFailures(rule: string, limit = 20): Promise<{ failures: ReplicationFailureEntry[] }> {
  return fetchJson(`/api/admin/replication/rules/${encodeURIComponent(rule)}/failures?limit=${encodeURIComponent(limit)}`, 'Replication failures');
}
