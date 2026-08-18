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

import {
  catalogDisplayName,
  type MCPCatalogEntry,
  type MCPCatalogFilters,
  type MCPCatalogSort,
} from '../types/mcp-catalog';

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
 * The catalog name, which is unique across the file.
 *
 * Every ordering ends here, so each is a total order: the grid cannot show an
 * entry twice or drop one because two entries compared equal and the sort was
 * free to pick either. It is a reverse-DNS identifier and appears on no screen,
 * which is why it is only ever the last key and never the first.
 */
function byIdentifier(a: MCPCatalogEntry, b: MCPCatalogEntry): number {
  return a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.name.localeCompare(b.name);
}

/**
 * Alphabetical by the name the card shows.
 *
 * Sorting by `name` instead puts `ai.exa/exa` before `com.airtable/mcp` — Exa
 * ahead of Airtable — because the leading label is a TLD. The user is reading
 * display names, so ordering by anything else reads as broken, and no entry in
 * the file states a `title`, which means every visible name is derived.
 *
 * `catalogDisplayName` is the same function the card and the drawer call, so
 * the order and the labels cannot disagree. Display names are not guaranteed
 * unique — two publishers could state one title — so the identifier still
 * settles ties.
 */
function byDisplayName(a: MCPCatalogEntry, b: MCPCatalogEntry): number {
  const display = catalogDisplayName(a)
    .toLowerCase()
    .localeCompare(catalogDisplayName(b).toLowerCase());
  return display || byIdentifier(a, b);
}

/** Compare two entries for a given sort key. */
function comparatorFor(
  sort: MCPCatalogSort | undefined
): (a: MCPCatalogEntry, b: MCPCatalogEntry) => number {
  if (sort === 'name') return byDisplayName;

  return (a, b) => {
    // An entry nobody ranked sorts after every ranked one rather than ahead of
    // rank 1, which is where an absent value would land compared numerically.
    const rankA = a.popularity_rank ?? Number.POSITIVE_INFINITY;
    const rankB = b.popularity_rank ?? Number.POSITIVE_INFINITY;
    return rankA - rankB || byIdentifier(a, b);
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
