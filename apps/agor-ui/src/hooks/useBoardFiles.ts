import {
  type AgorClient,
  type Artifact,
  BOARD_FILES_PAGE_SIZE,
  type BoardFileItem,
  type BoardFileKind,
  type BoardFileSort,
  type BoardFilesPage,
  type Branch,
} from '@agor-live/client';
import { useCallback, useEffect, useRef, useState } from 'react';

export const BOARD_FILES_SEARCH_DEBOUNCE_MS = 250;
const LIVE_REFRESH_DEBOUNCE_MS = 1000;

export interface BoardFilesFilters {
  q: string;
  kind: BoardFileKind | 'all';
  sort: BoardFileSort;
}

interface BoardFilesState {
  key: string;
  items: BoardFileItem[];
  total: number;
  loading: boolean;
  error: boolean;
}

/** The read itself, also used by work cards (`useSessionWork`). */
export function fetchBoardFiles(
  client: AgorClient,
  boardId: string,
  query: Record<string, unknown>
): Promise<BoardFilesPage> {
  return client.service(`boards/${boardId}/files`).find({ query }) as Promise<BoardFilesPage>;
}

/**
 * One board's Files, 50 at a time. Search (debounced), type and sort run on the
 * server. The first page reloads when the tab is shown and, while it is, when an
 * artifact or branch on the board changes. Documents and uploads refresh the
 * next time the tab is shown.
 */
export function useBoardFiles({
  client,
  boardId,
  filters,
  active,
}: {
  client: AgorClient | null;
  boardId: string;
  filters: BoardFilesFilters;
  active: boolean;
}) {
  const [q, setQ] = useState(filters.q);
  useEffect(() => {
    const timer = window.setTimeout(() => setQ(filters.q), BOARD_FILES_SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [filters.q]);

  const key = JSON.stringify([boardId, q.trim(), filters.kind, filters.sort]);
  const [state, setState] = useState<BoardFilesState>({
    key,
    items: [],
    total: 0,
    loading: true,
    error: false,
  });
  const current =
    state.key === key ? state : { key, items: [], total: 0, loading: true, error: false };
  const requestRef = useRef(0);

  const load = useCallback(
    async (skip: number) => {
      if (!client) return;
      const request = ++requestRef.current;
      setState((prev) => ({
        ...(prev.key === key ? prev : { key, items: [], total: 0, error: false }),
        loading: true,
      }));
      try {
        const page = await fetchBoardFiles(client, boardId, {
          ...(q.trim() ? { q: q.trim() } : {}),
          ...(filters.kind !== 'all' ? { kind: filters.kind } : {}),
          sort: filters.sort,
          $limit: BOARD_FILES_PAGE_SIZE,
          $skip: skip,
        });
        if (request !== requestRef.current) return;
        setState((prev) => ({
          key,
          items: skip === 0 ? page.data : [...(prev.key === key ? prev.items : []), ...page.data],
          total: page.total,
          loading: false,
          error: false,
        }));
      } catch {
        if (request !== requestRef.current) return;
        setState((prev) => ({ ...prev, key, loading: false, error: true }));
      }
    },
    [client, boardId, key, q, filters.kind, filters.sort]
  );

  // The first page: on a new query, and each time the tab is shown.
  useEffect(() => {
    if (active) void load(0);
  }, [active, load]);

  // Live: artifacts and branches on this board.
  useEffect(() => {
    if (!client || !active) return;
    let timer: number | undefined;
    const refresh = (record: Partial<Artifact> | Partial<Branch>) => {
      if (record?.board_id !== boardId) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void load(0), LIVE_REFRESH_DEBOUNCE_MS);
    };
    const artifacts = client.service('artifacts');
    const branches = client.service('branches');
    for (const event of ['created', 'patched', 'removed']) artifacts.on(event, refresh);
    branches.on('patched', refresh);
    return () => {
      window.clearTimeout(timer);
      for (const event of ['created', 'patched', 'removed']) {
        artifacts.removeListener(event, refresh);
      }
      branches.removeListener('patched', refresh);
    };
  }, [client, active, boardId, load]);

  const hasMore = current.items.length < current.total;
  const loadMore = useCallback(() => {
    if (!current.loading && hasMore) void load(current.items.length);
  }, [current.loading, current.items.length, hasMore, load]);

  return {
    items: current.items,
    total: current.total,
    loading: current.loading,
    error: current.error,
    hasMore,
    loadMore,
    retry: () => void load(0),
    /** The search the list shows, after the debounce. */
    appliedQuery: q,
  };
}
