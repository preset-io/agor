/**
 * Narrowing and ordering the catalog.
 *
 * Separate from `catalog.ts` because this is the half with no filesystem in it.
 * The browser is now the only caller that narrows — the daemon hands over the
 * whole catalog and the Marketplace filters what it already holds — so this
 * module has to be importable from a bundle, and `catalog.ts` cannot be: it
 * reads `curated.yaml` off disk.
 *
 * Keeping it here rather than in the UI is what makes "search behaves the same"
 * a fact rather than a hope. There is one implementation of what a search term
 * matches and how ties break, it lives beside the types it filters, and
 * `query.test.ts` covers it. A copy in `apps/agor-ui` would be free to drift
 * one word at a time with nothing failing.
 */

import type { MCPCatalogEntry, MCPCatalogFilters, MCPCatalogSort } from '../types/mcp-catalog';

/** Case-insensitive substring test that tolerates an absent field. */
function contains(haystack: string | undefined, needle: string): boolean {
  return Boolean(haystack?.toLowerCase().includes(needle));
}

/** Whether one entry survives every active filter. */
function matches(entry: MCPCatalogEntry, filters: MCPCatalogFilters): boolean {
  const search = filters.search?.trim().toLowerCase();
  if (
    search &&
    !contains(entry.name, search) &&
    !contains(entry.title, search) &&
    !contains(entry.description, search)
  ) {
    return false;
  }
  if (filters.category && entry.category !== filters.category) return false;

  const capability = filters.capability?.trim().toLowerCase();
  if (capability && !entry.capabilities.some((tag) => tag.toLowerCase() === capability)) {
    return false;
  }

  if (filters.auth_types && !filters.auth_types.includes(entry.auth_type)) return false;
  return true;
}

/**
 * Compare two entries for a given sort key.
 *
 * Every ordering ends in `name`, which is unique across the catalog, so the
 * result is a total order: the grid cannot show an entry twice or drop one
 * because two entries compared equal and the sort was free to pick either.
 */
function comparatorFor(
  sort: MCPCatalogSort | undefined
): (a: MCPCatalogEntry, b: MCPCatalogEntry) => number {
  const byName = (a: MCPCatalogEntry, b: MCPCatalogEntry): number =>
    a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.name.localeCompare(b.name);

  if (sort === 'name') return byName;

  return (a, b) => {
    // An entry nobody ranked sorts after every ranked one rather than ahead of
    // rank 1, which is where an absent value would land compared numerically.
    const rankA = a.popularity_rank ?? Number.POSITIVE_INFINITY;
    const rankB = b.popularity_rank ?? Number.POSITIVE_INFINITY;
    return rankA - rankB || byName(a, b);
  };
}

/**
 * The entries matching `filters`, in sort order.
 *
 * The returned array is freshly built on every call, so a caller may reorder or
 * splice it — the Marketplace slices a page out of it — without reaching the
 * held catalog. The entries inside it are the shared frozen objects.
 */
export function filterCatalog(
  entries: readonly MCPCatalogEntry[],
  filters: MCPCatalogFilters = {}
): MCPCatalogEntry[] {
  const matched = entries.filter((entry) => matches(entry, filters));
  matched.sort(comparatorFor(filters.sort));
  return matched;
}
