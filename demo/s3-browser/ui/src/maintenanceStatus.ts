/**
 * Pure status→UI mapping for bucket maintenance (re-encryption) jobs.
 *
 * React-free so the Node regression script can transpile-and-import it
 * directly (same pattern as droppedFiles.ts / destinationSuggest.ts).
 *
 * The server's job view carries `percent` (0-99 while running, null
 * while counting, 100 on completed). These helpers turn that into the
 * three UI surfaces: the Buckets-page chip, the row progress bar, and
 * the browser banner.
 */

export interface MaintenanceJobView {
  id: number;
  kind: string;
  bucket: string;
  status: string; // queued | running | cancelling | completed | failed | cancelled
  phase: string; // counting | objects | references
  objects_total: number | null;
  objects_done: number;
  objects_skipped: number;
  objects_failed: number;
  bytes_done: number;
  percent: number | null;
  last_error: string | null;
  triggered_by: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

/** Statuses for which the bucket is gated (writes 503) and the UI shows busy. */
export function isActiveStatus(status: string): boolean {
  return status === 'queued' || status === 'running' || status === 'cancelling';
}

/**
 * Progress-bar percent for an ACTIVE job. `null` = indeterminate (queued,
 * or still counting objects) — render an animated/indeterminate bar.
 */
export function activePercent(job: MaintenanceJobView): number | null {
  if (job.status === 'queued') return null;
  return job.percent;
}

/** Short human label for the active phase, used next to the progress bar. */
export function phaseLabel(job: MaintenanceJobView): string {
  if (job.status === 'queued') return 'Waiting to start…';
  if (job.status === 'cancelling') return 'Cancelling…';
  switch (job.phase) {
    case 'counting':
      return 'Counting objects…';
    case 'references':
      return 'Finalizing (shared baselines)…';
    default: {
      const total = job.objects_total;
      const processed = job.objects_done + job.objects_skipped;
      return total != null ? `${processed} / ${total} objects` : `${processed} objects`;
    }
  }
}

/** One-line banner text for the object browser. */
export function browserBannerText(job: MaintenanceJobView): string {
  const pct = activePercent(job);
  const pctPart = pct != null ? ` — ${pct}%` : '';
  return `Re-encrypting this bucket${pctPart}. Files stay readable; uploads and deletes are temporarily unavailable.`;
}

/** Find the active job for a bucket in a job list (newest wins). */
export function activeJobForBucket(
  jobs: MaintenanceJobView[],
  bucket: string
): MaintenanceJobView | null {
  const key = bucket.toLowerCase();
  return (
    jobs.find((j) => j.bucket.toLowerCase() === key && isActiveStatus(j.status)) ?? null
  );
}
