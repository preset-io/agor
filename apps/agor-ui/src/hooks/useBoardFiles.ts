import {
  type AgorClient,
  type Artifact,
  BOARD_FILES_PAGE_SIZE,
  type BoardFileItem,
  type BoardFileKind,
  type BoardFileSort,
  type BoardFilesPage,
  type Branch,
  type KnowledgeDocument,
} from '@agor-live/client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { agorStore } from '../store/agorStore';

export const BOARD_FILES_SEARCH_DEBOUNCE_MS = 250;
const LIVE_REFRESH_DEBOUNCE_MS = 1000;
const ARTIFACT_EVENTS = ['created', 'patched', 'removed'] as const;
// Archiving a document is a patch; a document listed here may also be patched
// to another board's session.
const DOCUMENT_EVENTS = ['patched', 'removed'] as const;

export interface BoardFilesFilters {
  q: string;
  kind: BoardFileKind | 'all';
  sort: BoardFileSort;
}

interface BoardFilesState {
  key: string;
  items: BoardFileItem[];
  total: number;
  /** Where the next page starts on the server. */
  next: number;
  loading: boolean;
  /** The first page failed. */
  error: boolean;
  /** A later page failed at this offset; Retry asks for it again. */
  failedSkip: number | null;
}

const emptyState = (key: string): BoardFilesState => ({
  key,
  items: [],
  total: 0,
  next: 0,
  loading: true,
  error: false,
  failedSkip: null,
});

/** One row per item, however the pages overlap. */
export const boardFileKey = (item: Pick<BoardFileItem, 'kind' | 'id'>) => `${item.kind}:${item.id}`;

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
 * server. The first page reloads when the tab is shown and, while it is, when
 * something listed or on the board changes: artifacts, branches (including one
 * that leaves or is deleted), and listed documents that are archived or move
 * to another board. A reload starts again from page one, since the order may
 * have changed. Uploads and new documents refresh the next time the tab is shown.
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
  const [state, setState] = useState<BoardFilesState>(() => emptyState(key));
  const current = state.key === key ? state : emptyState(key);
  const requestRef = useRef(0);
  const listedRef = useRef(new Set<string>());
  listedRef.current = new Set(current.items.map(boardFileKey));

  const load = useCallback(
    async (skip: number) => {
      if (!client) return;
      const request = ++requestRef.current;
      setState((prev) => ({
        ...(prev.key === key ? prev : emptyState(key)),
        loading: true,
        failedSkip: null,
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
        setState((prev) => {
          const items = skip === 0 || prev.key !== key ? [] : [...prev.items];
          const seen = new Set(items.map(boardFileKey));
          for (const item of page.data) {
            if (seen.has(boardFileKey(item))) continue;
            seen.add(boardFileKey(item));
            items.push(item);
          }
          return {
            key,
            items,
            total: page.total,
            next: skip + page.data.length,
            loading: false,
            error: false,
            failedSkip: null,
          };
        });
      } catch {
        if (request !== requestRef.current) return;
        setState((prev) => ({
          ...(prev.key === key ? prev : emptyState(key)),
          loading: false,
          error: skip === 0,
          failedSkip: skip === 0 ? null : skip,
        }));
      }
    },
    [client, boardId, key, q, filters.kind, filters.sort]
  );

  // The first page: on a new query, and each time the tab is shown.
  useEffect(() => {
    if (active) void load(0);
  }, [active, load]);

  // Live, while shown. Branches are tracked here from the store's snapshot, so a
  // patch that moves one to another board (it names only the new board) still
  // refreshes this one.
  useEffect(() => {
    if (!client || !active) return;
    let timer: number | undefined;
    const refresh = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void load(0), LIVE_REFRESH_DEBOUNCE_MS);
    };
    const boardBranchIds = new Set<string>();
    for (const branch of agorStore.getState().branchById.values()) {
      if (branch.board_id === boardId) boardBranchIds.add(branch.branch_id);
    }
    const onArtifact = (artifact: Partial<Artifact>) => {
      const listed =
        !!artifact?.artifact_id && listedRef.current.has(`artifact:${artifact.artifact_id}`);
      if (artifact?.board_id === boardId || listed) refresh();
    };
    const onBranch = (removed: boolean) => (branch: Partial<Branch>) => {
      if (!branch?.branch_id) return;
      const wasHere = boardBranchIds.has(branch.branch_id);
      const isHere = branch.board_id === boardId;
      if (isHere && !removed) boardBranchIds.add(branch.branch_id);
      else boardBranchIds.delete(branch.branch_id);
      if (wasHere || isHere) refresh();
    };
    const onBranchChanged = onBranch(false);
    const onBranchRemoved = onBranch(true);
    const onDocument = (doc: Partial<KnowledgeDocument>) => {
      if (doc?.document_id && listedRef.current.has(`document:${doc.document_id}`)) refresh();
    };
    const artifacts = client.service('artifacts');
    const branches = client.service('branches');
    const documents = client.service('kb/documents');
    for (const event of ARTIFACT_EVENTS) artifacts.on(event, onArtifact);
    branches.on('created', onBranchChanged);
    branches.on('patched', onBranchChanged);
    branches.on('removed', onBranchRemoved);
    for (const event of DOCUMENT_EVENTS) documents.on(event, onDocument);
    return () => {
      window.clearTimeout(timer);
      for (const event of ARTIFACT_EVENTS) artifacts.removeListener(event, onArtifact);
      branches.removeListener('created', onBranchChanged);
      branches.removeListener('patched', onBranchChanged);
      branches.removeListener('removed', onBranchRemoved);
      for (const event of DOCUMENT_EVENTS) documents.removeListener(event, onDocument);
    };
  }, [client, active, boardId, load]);

  const hasMore = current.next < current.total;
  const { loading, next, failedSkip } = current;
  const loadMore = useCallback(() => {
    if (!loading && hasMore && failedSkip === null) void load(next);
  }, [loading, hasMore, failedSkip, next, load]);

  return {
    items: current.items,
    total: current.total,
    loading,
    error: current.error,
    hasMore,
    loadMore,
    /** Where the next page starts; a new value is a new page. */
    nextSkip: next,
    /** A later page failed; `retryMore` asks for it again. */
    loadMoreFailed: failedSkip !== null,
    retryMore: () => {
      if (failedSkip !== null) void load(failedSkip);
    },
    retry: () => void load(0),
    /** The search the list shows, after the debounce. */
    appliedQuery: q,
  };
}
