/**
 * Board Comments Service
 *
 * Provides REST + WebSocket API for board comments (human-to-human conversations).
 * Uses DrizzleService adapter with BoardCommentsRepository.
 *
 * Features:
 * - Board-level conversations (Phase 1)
 * - Object attachments: session, task, message, worktree (Phase 2)
 * - Spatial positioning: absolute/relative (Phase 3)
 * - Mentions and notifications (Phase 4)
 */

import { BoardCommentsRepository, type Database } from '@agor/core/db';
import type { BoardComment, QueryParams } from '@agor/core/types';
import { DrizzleService } from '../adapters/drizzle';

/**
 * Board comments service params
 */
export type BoardCommentsParams = QueryParams<{
  board_id?: string;
  session_id?: string;
  task_id?: string;
  message_id?: string;
  worktree_id?: string;
  resolved?: boolean;
  created_by?: string;
}>;

/**
 * Extended board comments service with custom methods
 */
export class BoardCommentsService extends DrizzleService<
  BoardComment,
  Partial<BoardComment>,
  BoardCommentsParams
> {
  private commentsRepo: BoardCommentsRepository;

  constructor(db: Database) {
    const commentsRepo = new BoardCommentsRepository(db);
    super(commentsRepo, {
      id: 'comment_id',
      resourceType: 'BoardComment',
      paginate: {
        default: 100,
        max: 500,
      },
    });

    this.commentsRepo = commentsRepo;
  }

  /**
   * Override find to support filtering by board, session, etc.
   * Returns paginated results for FeathersJS compatibility.
   */
  async find(params?: BoardCommentsParams) {
    const filters = params?.query || {};

    // Get all matching comments
    const allComments = await this.commentsRepo.findAll({
      board_id: filters.board_id,
      session_id: filters.session_id,
      task_id: filters.task_id,
      message_id: filters.message_id,
      worktree_id: filters.worktree_id,
      resolved: filters.resolved,
      created_by: filters.created_by,
    });

    // Apply pagination if requested (default: 100)
    const $limit = filters.$limit || 100;
    const $skip = filters.$skip || 0;
    const paginated = allComments.slice($skip, $skip + $limit);

    // Return paginated result format expected by FeathersJS
    return {
      total: allComments.length,
      limit: $limit,
      skip: $skip,
      data: paginated,
    };
  }

  /**
   * Custom method: Resolve comment
   */
  async resolve(id: string, _params?: BoardCommentsParams): Promise<BoardComment> {
    return this.commentsRepo.resolve(id);
  }

  /**
   * Custom method: Unresolve comment
   */
  async unresolve(id: string, _params?: BoardCommentsParams): Promise<BoardComment> {
    return this.commentsRepo.unresolve(id);
  }

  /**
   * Custom method: Find comments by board
   */
  async findByBoard(
    boardId: string,
    filters?: {
      resolved?: boolean;
      created_by?: string;
      session_id?: string;
    },
    _params?: BoardCommentsParams
  ): Promise<BoardComment[]> {
    return this.commentsRepo.findByBoard(boardId, filters);
  }

  /**
   * Custom method: Find comments by session
   */
  async findBySession(sessionId: string, _params?: BoardCommentsParams): Promise<BoardComment[]> {
    return this.commentsRepo.findBySession(sessionId);
  }

  /**
   * Custom method: Find comments by task
   */
  async findByTask(taskId: string, _params?: BoardCommentsParams): Promise<BoardComment[]> {
    return this.commentsRepo.findByTask(taskId);
  }

  /**
   * Custom method: Find comments mentioning a user
   */
  async findMentions(
    userId: string,
    boardId?: string,
    _params?: BoardCommentsParams
  ): Promise<BoardComment[]> {
    return this.commentsRepo.findMentions(userId, boardId);
  }

  /**
   * Custom method: Bulk create comments
   */
  async bulkCreate(
    comments: Partial<BoardComment>[],
    _params?: BoardCommentsParams
  ): Promise<BoardComment[]> {
    return this.commentsRepo.bulkCreate(comments);
  }

  // ============================================================================
  // Phase 2: Threading + Reactions
  // ============================================================================

  /**
   * Custom method: Toggle reaction on a comment
   * If user has already reacted with this emoji, remove it. Otherwise, add it.
   */
  async toggleReaction(
    commentId: string,
    data: { user_id: string; emoji: string },
    _params?: BoardCommentsParams
  ): Promise<BoardComment> {
    return this.commentsRepo.toggleReaction(commentId, data.user_id, data.emoji);
  }

  /**
   * Custom method: Create a reply to a comment (thread root)
   * Validates that parent exists and is a thread root
   */
  async createReply(
    parentId: string,
    data: Partial<BoardComment>,
    _params?: BoardCommentsParams
  ): Promise<BoardComment> {
    return this.commentsRepo.createReply(parentId, data);
  }
}

/**
 * Service factory function
 */
export function createBoardCommentsService(db: Database): BoardCommentsService {
  return new BoardCommentsService(db);
}
