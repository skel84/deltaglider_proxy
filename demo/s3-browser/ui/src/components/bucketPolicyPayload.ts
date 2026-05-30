/**
 * Pure payload + validation logic for BucketsPanel.
 *
 * Extracted to a React-free module (no antd / no hooks) so the Node
 * regression script can transpile-and-import it directly, and so the
 * fetch→dirty→validate→PUT pipeline can move onto the shared
 * `useSectionEditor` hook without duplicating the storage-section
 * apply machinery.
 *
 * The local editing shape carries stable synthetic ids (`_id` on each
 * row, `{ id, value }` on each public prefix) so React keys by identity,
 * not array index. Those ids are NEVER serialised — `rowToPolicy`
 * strips them on the way to the wire.
 *
 * `buildBucketPayload` mirrors the old in-component `buildPayload`:
 * it validates (duplicate bucket names) and produces the exact
 * `{ buckets }` body sent to /validate and PUT. The body is
 * byte-identical to the pre-refactor builder for the same input.
 */
import type { AdminConfig } from '../adminApi';

/** A public-prefix entry carrying a stable synthetic id so the
 *  prefix list keys by identity, not array index. */
export interface PrefixEntry {
  id: string;
  value: string;
}

/** Local working shape — mirrors the backend `BucketPolicyConfig`
 *  but normalises nulls to undefined for the form controllers. */
export interface BucketPolicyRow {
  /** Stable synthetic id — React key + mutate-by-id target. Never serialised. */
  _id: string;
  name: string;
  /** `null` = omit key / YAML null — inherit engine default (delta enabled). */
  compression: boolean | null;
  max_delta_ratio: number | null;
  backend: string;
  alias: string;
  /** Tri-state source of truth for the anonymous-read radio group. */
  publicMode: 'none' | 'entire' | 'prefixes';
  /** Specific prefixes — only surfaced when `publicMode === 'prefixes'`.
   *  Local editing shape carries stable ids; converted to/from the wire
   *  `string[]` in policyToRow / rowToPolicy. */
  public_prefixes: PrefixEntry[];
  quota_bytes: number | null;
}

let rowIdCounter = 0;

/** Monotonic, collision-free row id (stable React key; never reused). */
export const freshId = (): string => `bkt-${++rowIdCounter}`;

export function policyToRow(
  name: string,
  p: NonNullable<AdminConfig['bucket_policies']>[string]
): BucketPolicyRow {
  // Determine the tri-state from the persisted shape:
  //   * `public: true` (shorthand)          -> entire
  //   * `public_prefixes: [""]` (expanded)   -> entire
  //   * `public_prefixes: ["builds/", ...]`  -> prefixes
  //   * anything else                        -> none
  let publicMode: 'none' | 'entire' | 'prefixes' = 'none';
  let prefixes: string[] = [];
  if (p.public === true) {
    publicMode = 'entire';
  } else if (p.public_prefixes && p.public_prefixes.length > 0) {
    if (p.public_prefixes.length === 1 && p.public_prefixes[0] === '') {
      publicMode = 'entire';
    } else {
      publicMode = 'prefixes';
      prefixes = p.public_prefixes.slice();
    }
  }
  return {
    _id: freshId(),
    name,
    compression:
      p.compression === undefined || p.compression === null ? null : p.compression,
    max_delta_ratio: p.max_delta_ratio ?? null,
    backend: p.backend ?? '',
    alias: p.alias ?? '',
    publicMode,
    public_prefixes: prefixes.map((value) => ({ id: freshId(), value })),
    quota_bytes: p.quota_bytes ?? null,
  };
}

function rowToPolicy(row: BucketPolicyRow): {
  /** Omitted or explicit bool; JSON `null` clears inherit (RFC 7396 merge removes key). */
  compression?: boolean | null;
  max_delta_ratio?: number;
  backend?: string;
  alias?: string;
  public_prefixes?: string[];
  quota_bytes?: number;
} {
  // Serialise the tri-state back to the wire shape the backend
  // accepts. `entire` uses the empty-string sentinel `[""]` — the
  // backend's `BucketPolicyConfig::normalize` collapses it to
  // `public: true` on re-serialisation, lossless round-trip.
  const out: ReturnType<typeof rowToPolicy> = {};
  // Section storage merge is RFC 7396 per nested object: omitting `compression`
  // leaves the previous value; JSON `null` removes the key → inherit default.
  out.compression = row.compression === null ? null : row.compression;
  if (row.max_delta_ratio != null) out.max_delta_ratio = row.max_delta_ratio;
  if (row.backend) out.backend = row.backend;
  if (row.alias) out.alias = row.alias;
  if (row.quota_bytes != null) out.quota_bytes = row.quota_bytes;
  if (row.publicMode === 'entire') {
    out.public_prefixes = [''];
  } else if (row.publicMode === 'prefixes') {
    const cleaned = row.public_prefixes
      .map((p) => p.value.trim())
      .filter((p) => p.length > 0);
    if (cleaned.length > 0) out.public_prefixes = cleaned;
  }
  return out;
}

type BucketPayloadResult =
  | { ok: true; body: { buckets: AdminConfig['bucket_policies'] } }
  | { ok: false; error: string };

/**
 * Validate the rows + build the `{ buckets }` storage-section body.
 *
 * Validation: bucket names must be non-empty (empty rows are
 * genuinely-unfilled and dropped); duplicate names abort with an
 * error. Identical to the pre-refactor in-component `buildPayload`.
 */
export function buildBucketPayload(rows: BucketPolicyRow[]): BucketPayloadResult {
  const cleaned = rows.filter((r) => r.name.trim());
  const names = cleaned.map((r) => r.name);
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  if (dupes.length > 0) {
    return { ok: false, error: `Duplicate bucket name: ${dupes[0]}` };
  }
  const bp: AdminConfig['bucket_policies'] = {};
  for (const row of cleaned) {
    bp[row.name] = rowToPolicy(row);
  }
  return { ok: true, body: { buckets: bp } };
}
