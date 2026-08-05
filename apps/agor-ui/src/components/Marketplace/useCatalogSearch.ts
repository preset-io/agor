/**
 * Paged reads of `/mcp-catalog`.
 *
 * The catalog is a global table that grows to thousands of registry rows, and
 * every predicate, the ordering and the page bounds already resolve in SQL. So
 * this fetches one page at a time and never holds the result set — it is
 * deliberately not hydrated into the workspace store, which models a
 * fully-loaded tenant-scoped collection kept live by socket events. The catalog
 * has no writers a browser can observe and nothing to keep live.
 */

import type { MCPCatalogCategory, MCPCatalogEntry, MCPCatalogSort } from '@agor/core/types';
import type { AgorClient, FindResult } from '@agor-live/client';
import { useEffect, useRef, useState } from 'react';

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
  sort: MCPCatalogSort;
}

export function isFilterActive(filters: CatalogFilterState): boolean {
  return Boolean(
    filters.search.trim() || filters.category || filters.capability || filters.reviewedOnly
  );
}

export interface CatalogSearchResult {
  entries: MCPCatalogEntry[];
  /** Rows matching the active filters. */
  matchCount: number;
  /** Rows in the catalog with no filters applied, for "N of M". */
  catalogSize: number | null;
  loading: boolean;
  error: string | null;
}

function buildQuery(filters: CatalogFilterState, page: number): Record<string, unknown> {
  const search = filters.search.trim();
  return {
    ...(search ? { search } : {}),
    ...(filters.category ? { category: filters.category } : {}),
    ...(filters.capability ? { capability: filters.capability } : {}),
    ...(filters.reviewedOnly ? { curated: true } : {}),
    sort: filters.sort,
    $limit: CATALOG_PAGE_SIZE,
    $skip: (page - 1) * CATALOG_PAGE_SIZE,
  };
}

export function useCatalogSearch(
  client: AgorClient,
  filters: CatalogFilterState,
  page: number
): CatalogSearchResult {
  const [entries, setEntries] = useState<MCPCatalogEntry[]>([]);
  const [matchCount, setMatchCount] = useState(0);
  const [catalogSize, setCatalogSize] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Responses can land out of order — a cheap `$skip` page overtaking a slow
  // search. Only the newest request may write state.
  const requestSeq = useRef(0);

  const { search, category, capability, reviewedOnly, sort } = filters;

  useEffect(() => {
    const seq = ++requestSeq.current;
    let cancelled = false;
    setLoading(true);

    const query = buildQuery({ search, category, capability, reviewedOnly, sort }, page);
    client
      .service('mcp-catalog')
      .find({ query })
      .then((result) => {
        if (cancelled || seq !== requestSeq.current) return;
        const matched = asPage(result);
        setEntries(matched.data);
        setMatchCount(matched.total);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled || seq !== requestSeq.current) return;
        setEntries([]);
        setMatchCount(0);
        setError(err instanceof Error ? err.message : 'Could not load the catalog');
      })
      .finally(() => {
        if (cancelled || seq !== requestSeq.current) return;
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [client, search, category, capability, reviewedOnly, sort, page]);

  // The unfiltered size is the M in "N of M". It changes only when ingestion
  // runs, so it is read once rather than alongside every filtered page.
  useEffect(() => {
    let cancelled = false;
    client
      .service('mcp-catalog')
      .find({ query: { $limit: 1 } })
      .then((result) => {
        if (cancelled) return;
        setCatalogSize(asPage(result).total);
      })
      .catch(() => {
        if (!cancelled) setCatalogSize(null);
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  return { entries, matchCount, catalogSize, loading, error };
}
