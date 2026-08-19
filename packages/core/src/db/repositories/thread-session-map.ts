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
import { prefixToLikePattern } from '@agor/core/types';
import { and, asc, eq, inArray, like, lt } from 'drizzle-orm';
import { DISCORD_PRESENCE_ACTIVE_COUNT_CAP } from '../../gateway/connectors/discord-presence';
import { parseDiscordProgressMetadata } from '../../gateway/connectors/discord-progress';
import { generateId } from '../../lib/ids';
import type { Database } from '../client';
import {
  deleteFrom,
  insert,
  jsonExtract,
  lockRowForUpdate,
  runDatabaseTransaction,
  select,
  update,
} from '../database-wrapper';
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
      branch_id: row.branch_id as UUID,
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
      branch_id: data.branch_id ?? '',
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

    const pattern = prefixToLikePattern(id);

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
        results.map((r: { id: string }) => r.id)
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
   * Return at most two active mappings for a Session so strict callers can
   * reject an ambiguous legacy graph without loading an unbounded inventory.
   * Existing outbound routing keeps its historical findBySession behavior.
   */
  async findActiveBySessionBounded(sessionId: string): Promise<ThreadSessionMap[]> {
    try {
      const rows = await select(this.db)
        .from(threadSessionMap)
        .where(
          and(eq(threadSessionMap.session_id, sessionId), eq(threadSessionMap.status, 'active'))
        )
        .orderBy(asc(threadSessionMap.id))
        .limit(2)
        .all();
      return rows.map((row: ThreadSessionMapRow) => this.rowToMapping(row));
    } catch (error) {
      throw new RepositoryError(
        `Failed to find active mappings by session: ${error instanceof Error ? error.message : String(error)}`,
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
   * Count strictly valid queued/working Discord progress rows for aggregate
   * presence. The JSON-state prefilter and hard candidate cap keep the query
   * content-free and bounded; malformed rows fail closed and are excluded.
   */
  async countActiveDiscordProgress(
    channelId: GatewayChannelID,
    displayCap = DISCORD_PRESENCE_ACTIVE_COUNT_CAP
  ): Promise<number> {
    if (
      !Number.isInteger(displayCap) ||
      displayCap < 1 ||
      displayCap > DISCORD_PRESENCE_ACTIVE_COUNT_CAP
    ) {
      throw new RepositoryError(
        `Discord presence display cap must be between 1 and ${DISCORD_PRESENCE_ACTIVE_COUNT_CAP}`
      );
    }
    try {
      const candidateLimit = displayCap * 4 + 1;
      const rows = await select(this.db, { metadata: threadSessionMap.metadata })
        .from(threadSessionMap)
        .where(
          and(
            eq(threadSessionMap.channel_id, channelId),
            eq(threadSessionMap.status, 'active'),
            inArray(jsonExtract(this.db, threadSessionMap.metadata, 'discord_progress_state'), [
              'queued',
              'working',
            ])
          )
        )
        .orderBy(asc(threadSessionMap.id))
        .limit(candidateLimit)
        .all();
      let count = 0;
      for (const row of rows) {
        const progress = parseDiscordProgressMetadata(
          (row.metadata as Record<string, unknown> | null) ?? {}
        );
        if (progress && (progress.state === 'queued' || progress.state === 'working')) {
          count += 1;
          if (count >= displayCap) return displayCap;
        }
      }
      return count;
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      throw new RepositoryError(
        `Failed to count active Discord progress: ${error instanceof Error ? error.message : String(error)}`,
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
   * Update metadata for a thread-session mapping
   */
  async updateMetadata(id: ThreadSessionMapID, metadata: Record<string, unknown>): Promise<void> {
    try {
      await update(this.db, threadSessionMap)
        .set({ metadata })
        .where(eq(threadSessionMap.id, id))
        .run();
    } catch (error) {
      throw new RepositoryError(
        `Failed to update metadata: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /** Update metadata from a fresh row snapshot under a short row lock. */
  async updateMetadataAtomic(
    id: ThreadSessionMapID,
    updateMetadata: (metadata: Record<string, unknown>) => Record<string, unknown>
  ): Promise<ThreadSessionMap> {
    return runDatabaseTransaction(
      this.db,
      async (txDb) => {
        await lockRowForUpdate(txDb, this.db, threadSessionMap, eq(threadSessionMap.id, id));
        const row = await select(txDb)
          .from(threadSessionMap)
          .where(eq(threadSessionMap.id, id))
          .one();
        if (!row) throw new EntityNotFoundError('ThreadSessionMap', id);
        const metadata = updateMetadata({
          ...((row.metadata as Record<string, unknown> | null) ?? {}),
        });
        const updated = await update(txDb, threadSessionMap)
          .set({ metadata })
          .where(eq(threadSessionMap.id, id))
          .returning()
          .one();
        return this.rowToMapping(updated);
      },
      { sqliteImmediate: true }
    );
  }

  /** Merge metadata under a short row lock without overwriting concurrent fields. */
  async mergeMetadata(
    id: ThreadSessionMapID,
    patch: Record<string, unknown>
  ): Promise<ThreadSessionMap> {
    return this.updateMetadataAtomic(id, (metadata) => ({ ...metadata, ...patch }));
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
   * Find all mappings for a branch (for UI filtering gateway sessions)
   */
  async findByBranch(branchId: string): Promise<ThreadSessionMap[]> {
    try {
      const rows = await select(this.db)
        .from(threadSessionMap)
        .where(eq(threadSessionMap.branch_id, branchId))
        .all();

      return rows.map((row: ThreadSessionMapRow) => this.rowToMapping(row));
    } catch (error) {
      throw new RepositoryError(
        `Failed to find mappings by branch: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }
}
