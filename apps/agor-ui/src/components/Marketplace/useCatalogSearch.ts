/**
 * Paged reads of `/mcp-catalog`.
 *
 * The catalog is a global table that grows to thousands of registry rows, and
 * every predicate, the ordering and the page bounds already resolve in SQL. So
 * this fetches one page at a time and never holds the result set — it is
 * deliberately not hydrated into the workspace store, which models a
 * fully-loaded tenant-scoped collection kept live by socket events. The catalog
 * has no writers a browser can observe and nothing to keep live.
 *
 * Reads wait for `ready`. The client object exists from the moment the socket
 * is being built, well before it has connected and authenticated, so a surface
 * that fetches on `client !== null` asks an anonymous socket and is refused.
 */

import type { MCPCatalogCategory, MCPCatalogEntry, MCPCatalogSort } from '@agor/core/types';
import type { AgorClient, FindResult } from '@agor-live/client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { CONNECTABLE_PROBE_VERDICTS } from './catalogPresentation';

/** The catalog service always paginates; an array is only a defensive fallback. */
function asPage(result: FindResult<MCPCatalogEntry>): { data: MCPCatalogEntry[]; total: number } {
  return Array.isArray(result)
    ? { data: result, total: result.length }
    : { data: result.data, total: result.total };
}

export const CATALOG_PAGE_SIZE = 24;

export interface CatalogFilterState {
  search: string;
  category?: MCPCatalogCategory;
  capability?: string;
  reviewedOnly: boolean;
  connectableOnly: boolean;
  sort: MCPCatalogSort;
}

export function isFilterActive(filters: CatalogFilterState): boolean {
  return Boolean(
    filters.search.trim() ||
      filters.category ||
      filters.capability ||
      filters.reviewedOnly ||
      filters.connectableOnly
  );
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
  entries: MCPCatalogEntry[];
  status: CatalogStatus;
  /** Rows matching the active filters. Meaningful only when `ready`. */
  matchCount: number;
  /** Rows in the catalog with no filters applied, for "N of M". */
  catalogSize: number | null;
  error: string | null;
  retry: () => void;
}

function buildQuery(filters: CatalogFilterState, page: number): Record<string, unknown> {
  const search = filters.search.trim();
  return {
    ...(search ? { search } : {}),
    ...(filters.category ? { category: filters.category } : {}),
    ...(filters.capability ? { capability: filters.capability } : {}),
    ...(filters.reviewedOnly ? { curated: true } : {}),
    ...(filters.connectableOnly ? { probed_auth_types: CONNECTABLE_PROBE_VERDICTS } : {}),
    sort: filters.sort,
    $limit: CATALOG_PAGE_SIZE,
    $skip: (page - 1) * CATALOG_PAGE_SIZE,
  };
}

export function useCatalogSearch(
  client: AgorClient | null,
  ready: boolean,
  filters: CatalogFilterState,
  page: number
): CatalogSearchResult {
  const [entries, setEntries] = useState<MCPCatalogEntry[]>([]);
  const [status, setStatus] = useState<CatalogStatus>('loading');
  const [matchCount, setMatchCount] = useState(0);
  const [catalogSize, setCatalogSize] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);

  // Responses can land out of order — a cheap `$skip` page overtaking a slow
  // search. Only the newest request may write state.
  const requestSeq = useRef(0);

  const { search, category, capability, reviewedOnly, connectableOnly, sort } = filters;

  // biome-ignore lint/correctness/useExhaustiveDependencies: retryToken is a manual re-run trigger, not a value the effect reads
  useEffect(() => {
    if (!client || !ready) {
      // Not a result, so not an empty one. Hold the loading state until the
      // socket can actually answer.
      setStatus('loading');
      return;
    }

    const seq = ++requestSeq.current;
    let cancelled = false;
    setStatus('loading');

    const query = buildQuery(
      { search, category, capability, reviewedOnly, connectableOnly, sort },
      page
    );
    client
      .service('mcp-catalog')
      .find({ query })
      .then((result) => {
        if (cancelled || seq !== requestSeq.current) return;
        const matched = asPage(result);
        setEntries(matched.data);
        setMatchCount(matched.total);
        setError(null);
        setStatus('ready');
      })
      .catch((err: unknown) => {
        if (cancelled || seq !== requestSeq.current) return;
        setEntries([]);
        setMatchCount(0);
        setError(err instanceof Error ? err.message : 'Could not load the catalog');
        setStatus('error');
      });

    return () => {
      cancelled = true;
    };
  }, [
    client,
    ready,
    search,
    category,
    capability,
    reviewedOnly,
    connectableOnly,
    sort,
    page,
    retryToken,
  ]);

  // The unfiltered size is the M in "N of M". It changes only when ingestion
  // runs, so it is read once rather than alongside every filtered page. A
  // failure here only costs the count, never the grid.
  // biome-ignore lint/correctness/useExhaustiveDependencies: retryToken is a manual re-run trigger, not a value the effect reads
  useEffect(() => {
    if (!client || !ready) return;
    let cancelled = false;
    client
      .service('mcp-catalog')
      .find({ query: { $limit: 1 } })
      .then((result) => {
        if (!cancelled) setCatalogSize(asPage(result).total);
      })
      .catch(() => {
        if (!cancelled) setCatalogSize(null);
      });
    return () => {
      cancelled = true;
    };
  }, [client, ready, retryToken]);

  const retry = useCallback(() => setRetryToken((token) => token + 1), []);

  return { entries, status, matchCount, catalogSize, error, retry };
}
