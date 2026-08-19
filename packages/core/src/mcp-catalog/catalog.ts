/**
 * The catalog itself: the parsed contents of `curated.yaml`.
 *
 * The whole catalog is a few dozen entries of authored text, identical for
 * every caller and unchanged for the life of the process. So it is parsed once
 * and held, and every read is served from there.
 *
 * Narrowing lives in `query.ts`, which has no filesystem in it and so can be
 * imported from the browser bundle that now does the narrowing.
 */

import type { MCPCatalogEntry } from '@agor/core/types';
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

/** Find one entry by its catalog name. */
export function findCatalogEntry(
  entries: readonly MCPCatalogEntry[],
  name: string
): MCPCatalogEntry | undefined {
  return entries.find((entry) => entry.name === name);
}
