// Central registry of product-facing docs bundled into the binary.
//
// Content is loaded by Vite glob from `docs/product/**/*.md` — the SAME
// files the marketing site bundles (see marketing/src/lib/docContent.ts).
// There is no hand-maintained import list: drop a .md under docs/product/
// and add its manifest entry, and it's picked up here automatically.
//
// `docs/dev/**` is NOT under docs/product/, so it can never be bundled.
// CI (scripts/check-docs-registry.sh) enforces manifest <-> disk parity.

// Grouping + ordering come from the shared manifest — the SINGLE source of
// truth, read by BOTH this in-product viewer and the marketing-website docs
// renderer (marketing/src/pages/docs).
import manifest from '../../../../docs/product/manifest.json';

/**
 * Raw markdown of every product doc, keyed by the manifest `path` (relative
 * to docs/product/, no extension). Vite inlines the file contents at build
 * time via `?raw`; `eager: true` makes them plain strings, not async imports.
 * A manifest path with no matching file throws below — keeps manifest honest.
 */
const rawModules = import.meta.glob('../../../../docs/product/**/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const CONTENT_BY_PATH: Record<string, string> = {};
for (const [absPath, content] of Object.entries(rawModules)) {
  const m = absPath.match(/\/docs\/product\/(.+)\.md$/);
  if (m) CONTENT_BY_PATH[m[1]] = content;
}

/** Extract the first `# heading` from markdown content */
function extractTitle(content: string): string {
  for (const line of content.split('\n')) {
    const m = line.match(/^#\s+(.+)/);
    if (m) return m[1].trim();
  }
  return 'Untitled';
}

// Group ids + taglines + ordering all derive from the shared manifest.
export type DocGroup = string;

export const DOC_GROUPS: readonly DocGroup[] = manifest.groups.map((g) => g.id);

/** One-line summary of what a group is for — rendered on the landing. */
export const GROUP_TAGLINE: Record<DocGroup, string> = Object.fromEntries(
  manifest.groups.map((g) => [g.id, g.tagline]),
);

export interface DocEntry {
  id: string;
  title: string;
  /** Path relative to docs/product/. Used by findDocByFilename to resolve links. */
  filename: string;
  content: string;
  group: DocGroup;
  /**
   * Sort position within the group. Lower = earlier. Landing + sidebar
   * render in ascending order; titles are *not* the sort key (they
   * change with editorial tweaks; order stays stable).
   */
  order: number;
}

interface ProductDoc {
  /** Path under docs/product/ — used as the doc's URL path under /_/docs/ */
  path: string;
  content: string;
  group: DocGroup;
  order: number;
}

// Derived from the shared manifest: iterate the manifest entries (which own
// group + order) and attach the statically-imported content for each path. A
// manifest path with no matching content throws loudly at module load — that
// only happens if a doc was added to the manifest without an import here, which
// CI (check-docs-registry.sh) also guards.
const PRODUCT_DOCS: ProductDoc[] = manifest.docs.map((d) => {
  const content = CONTENT_BY_PATH[d.path];
  if (content === undefined) {
    throw new Error(
      `docs manifest lists "${d.path}" but no ?raw import is registered in CONTENT_BY_PATH (docs-imports.ts)`,
    );
  }
  return { path: d.path, content, group: d.group, order: d.order };
});

/**
 * Convert a doc path ("auth/30-oauth-setup") into a URL-safe id
 * ("auth-30-oauth-setup"). Subfolder segments collapse to flat ids
 * because the doc URL space (`/_/docs/:id`) is intentionally flat —
 * it's a product surface, not a filesystem browser.
 */
function pathToId(path: string): string {
  return path.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export const DOCS: DocEntry[] = PRODUCT_DOCS.map((d) => ({
  id: pathToId(d.path),
  title: extractTitle(d.content),
  filename: d.path + '.md',
  content: d.content,
  group: d.group,
  order: d.order,
}));

/**
 * Resolve a markdown link to a DocEntry.
 *
 * Inter-doc links in the product bundle take three shapes:
 *   - `faq.md` (top-level)
 *   - `../faq.md` (from a subfolder back to top)
 *   - `reference/configuration.md` (from top-level into a subfolder)
 *   - `../reference/metrics.md` (from subfolder to subfolder)
 *
 * We normalise all of them by:
 *   1. Stripping leading `./` or `../` segments.
 *   2. Matching against each doc's `filename` (which already carries
 *      its full path under docs/product/).
 *
 * Returns undefined if the target isn't in the bundle — the caller
 * falls back to rendering the link as a normal anchor, so a missing
 * target degrades to a user-visible 404 (and CI catches it via
 * lychee before it ever ships).
 */
export function findDocByFilename(filename: string): DocEntry | undefined {
  // Strip common relative-path segments. After this, `filename` is
  // either a bare name ("foo.md"), a subfolder path ("auth/foo.md"),
  // or junk. `DOCS` filenames always have the form "<path>.md" where
  // `path` is the canonical PRODUCT_DOCS key.
  let target = filename.trim();
  // Strip query string / anchor — we match on path only.
  target = target.split('#')[0].split('?')[0];
  // Normalise away leading ../ and ./ sequences.
  while (target.startsWith('../')) target = target.slice(3);
  while (target.startsWith('./')) target = target.slice(2);

  const exact = DOCS.find((d) => d.filename === target);
  if (exact) return exact;

  // Fallback: bare filename match across all docs (handles legacy
  // links like `CONFIGURATION.md` that predate the subfolder move).
  // We deliberately do NOT match partial paths — that would make
  // renaming docs unsafe.
  const bare = target.replace(/^.*\//, '');
  return DOCS.find((d) => d.filename.replace(/^.*\//, '') === bare);
}
