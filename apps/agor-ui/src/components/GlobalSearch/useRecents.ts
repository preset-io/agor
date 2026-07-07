import { isTeammate } from '@agor-live/client';
import { useMemo } from 'react';
import {
  EMPTY_RESULTS,
  type GlobalSearchEntityMaps,
  RECENTS_SECTION_LIMIT,
  type ResultsByType,
} from './types';
import { byTimestamp } from './utils';

type UseRecentsInput = GlobalSearchEntityMaps & {
  currentUserId?: string;
};

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
 * teammates, artifacts, boards, MCP servers.
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
      .sort(byTimestamp((s) => s.last_updated))
      .slice(0, RECENTS_SECTION_LIMIT);

    // Pre-sort all the user's branches once, then bucket into branch vs.
    // teammate — preserves recency order within each sub-type without two
    // separate passes through the map.
    const myBranches = Array.from(branchById.values())
      .filter((b) => b.created_by === currentUserId)
      .sort(byTimestamp((b) => b.updated_at));
    const branches = myBranches.filter((b) => !isTeammate(b)).slice(0, RECENTS_SECTION_LIMIT);
    const teammates = myBranches.filter((b) => isTeammate(b)).slice(0, RECENTS_SECTION_LIMIT);

    const artifacts = Array.from(artifactById.values())
      .filter((a) => !a.archived)
      .filter((a) => a.created_by === currentUserId)
      .sort(byTimestamp((a) => a.updated_at))
      .slice(0, RECENTS_SECTION_LIMIT);

    const boards = Array.from(boardById.values())
      .filter((b) => !b.archived)
      .filter((b) => b.created_by === currentUserId)
      .sort(byTimestamp((b) => b.last_updated))
      .slice(0, RECENTS_SECTION_LIMIT);

    // MCP uses owner_user_id (not created_by) and a Date timestamp.
    const mcpServers = Array.from(mcpServerById.values())
      .filter((m) => m.owner_user_id === currentUserId)
      .sort(byTimestamp((m) => m.updated_at))
      .slice(0, RECENTS_SECTION_LIMIT);

    return {
      session: sessions.map((s) => ({
        type: 'session' as const,
        item: s,
        parentBranch: branchById.get(s.branch_id),
      })),
      branch: branches.map((b) => ({ type: 'branch' as const, item: b })),
      teammate: teammates.map((b) => ({ type: 'teammate' as const, item: b })),
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
