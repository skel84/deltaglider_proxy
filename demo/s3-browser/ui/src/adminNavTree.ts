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
  /** The dirty-state key this entry owns (a leaf's nav path). Parents
   *  usually have none and roll up their descendants. */
  dirtyKey?: string;
  children?: T[];
}

/**
 * Should this nav entry show the amber "unsaved" dot, given the set of
 * currently-dirty keys?
 *
 * A LEAF lights iff its own `dirtyKey` is dirty. A PARENT lights iff ANY
 * descendant leaf is dirty (roll-up) — never just because a SIBLING shares a
 * coarse server section. This is the fix for the bug where one unsaved Storage
 * sub-section lit every Storage sibling: dirty keys are per-leaf (nav paths),
 * not the shared `storage` SectionName.
 *
 * Pure + JSX-free so it's unit-tested against a bare data tree.
 */
export function dirtyDotForEntry<T extends NavNode<T>>(
  entry: T,
  dirtyKeys: Set<string>
): boolean {
  if (entry.dirtyKey && dirtyKeys.has(entry.dirtyKey)) return true;
  // Roll up: any descendant leaf dirty → parent shows the dot.
  if (entry.children) {
    for (const child of entry.children) {
      if (dirtyDotForEntry(child, dirtyKeys)) return true;
    }
  }
  return false;
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
