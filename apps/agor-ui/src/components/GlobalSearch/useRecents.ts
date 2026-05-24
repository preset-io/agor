import type { Artifact, Board, Branch, MCPServer, Session } from '@agor-live/client';
import { isAssistant } from '@agor-live/client';
import { useMemo } from 'react';
import { EMPTY_RESULTS, type ResultsByType } from './types';
import { tsValue } from './utils';

interface UseRecentsInput {
  currentUserId?: string;
  sessionById: Map<string, Session>;
  branchById: Map<string, Branch>;
  artifactById: Map<string, Artifact>;
  boardById: Map<string, Board>;
  mcpServerById: Map<string, MCPServer>;
}

/**
 * Cap per recents section. Smaller than `SECTION_LIMIT` (5) because recents is
 * the at-rest empty-query view — six sections × 3 rows is already a 100+px
 * column of suggestions before the user has typed anything.
 */
const RECENTS_SECTION_LIMIT = 3;

/**
 * Backend-free recents — "stuff I created, most-recently-updated first," now
 * grouped by entity type so the dropdown can reuse the same section renderer
 * as live search results.
 *
 * Sources directly from the in-memory entity maps that useAgorData keeps
 * WebSocket-synced (per design doc §3.2 — no localStorage, no new tracking
 * tables). Each section caps at RECENTS_SECTION_LIMIT.
 *
 * Coverage matches the live-search section set: sessions, branches,
 * assistants, artifacts, boards, MCP servers.
 */
export function useRecents({
  currentUserId,
  sessionById,
  branchById,
  artifactById,
  boardById,
  mcpServerById,
}: UseRecentsInput): ResultsByType {
  return useMemo(() => {
    if (!currentUserId) return EMPTY_RESULTS;

    const sessions = Array.from(sessionById.values())
      .filter((s) => s.created_by === currentUserId)
      .sort((a, b) => tsValue(b.last_updated) - tsValue(a.last_updated))
      .slice(0, RECENTS_SECTION_LIMIT);

    // Pre-sort all the user's branches once, then bucket into branch vs.
    // assistant — preserves recency order within each sub-type without two
    // separate passes through the map.
    const myBranches = Array.from(branchById.values())
      .filter((b) => b.created_by === currentUserId)
      .sort((a, b) => tsValue(b.updated_at) - tsValue(a.updated_at));
    const branches = myBranches.filter((b) => !isAssistant(b)).slice(0, RECENTS_SECTION_LIMIT);
    const assistants = myBranches.filter((b) => isAssistant(b)).slice(0, RECENTS_SECTION_LIMIT);

    const artifacts = Array.from(artifactById.values())
      .filter((a) => !a.archived)
      .filter((a) => a.created_by === currentUserId)
      .sort((a, b) => tsValue(b.updated_at) - tsValue(a.updated_at))
      .slice(0, RECENTS_SECTION_LIMIT);

    const boards = Array.from(boardById.values())
      .filter((b) => !b.archived)
      .filter((b) => b.created_by === currentUserId)
      .sort((a, b) => tsValue(b.last_updated) - tsValue(a.last_updated))
      .slice(0, RECENTS_SECTION_LIMIT);

    // MCP uses owner_user_id (not created_by) and a Date timestamp.
    const mcpServers = Array.from(mcpServerById.values())
      .filter((m) => m.owner_user_id === currentUserId)
      .sort((a, b) => tsValue(b.updated_at) - tsValue(a.updated_at))
      .slice(0, RECENTS_SECTION_LIMIT);

    return {
      session: sessions.map((s) => ({
        type: 'session' as const,
        item: s,
        parentBranch: branchById.get(s.branch_id),
      })),
      branch: branches.map((b) => ({ type: 'branch' as const, item: b })),
      assistant: assistants.map((b) => ({ type: 'assistant' as const, item: b })),
      artifact: artifacts.map((a) => ({
        type: 'artifact' as const,
        item: a,
        parentBranch: a.branch_id ? branchById.get(a.branch_id) : undefined,
      })),
      board: boards.map((b) => ({ type: 'board' as const, item: b })),
      mcp: mcpServers.map((m) => ({ type: 'mcp' as const, item: m })),
    };
  }, [currentUserId, sessionById, branchById, artifactById, boardById, mcpServerById]);
}
