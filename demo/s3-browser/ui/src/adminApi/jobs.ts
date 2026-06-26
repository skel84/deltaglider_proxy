// === Unified jobs API (replication / lifecycle / reencrypt / migrate) ===
import { throwApiError } from '../errorHandling';
import { adminFetch, fetchJson, safeJson } from './core';
import type { JobAction, JobRow } from '../jobsView';

interface JobsOverview {
  workers: {
    replication: { enabled: boolean; tick_interval: string; last_event_applied_at?: number | null };
    lifecycle: { enabled: boolean; tick_interval: string };
  };
  jobs: JobRow[];
}

interface JobRunEntry {
  id: number;
  triggered_by: string;
  started_at: number;
  finished_at?: number | null;
  status: string;
  status_raw: string;
  objects_scanned: number;
  objects_processed: number;
  objects_skipped: number;
  objects_deleted?: number | null;
  bytes: number;
  errors: number;
}

interface JobFailureEntry {
  id: number;
  run_id?: number | null;
  occurred_at: number;
  object_key: string;
  bucket?: string | null;
  source_key?: string | null;
  dest_key?: string | null;
  error: string;
}

// === Replication parity audit (the "Verify" tab) ===
export type Verifier = 'sha256' | 'etag_size' | 'size_only';
export type FindingKind = 'match' | 'checksum_mismatch' | 'missing_on_dest' | 'orphan_on_dest';

export interface ParityFinding {
  key: string;
  kind: FindingKind;
  verifier?: Verifier;
  unverifiable: boolean;
  detail: string;
}

export interface ParityOutcome {
  rule_name: string;
  source_bucket: string;
  dest_bucket: string;
  source_objects: number;
  dest_objects: number;
  matched: number;
  missing_on_dest: number;
  orphan_on_dest: number;
  checksum_mismatch: number;
  unverifiable: number;
  truncated: boolean;
  /** THE signal: true iff !truncated && missing/orphan/mismatch/unverifiable all 0. */
  in_sync: boolean;
  scanned_at: number; // unix SECONDS
  missing_samples: ParityFinding[];
  orphan_samples: ParityFinding[];
  mismatch_samples: ParityFinding[];
}

export async function getJobs(): Promise<JobsOverview> {
  return fetchJson('/api/admin/jobs', 'Jobs');
}

/**
 * On-demand source-vs-dest parity audit for a replication rule.
 * Synchronous POST: metadata-only compare, seconds typical, capped + truncatable.
 */
export async function verifyReplicationParity(ruleName: string): Promise<ParityOutcome> {
  const res = await adminFetch(
    `/api/admin/jobs/replication:${encodeURIComponent(ruleName)}/verify`,
    'POST'
  );
  if (!res.ok) await throwApiError(res, 'Verify replication parity');
  return safeJson(res);
}

export async function getJobRuns(id: string): Promise<{ runs: JobRunEntry[] }> {
  return fetchJson(`/api/admin/jobs/${encodeURIComponent(id)}/runs`, 'Job runs');
}

export async function getJobFailures(id: string): Promise<{ failures: JobFailureEntry[] }> {
  return fetchJson(`/api/admin/jobs/${encodeURIComponent(id)}/failures`, 'Job failures');
}

/** Uniform action dispatch; returns the action's JSON payload (if any). */
export async function runJobAction(id: string, action: JobAction): Promise<unknown> {
  const res = await adminFetch(`/api/admin/jobs/${encodeURIComponent(id)}/${action}`, 'POST');
  if (!res.ok) await throwApiError(res, `Job ${action}`);
  if (res.status === 204) return null;
  return safeJson(res);
}

/** Queue re-encryption jobs for the given buckets. */
export async function startReencrypt(buckets: string[]): Promise<{
  started: Array<{ bucket: string; job_id: number }>;
  errors: Array<{ bucket: string; error: string }>;
}> {
  const res = await adminFetch('/api/admin/jobs/reencrypt', 'POST', { buckets });
  if (!res.ok) await throwApiError(res, 'Start re-encryption');
  return safeJson(res);
}

/** Create a durable migrate job; returns 202 with the job id. */
export async function createMigrateJob(
  bucket: string,
  targetBackend: string,
  deleteSource: boolean
): Promise<{ job_id: number; id: string; bucket: string; from_backend: string; to_backend: string }> {
  const res = await adminFetch(`/api/admin/buckets/${encodeURIComponent(bucket)}/migrate`, 'POST', {
    target_backend: targetBackend,
    delete_source: deleteSource,
  });
  if (!res.ok) await throwApiError(res, `Migrate ${bucket}`);
  return safeJson(res);
}
