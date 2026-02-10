/**
 * Add Resource URLs Hook
 *
 * Adds external/user-facing URLs to API responses for sessions and boards.
 * These URLs can be used in Slack messages, MCP tools, and UI links.
 */

import { getBaseUrl } from '@agor/core/config';
import type { Board, HookContext, Session } from '@agor/core/types';
import { getBoardUrl, getSessionUrl } from '@agor/core/utils/url';

/**
 * Add URL to session response(s)
 *
 * Computes the `url` property from `worktree_board_id` (already populated by repository JOIN).
 * URL format: {baseUrl}/b/{boardId}/{sessionId}/
 *
 * Returns null if the session's worktree is not on a board.
 * No database queries - just string computation from already-joined data.
 */
export function addSessionUrl() {
  return async (context: HookContext) => {
    // Skip if no result
    if (!context.result) {
      return context;
    }

    try {
      const baseUrl = await getBaseUrl();

      // Handle both single result, paginated results, and non-paginated arrays
      const isArray = Array.isArray(context.result);
      const isPaginated = !isArray && context.result.data;
      const sessions = isPaginated
        ? context.result.data
        : isArray
          ? context.result
          : [context.result];

      // Compute URL for each session from already-joined worktree_board_id
      for (const session of sessions as Session[]) {
        session.url = getSessionUrl(session.session_id, session.worktree_board_id ?? null, baseUrl);
      }
    } catch (error) {
      console.error('[addSessionUrl] Failed to generate URLs:', error);
      // Don't fail the request, just skip URL generation
    }

    return context;
  };
}

/**
 * Add URL to board response(s)
 *
 * Computes the `url` property for board objects.
 * URL format: {baseUrl}/b/{boardId}/
 */
export function addBoardUrl() {
  return async (context: HookContext) => {
    // Skip if no result
    if (!context.result) {
      return context;
    }

    try {
      const baseUrl = await getBaseUrl();

      // Handle both single result, paginated results, and non-paginated arrays
      const isArray = Array.isArray(context.result);
      const isPaginated = !isArray && context.result.data;
      const boards = isPaginated
        ? context.result.data
        : isArray
          ? context.result
          : [context.result];

      // Compute URL for each board
      for (const board of boards as Board[]) {
        board.url = getBoardUrl(board.board_id, baseUrl);
      }
    } catch (error) {
      console.error('[addBoardUrl] Failed to generate URLs:', error);
      // Don't fail the request, just skip URL generation
    }

    return context;
  };
}
