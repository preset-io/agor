import type { Artifact, Board, MCPServer, Session, Worktree } from '@agor-live/client';
import { useEffect, useMemo, useState } from 'react';
import {
  EMPTY_RESULTS,
  MIN_QUERY_LENGTH,
  type ResultsByType,
  SEARCH_DEBOUNCE_MS,
  SECTION_LIMIT,
  SECTION_LIMIT_EXPANDED,
  type SearchResultItem,
} from '../components/GlobalSearch/types';

interface UseGlobalSearchInput {
  query: string;
  ownedByMe: boolean;
  activeTypeChip: 'all' | 'session' | 'worktree' | 'assistant' | 'artifact' | 'board' | 'mcp';
  currentUserId?: string;
  sessionById: Map<string, Session>;
  worktreeById: Map<string, Worktree>;
  artifactById: Map<string, Artifact>;
  boards: Board[];
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
  worktreeById,
  artifactById,
  boards,
  mcpServerById,
}: UseGlobalSearchInput): {
  results: ResultsByType;
  hasAnyResults: boolean;
  debouncedQuery: string;
} {
  const [debouncedQuery, setDebouncedQuery] = useState(query);

  useEffect(() => {
    const handle = setTimeout(() => setDebouncedQuery(query), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [query]);

  const results = useMemo<ResultsByType>(() => {
    const trimmed = debouncedQuery.trim();
    if (trimmed.length < MIN_QUERY_LENGTH) return EMPTY_RESULTS;

    const tokens = trimmed.toLowerCase().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return EMPTY_RESULTS;

    const sectionLimit = activeTypeChip === 'all' ? SECTION_LIMIT : SECTION_LIMIT_EXPANDED;
    const buckets: ResultsByType = {
      session: [],
      worktree: [],
      assistant: [],
      artifact: [],
      board: [],
      mcp: [],
    };

    const includeType = (t: SearchResultItem['type']) =>
      activeTypeChip === 'all' || activeTypeChip === t;

    // Sessions
    if (includeType('session')) {
      const sessions = Array.from(sessionById.values())
        .filter((s) => !ownedByMe || s.created_by === currentUserId)
        .filter((s) => matchTokens(tokens, [s.title, s.description]))
        .sort(byUpdatedAt);
      for (const s of sessions.slice(0, sectionLimit)) {
        buckets.session.push({
          type: 'session',
          item: s,
          parentWorktree: worktreeById.get(s.worktree_id),
        });
      }
    }

    // Worktrees + Assistants share the same table, split by data.custom_context.assistant
    if (includeType('worktree') || includeType('assistant')) {
      const allWorktrees = Array.from(worktreeById.values())
        .filter((w) => !ownedByMe || w.created_by === currentUserId)
        .filter((w) => matchTokens(tokens, [w.name, w.issue_url, w.pull_request_url]))
        .sort(byUpdatedAt);

      for (const w of allWorktrees) {
        const isAssistant = Boolean(w.custom_context?.assistant ?? w.custom_context?.agent);
        if (isAssistant && includeType('assistant') && buckets.assistant.length < sectionLimit) {
          buckets.assistant.push({ type: 'assistant', item: w });
        } else if (!isAssistant && includeType('worktree') && buckets.worktree.length < sectionLimit) {
          buckets.worktree.push({ type: 'worktree', item: w });
        }
      }
    }

    // Artifacts
    if (includeType('artifact')) {
      const arts = Array.from(artifactById.values())
        .filter((a) => !ownedByMe || a.created_by === currentUserId)
        .filter((a) => matchTokens(tokens, [a.name, a.description]))
        .sort(byUpdatedAt);
      for (const a of arts.slice(0, sectionLimit)) {
        buckets.artifact.push({
          type: 'artifact',
          item: a,
          parentWorktree: a.worktree_id ? worktreeById.get(a.worktree_id) : undefined,
        });
      }
    }

    // Boards
    if (includeType('board')) {
      const bs = boards
        .filter((b) => !ownedByMe || b.created_by === currentUserId)
        .filter((b) => matchTokens(tokens, [b.name]))
        .sort(byUpdatedAt);
      for (const b of bs.slice(0, sectionLimit)) {
        buckets.board.push({ type: 'board', item: b });
      }
    }

    // MCP servers (uses owner_user_id instead of created_by per design doc §6)
    if (includeType('mcp')) {
      const servers = Array.from(mcpServerById.values())
        .filter((m) => !ownedByMe || m.owner_user_id === currentUserId)
        .filter((m) => matchTokens(tokens, [m.name, m.display_name, m.description]))
        .sort(byUpdatedAt);
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
    worktreeById,
    artifactById,
    boards,
    mcpServerById,
  ]);

  const hasAnyResults =
    results.session.length > 0 ||
    results.worktree.length > 0 ||
    results.assistant.length > 0 ||
    results.artifact.length > 0 ||
    results.board.length > 0 ||
    results.mcp.length > 0;

  return { results, hasAnyResults, debouncedQuery };
}

/** Every token must appear (case-insensitive substring) in at least one field. */
function matchTokens(tokens: string[], fields: Array<string | undefined | null>): boolean {
  const haystack = fields
    .filter((f): f is string => Boolean(f))
    .join(' \n ')
    .toLowerCase();
  return tokens.every((t) => haystack.includes(t));
}

function byUpdatedAt(a: { updated_at?: string }, b: { updated_at?: string }): number {
  const at = a.updated_at ?? '';
  const bt = b.updated_at ?? '';
  return bt.localeCompare(at);
}
