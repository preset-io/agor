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

import { PAGINATION } from '@agor/core/config';
import { BoardCommentsRepository, type Database } from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
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
  private app?: Application;

  constructor(db: Database, app?: Application) {
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
    this.app = app;
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

    // Apply pagination if requested
    const $limit = filters.$limit ?? PAGINATION.DEFAULT_LIMIT;
    const $skip = filters.$skip ?? 0;
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
  // Mention producer (Phase 4 / notifications v1)
  // ============================================================================

  /**
   * Emit `mention` notifications for any user appearing in the comment's
   * mention set that wasn't already mentioned in the previous revision.
   *
   * Source-of-truth for mention identity is the comment row's
   * `data.mentions[]`. Substring fallback on `@username` / `@email` is a
   * stop-gap until board-comments Phase 4 lands the explicit field.
   *
   * Self-mentions are skipped per design doc Q-G.
   */
  private async fireMentionNotifications(
    comment: BoardComment,
    previousMentions: string[]
  ): Promise<void> {
    if (!this.app) return;
    const notifs = this.app.service('notifications') as unknown as
      | {
          deliver: (notif: unknown) => Promise<unknown>;
        }
      | undefined;
    if (!notifs?.deliver) return;

    const explicitMentions = (comment.mentions ?? []) as string[];
    const mentions =
      explicitMentions.length > 0
        ? explicitMentions
        : this.extractMentionsFromContent(comment.content);

    if (mentions.length === 0) return;

    const previousSet = new Set(previousMentions);
    const newRecipients = mentions.filter(
      (uid) => uid && uid !== comment.created_by && !previousSet.has(uid)
    );
    if (newRecipients.length === 0) return;

    const preview = comment.content_preview ?? comment.content?.slice(0, 160);
    const title = `${(comment.created_by ?? 'Someone').substring(0, 8)} mentioned you in a comment`;

    for (const recipient of newRecipients) {
      try {
        await notifs.deliver({
          recipient_user_id: recipient,
          type: 'mention',
          title,
          preview,
          source_session_id: comment.session_id ?? undefined,
          source_worktree_id: comment.worktree_id ?? undefined,
          source_board_id: comment.board_id ?? undefined,
          source_comment_id: comment.comment_id,
          source_user_id: comment.created_by ?? undefined,
          data: {},
        });
      } catch (err) {
        console.warn(
          `[notifications] failed to deliver mention for ${recipient.substring(0, 8)}:`,
          err
        );
      }
    }
  }

  /**
   * Substring fallback for mention detection — best-effort.
   * Without a user lookup we can't resolve `@name` → user_id, so we only fire
   * when the explicit `mentions[]` field is present. This helper exists so
   * the substring path can be plugged in later without re-touching consumers.
   */
  private extractMentionsFromContent(_content: string): string[] {
    return [];
  }

  // Hook create / patch to fire mention notifications. The DrizzleService
  // adapter doesn't expose a built-in hook system for create/patch internals,
  // so we override these methods here.

  async create(
    data: Partial<BoardComment> | Partial<BoardComment>[],
    params?: BoardCommentsParams
  ): Promise<BoardComment | BoardComment[]> {
    // biome-ignore lint/suspicious/noExplicitAny: passing through to base adapter
    const result = await (super.create as any)(data, params);
    const created = (Array.isArray(result) ? result : [result]) as BoardComment[];
    for (const comment of created) {
      this.fireMentionNotifications(comment, []).catch((err) =>
        console.warn('[notifications] mention producer failed (create):', err)
      );
    }
    return result;
  }

  async patch(
    id: string | null,
    data: Partial<BoardComment>,
    params?: BoardCommentsParams
  ): Promise<BoardComment | BoardComment[]> {
    let previousMentions: string[] = [];
    if (typeof id === 'string') {
      try {
        const prev = await this.commentsRepo.findById(id);
        previousMentions = (prev?.mentions ?? []) as string[];
      } catch {
        previousMentions = [];
      }
    }
    // biome-ignore lint/suspicious/noExplicitAny: passing through to base adapter
    const result = await (super.patch as any)(id, data, params);
    const updated = (Array.isArray(result) ? result : [result]) as BoardComment[];
    for (const comment of updated) {
      this.fireMentionNotifications(comment, previousMentions).catch((err) =>
        console.warn('[notifications] mention producer failed (patch):', err)
      );
    }
    return result;
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
export function createBoardCommentsService(db: Database, app?: Application): BoardCommentsService {
  return new BoardCommentsService(db, app);
}
