// === Object Lifecycle ===
import { throwApiError } from '../errorHandling';
import { adminFetch, fetchJson, safeJson } from './core';
import type { AdminConfig } from './core';
import type { ReplicationConfig } from './replication';

export type LifecycleAction =
  | 'delete'
  | {
      type: 'transition' | 'archive';
      destination: {
        bucket: string;
        prefix?: string;
      };
      delete_source_after_success?: boolean;
    };

export interface LifecycleRuleConfig {
  name: string;
  enabled: boolean;
  bucket: string;
  prefix: string;
  action?: LifecycleAction;
  expire_after: string;
  include_globs: string[];
  exclude_globs: string[];
  batch_size: number;
}

export interface LifecycleConfig {
  enabled: boolean;
  tick_interval: string;
  max_failures_retained: number;
  rules: LifecycleRuleConfig[];
}

export interface StorageSectionBody {
  buckets?: AdminConfig['bucket_policies'];
  replication?: ReplicationConfig;
  lifecycle?: LifecycleConfig;
}

export interface LifecycleRuleOverview {
  name: string;
  enabled: boolean;
  bucket: string;
  prefix: string;
  action: LifecycleAction | string;
  expire_after: string;
  include_globs: string[];
  exclude_globs: string[];
  last_status: string;
  last_run_at: number | null;
  next_due_at: number;
  objects_affected_lifetime: number;
  bytes_affected_lifetime: number;
}

interface LifecycleOverview {
  worker_enabled: boolean;
  tick_interval: string;
  rules: LifecycleRuleOverview[];
}

export interface LifecyclePreviewObject {
  bucket: string;
  key: string;
  action: string;
  destination_bucket?: string;
  destination_key?: string;
  delete_source_after_success: boolean;
  created_at: string;
  size: number;
}

export interface LifecycleFailure {
  key: string;
  error: string;
}

export interface LifecycleRunOutcome {
  run_id?: number;
  rule_name: string;
  status: string;
  objects_scanned: number;
  objects_affected: number;
  objects_skipped: number;
  bytes_affected: number;
  errors: number;
  candidates: LifecyclePreviewObject[];
  failures: LifecycleFailure[];
}

export interface LifecycleHistoryEntry {
  id: number;
  triggered_by: 'scheduler' | 'run-now' | string;
  started_at: number;
  finished_at: number | null;
  objects_scanned: number;
  objects_affected: number;
  objects_skipped: number;
  bytes_affected: number;
  errors: number;
  status: string;
}

export interface LifecycleFailureEntry {
  id: number;
  run_id: number | null;
  occurred_at: number;
  bucket: string;
  object_key: string;
  error_message: string;
}

export async function getLifecycleOverview(): Promise<LifecycleOverview> {
  return fetchJson('/api/admin/lifecycle', 'Lifecycle overview');
}

export async function previewLifecycleRule(rule: string): Promise<LifecycleRunOutcome> {
  const res = await adminFetch(`/api/admin/lifecycle/rules/${encodeURIComponent(rule)}/preview`, 'POST');
  if (!res.ok) await throwApiError(res, 'Lifecycle preview');
  return safeJson(res);
}

export async function runLifecycleNow(rule: string): Promise<LifecycleRunOutcome> {
  const res = await adminFetch(`/api/admin/lifecycle/rules/${encodeURIComponent(rule)}/run-now`, 'POST');
  if (!res.ok) await throwApiError(res, 'Lifecycle run-now');
  return safeJson(res);
}

export async function getLifecycleHistory(rule: string, limit = 20): Promise<{ runs: LifecycleHistoryEntry[] }> {
  return fetchJson(`/api/admin/lifecycle/rules/${encodeURIComponent(rule)}/history?limit=${encodeURIComponent(limit)}`, 'Lifecycle history');
}

export async function getLifecycleFailures(rule: string, limit = 20): Promise<{ failures: LifecycleFailureEntry[] }> {
  return fetchJson(`/api/admin/lifecycle/rules/${encodeURIComponent(rule)}/failures?limit=${encodeURIComponent(limit)}`, 'Lifecycle failures');
}
