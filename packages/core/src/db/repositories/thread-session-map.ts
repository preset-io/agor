/**
 * Thread-Session Map Repository
 *
 * Type-safe CRUD operations for thread-session mappings with short ID support.
 * Maps platform threads to Agor sessions for gateway routing.
 */

import type {
  GatewayChannelID,
  SessionID,
  ThreadSessionMap,
  ThreadSessionMapID,
  ThreadStatus,
  UUID,
} from '@agor/core/types';
import { and, eq, like, lt } from 'drizzle-orm';
import { formatShortId, generateId } from '../../lib/ids';
import type { Database } from '../client';
import { deleteFrom, insert, select, update } from '../database-wrapper';
import { type ThreadSessionMapInsert, type ThreadSessionMapRow, threadSessionMap } from '../schema';
import {
  AmbiguousIdError,
  type BaseRepository,
  EntityNotFoundError,
  RepositoryError,
} from './base';

/**
 * Thread-session map repository implementation
 */
export class ThreadSessionMapRepository
  implements BaseRepository<ThreadSessionMap, Partial<ThreadSessionMap>>
{
  constructor(private db: Database) {}

  /**
   * Convert database row to ThreadSessionMap type
   */
  private rowToMapping(row: ThreadSessionMapRow): ThreadSessionMap {
    return {
      id: row.id as ThreadSessionMapID,
      channel_id: row.channel_id as GatewayChannelID,
      thread_id: row.thread_id,
      session_id: row.session_id as SessionID,
      worktree_id: row.worktree_id as UUID,
      created_at: new Date(row.created_at).toISOString(),
      last_message_at: new Date(row.last_message_at).toISOString(),
      status: row.status as ThreadStatus,
      metadata: (row.metadata as Record<string, unknown>) ?? null,
    };
  }

  /**
   * Convert ThreadSessionMap to database insert format
   */
  private mappingToInsert(data: Partial<ThreadSessionMap>): ThreadSessionMapInsert {
    const now = Date.now();
    const id = data.id ?? generateId();

    return {
      id,
      created_at: new Date(data.created_at ?? now),
      last_message_at: new Date(data.last_message_at ?? now),
      channel_id: data.channel_id ?? '',
      thread_id: data.thread_id ?? '',
      session_id: data.session_id ?? '',
      worktree_id: data.worktree_id ?? '',
      status: data.status ?? 'active',
      metadata: data.metadata ?? null,
    };
  }

  /**
   * Resolve short ID to full ID
   */
  private async resolveId(id: string): Promise<string> {
    if (id.length === 36 && id.includes('-')) {
      return id;
    }

    const normalized = id.replace(/-/g, '').toLowerCase();
    const pattern = `${normalized}%`;

    const results = await select(this.db)
      .from(threadSessionMap)
      .where(like(threadSessionMap.id, pattern))
      .all();

    if (results.length === 0) {
      throw new EntityNotFoundError('ThreadSessionMap', id);
    }

    if (results.length > 1) {
      throw new AmbiguousIdError(
        'ThreadSessionMap',
        id,
        results.map((r: { id: string }) => formatShortId(r.id as UUID))
      );
    }

    return results[0].id;
  }

  /**
   * Create a new thread-session mapping
   */
  async create(data: Partial<ThreadSessionMap>): Promise<ThreadSessionMap> {
    try {
      const insertData = this.mappingToInsert({
        ...data,
        id: data.id ?? generateId(),
      });

      await insert(this.db, threadSessionMap).values(insertData).run();

      const row = await select(this.db)
        .from(threadSessionMap)
        .where(eq(threadSessionMap.id, insertData.id))
        .one();

      if (!row) {
        throw new RepositoryError('Failed to retrieve created thread-session mapping');
      }

      return this.rowToMapping(row);
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      throw new RepositoryError(
        `Failed to create thread-session mapping: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find thread-session mapping by ID (supports short ID)
   */
  async findById(id: string): Promise<ThreadSessionMap | null> {
    try {
      const fullId = await this.resolveId(id);
      const row = await select(this.db)
        .from(threadSessionMap)
        .where(eq(threadSessionMap.id, fullId))
        .one();

      return row ? this.rowToMapping(row) : null;
    } catch (error) {
      if (error instanceof EntityNotFoundError) return null;
      if (error instanceof AmbiguousIdError) throw error;
      throw new RepositoryError(
        `Failed to find thread-session mapping: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find all thread-session mappings
   */
  async findAll(): Promise<ThreadSessionMap[]> {
    try {
      const rows = await select(this.db).from(threadSessionMap).all();
      return rows.map((row: ThreadSessionMapRow) => this.rowToMapping(row));
    } catch (error) {
      throw new RepositoryError(
        `Failed to find all thread-session mappings: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Update thread-session mapping by ID
   */
  async update(id: string, updates: Partial<ThreadSessionMap>): Promise<ThreadSessionMap> {
    try {
      const fullId = await this.resolveId(id);

      const current = await this.findById(fullId);
      if (!current) {
        throw new EntityNotFoundError('ThreadSessionMap', id);
      }

      const merged = { ...current, ...updates };
      const insertData = this.mappingToInsert(merged);

      await update(this.db, threadSessionMap)
        .set({
          status: insertData.status,
          last_message_at: insertData.last_message_at,
          metadata: insertData.metadata,
        })
        .where(eq(threadSessionMap.id, fullId))
        .run();

      const updated = await this.findById(fullId);
      if (!updated) {
        throw new RepositoryError('Failed to retrieve updated thread-session mapping');
      }

      return updated;
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      if (error instanceof EntityNotFoundError) throw error;
      throw new RepositoryError(
        `Failed to update thread-session mapping: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Delete thread-session mapping by ID
   */
  async delete(id: string): Promise<void> {
    try {
      const fullId = await this.resolveId(id);

      const result = await deleteFrom(this.db, threadSessionMap)
        .where(eq(threadSessionMap.id, fullId))
        .run();

      if (result.rowsAffected === 0) {
        throw new EntityNotFoundError('ThreadSessionMap', id);
      }
    } catch (error) {
      if (error instanceof EntityNotFoundError) throw error;
      throw new RepositoryError(
        `Failed to delete thread-session mapping: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find mapping by channel and thread (inbound routing lookup)
   */
  async findByChannelAndThread(
    channelId: string,
    threadId: string
  ): Promise<ThreadSessionMap | null> {
    try {
      const row = await select(this.db)
        .from(threadSessionMap)
        .where(
          and(eq(threadSessionMap.channel_id, channelId), eq(threadSessionMap.thread_id, threadId))
        )
        .one();

      return row ? this.rowToMapping(row) : null;
    } catch (error) {
      throw new RepositoryError(
        `Failed to find mapping by channel and thread: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find any mapping for a thread ID, regardless of channel.
   * Used to detect cross-channel thread ownership (e.g., thread belongs
   * to a different gateway channel on the same daemon).
   */
  async findByThread(threadId: string): Promise<ThreadSessionMap | null> {
    try {
      const row = await select(this.db)
        .from(threadSessionMap)
        .where(eq(threadSessionMap.thread_id, threadId))
        .one();

      return row ? this.rowToMapping(row) : null;
    } catch (error) {
      throw new RepositoryError(
        `Failed to find mapping by thread: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find mapping by session ID (outbound routing lookup)
   */
  async findBySession(sessionId: string): Promise<ThreadSessionMap | null> {
    try {
      const row = await select(this.db)
        .from(threadSessionMap)
        .where(eq(threadSessionMap.session_id, sessionId))
        .one();

      return row ? this.rowToMapping(row) : null;
    } catch (error) {
      throw new RepositoryError(
        `Failed to find mapping by session: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find all mappings for a channel, optionally filtered by status
   */
  async findByChannel(channelId: string, status?: ThreadStatus): Promise<ThreadSessionMap[]> {
    try {
      const conditions = [eq(threadSessionMap.channel_id, channelId)];
      if (status) {
        conditions.push(eq(threadSessionMap.status, status));
      }

      const rows = await select(this.db)
        .from(threadSessionMap)
        .where(and(...conditions))
        .all();

      return rows.map((row: ThreadSessionMapRow) => this.rowToMapping(row));
    } catch (error) {
      throw new RepositoryError(
        `Failed to find mappings by channel: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Touch last_message_at timestamp
   */
  async updateLastMessage(id: ThreadSessionMapID): Promise<void> {
    try {
      await update(this.db, threadSessionMap)
        .set({
          last_message_at: new Date(),
        })
        .where(eq(threadSessionMap.id, id))
        .run();
    } catch (error) {
      throw new RepositoryError(
        `Failed to update last message timestamp: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find inactive mappings for garbage collection
   */
  async findInactive(daysInactive: number): Promise<ThreadSessionMap[]> {
    try {
      const cutoff = new Date(Date.now() - daysInactive * 24 * 60 * 60 * 1000);

      const rows = await select(this.db)
        .from(threadSessionMap)
        .where(
          and(eq(threadSessionMap.status, 'active'), lt(threadSessionMap.last_message_at, cutoff))
        )
        .all();

      return rows.map((row: ThreadSessionMapRow) => this.rowToMapping(row));
    } catch (error) {
      throw new RepositoryError(
        `Failed to find inactive mappings: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find all mappings for a worktree (for UI filtering gateway sessions)
   */
  async findByWorktree(worktreeId: string): Promise<ThreadSessionMap[]> {
    try {
      const rows = await select(this.db)
        .from(threadSessionMap)
        .where(eq(threadSessionMap.worktree_id, worktreeId))
        .all();

      return rows.map((row: ThreadSessionMapRow) => this.rowToMapping(row));
    } catch (error) {
      throw new RepositoryError(
        `Failed to find mappings by worktree: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }
}
