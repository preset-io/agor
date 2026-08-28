/**
 * Thread-Session Map Repository
 *
 * Type-safe CRUD operations for thread-session mappings with short ID support.
 * Maps platform threads to Agor sessions for gateway routing.
 */

import type {
  GatewayChannelID,
  GatewayInboundEventID,
  SessionID,
  TaskID,
  ThreadSessionMap,
  ThreadSessionMapID,
  ThreadStatus,
  UUID,
} from '@agor/core/types';
import { prefixToLikePattern } from '@agor/core/types';
import { and, eq, isNull, like, lt } from 'drizzle-orm';
import { generateId } from '../../lib/ids';
import { compareDiscordSnowflakes, isDiscordSnowflake } from '../../types/gateway';
import type { Database } from '../client';
import {
  deleteFrom,
  insert,
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

function isSqliteBusy(error: unknown): boolean {
  return (
    String(error).includes('SQLITE_BUSY') ||
    String(error).toLowerCase().includes('database is locked')
  );
}

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
      discord_last_admitted_message_id: row.discord_last_admitted_message_id ?? null,
      teams_last_admitted_activity_id: row.teams_last_admitted_activity_id ?? null,
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
      discord_last_admitted_message_id: data.discord_last_admitted_message_id ?? null,
      teams_last_admitted_activity_id: data.teams_last_admitted_activity_id ?? null,
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
          discord_last_admitted_message_id: insertData.discord_last_admitted_message_id,
          teams_last_admitted_activity_id: insertData.teams_last_admitted_activity_id,
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

  /**
   * Advance the canonical Discord message ID only after Task admission.
   * The row lock makes retries and concurrent listener owners monotonic; a
   * lower/equal Snowflake is a harmless no-op.
   */
  async advanceDiscordLastAdmittedMessageId(
    id: ThreadSessionMapID,
    cursor: string
  ): Promise<boolean> {
    if (!isDiscordSnowflake(cursor)) {
      throw new RepositoryError('Invalid Discord message ID');
    }

    return runDatabaseTransaction(
      this.db,
      async (txDb) => {
        await lockRowForUpdate(txDb, this.db, threadSessionMap, eq(threadSessionMap.id, id));
        const row = await select(txDb)
          .from(threadSessionMap)
          .where(eq(threadSessionMap.id, id))
          .one();
        if (!row) throw new EntityNotFoundError('ThreadSessionMap', id);
        const previous = row.discord_last_admitted_message_id;
        if (previous && compareDiscordSnowflakes(cursor, previous) <= 0) return false;
        await update(txDb, threadSessionMap)
          .set({ discord_last_admitted_message_id: cursor })
          .where(eq(threadSessionMap.id, id))
          .run();
        return true;
      },
      { sqliteImmediate: true }
    );
  }

  /** Advance the Teams activity cursor only after deterministic Task admission. */
  async advanceTeamsLastAdmittedActivityId(
    id: ThreadSessionMapID,
    cursor: string,
    expectedPreviousCursor?: string | null
  ): Promise<boolean> {
    if (!cursor.trim()) throw new RepositoryError('Invalid Teams activity ID');
    return runDatabaseTransaction(
      this.db,
      async (txDb) => {
        await lockRowForUpdate(txDb, this.db, threadSessionMap, eq(threadSessionMap.id, id));
        const row = await select(txDb)
          .from(threadSessionMap)
          .where(eq(threadSessionMap.id, id))
          .one();
        if (!row) throw new EntityNotFoundError('ThreadSessionMap', id);
        const previous = row.teams_last_admitted_activity_id;
        if (previous === cursor) return false;
        const result = await update(txDb, threadSessionMap)
          .set({ teams_last_admitted_activity_id: cursor })
          .where(
            expectedPreviousCursor === undefined
              ? eq(threadSessionMap.id, id)
              : and(
                  eq(threadSessionMap.id, id),
                  expectedPreviousCursor === null
                    ? isNull(threadSessionMap.teams_last_admitted_activity_id)
                    : eq(threadSessionMap.teams_last_admitted_activity_id, expectedPreviousCursor)
                )
          )
          .run();
        if (result.rowsAffected < 1) return false;
        const updated = await select(txDb, {
          cursor: threadSessionMap.teams_last_admitted_activity_id,
        })
          .from(threadSessionMap)
          .where(eq(threadSessionMap.id, id))
          .one();
        return updated?.cursor === cursor;
      },
      { sqliteImmediate: true }
    );
  }

  /** Merge metadata under a short row lock without overwriting concurrent fields. */
  async mergeMetadata(
    id: ThreadSessionMapID,
    patch: Record<string, unknown>
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
        const updated = await update(txDb, threadSessionMap)
          .set({ metadata: { ...((row.metadata as Record<string, unknown>) ?? {}), ...patch } })
          .where(eq(threadSessionMap.id, id))
          .returning()
          .one();
        return this.rowToMapping(updated);
      },
      { sqliteImmediate: true }
    );
  }

  /** Atomically complete the initial prompt for the event that owns the seed. */
  async completeSeedInitialPrompt(
    id: ThreadSessionMapID,
    eventId: GatewayInboundEventID | undefined,
    taskId: TaskID
  ): Promise<boolean> {
    return runDatabaseTransaction(
      this.db,
      async (txDb) => {
        await lockRowForUpdate(txDb, this.db, threadSessionMap, eq(threadSessionMap.id, id));
        const row = await select(txDb)
          .from(threadSessionMap)
          .where(eq(threadSessionMap.id, id))
          .one();
        if (!row) throw new EntityNotFoundError('ThreadSessionMap', id);

        const current = (row.metadata as Record<string, unknown> | null) ?? {};
        if (current.outbound_seed_initial_prompt_pending !== true) return false;

        const storedEventId = current.outbound_seed_initial_event_id;
        const eventMatches =
          (storedEventId === undefined && eventId === undefined) ||
          (typeof storedEventId === 'string' &&
            storedEventId.length > 0 &&
            typeof eventId === 'string' &&
            eventId.length > 0 &&
            storedEventId === eventId);
        if (!eventMatches) return false;

        await update(txDb, threadSessionMap)
          .set({
            metadata: {
              ...current,
              outbound_seed_initial_prompt_pending: false,
              outbound_seed_initial_task_id: taskId,
            },
          })
          .where(eq(threadSessionMap.id, id))
          .run();
        return true;
      },
      { sqliteImmediate: true }
    );
  }

  /** Atomically merge provider reply aliases so concurrent chunks cannot lose one another. */
  async mergeGatewayReplyAliases(
    id: ThreadSessionMapID,
    aliasesToAdd: string[]
  ): Promise<ThreadSessionMap> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        return await runDatabaseTransaction(
          this.db,
          async (txDb) => {
            await lockRowForUpdate(txDb, this.db, threadSessionMap, eq(threadSessionMap.id, id));
            const row = await select(txDb)
              .from(threadSessionMap)
              .where(eq(threadSessionMap.id, id))
              .one();
            if (!row) throw new EntityNotFoundError('ThreadSessionMap', id);
            const current = (row.metadata as Record<string, unknown> | null) ?? {};
            const previous = Array.isArray(current.gateway_reply_aliases)
              ? current.gateway_reply_aliases.filter(
                  (alias): alias is string => typeof alias === 'string'
                )
              : [];
            const aliases = aliasesToAdd.filter(
              (alias): alias is string => typeof alias === 'string' && alias.length > 0
            );
            // Every provider reply alias is a durable inbound identity. Evicting
            // old aliases makes replies to earlier emitted chunks create a new
            // session, so retain the complete live set and deduplicate only.
            const mergedAliases = [...new Set([...previous, ...aliases])];
            const updated = await update(txDb, threadSessionMap)
              .set({
                metadata: {
                  ...current,
                  ...(mergedAliases.length > 0 ? { gateway_reply_aliases: mergedAliases } : {}),
                },
              })
              .where(eq(threadSessionMap.id, id))
              .returning()
              .one();
            return this.rowToMapping(updated);
          },
          { sqliteImmediate: true }
        );
      } catch (error) {
        if (isSqliteBusy(error) && attempt < 4) {
          await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
          continue;
        }
        throw error;
      }
    }
    throw new RepositoryError('Failed to merge gateway reply aliases after lock retries');
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
