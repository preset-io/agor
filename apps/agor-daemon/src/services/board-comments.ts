/**
 * Board Comments Service
 *
 * Provides REST + WebSocket API for board comments (human-to-human conversations).
 * Uses DrizzleService adapter with BoardCommentsRepository.
 *
 * Features:
 * - Board-level conversations (Phase 1)
 * - Object attachments: session, task, message, branch (Phase 2)
 * - Spatial positioning: absolute/relative (Phase 3)
 * - Mentions and notifications (Phase 4)
 */

import { PAGINATION } from '@agor/core/config';
import { BoardCommentsRepository, type TenantScopeAwareDatabase } from '@agor/core/db';
import type { AuthenticatedParams, BoardComment, QueryParams, UUID } from '@agor/core/types';
import { DrizzleService } from '../adapters/drizzle';
import type { CollaborationAuthorization } from '../utils/collaboration-authorization.js';

/**
 * Board comments service params
 */
export type BoardCommentsParams = QueryParams<{
  board_id?: string;
  session_id?: string;
  task_id?: string;
  message_id?: string;
  branch_id?: string;
  resolved?: boolean;
  created_by?: string;
}> &
  AuthenticatedParams & {
    /** Internal RBAC SQL pushdown marker set by register-hooks for external regular users. */
    _agorSqlBoardAccessUserId?: UUID;
  };

/**
 * Extended board comments service with custom methods
 */
export class BoardCommentsService extends DrizzleService<
  BoardComment,
  Partial<BoardComment>,
  BoardCommentsParams
