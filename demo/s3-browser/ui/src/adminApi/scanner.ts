// === Usage Scanner ===
import { throwApiError } from '../errorHandling';
import { adminFetch, safeJson } from './core';

interface ChildUsage {
  size: number;
  objects: number;
}

interface UsageEntry {
  prefix: string;
  bucket: string;
  total_size: number;
  total_objects: number;
  children: Record<string, ChildUsage>;
  computed_at: string;
  stale_seconds: number;
}

/** Trigger a background usage scan for a bucket/prefix. */
export async function scanPrefixUsage(bucket: string, prefix: string): Promise<void> {
  const res = await adminFetch('/api/admin/usage/scan', 'POST', { bucket, prefix });
  if (!res.ok) await throwApiError(res, 'Prefix usage scan');
}

/** Get cached usage entry for a bucket/prefix, or null if not cached yet. */
export async function getPrefixUsage(bucket: string, prefix: string): Promise<UsageEntry | null> {
  const params = new URLSearchParams({ bucket, prefix });
  const res = await adminFetch(`/api/admin/usage?${params}`);
  if (!res.ok) await throwApiError(res, 'Usage query');
  // The server returns 200 `{ cached: false }` for the not-yet-scanned case
  // (a benign state, not a 404 — keeps the console clean).
  const body = await safeJson(res);
  if (!body || (body as { cached?: boolean }).cached === false) return null;
  return body as UsageEntry;
}

/**
 * Per-prefix delta-compression savings, reference-aware.
 *
 * Backed by `src/api/admin/savings.rs` + the central `SavingsTotals`
 * accumulator. Unlike a client-side aggregation over `headCache`, this
 * includes the on-disk `reference.bin` cost in `stored_bytes`, so the
 * chip never displays "100% saved" while a reference still lives on
 * disk. Server-side cached for 30 s.
 */
interface PrefixSavingsTotals {
  original_bytes: number;
  stored_bytes: number;
  reference_bytes: number;
  delta_stored_bytes: number;
  passthrough_bytes: number;
  reference_count: number;
  delta_count: number;
  passthrough_count: number;
}

export interface PrefixSavingsResponse {
  bucket: string;
  prefix: string;
  totals: PrefixSavingsTotals;
  /** 0..=99.99, or null when there's nothing measurable under the prefix. */
  savings_percentage: number | null;
  truncated: boolean;
  computed_at: string;
}

export async function getPrefixSavings(
  bucket: string,
  prefix: string,
): Promise<PrefixSavingsResponse | null> {
  const params = new URLSearchParams({ bucket, prefix });
  const res = await adminFetch(`/api/admin/deltaspace/savings?${params}`);
  if (!res.ok) {
    // 401/403 (no admin session) is expected on bootstrap-only S3
    // browsers — we silently degrade and the chip stays hidden.
    if (res.status === 401 || res.status === 403) return null;
    await throwApiError(res, 'Prefix savings query');
  }
  return safeJson(res);
}

// === Per-bucket running usage counter (Ceph-style O(1) size) ===

/**
 * O(1) per-bucket size from the running counter (`src/bucket_usage.rs`),
 * maintained inline on every PUT/DELETE — no scan. `last_scan_at` is when an
 * authoritative full scan last reconciled it (null = never; the inline running
 * total is still shown). Returns null on 401/403 (no admin session) so callers
 * can silently degrade.
 */
export interface BucketUsage {
  bucket: string;
  object_count: number;
  logical_bytes: number;
  stored_bytes: number;
  savings_percentage: number | null;
  last_scan_at: number | null;
  never_scanned: boolean;
}

export async function getBucketUsage(bucket: string): Promise<BucketUsage | null> {
  const res = await adminFetch(`/api/admin/usage/bucket/${encodeURIComponent(bucket)}`);
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) return null;
    await throwApiError(res, 'Bucket usage query');
  }
  return safeJson(res);
}

/** Force an authoritative full scan and overwrite the counter; returns the
 *  reconciled row. The only O(n) path — the Refresh button. */
export async function refreshBucketUsage(bucket: string): Promise<BucketUsage | null> {
  const params = new URLSearchParams({ bucket });
  const res = await adminFetch(`/api/admin/usage/refresh?${params}`, 'POST');
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) return null;
    await throwApiError(res, 'Bucket usage refresh');
  }
  return safeJson(res);
}
