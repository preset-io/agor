import {
  isTeammate,
  matchSearchTokens,
  SEARCHABLE_FIELDS,
  tokenizeSearchQuery,
} from '@agor-live/client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  type ChipFilter,
  EMPTY_COUNTS,
  EMPTY_RESULTS,
  type GlobalSearchEntityMaps,
  MIN_QUERY_LENGTH,
  type ResultsByType,
  SEARCH_DEBOUNCE_MS,
  SECTION_LIMIT,
  SECTION_LIMIT_EXPANDED,
  type SearchCounts,
  type SearchResultItem,
} from './types';
import { byTimestamp, hasAnyEntries } from './utils';

interface UseGlobalSearchInput extends GlobalSearchEntityMaps {
  query: string;
  ownedByMe: boolean;
  activeTypeChip: ChipFilter;
  currentUserId?: string;
}

/**
 * Global-search client-side filter over the in-memory entity maps from useAgorData.
 *
 * V1 scaffolding: AND-of-tokens substring match over each entity's
 * `SEARCHABLE_FIELDS` set (the canonical registry in `@agor/core/search`).
 * No backend round-trip; the maps are already streamed by WebSocket. When V2
 * lands (message search, FTS), this hook gets replaced with a server-driven
 * fan-out keeping the same return shape and reading the same registry.
 */
export function useGlobalSearch({
  query,
  ownedByMe,
  activeTypeChip,
  currentUserId,
  sessionById,
  branchById,
  artifactById,
  boardById,
  mcpServerById,
}: UseGlobalSearchInput): {
  results: ResultsByType;
  /** Pre-cap per-type match counts. Independent of `activeTypeChip` so chip
   * badges reflect "how many you'd find here," not "how many fit on screen." */
  counts: SearchCounts;
  hasAnyResults: boolean;
  debouncedQuery: string;
  /** Force the debounced query to match the raw query immediately — used by
   * the Enter handler to honor the design doc's "immediate dispatch on Enter". */
  flush: () => void;
} {
  const [debouncedQuery, setDebouncedQuery] = useState(query);

  useEffect(() => {
    const handle = setTimeout(() => setDebouncedQuery(query), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [query]);

  const flush = useCallback(() => setDebouncedQuery(query), [query]);

  const { results, counts } = useMemo<{ results: ResultsByType; counts: SearchCounts }>(() => {
    const trimmed = debouncedQuery.trim();
    if (trimmed.length < MIN_QUERY_LENGTH) {
      return { results: EMPTY_RESULTS, counts: EMPTY_COUNTS };
    }

    const tokens = tokenizeSearchQuery(trimmed);
    if (tokens.length === 0) {
      return { results: EMPTY_RESULTS, counts: EMPTY_COUNTS };
    }

    // Counts must be independent of `activeTypeChip`: an inactive chip still
    // shows its real match count so the badge tells you what's behind that
    // tab. So we always run the full match pass for every type, then apply
    // the chip filter only when slicing into `results` for render.
    const limitFor = (t: SearchResultItem['type']) =>
      activeTypeChip === t ? SECTION_LIMIT_EXPANDED : SECTION_LIMIT;
    const includeType = (t: SearchResultItem['type']) =>
      activeTypeChip === 'all' || activeTypeChip === t;

    // Sessions (timestamp field is `last_updated`, not `updated_at`)
    const sessions = Array.from(sessionById.values())
      .filter((s) => !ownedByMe || s.created_by === currentUserId)
      .filter((s) => matchSearchTokens(tokens, SEARCHABLE_FIELDS.session(s)))
      .sort(byTimestamp((s) => s.last_updated));

    // Branches + Teammates share one registry entry: the field set covers
    // both row variants (teammate displayName is included), and the type
    // split below uses `isTeammate()` to bucket matched rows.
    const allBranches = Array.from(branchById.values())
      .filter((b) => !ownedByMe || b.created_by === currentUserId)
      .filter((b) => matchSearchTokens(tokens, SEARCHABLE_FIELDS.branch(b)))
      .sort(byTimestamp((b) => b.updated_at));
    const branches = allBranches.filter((b) => !isTeammate(b));
    const teammates = allBranches.filter((b) => isTeammate(b));

    // Artifacts (filter archived — useAgorData keeps them in the map regardless)
    const arts = Array.from(artifactById.values())
      .filter((a) => !a.archived)
      .filter((a) => !ownedByMe || a.created_by === currentUserId)
      .filter((a) => matchSearchTokens(tokens, SEARCHABLE_FIELDS.artifact(a)))
      .sort(byTimestamp((a) => a.updated_at));

    // Boards (filter archived)
    const bs = Array.from(boardById.values())
      .filter((b) => !b.archived)
      .filter((b) => !ownedByMe || b.created_by === currentUserId)
      .filter((b) => matchSearchTokens(tokens, SEARCHABLE_FIELDS.board(b)))
      .sort(byTimestamp((b) => b.last_updated));

    // MCP servers (uses owner_user_id instead of created_by; updated_at is a Date object)
    const servers = Array.from(mcpServerById.values())
      .filter((m) => !ownedByMe || m.owner_user_id === currentUserId)
      .filter((m) => matchSearchTokens(tokens, SEARCHABLE_FIELDS.mcp(m)))
      .sort(byTimestamp((m) => m.updated_at));

    const counts: SearchCounts = {
      session: sessions.length,
      branch: branches.length,
      teammate: teammates.length,
      artifact: arts.length,
      board: bs.length,
      mcp: servers.length,
    };

    const buckets: ResultsByType = {
      session: includeType('session')
        ? sessions.slice(0, limitFor('session')).map((s) => ({
            type: 'session',
            item: s,
            parentBranch: branchById.get(s.branch_id),
          }))
        : [],
      branch: includeType('branch')
        ? branches.slice(0, limitFor('branch')).map((b) => ({ type: 'branch', item: b }))
        : [],
      teammate: includeType('teammate')
        ? teammates.slice(0, limitFor('teammate')).map((b) => ({ type: 'teammate', item: b }))
        : [],
      artifact: includeType('artifact')
        ? arts.slice(0, limitFor('artifact')).map((a) => ({
            type: 'artifact',
            item: a,
            parentBranch: a.branch_id ? branchById.get(a.branch_id) : undefined,
          }))
        : [],
      board: includeType('board')
        ? bs.slice(0, limitFor('board')).map((b) => ({ type: 'board', item: b }))
        : [],
      mcp: includeType('mcp')
        ? servers.slice(0, limitFor('mcp')).map((m) => ({ type: 'mcp', item: m }))
        : [],
    };

    return { results: buckets, counts };
  }, [
    debouncedQuery,
    ownedByMe,
    activeTypeChip,
    currentUserId,
    sessionById,
    branchById,
    artifactById,
    boardById,
    mcpServerById,
  ]);

  const hasAnyResults = hasAnyEntries(results);

  return { results, counts, hasAnyResults, debouncedQuery, flush };
}
