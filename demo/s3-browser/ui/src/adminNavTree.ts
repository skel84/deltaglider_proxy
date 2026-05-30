/**
 * Pure tree-walk over the admin IA (`ADMIN_IA` in
 * `components/adminNavigation.tsx`). Kept JSX-free in its own module so
 * the navigation single-source-of-truth logic can be unit-tested with a
 * plain data tree (no icon imports, no JSX factory) — see
 * `scripts/admin-nav-tree-regression-test.mjs`.
 *
 * Generic over the entry shape: callers in `adminNavigation.tsx` pass
 * the real `SidebarEntry` tree; the regression test feeds bare
 * `{ path, children }` objects.
 */

interface NavNode<T extends NavNode<T>> {
  path: string;
  children?: T[];
}

/** Depth-first lookup of the entry whose `path` matches exactly. */
export function findEntry<T extends NavNode<T>>(
  groups: Array<{ entries: T[] }>,
  path: string
): T | undefined {
  const walk = (entries: T[]): T | undefined => {
    for (const e of entries) {
      if (e.path === path) return e;
      if (e.children) {
        const hit = walk(e.children);
        if (hit) return hit;
      }
    }
    return undefined;
  };
  for (const g of groups) {
    const hit = walk(g.entries);
    if (hit) return hit;
  }
  return undefined;
}

/** Direct leaf children of the entry at `sectionPath` (empty if none). */
export function leavesUnder<T extends NavNode<T>>(
  groups: Array<{ entries: T[] }>,
  sectionPath: string
): T[] {
  return findEntry(groups, sectionPath)?.children ?? [];
}
