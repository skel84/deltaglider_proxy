import { clamp } from './utils';

export const DEFAULT_UPLOAD_PART_SIZE = 16 * 1024 * 1024; // 16 MiB
export const DEFAULT_UPLOAD_QUEUE_SIZE = 4;
const SPEED_WINDOW_MS = 5000;

export type UploadStatus =
  | 'queued'
  | 'uploading'
  | 'completing'
  | 'success'
  | 'error'
  | 'cancelled';

export interface ThroughputSample {
  atMs: number;
  loadedBytes: number;
}

export function clampPercent(value: number): number {
  return clamp(value, 0, 100);
}

// Merge an incoming telemetry totalBytes against the queue item's known size.
// A legitimate 0 (0-byte upload) must be preserved, so use nullish coalescing
// rather than `||` (which would treat 0 as "no value" and fall back). The
// fallback still covers telemetry events that arrive before the size is known
// (undefined/null totalBytes).
export function mergeTotalBytes(
  telemetryTotal: number | null | undefined,
  itemTotal: number,
): number {
  return telemetryTotal ?? itemTotal;
}

export function estimateTotalParts(totalBytes: number, partSize: number): number {
  if (partSize <= 0 || totalBytes <= 0) return 0;
  return Math.max(1, Math.ceil(totalBytes / partSize));
}

export function estimateCompletedParts(
  loadedBytes: number,
  totalBytes: number,
  partSize: number,
): number {
  const totalParts = estimateTotalParts(totalBytes, partSize);
  if (totalParts === 0) return 0;
  if (loadedBytes >= totalBytes && totalBytes > 0) return totalParts;
  return Math.min(totalParts, Math.floor(Math.max(0, loadedBytes) / partSize));
}

export function estimateInFlightParts(
  status: UploadStatus,
  totalParts: number,
  completedParts: number,
  queueSize: number,
): number {
  if (status !== 'uploading' && status !== 'completing') return 0;
  const remaining = Math.max(0, totalParts - completedParts);
  if (remaining === 0) return 0;
  return Math.min(Math.max(1, queueSize), remaining);
}

export function appendThroughputSample(
  samples: ThroughputSample[],
  sample: ThroughputSample,
  windowMs = SPEED_WINDOW_MS,
): ThroughputSample[] {
  const threshold = sample.atMs - windowMs;
  const pruned = samples.filter((s) => s.atMs >= threshold);
  return [...pruned, sample];
}

export function movingAverageSpeedBps(samples: ThroughputSample[]): number {
  if (samples.length < 2) return 0;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const elapsedMs = last.atMs - first.atMs;
  const bytes = last.loadedBytes - first.loadedBytes;
  if (elapsedMs <= 0 || bytes <= 0) return 0;
  return (bytes / elapsedMs) * 1000;
}
