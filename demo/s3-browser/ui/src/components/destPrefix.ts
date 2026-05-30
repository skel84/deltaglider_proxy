/**
 * Pure destination-prefix normalization for DestinationPickerModal.
 *
 * The copy/move modal sends the user-entered destination path as an S3
 * `dest_prefix`. Historically it only stripped leading/trailing slashes, so a
 * fat-fingered `foo//bar` survived verbatim and produced keys with a literal
 * empty path segment (`foo//bar/...`). This collapses internal slash runs too,
 * matching the canonical key-segment cleanup already applied to upload paths in
 * useS3Browser.ts (`.replace(/\/{2,}/g, '/')`).
 *
 * Guarantees (see destPrefix regression test):
 *   - no leading slash, no trailing slash
 *   - no internal `//` run
 *   - an all-slash / empty input yields `''` (bucket root)
 */
export function normalizeDestPrefix(input: string): string {
  return input
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\/{2,}/g, '/');
}
