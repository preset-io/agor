import {
  type AgorClient,
  type Branch,
  isTeammate,
  MAX_SEARCH_TOKENS,
  matchSearchTokens,
  SEARCHABLE_FIELDS,
  type Session,
  serverSearchText,
  tokenizeSearchQuery,
  uniqueSearchTokens,
} from '@agor-live/client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useEnsureBranches } from '../../hooks/useEnsureRows';
import { holdRows, type RowHold } from '../../store/retention';
import { sessionListQuery } from '../../store/sessionListQuery';
import { fillOnDemand, rowsOf } from '../../store/userScope';
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
import { byTimestamp, hasAnyEntries, parentBranchIds } from './utils';

interface UseGlobalSearchInput extends GlobalSearchEntityMaps {
  /** Also search the daemon's sessions and branches (see `useServerSearch`). */
  client?: AgorClient | null;
  query: string;
  ownedByMe: boolean;
  activeTypeChip: ChipFilter;
  currentUserId?: string;
}

// A memoized flush/timer must not share a closure context with entity maps.
export function useDebouncedSearchQuery(query: string) {
  const [debouncedQuery, setDebouncedQuery] = useState(query);

  useEffect(() => {
    const handle = setTimeout(() => setDebouncedQuery(query), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [query]);

  const flush = useCallback(() => setDebouncedQuery(query), [query]);

  return { debouncedQuery, flush };
}

/** The ids the daemon matched for `query`. */
interface ServerMatches {
  query: string;
  sessionIds: ReadonlySet<string>;
  branchIds: ReadonlySet<string>;
}

/**
 * The server half of a search: read the sessions and branches matching
 * `query` from the daemon (its `search` key, under the caller's visibility)
 * and fill them into the store, so the local pass below finds rows the store
 * never loaded. Display only: the rows join no scope, and are held
 * (`holdRows`) until the next query's results replace them or the search
 * closes; a read the search outlived inserts nothing. The daemon also matches
 * fields the local registry lacks (a branch's repo, path and ids), so its
 * matches are returned for the local pass to show; only the terms past its
 * cap (`MAX_SEARCH_TOKENS`) are checked locally.
 */
function useServerSearch(
  client: AgorClient | null | undefined,
  query: string,
  createdBy: string | undefined
): ServerMatches | null {
  const shown = useRef<RowHold | null>(null);
  const [matches, setMatches] = useState<ServerMatches | null>(null);
  useEffect(
    () => () => {
      shown.current?.release();
      shown.current = null;
    },
    []
  );
  useEffect(() => {
    const search = query.trim();
    const tokens = tokenizeSearchQuery(search);
    if (!client || search.length < MIN_QUERY_LENGTH || tokens.length === 0) {
      shown.current?.release();
      shown.current = null;
      return;
    }
    const hold = holdRows();
    // Terms the daemon didn't receive; every term it did, it matched.
    const unsent = uniqueSearchTokens(search).slice(MAX_SEARCH_TOKENS);
    const matchesUnsent = (fields: Array<string | undefined | null>) =>
      unsent.length === 0 || matchSearchTokens(unsent, fields);
    const filter = {
      // At most the daemon's term cap; every term still filters below.
      search: serverSearchText(search),
      archived: false,
      ...(createdBy ? { created_by: createdBy } : {}),
      $sort: { updated_at: -1 },
      $limit: SECTION_LIMIT_EXPANDED,
    };
    fillOnDemand(async () => {
      const [sessions, branches] = await Promise.all([
        client.service('sessions').find({ query: sessionListQuery({ ...filter, $count: false }) }),
        client.service('branches').find({ query: filter }),
      ]);
      return {
        sessions: rowsOf<Session>(sessions).filter((s) =>
          matchesUnsent(SEARCHABLE_FIELDS.session(s))
        ),
        branches: rowsOf<Branch>(branches).filter((b) =>
          matchesUnsent(SEARCHABLE_FIELDS.branch(b))
        ),
      };
    }, hold)
      .then((rows) => {
        if (!rows || hold.released) return;
        shown.current?.release();
        shown.current = hold;
        setMatches({
          query: search,
          sessionIds: new Set(rows.sessions.map((s) => s.session_id)),
          branchIds: new Set(rows.branches.map((b) => b.branch_id)),
        });
      })
      .catch((err) => console.warn('[GlobalSearch] server search failed:', err));
    return () => {
      if (shown.current !== hold) hold.release();
    };
  }, [client, query, createdBy]);
  return matches;
}

/**
 * Global-search client-side filter over the in-memory entity maps from useAgorData.
 *
 * V1 scaffolding: AND-of-tokens substring match over each entity's
 * `SEARCHABLE_FIELDS` set (the canonical registry in `@agor/core/search`).
 * Sessions and branches also come from the daemon (`useServerSearch`), filled
 * into the maps after the debounce, so the store need not hold them all.
 */
export function useGlobalSearch({
  client,
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
  const { debouncedQuery, flush } = useDebouncedSearchQuery(query);
  const serverMatches = useServerSearch(
    client,
    debouncedQuery,
    ownedByMe ? currentUserId : undefined
  );

  const { results, counts } = useMemo<{ results: ResultsByType; counts: SearchCounts }>(() => {
    const trimmed = debouncedQuery.trim();
    if (trimmed.length < MIN_QUERY_LENGTH) {
      return { results: EMPTY_RESULTS, counts: EMPTY_COUNTS };
    }

    const tokens = tokenizeSearchQuery(trimmed);
    if (tokens.length === 0) {
      return { results: EMPTY_RESULTS, counts: EMPTY_COUNTS };
    }
    const served = serverMatches?.query === trimmed ? serverMatches : null;

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
      .filter((s) => !s.archived)
      .filter((s) => !ownedByMe || s.created_by === currentUserId)
      .filter(
        (s) =>
          served?.sessionIds.has(s.session_id) ||
          matchSearchTokens(tokens, SEARCHABLE_FIELDS.session(s))
      )
      .sort(byTimestamp((s) => s.last_updated));

    // Branches + Teammates share one registry entry: the field set covers
    // both row variants (teammate displayName is included), and the type
    // split below uses `isTeammate()` to bucket matched rows.
    const allBranches = Array.from(branchById.values())
      .filter((b) => !ownedByMe || b.created_by === currentUserId)
      .filter(
        (b) =>
          served?.branchIds.has(b.branch_id) ||
          matchSearchTokens(tokens, SEARCHABLE_FIELDS.branch(b))
      )
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
    serverMatches,
  ]);

  // Parent-branch labels come from the map: read the shown rows' parents it lacks.
  useEnsureBranches(client, parentBranchIds(results));

  const hasAnyResults = hasAnyEntries(results);

  return { results, counts, hasAnyResults, debouncedQuery, flush };
}
