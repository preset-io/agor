/**
 * The catalog, read once and narrowed in the browser.
 *
 * `/mcp-catalog` returns all ~50 entries in one read, so this fetches them once
 * per mount and every filter, sort and page after that is a pass over an array
 * already in memory. Searching is a keystroke rather than a debounced round
 * trip, and there is no second request whose only job is to learn the total.
 *
 * The catalog is deliberately not hydrated into the workspace store, which
 * models a fully-loaded tenant-scoped collection kept live by socket events.
 * This has no writers a browser can observe and nothing to keep live — it
 * changes when the daemon is redeployed, which reloads the page anyway.
 *
 * Reads wait for `ready`. The client object exists from the moment the socket
 * is being built, well before it has connected and authenticated, so a surface
 * that fetches on `client !== null` asks an anonymous socket and is refused.
 *
 * Filtering and ordering come from `@agor/core/mcp-catalog/query` rather than
 * being written here, so that "search matches the same things it used to" holds
 * by construction: it is the same function, and one test suite covers it.
 */

import { filterCatalog } from '@agor/core/mcp-catalog/query';
import type { MCPCatalogCategory, MCPCatalogEntry, MCPCatalogSort } from '@agor/core/types';
import type { AgorClient, FindResult } from '@agor-live/client';
import { useCallback, useEffect, useMemo, useState } from 'react';

/** The catalog service always paginates; an array is only a defensive fallback. */
function asEntries(result: FindResult<MCPCatalogEntry>): MCPCatalogEntry[] {
  return Array.isArray(result) ? result : result.data;
}

export const CATALOG_PAGE_SIZE = 24;

export interface CatalogFilterState {
  search: string;
  category?: MCPCatalogCategory;
  capability?: string;
  sort: MCPCatalogSort;
}

export function isFilterActive(filters: CatalogFilterState): boolean {
  return Boolean(filters.search.trim() || filters.category || filters.capability);
}

/**
 * Load state as three exclusive cases.
 *
 * A boolean pair let "the read failed" and "the catalog has nothing to show"
 * reach the same branch, and an empty grid is the more plausible-looking of
 * the two — so a broken read rendered as an honest-looking answer. `empty` is
 * now only reachable from a read that actually returned.
 */
export type CatalogStatus = 'loading' | 'ready' | 'error';

export interface CatalogSearchResult {
  /** The current page of matching entries. */
  entries: MCPCatalogEntry[];
  status: CatalogStatus;
  /** Entries matching the active filters. Meaningful only when `ready`. */
  matchCount: number;
  /** Entries in the catalog with no filters applied, for "N of M". */
  catalogSize: number | null;
  error: string | null;
  retry: () => void;
}

export function useCatalogSearch(
  client: AgorClient | null,
  ready: boolean,
  filters: CatalogFilterState,
  page: number
): CatalogSearchResult {
  const [catalog, setCatalog] = useState<MCPCatalogEntry[] | null>(null);
  const [status, setStatus] = useState<CatalogStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);

  const { search, category, capability, sort } = filters;

  // biome-ignore lint/correctness/useExhaustiveDependencies: retryToken is a manual re-run trigger, not a value the effect reads
  useEffect(() => {
    if (!client || !ready) {
      // Not a result, so not an empty one. Hold the loading state until the
      // socket can actually answer.
      setStatus('loading');
      return;
    }

    let cancelled = false;
    setStatus('loading');

    client
      .service('mcp-catalog')
      .find()
      .then((result) => {
        if (cancelled) return;
        setCatalog(asEntries(result));
        setError(null);
        setStatus('ready');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setCatalog(null);
        setError(err instanceof Error ? err.message : 'Could not load the catalog');
        setStatus('error');
      });

    return () => {
      cancelled = true;
    };
  }, [client, ready, retryToken]);

  // Everything below is derived from what is already held: no request, and no
  // dependency on `page`, so paging does not re-filter the catalog.
  const matched = useMemo(
    () =>
      catalog === null
        ? []
        : filterCatalog(catalog, {
            search,
            category,
            capability,
            sort,
            // The toolbar's one auth control means a set: "not known to need an
            // account" is stated-open *or* not stated.
          }),
    [catalog, search, category, capability, sort]
  );

  const entries = useMemo(() => {
    const start = (page - 1) * CATALOG_PAGE_SIZE;
    return matched.slice(start, start + CATALOG_PAGE_SIZE);
  }, [matched, page]);

  const retry = useCallback(() => setRetryToken((token) => token + 1), []);

  return {
    entries,
    status,
    matchCount: matched.length,
    catalogSize: catalog?.length ?? null,
    error,
    retry,
  };
}
