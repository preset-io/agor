/**
 * Knowledge Document Comments Repository
 *
 * Threaded comments on Knowledge documents, optionally anchored to a heading
 * section. Mirrors the board-comment threading model (Figma-style 2 layers,
 * resolve, reactions) but keyed by `document_id` so access can be gated by the
 * document's namespace ACL instead of board membership.
 */

import type {
  CommentID,
  KnowledgeDocumentComment,
  KnowledgeDocumentID,
  UUID,
} from '@agor/core/types';
import { commentContentPreview, toggleCommentReaction } from '@agor/core/types';
import { and, asc, eq, like, type SQL, sql } from 'drizzle-orm';
import { generateId } from '../../lib/ids';
import type { Database } from '../client';
import { deleteFrom, insert, select, update } from '../database-wrapper';
import {
  type KBDocumentCommentInsert,
  type KBDocumentCommentRow,
  kbDocumentComments,
} from '../schema';
import {
  AmbiguousIdError,
  type BaseRepository,
  EntityNotFoundError,
  RESOLVE_SHORT_ID_FETCH_LIMIT,
  RepositoryError,
  resolveByShortIdPrefix,
} from './base';

export interface KnowledgeDocumentCommentFilters {
  document_id?: string;
  resolved?: boolean;
  created_by?: string;
}

