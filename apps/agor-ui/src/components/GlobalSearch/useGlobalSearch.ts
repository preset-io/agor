import type { Artifact, Board, Branch, MCPServer, Session } from '@agor-live/client';
import { getAssistantConfig, isAssistant } from '@agor-live/client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  EMPTY_COUNTS,
  EMPTY_RESULTS,
  MIN_QUERY_LENGTH,
  type ResultsByType,
  SEARCH_DEBOUNCE_MS,
  SECTION_LIMIT,
  SECTION_LIMIT_EXPANDED,
  type SearchCounts,
  type SearchResultItem,
} from './types';
import { byTimestamp } from './utils';

interface UseGlobalSearchInput {
  query: string;
  ownedByMe: boolean;
  activeTypeChip: 'all' | 'session' | 'branch' | 'assistant' | 'artifact' | 'board' | 'mcp';
  currentUserId?: string;
  sessionById: Map<string, Session>;
  branchById: Map<string, Branch>;
  artifactById: Map<string, Artifact>;
  boardById: Map<string, Board>;
  mcpServerById: Map<string, MCPServer>;
}

/**
 * Global-search client-side filter over the in-memory entity maps from useAgorData.
 *
 * V1 scaffolding: title-only AND-of-tokens LIKE across each entity's searchable fields.
 * No backend round-trip; the maps are already streamed by WebSocket. When V2 lands
 * (message search, FTS), this hook gets replaced with a server-driven fan-out
 * keeping the same return shape.
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

    const tokens = trimmed.toLowerCase().split(/\s+/).filter(Boolean);
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
      .filter((s) => matchTokens(tokens, [s.title, s.description]))
      .sort(byTimestamp((s) => s.last_updated));

    // Branches + Assistants share the same table — split via the canonical
    // isAssistant() helper from @agor-live/client. Assistants' user-visible
    // displayName lives in custom_context.assistant and must be searchable too.
    const allBranches = Array.from(branchById.values())
      .filter((b) => !ownedByMe || b.created_by === currentUserId)
      .filter((b) =>
        matchTokens(tokens, [
          b.name,
          b.issue_url,
          b.pull_request_url,
          getAssistantConfig(b)?.displayName,
        ])
      )
      .sort(byTimestamp((b) => b.updated_at));
    const branches = allBranches.filter((b) => !isAssistant(b));
    const assistants = allBranches.filter((b) => isAssistant(b));

    // Artifacts (filter archived — useAgorData keeps them in the map regardless)
    const arts = Array.from(artifactById.values())
      .filter((a) => !a.archived)
      .filter((a) => !ownedByMe || a.created_by === currentUserId)
      .filter((a) => matchTokens(tokens, [a.name, a.description]))
      .sort(byTimestamp((a) => a.updated_at));

    // Boards (filter archived)
    const bs = Array.from(boardById.values())
      .filter((b) => !b.archived)
      .filter((b) => !ownedByMe || b.created_by === currentUserId)
      .filter((b) => matchTokens(tokens, [b.name]))
      .sort(byTimestamp((b) => b.last_updated));

    // MCP servers (uses owner_user_id instead of created_by; updated_at is a Date object)
    const servers = Array.from(mcpServerById.values())
      .filter((m) => !ownedByMe || m.owner_user_id === currentUserId)
      .filter((m) => matchTokens(tokens, [m.name, m.display_name, m.description]))
      .sort(byTimestamp((m) => m.updated_at));

    const counts: SearchCounts = {
      session: sessions.length,
      branch: branches.length,
      assistant: assistants.length,
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
      assistant: includeType('assistant')
        ? assistants.slice(0, limitFor('assistant')).map((b) => ({ type: 'assistant', item: b }))
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

  const hasAnyResults =
    results.session.length > 0 ||
    results.branch.length > 0 ||
    results.assistant.length > 0 ||
    results.artifact.length > 0 ||
    results.board.length > 0 ||
    results.mcp.length > 0;

  return { results, counts, hasAnyResults, debouncedQuery, flush };
}

/** Every token must appear (case-insensitive substring) in at least one field. */
function matchTokens(tokens: string[], fields: Array<string | undefined | null>): boolean {
  const haystack = fields
    .filter((f): f is string => Boolean(f))
    .join(' \n ')
    .toLowerCase();
  return tokens.every((t) => haystack.includes(t));
}
