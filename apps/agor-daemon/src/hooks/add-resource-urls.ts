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
 * Adds a `url` property to session objects with a direct link to view the session.
 * URL format: {baseUrl}/b/{boardId}/{sessionId}/
 *
 * Returns null if the session's worktree is not on a board.
 */
export function addSessionUrl() {
  return async (context: HookContext) => {
    // Skip if no result
    if (!context.result) {
      return context;
    }

    try {
      const baseUrl = await getBaseUrl();

      // Handle both single result and paginated results
      const sessions = context.result.data || [context.result];
      const isSingle = !context.result.data;

      // Add URL to each session
      for (const session of sessions as Session[]) {
        // Need to fetch worktree to get board_id
        try {
          const worktree = await context.app.service('worktrees').get(session.worktree_id);
          const url = getSessionUrl(session.session_id, worktree.board_id, baseUrl);
          (session as Session & { url: string | null }).url = url;
        } catch (error) {
          console.warn(
            `[addSessionUrl] Failed to get worktree for session ${session.session_id}:`,
            error
          );
          (session as Session & { url: string | null }).url = null;
        }
      }

      // Update context result
      if (isSingle) {
        context.result = sessions[0];
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
 * Adds a `url` property to board objects with a direct link to view the board.
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

      // Handle both single result and paginated results
      const boards = context.result.data || [context.result];
      const isSingle = !context.result.data;

      // Add URL to each board
      for (const board of boards as Board[]) {
        const url = getBoardUrl(board.board_id, baseUrl);
        (board as Board & { url: string }).url = url;
      }

      // Update context result
      if (isSingle) {
        context.result = boards[0];
      }
    } catch (error) {
      console.error('[addBoardUrl] Failed to generate URLs:', error);
      // Don't fail the request, just skip URL generation
    }

    return context;
  };
}
