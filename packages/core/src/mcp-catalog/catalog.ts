/**
 * The catalog itself: the parsed contents of `curated.yaml`, and the reads over
 * them.
 *
 * The whole catalog is a few dozen entries of authored text, identical for
 * every caller and unchanged for the life of the process. So it is parsed once
 * and held, and a read is a pass over an array rather than a query. What the
 * marketplace does on every keystroke costs less here than the round trip that
 * carries it.
 */

import type { MCPCatalogEntry, MCPCatalogFilters, MCPCatalogSort } from '@agor/core/types';
import { loadCuratedCatalog } from './curated-loader';

/**
 * The loaded catalog, or null before the first read.
 *
 * A rejected load is not retained: the failure modes are a missing or
 * unreadable file, and caching the rejection would make one bad read permanent
 * for a process that could otherwise recover on the next request.
 */
let loaded: Promise<readonly MCPCatalogEntry[]> | null = null;

/**
 * Freeze an entry and everything reachable from it.
 *
 * Callers get the same objects on every read rather than copies, which is what
 * makes holding the catalog worth doing. Freezing is what makes sharing them
 * safe: a caller that sorted `capabilities` in place, or blanked a field it
 * meant to omit from a response, would corrupt the catalog for every later
 * read in the process, and nothing would point back here.
 */
function freezeEntry(entry: MCPCatalogEntry): MCPCatalogEntry {
  Object.freeze(entry.capabilities);
  return Object.freeze(entry);
}

/**
 * The catalog, parsed on first use.
 *
 * @param filePath Overrides the checked-in file. Tests pass this; it bypasses
 * the cache, because a test that pointed at its own fixture and got the shipped
 * catalog would be asserting against the wrong data.
 */
export function loadCatalog(filePath?: string): Promise<readonly MCPCatalogEntry[]> {
  if (filePath !== undefined) {
    return loadCuratedCatalog(filePath).then((entries) => Object.freeze(entries.map(freezeEntry)));
  }
  loaded ??= loadCuratedCatalog()
    .then((entries) => Object.freeze(entries.map(freezeEntry)))
    .catch((error) => {
      loaded = null;
      throw error;
    });
  return loaded;
}

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

  if (filters.has_remote !== undefined && entry.has_remote !== filters.has_remote) return false;
  if (filters.auth_type && entry.auth_type !== filters.auth_type) return false;
  if (filters.auth_types && !filters.auth_types.includes(entry.auth_type)) return false;
  if (filters.names && !filters.names.includes(entry.name)) return false;
  return true;
}

/**
 * Compare two entries for a given sort key.
 *
 * Every ordering ends in `name`, which is unique across the catalog, so the
 * result is a total order and a page taken at one offset cannot repeat or skip
 * an entry a page at another offset showed.
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
 * Filter, order, and page the catalog, and say how many entries matched in
 * total.
 *
 * The returned array is freshly built on every call, so a caller may reorder or
 * splice it without reaching the held catalog; the entries inside it are the
 * shared frozen objects.
 */
export function queryCatalog(
  entries: readonly MCPCatalogEntry[],
  filters: MCPCatalogFilters = {}
): { data: MCPCatalogEntry[]; total: number } {
  const matched = entries.filter((entry) => matches(entry, filters));
  matched.sort(comparatorFor(filters.sort));

  const offset = filters.offset ?? 0;
  const data =
    filters.limit === undefined
      ? matched.slice(offset)
      : matched.slice(offset, offset + filters.limit);
  return { data, total: matched.length };
}

/** Find one entry by its catalog name. */
export function findCatalogEntry(
  entries: readonly MCPCatalogEntry[],
  name: string
): MCPCatalogEntry | undefined {
  return entries.find((entry) => entry.name === name);
}
