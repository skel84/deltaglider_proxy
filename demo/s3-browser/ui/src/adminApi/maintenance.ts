// === Bucket maintenance (re-encryption) jobs ===
import { throwApiError } from '../errorHandling';
import { adminFetch, fetchJson, safeJson } from './core';
import type { MaintenanceJobView } from '../maintenanceStatus';

interface ReencryptResponse {
  started: Array<{ bucket: string; job_id: number }>;
  errors: Array<{ bucket: string; error: string }>;
}

/** Queue re-encryption jobs for the given buckets (admin tier). */
export async function startReencrypt(buckets: string[]): Promise<ReencryptResponse> {
  const res = await adminFetch('/api/admin/maintenance/reencrypt', 'POST', { buckets });
  if (!res.ok) await throwApiError(res, 'Start re-encryption');
  return safeJson(res);
}

/** Recent jobs, newest first (admin tier). */
export async function getMaintenanceJobs(): Promise<{ jobs: MaintenanceJobView[] }> {
  return fetchJson('/api/admin/maintenance', 'Maintenance jobs');
}

/**
 * The bucket's active job, if any. Session-light: works for non-admin
 * browser sessions too (powers the browser busy banner).
 */
export async function getBucketMaintenance(
  bucket: string
): Promise<{ active: MaintenanceJobView | null }> {
  return fetchJson(
    `/api/admin/maintenance/bucket/${encodeURIComponent(bucket)}`,
    'Bucket maintenance status'
  );
}

export async function cancelMaintenanceJob(id: number): Promise<{ status: string }> {
  const res = await adminFetch(`/api/admin/maintenance/jobs/${id}/cancel`, 'POST');
  if (!res.ok) await throwApiError(res, 'Cancel maintenance job');
  return safeJson(res);
}