> {
  private commentsRepo: BoardCommentsRepository;

  constructor(
    db: TenantScopeAwareDatabase,
    private authorization?: CollaborationAuthorization
  ) {
    const commentsRepo = new BoardCommentsRepository(db);
    super(commentsRepo, {
      id: 'comment_id',
      resourceType: 'BoardComment',
      paginate: {
        default: PAGINATION.DEFAULT_LIMIT,
        max: PAGINATION.MAX_LIMIT,
      },
    });

    this.commentsRepo = commentsRepo;
  }

  private async requireComment(
    id: string,
    params: BoardCommentsParams | undefined,
    mode: 'view' | 'mutate'
  ): Promise<BoardComment> {
    const comment = await this.commentsRepo.findById(id);
    if (!comment) throw new Error(`Board comment ${id} not found`);
    const attached = await this.authorization?.requireCommentAttachments(params, {
      boardId: comment.board_id,
      branchId: comment.branch_id,
      sessionId: comment.session_id,
      taskId: comment.task_id,
      messageId: comment.message_id,
    });
    if (mode === 'mutate' || !attached) {
      await this.authorization?.requireBoard(params, comment.board_id, mode);
    }
    return comment;
  }

  override async get(id: string, params?: BoardCommentsParams): Promise<BoardComment> {
    return this.requireComment(id, params, 'view');
  }

  override async patch(
    id: string,
    data: Partial<BoardComment>,
    params?: BoardCommentsParams
  ): Promise<BoardComment> {
    const immutable = [
      'comment_id',
      'board_id',
      'branch_id',
      'session_id',
      'task_id',
      'message_id',
      'parent_id',
      'created_by',
      'created_at',
    ] as const;
    if (immutable.some((field) => field in data)) {
      throw new Error('Comment identity, ownership, and attachments cannot be changed');
    }
    await this.requireComment(id, params, 'mutate');
    const result = await super.patch(id, data, params);
    if (Array.isArray(result)) throw new Error('Unexpected multi-comment patch result');
    return result;
  }

  override async remove(id: string, params?: BoardCommentsParams): Promise<BoardComment> {
    await this.requireComment(id, params, 'mutate');
    const result = await super.remove(id, params);
    if (Array.isArray(result)) throw new Error('Unexpected multi-comment remove result');
    return result;
  }

  override async create(
    data: Partial<BoardComment>,
    params?: BoardCommentsParams
  ): Promise<BoardComment> {
    if (!data.board_id) throw new Error('board_id is required');
    await this.authorization?.requireBoard(params, data.board_id, 'mutate');
    await this.authorization?.requireCommentAttachments(params, {
      boardId: data.board_id,
      branchId: data.branch_id,
      sessionId: data.session_id,
      taskId: data.task_id,
      messageId: data.message_id,
    });
    const result = await super.create(
      { ...data, created_by: (params?.user?.user_id as UUID | undefined) ?? data.created_by },
      params
    );
    if (Array.isArray(result)) throw new Error('Unexpected multi-comment create result');
    return result;
  }

  /**
   * Override find to support filtering by board, session, etc.
   * Returns paginated results for FeathersJS compatibility.
   */
  async find(params?: BoardCommentsParams) {
    const filters = params?.query || {};

    const queryFilters = {
      board_id: filters.board_id,
      session_id: filters.session_id,
      task_id: filters.task_id,
      message_id: filters.message_id,
      branch_id: filters.branch_id,
      resolved: filters.resolved,
      created_by: filters.created_by,
      visibleToUserId: params?._agorSqlBoardAccessUserId,
    };

    const $limit = filters.$limit ?? PAGINATION.DEFAULT_LIMIT;
    const $skip = filters.$skip ?? 0;
    const [total, data] = await Promise.all([
      this.commentsRepo.count(queryFilters),
      this.commentsRepo.findAll(queryFilters, { limit: $limit, offset: $skip }),
    ]);

    return {
      total,
      limit: $limit,
      skip: $skip,
      data,
    };
  }

  /**
   * Custom method: Resolve comment
   */
  async resolve(id: string, params?: BoardCommentsParams): Promise<BoardComment> {
    await this.requireComment(id, params, 'mutate');
    return this.commentsRepo.resolve(id);
  }

  /**
   * Custom method: Unresolve comment
   */
  async unresolve(id: string, params?: BoardCommentsParams): Promise<BoardComment> {
    await this.requireComment(id, params, 'mutate');
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
    params?: BoardCommentsParams
  ): Promise<BoardComment[]> {
    await this.authorization?.requireBoard(params, boardId, 'view');
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
    params?: BoardCommentsParams
  ): Promise<BoardComment[]> {
    for (const comment of comments) {
      if (!comment.board_id) throw new Error('board_id is required');
      await this.authorization?.requireBoard(params, comment.board_id, 'mutate');
      await this.authorization?.requireCommentAttachments(params, {
        boardId: comment.board_id,
        branchId: comment.branch_id,
        sessionId: comment.session_id,
        taskId: comment.task_id,
        messageId: comment.message_id,
      });
    }
    return this.commentsRepo.bulkCreate(
      comments.map((comment) => ({
        ...comment,
        created_by: (params?.user?.user_id as UUID | undefined) ?? comment.created_by,
      }))
    );
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
    data: { user_id?: string; emoji: string },
    params?: BoardCommentsParams
  ): Promise<BoardComment> {
    await this.requireComment(commentId, params, 'view');
    const userId = params?.user?.user_id;
    if (!userId) throw new Error('Authentication required');
    return this.commentsRepo.toggleReaction(commentId, userId, data.emoji);
  }

  /**
   * Custom method: Create a reply to a comment (thread root)
   * Validates that parent exists and is a thread root
   */
  async createReply(
    parentId: string,
    data: Partial<BoardComment>,
    params?: BoardCommentsParams
  ): Promise<BoardComment> {
    const parent = await this.requireComment(parentId, params, 'mutate');
    return this.commentsRepo.createReply(parentId, {
      ...data,
      board_id: parent.board_id,
      created_by: (params?.user?.user_id as UUID | undefined) ?? data.created_by,
    });
  }
}

/**
 * Service factory function
 */
export function createBoardCommentsService(
  db: TenantScopeAwareDatabase,
  authorization?: CollaborationAuthorization
): BoardCommentsService {
  return new BoardCommentsService(db, authorization);
}
