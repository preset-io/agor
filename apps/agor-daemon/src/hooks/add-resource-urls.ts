/**
 * Add Resource URLs Hook
 *
 * Adds external/user-facing URLs to API responses for sessions and boards.
 * These URLs can be used in Slack messages, MCP tools, and UI links.
 */

import { getBaseUrl } from '@agor/core/config';
import { SessionRepository } from '@agor/core/db';
import type {
  BoardWithUrl,
  HookContext,
  Session,
  SessionWithBoardId,
  SessionWithUrl,
} from '@agor/core/types';
import { getBoardUrl, getSessionUrl } from '@agor/core/utils/url';

/**
 * Add URL to session response(s)
 *
 * Adds a `url` property to session objects with a direct link to view the session.
 * URL format: {baseUrl}/b/{boardId}/{sessionId}/
 *
 * Returns null if the session's worktree is not on a board.
 *
 * Uses SessionRepository.enrichWithBoardIds() for efficient batch loading.
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
      const isSingle = !isPaginated && !isArray;

      // Access the SessionRepository from the service
      // SessionsService extends DrizzleService and has sessionRepo as a private property
      const sessionsService = context.service as { sessionRepo: SessionRepository };
      const sessionRepo = sessionsService.sessionRepo;

      if (!sessionRepo) {
        console.warn('[addSessionUrl] No session repository available, skipping URL enrichment');
        return context;
      }

      // Enrich all sessions with board_ids in one efficient query
      const enrichedSessions = await sessionRepo.enrichWithBoardIds(sessions as Session[]);

      // Add URL to each session using the joined board_id
      const sessionsWithUrl = enrichedSessions.map((session: SessionWithBoardId) => {
        const url = getSessionUrl(session.session_id, session.worktree_board_id, baseUrl);
        return { ...session, url } as SessionWithUrl;
      });

      // Update context result
      if (isSingle) {
        context.result = sessionsWithUrl[0];
      } else if (isArray) {
        context.result = sessionsWithUrl;
      } else if (isPaginated) {
        context.result.data = sessionsWithUrl;
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

      // Handle both single result, paginated results, and non-paginated arrays
      const isArray = Array.isArray(context.result);
      const isPaginated = !isArray && context.result.data;
      const boards = isPaginated
        ? context.result.data
        : isArray
          ? context.result
          : [context.result];
      const isSingle = !isPaginated && !isArray;

      // Add URL to each board
      for (const board of boards as BoardWithUrl[]) {
        const url = getBoardUrl(board.board_id, baseUrl);
        board.url = url;
      }

      // Update context result
      if (isSingle) {
        context.result = boards[0];
      } else if (isArray) {
        context.result = boards;
      }
    } catch (error) {
      console.error('[addBoardUrl] Failed to generate URLs:', error);
      // Don't fail the request, just skip URL generation
    }

    return context;
  };
}