export class KnowledgeDocumentCommentsRepository
  implements BaseRepository<KnowledgeDocumentComment, Partial<KnowledgeDocumentComment>>
{
  constructor(private db: Database) {}

  private rowToComment(row: KBDocumentCommentRow): KnowledgeDocumentComment {
    const reactions =
      typeof row.reactions === 'string' ? JSON.parse(row.reactions) : (row.reactions ?? []);
    const mentions = typeof row.mentions === 'string' ? JSON.parse(row.mentions) : row.mentions;

    return {
      comment_id: row.comment_id as CommentID,
      document_id: row.document_id as KnowledgeDocumentID,
      created_by: row.created_by as UUID,
      content: row.content,
      content_preview: row.content_preview,
      parent_comment_id: row.parent_comment_id ? (row.parent_comment_id as CommentID) : undefined,
      anchor_slug: row.anchor_slug ?? null,
      anchor_label: row.anchor_label ?? null,
      resolved: Boolean(row.resolved),
      edited: Boolean(row.edited),
      reactions,
      mentions: mentions ? (mentions as UUID[]) : undefined,
      created_at: new Date(row.created_at),
      updated_at: row.updated_at ? new Date(row.updated_at) : undefined,
    };
  }

  private commentToInsert(comment: Partial<KnowledgeDocumentComment>): KBDocumentCommentInsert {
    if (!comment.document_id) {
      throw new RepositoryError('KnowledgeDocumentComment must have a document_id');
    }
    if (!comment.created_by) {
      throw new RepositoryError('KnowledgeDocumentComment must have a created_by');
    }
    if (!comment.content?.trim()) {
      throw new RepositoryError('KnowledgeDocumentComment must have content');
    }

    return {
      comment_id: comment.comment_id ?? generateId(),
      document_id: comment.document_id,
      created_by: comment.created_by,
      content: comment.content,
      content_preview: comment.content_preview ?? commentContentPreview(comment.content),
      parent_comment_id: comment.parent_comment_id ?? null,
      anchor_slug: comment.anchor_slug ?? null,
      anchor_label: comment.anchor_label ?? null,
      resolved: comment.resolved ?? false,
      edited: comment.edited ?? false,
      reactions: comment.reactions ?? [],
      mentions: comment.mentions ?? null,
      created_at: new Date(comment.created_at ?? Date.now()),
      updated_at: comment.updated_at ? new Date(comment.updated_at) : null,
    };
  }

  private async resolveId(id: string): Promise<string> {
    return resolveByShortIdPrefix(id, 'KnowledgeDocumentComment', async (pattern) => {
      const rows = await select(this.db)
        .from(kbDocumentComments)
        .where(like(kbDocumentComments.comment_id, pattern))
        .limit(RESOLVE_SHORT_ID_FETCH_LIMIT)
        .all();
      return rows.map((r: { comment_id: string }) => r.comment_id);
    });
  }

  private buildFindConditions(filters?: KnowledgeDocumentCommentFilters): SQL[] {
    const conditions: SQL[] = [];
    if (filters?.document_id) {
      conditions.push(eq(kbDocumentComments.document_id, filters.document_id));
    }
    if (filters?.resolved !== undefined) {
      conditions.push(eq(kbDocumentComments.resolved, filters.resolved));
    }
    if (filters?.created_by) {
      conditions.push(eq(kbDocumentComments.created_by, filters.created_by));
    }
    return conditions;
  }

  async create(data: Partial<KnowledgeDocumentComment>): Promise<KnowledgeDocumentComment> {
    try {
      const insertData = this.commentToInsert(data);
      await insert(this.db, kbDocumentComments).values(insertData).run();

      const row = await select(this.db)
        .from(kbDocumentComments)
        .where(eq(kbDocumentComments.comment_id, insertData.comment_id))
        .one();
      if (!row) {
        throw new RepositoryError('Failed to retrieve created knowledge document comment');
      }
      return this.rowToComment(row);
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      throw new RepositoryError(
        `Failed to create knowledge document comment: ${
          error instanceof Error ? error.message : String(error)
        }`,
        error
      );
    }
  }

  async findById(id: string): Promise<KnowledgeDocumentComment | null> {
    try {
      const fullId = await this.resolveId(id);
      const row = await select(this.db)
        .from(kbDocumentComments)
        .where(eq(kbDocumentComments.comment_id, fullId))
        .one();
      return row ? this.rowToComment(row) : null;
    } catch (error) {
      if (error instanceof EntityNotFoundError) return null;
      if (error instanceof AmbiguousIdError) throw error;
      throw new RepositoryError(
        `Failed to find knowledge document comment: ${
          error instanceof Error ? error.message : String(error)
        }`,
        error
      );
    }
  }

  /** Threads and replies for a document, oldest first. */
  async findAll(
    filters?: KnowledgeDocumentCommentFilters,
    options?: { limit?: number; offset?: number }
  ): Promise<KnowledgeDocumentComment[]> {
    try {
      let query = select(this.db).from(kbDocumentComments);
      const conditions = this.buildFindConditions(filters);
      if (conditions.length > 0) {
        query = query.where(and(...conditions)) as typeof query;
      }
      query = query.orderBy(asc(kbDocumentComments.created_at)) as typeof query;
      if (options?.limit !== undefined) {
        query = query.limit(options.limit) as typeof query;
      }
      if (options?.offset !== undefined) {
        query = query.offset(options.offset) as typeof query;
      }

      const rows = await query.all();
      return rows.map((row: KBDocumentCommentRow) => this.rowToComment(row));
    } catch (error) {
      throw new RepositoryError(
        `Failed to find knowledge document comments: ${
          error instanceof Error ? error.message : String(error)
        }`,
        error
      );
    }
  }

  async count(filters?: KnowledgeDocumentCommentFilters): Promise<number> {
    try {
      const conditions = this.buildFindConditions(filters);
      const query = select(this.db, { count: sql<number>`count(*)` }).from(kbDocumentComments);
      const row =
        conditions.length > 0 ? await query.where(and(...conditions)).one() : await query.one();
      return Number(row?.count ?? 0);
    } catch (error) {
      throw new RepositoryError(
        `Failed to count knowledge document comments: ${
          error instanceof Error ? error.message : String(error)
        }`,
        error
      );
    }
  }

  async update(
    id: string,
    updates: Partial<KnowledgeDocumentComment>
  ): Promise<KnowledgeDocumentComment> {
    try {
      const fullId = await this.resolveId(id);
      const current = await this.findById(fullId);
      if (!current) {
        throw new EntityNotFoundError('KnowledgeDocumentComment', id);
      }

      const contentChanged = updates.content !== undefined && updates.content !== current.content;
      const merged: Partial<KnowledgeDocumentComment> = {
        ...current,
        ...updates,
        edited: current.edited || contentChanged,
      };
      if (contentChanged && updates.content_preview === undefined) {
        merged.content_preview = commentContentPreview(updates.content as string);
      }

      const insertData = this.commentToInsert(merged);
      await update(this.db, kbDocumentComments)
        .set({
          content: insertData.content,
          content_preview: insertData.content_preview,
          anchor_slug: insertData.anchor_slug,
          anchor_label: insertData.anchor_label,
          resolved: insertData.resolved,
          edited: insertData.edited,
          reactions: insertData.reactions,
          mentions: insertData.mentions,
          updated_at: new Date(),
        })
        .where(eq(kbDocumentComments.comment_id, fullId))
        .run();

      const updated = await this.findById(fullId);
      if (!updated) {
        throw new RepositoryError('Failed to retrieve updated knowledge document comment');
      }
      return updated;
    } catch (error) {
      if (error instanceof EntityNotFoundError) throw error;
      if (error instanceof RepositoryError) throw error;
      throw new RepositoryError(
        `Failed to update knowledge document comment: ${
          error instanceof Error ? error.message : String(error)
        }`,
        error
      );
    }
  }

  /** Deleting a thread root also deletes its replies. */
  async delete(id: string): Promise<void> {
    try {
      const fullId = await this.resolveId(id);
      await deleteFrom(this.db, kbDocumentComments)
        .where(eq(kbDocumentComments.parent_comment_id, fullId))
        .run();

      const result = await deleteFrom(this.db, kbDocumentComments)
        .where(eq(kbDocumentComments.comment_id, fullId))
        .run();
      if (result.rowsAffected === 0) {
        throw new EntityNotFoundError('KnowledgeDocumentComment', id);
      }
    } catch (error) {
      if (error instanceof EntityNotFoundError) throw error;
      throw new RepositoryError(
        `Failed to delete knowledge document comment: ${
          error instanceof Error ? error.message : String(error)
        }`,
        error
      );
    }
  }

  async resolve(id: string): Promise<KnowledgeDocumentComment> {
    return this.update(id, { resolved: true });
  }

  async unresolve(id: string): Promise<KnowledgeDocumentComment> {
    return this.update(id, { resolved: false });
  }

  async toggleReaction(
    commentId: string,
    userId: string,
    emoji: string
  ): Promise<KnowledgeDocumentComment> {
    const comment = await this.findById(commentId);
    if (!comment) {
      throw new EntityNotFoundError('KnowledgeDocumentComment', commentId);
    }
    return this.update(comment.comment_id, {
      reactions: toggleCommentReaction(comment.reactions ?? [], userId, emoji),
    });
  }

  /**
   * Replies inherit the thread root's document and anchor so a thread never
   * splits across sections. Threading is capped at 2 layers.
   */
  async createReply(
    parentId: string,
    data: Partial<KnowledgeDocumentComment>
  ): Promise<KnowledgeDocumentComment> {
    const parent = await this.findById(parentId);
    if (!parent) {
      throw new EntityNotFoundError('KnowledgeDocumentComment', parentId);
    }
    if (parent.parent_comment_id) {
      throw new RepositoryError(
        'Cannot reply to a reply. Replies can only be added to thread roots (2-layer limit).'
      );
    }

    return this.create({
      ...data,
      parent_comment_id: parent.comment_id,
      document_id: parent.document_id,
      anchor_slug: parent.anchor_slug,
      anchor_label: parent.anchor_label,
      resolved: false,
    });
  }
}
