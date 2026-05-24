import type { Artifact, Board, Branch, MCPServer, Session } from '@agor-live/client';
import { getAssistantConfig, isAssistant } from '@agor-live/client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  EMPTY_RESULTS,
  MIN_QUERY_LENGTH,
  type ResultsByType,
  SEARCH_DEBOUNCE_MS,
  SECTION_LIMIT,
  SECTION_LIMIT_EXPANDED,
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

  const results = useMemo<ResultsByType>(() => {
    const trimmed = debouncedQuery.trim();
    if (trimmed.length < MIN_QUERY_LENGTH) return EMPTY_RESULTS;

    const tokens = trimmed.toLowerCase().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return EMPTY_RESULTS;

    const sectionLimit = activeTypeChip === 'all' ? SECTION_LIMIT : SECTION_LIMIT_EXPANDED;
    const buckets: ResultsByType = {
      session: [],
      branch: [],
      assistant: [],
      artifact: [],
      board: [],
      mcp: [],
    };

    const includeType = (t: SearchResultItem['type']) =>
      activeTypeChip === 'all' || activeTypeChip === t;

    // Sessions (timestamp field is `last_updated`, not `updated_at`)
    if (includeType('session')) {
      const sessions = Array.from(sessionById.values())
        .filter((s) => !ownedByMe || s.created_by === currentUserId)
        .filter((s) => matchTokens(tokens, [s.title, s.description]))
        .sort(byTimestamp((s) => s.last_updated));
      for (const s of sessions.slice(0, sectionLimit)) {
        buckets.session.push({
          type: 'session',
          item: s,
          parentBranch: branchById.get(s.branch_id),
        });
      }
    }

    // Branches + Assistants share the same table — split via the canonical
    // isAssistant() helper from @agor-live/client. Assistants' user-visible
    // displayName lives in custom_context.assistant and must be searchable too.
    if (includeType('branch') || includeType('assistant')) {
      const allBranches = Array.from(branchById.values())
        .filter((w) => !ownedByMe || w.created_by === currentUserId)
        .filter((w) =>
          matchTokens(tokens, [
            w.name,
            w.issue_url,
            w.pull_request_url,
            getAssistantConfig(w)?.displayName,
          ])
        )
        .sort(byTimestamp((w) => w.updated_at));

      for (const w of allBranches) {
        if (isAssistant(w) && includeType('assistant') && buckets.assistant.length < sectionLimit) {
          buckets.assistant.push({ type: 'assistant', item: w });
        } else if (
          !isAssistant(w) &&
          includeType('branch') &&
          buckets.branch.length < sectionLimit
        ) {
          buckets.branch.push({ type: 'branch', item: w });
        }
      }
    }

    // Artifacts (filter archived — useAgorData keeps them in the map regardless)
    if (includeType('artifact')) {
      const arts = Array.from(artifactById.values())
        .filter((a) => !a.archived)
        .filter((a) => !ownedByMe || a.created_by === currentUserId)
        .filter((a) => matchTokens(tokens, [a.name, a.description]))
        .sort(byTimestamp((a) => a.updated_at));
      for (const a of arts.slice(0, sectionLimit)) {
        buckets.artifact.push({
          type: 'artifact',
          item: a,
          parentBranch: a.branch_id ? branchById.get(a.branch_id) : undefined,
        });
      }
    }

    // Boards (filter archived)
    if (includeType('board')) {
      const bs = Array.from(boardById.values())
        .filter((b) => !b.archived)
        .filter((b) => !ownedByMe || b.created_by === currentUserId)
        .filter((b) => matchTokens(tokens, [b.name]))
        .sort(byTimestamp((b) => b.last_updated));
      for (const b of bs.slice(0, sectionLimit)) {
        buckets.board.push({ type: 'board', item: b });
      }
    }

    // MCP servers (uses owner_user_id instead of created_by; updated_at is a Date object)
    if (includeType('mcp')) {
      const servers = Array.from(mcpServerById.values())
        .filter((m) => !ownedByMe || m.owner_user_id === currentUserId)
        .filter((m) => matchTokens(tokens, [m.name, m.display_name, m.description]))
        .sort(byTimestamp((m) => m.updated_at));
      for (const m of servers.slice(0, sectionLimit)) {
        buckets.mcp.push({ type: 'mcp', item: m });
      }
    }

    return buckets;
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

  return { results, hasAnyResults, debouncedQuery, flush };
}

/** Every token must appear (case-insensitive substring) in at least one field. */
function matchTokens(tokens: string[], fields: Array<string | undefined | null>): boolean {
  const haystack = fields
    .filter((f): f is string => Boolean(f))
    .join(' \n ')
    .toLowerCase();
  return tokens.every((t) => haystack.includes(t));
}
