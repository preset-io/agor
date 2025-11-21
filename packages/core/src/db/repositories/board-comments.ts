/**
 * Board Comments Repository
 *
 * Type-safe CRUD operations for board comments with short ID support.
 * Supports flexible attachments (board, session, task, message, worktree, spatial).
 */

import type { BoardComment, CommentID, UUID } from '@agor/core/types';
import { and, eq, isNull, like } from 'drizzle-orm';
import { formatShortId, generateId } from '../../lib/ids';
import type { Database } from '../client';
import { deleteFrom, insert, select, update } from '../database-wrapper';
import { type BoardCommentInsert, type BoardCommentRow, boardComments } from '../schema';
import {
  AmbiguousIdError,
  type BaseRepository,
  EntityNotFoundError,
  RepositoryError,
} from './base';

/**
 * Generate content preview (first 200 chars)
 */
function generatePreview(content: string): string {
  return content.length > 200 ? `${content.slice(0, 200)}...` : content;
}

/**
 * Board comments repository implementation
 */
export class BoardCommentsRepository
  implements BaseRepository<BoardComment, Partial<BoardComment>>
{
  constructor(private db: Database) {}

  /**
   * Convert database row to BoardComment type
   */
  private rowToComment(row: BoardCommentRow): BoardComment {
    const data = row.data as {
      position?: BoardComment['position'];
      mentions?: string[];
    };

    // Parse reactions (stored as JSON string)
    const reactions = row.reactions
      ? typeof row.reactions === 'string'
        ? JSON.parse(row.reactions)
        : row.reactions
      : [];

    return {
      comment_id: row.comment_id as CommentID,
      board_id: row.board_id as UUID,
      created_by: row.created_by as UUID,
      content: row.content,
      content_preview: row.content_preview,
      session_id: row.session_id ? (row.session_id as UUID) : undefined,
      task_id: row.task_id ? (row.task_id as UUID) : undefined,
      message_id: row.message_id ? (row.message_id as UUID) : undefined,
      worktree_id: row.worktree_id ? (row.worktree_id as UUID) : undefined,
      parent_comment_id: row.parent_comment_id ? (row.parent_comment_id as CommentID) : undefined,
      resolved: Boolean(row.resolved),
      edited: Boolean(row.edited),
      reactions,
      position: data.position,
      mentions: data.mentions ? (data.mentions as UUID[]) : undefined,
      created_at: new Date(row.created_at),
      updated_at: row.updated_at ? new Date(row.updated_at) : undefined,
    };
  }

  /**
   * Convert BoardComment to database insert format
   */
  private commentToInsert(comment: Partial<BoardComment>): BoardCommentInsert {
    const now = Date.now();
    const commentId = comment.comment_id ?? generateId();

    // Auto-generate content_preview if not provided
    const contentPreview =
      comment.content_preview ?? (comment.content ? generatePreview(comment.content) : '');

    return {
      comment_id: commentId,
      board_id: comment.board_id!,
      created_by: comment.created_by ?? 'anonymous',
      content: comment.content ?? '',
      content_preview: contentPreview,
      session_id: comment.session_id ?? null,
      task_id: comment.task_id ?? null,
      message_id: comment.message_id ?? null,
      worktree_id: comment.worktree_id ?? null,
      parent_comment_id: comment.parent_comment_id ?? null,
      resolved: comment.resolved ?? false,
      edited: comment.edited ?? false,
      reactions: comment.reactions ?? [],
      created_at: new Date(comment.created_at ?? now),
      updated_at: comment.updated_at ? new Date(comment.updated_at) : null,
      data: {
        position: comment.position,
        mentions: comment.mentions,
      },
    };
  }

  /**
   * Resolve short ID to full ID
   */
  private async resolveId(id: string): Promise<string> {
    // If already a full UUID, return as-is
    if (id.length === 36 && id.includes('-')) {
      return id;
    }

    // Short ID - need to resolve
    const normalized = id.replace(/-/g, '').toLowerCase();
    const pattern = `${normalized}%`;

    const results = await select(this.db)
      .from(boardComments)
      .where(like(boardComments.comment_id, pattern))
      .all();

    if (results.length === 0) {
      throw new EntityNotFoundError('BoardComment', id);
    }

    if (results.length > 1) {
      throw new AmbiguousIdError(
        'BoardComment',
        id,
        results.map((r: { comment_id: string }) => formatShortId(r.comment_id as UUID))
      );
    }

    return results[0].comment_id as UUID;
  }

  /**
   * Create a new comment
   */
  async create(data: Partial<BoardComment>): Promise<BoardComment> {
    try {
      const insertData = this.commentToInsert(data);
      await insert(this.db, boardComments).values(insertData).run();

      const row = await select(this.db)
        .from(boardComments)
        .where(eq(boardComments.comment_id, insertData.comment_id))
        .one();

      if (!row) {
        throw new RepositoryError('Failed to retrieve created comment');
      }

      return this.rowToComment(row);
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      throw new RepositoryError(
        `Failed to create comment: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find comment by ID (supports short ID)
   */
  async findById(id: string): Promise<BoardComment | null> {
    try {
      const fullId = await this.resolveId(id);
      const row = await select(this.db)
        .from(boardComments)
        .where(eq(boardComments.comment_id, fullId))
        .one();

      return row ? this.rowToComment(row) : null;
    } catch (error) {
      if (error instanceof EntityNotFoundError) return null;
      if (error instanceof AmbiguousIdError) throw error;
      throw new RepositoryError(
        `Failed to find comment: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find all comments (optionally filtered by board, session, task, etc.)
   */
  async findAll(filters?: {
    board_id?: string;
    session_id?: string;
    task_id?: string;
    message_id?: string;
    worktree_id?: string;
    resolved?: boolean;
    created_by?: string;
  }): Promise<BoardComment[]> {
    try {
      let query = select(this.db).from(boardComments);

      // Apply filters
      const conditions = [];
      if (filters?.board_id) {
        conditions.push(eq(boardComments.board_id, filters.board_id));
      }
      if (filters?.session_id !== undefined) {
        if (filters.session_id === null) {
          conditions.push(isNull(boardComments.session_id));
        } else {
          conditions.push(eq(boardComments.session_id, filters.session_id));
        }
      }
      if (filters?.task_id !== undefined) {
        if (filters.task_id === null) {
          conditions.push(isNull(boardComments.task_id));
        } else {
          conditions.push(eq(boardComments.task_id, filters.task_id));
        }
      }
      if (filters?.message_id !== undefined) {
        if (filters.message_id === null) {
          conditions.push(isNull(boardComments.message_id));
        } else {
          conditions.push(eq(boardComments.message_id, filters.message_id));
        }
      }
      if (filters?.worktree_id !== undefined) {
        if (filters.worktree_id === null) {
          conditions.push(isNull(boardComments.worktree_id));
        } else {
          conditions.push(eq(boardComments.worktree_id, filters.worktree_id));
        }
      }
      if (filters?.resolved !== undefined) {
        conditions.push(eq(boardComments.resolved, filters.resolved));
      }
      if (filters?.created_by) {
        conditions.push(eq(boardComments.created_by, filters.created_by));
      }

      if (conditions.length > 0) {
        query = query.where(and(...conditions)) as typeof query;
      }

      const rows = await query.all();
      return rows.map((row: BoardCommentRow) => this.rowToComment(row));
    } catch (error) {
      throw new RepositoryError(
        `Failed to find comments: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Update comment by ID
   */
  async update(id: string, updates: Partial<BoardComment>): Promise<BoardComment> {
    try {
      const fullId = await this.resolveId(id);

      // Get current comment to merge updates
      const current = await this.findById(fullId);
      if (!current) {
        throw new EntityNotFoundError('BoardComment', id);
      }

      const merged = { ...current, ...updates };

      // Auto-regenerate content_preview if content changed
      if (updates.content && !updates.content_preview) {
        merged.content_preview = generatePreview(updates.content);
      }

      // Set edited flag if content changed
      if (updates.content && updates.content !== current.content) {
        merged.edited = true;
      }

      const insertData = this.commentToInsert(merged);

      await update(this.db, boardComments)
        .set({
          content: insertData.content,
          content_preview: insertData.content_preview,
          session_id: insertData.session_id,
          task_id: insertData.task_id,
          message_id: insertData.message_id,
          worktree_id: insertData.worktree_id,
          parent_comment_id: insertData.parent_comment_id,
          resolved: insertData.resolved,
          edited: insertData.edited,
          reactions: insertData.reactions,
          updated_at: new Date(),
          data: insertData.data,
        })
        .where(eq(boardComments.comment_id, fullId))
        .run();

      const updated = await this.findById(fullId);
      if (!updated) {
        throw new RepositoryError('Failed to retrieve updated comment');
      }

      return updated;
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      if (error instanceof EntityNotFoundError) throw error;
      throw new RepositoryError(
        `Failed to update comment: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Delete comment by ID
   * If deleting a thread root, also deletes all replies (cascade)
   */
  async delete(id: string): Promise<void> {
    try {
      const fullId = await this.resolveId(id);

      // First, delete all replies (if this is a thread root)
      await deleteFrom(this.db, boardComments)
        .where(eq(boardComments.parent_comment_id, fullId))
        .run();

      // Then delete the comment itself
      const result = await deleteFrom(this.db, boardComments)
        .where(eq(boardComments.comment_id, fullId))
        .run();

      if (result.rowsAffected === 0) {
        throw new EntityNotFoundError('BoardComment', id);
      }
    } catch (error) {
      if (error instanceof EntityNotFoundError) throw error;
      throw new RepositoryError(
        `Failed to delete comment: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Resolve comment (mark as resolved)
   */
  async resolve(id: string): Promise<BoardComment> {
    return this.update(id, { resolved: true });
  }

  /**
   * Unresolve comment (mark as unresolved)
   */
  async unresolve(id: string): Promise<BoardComment> {
    return this.update(id, { resolved: false });
  }

  /**
   * Find comments by board ID with optional filters
   */
  async findByBoard(
    boardId: string,
    filters?: {
      resolved?: boolean;
      created_by?: string;
      session_id?: string;
    }
  ): Promise<BoardComment[]> {
    return this.findAll({ board_id: boardId, ...filters });
  }

  /**
   * Find comments for a specific session
   */
  async findBySession(sessionId: string): Promise<BoardComment[]> {
    return this.findAll({ session_id: sessionId });
  }

  /**
   * Find comments for a specific task
   */
  async findByTask(taskId: string): Promise<BoardComment[]> {
    return this.findAll({ task_id: taskId });
  }

  /**
   * Find comments mentioning a specific user
   */
  async findMentions(userId: string, boardId?: string): Promise<BoardComment[]> {
    const comments = await this.findAll({ board_id: boardId });
    return comments.filter((comment) => comment.mentions?.includes(userId as UUID));
  }

  /**
   * Batch create comments (for bulk operations)
   */
  async bulkCreate(comments: Partial<BoardComment>[]): Promise<BoardComment[]> {
    try {
      const inserts = comments.map((comment) => this.commentToInsert(comment));

      // Batch insert
      await insert(this.db, boardComments).values(inserts).run();

      // Fetch all created comments
      const commentIds = inserts.map((insertItem) => insertItem.comment_id);
      const rows = await select(this.db)
        .from(boardComments)
        .where(
          eq(
            boardComments.comment_id,
            commentIds[0] // TODO: Support proper IN clause when available
          )
        )
        .all();

      return rows.map((row: BoardCommentRow) => this.rowToComment(row));
    } catch (error) {
      throw new RepositoryError(
        `Failed to bulk create comments: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  // ============================================================================
  // Phase 2: Threading + Reactions
  // ============================================================================

  /**
   * Toggle a reaction on a comment
   * If user has already reacted with this emoji, remove it. Otherwise, add it.
   */
  async toggleReaction(commentId: string, userId: string, emoji: string): Promise<BoardComment> {
    try {
      const comment = await this.findById(commentId);
      if (!comment) {
        throw new EntityNotFoundError('BoardComment', commentId);
      }

      const reactions = comment.reactions || [];
      const existingIndex = reactions.findIndex((r) => r.user_id === userId && r.emoji === emoji);

      let updatedReactions: typeof reactions;
      if (existingIndex >= 0) {
        // Remove reaction
        updatedReactions = reactions.filter((_, i) => i !== existingIndex);
      } else {
        // Add reaction
        updatedReactions = [...reactions, { user_id: userId, emoji }];
      }

      return this.update(commentId, { reactions: updatedReactions });
    } catch (error) {
      if (error instanceof EntityNotFoundError) throw error;
      throw new RepositoryError(
        `Failed to toggle reaction: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Create a reply to a comment (thread root)
   * Validates that parent exists and is a thread root
   */
  async createReply(parentId: string, data: Partial<BoardComment>): Promise<BoardComment> {
    try {
      // Validate parent exists
      const parent = await this.findById(parentId);
      if (!parent) {
        throw new EntityNotFoundError('BoardComment', parentId);
      }

      // Validate parent is a thread root (not a reply to a reply)
      if (parent.parent_comment_id) {
        throw new RepositoryError(
          'Cannot reply to a reply. Replies can only be added to thread roots (2-layer limit).'
        );
      }

      // Create reply with parent_comment_id
      const reply: Partial<BoardComment> = {
        ...data,
        parent_comment_id: parent.comment_id,
        board_id: parent.board_id, // Inherit board_id from parent
        // Replies don't have attachments - they inherit context from parent
        session_id: undefined,
        task_id: undefined,
        message_id: undefined,
        worktree_id: undefined,
        position: undefined,
      };

      return this.create(reply);
    } catch (error) {
      if (error instanceof EntityNotFoundError) throw error;
      if (error instanceof RepositoryError) throw error;
      throw new RepositoryError(
        `Failed to create reply: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }
}
