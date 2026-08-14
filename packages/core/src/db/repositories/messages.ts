/**
 * Messages Repository
 *
 * CRUD operations for conversation messages.
 * Supports bulk inserts for session loading and queries by session/task.
 */

import type { Message, MessageID, SessionID, TaskID, UUID } from '@agor/core/types';
import {
  and,
  asc,
  desc,
  eq,
  exists,
  gt,
  inArray,
  isNull,
  lte,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import { JsonSanitizationError, sanitizeJsonValue } from '../../utils/sanitize-json';
import type { Database } from '../client';
import {
  deleteFrom,
  insert,
  isSQLiteDatabase,
  lockRowForUpdate,
  runDatabaseTransaction,
  select,
  update,
} from '../database-wrapper';
import { type MessageInsert, type MessageRow, messages, sessions, tasks } from '../schema';
import { visibleSessionReferenceAccessExists } from './branch-access';

export const MESSAGE_CONTENT_OMITTED =
  '[Message content omitted: payload could not be safely persisted]';

export type MessageFindPageOptions = {
  messageId?: MessageID;
  afterMessageId?: MessageID;
  throughMessageId?: MessageID;
  sessionId?: SessionID;
  sessionIds?: SessionID[];
  taskId?: TaskID;
  type?: Message['type'];
  role?: Message['role'];
  visibleToUserId?: UUID;
  sort?: Record<string, 1 | -1>;
  limit?: number;
  skip?: number;
};

export class MessageParentIntegrityError extends Error {
  constructor(
    readonly reason: 'session_tenant_mismatch' | 'task_session_mismatch' | 'task_already_assigned',
    message: string
  ) {
    super(message);
    this.name = 'MessageParentIntegrityError';
  }
}

/** @deprecated Use MessageParentIntegrityError; retained for internal API compatibility. */
export { MessageParentIntegrityError as MessageTaskIntegrityError };

function omittedMessageData(reason: JsonSanitizationError['category']): MessageInsert['data'] {
  return {
    content: MESSAGE_CONTENT_OMITTED,
    metadata: { persistence_omission: { reason } },
  };
}

export class MessagesRepository {
  constructor(private db: Database) {}

  /** Retry a whole locked metadata mutation so SQLite re-reads after contention. */
  private async runMetadataMutation<T>(mutation: () => Promise<T>, attempt = 0): Promise<T> {
    try {
      return await mutation();
    } catch (error) {
      const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      if (
        isSQLiteDatabase(this.db) &&
        attempt < 4 &&
        /SQLITE_BUSY|database is locked|database is busy/i.test(text)
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
        return this.runMetadataMutation(mutation, attempt + 1);
      }
      throw error;
    }
  }

  /**
   * Convert database row to Message type
   */
  private rowToMessage(row: MessageRow): Message {
    return {
      message_id: row.message_id as UUID,
      session_id: row.session_id as UUID,
      task_id: row.task_id ? (row.task_id as UUID) : undefined,
      type: row.type,
      role: row.role as Message['role'],
      index: row.index,
      timestamp: new Date(row.timestamp).toISOString(),
      content_preview: row.content_preview || '',
      content: (row.data as { content: Message['content'] }).content,
      tool_uses: (row.data as { tool_uses?: Message['tool_uses'] }).tool_uses,
      parent_tool_use_id: row.parent_tool_use_id || undefined,
      metadata: (row.data as { metadata?: Message['metadata'] }).metadata,
    };
  }

  /**
   * Convert Message to database row
   */
  private messageToRow(message: Message): MessageInsert {
    let contentPreview: string;
    let data: MessageInsert['data'];
    try {
      contentPreview = sanitizeJsonValue(message.content_preview);
      data = sanitizeJsonValue({
        content: message.content,
        tool_uses: message.tool_uses,
        metadata: message.metadata,
      });
    } catch (error) {
      if (!(error instanceof JsonSanitizationError)) throw error;
      console.warn(
        `[messages.persistence] content omitted category=${error.category} message_id=${message.message_id}`
      );
      contentPreview = MESSAGE_CONTENT_OMITTED;
      data = omittedMessageData(error.category);
    }
    return {
      message_id: message.message_id,
      created_at: new Date(),
      session_id: message.session_id,
      task_id: message.task_id,
      type: message.type,
      role: message.role,
      index: message.index,
      timestamp: new Date(message.timestamp),
      content_preview: contentPreview,
      parent_tool_use_id: message.parent_tool_use_id || null,
      data,
    };
  }

  private async assertTaskBelongsToSession(
    db: Database,
    taskId: TaskID,
    sessionId: SessionID
  ): Promise<void> {
    await lockRowForUpdate(db, this.db, tasks, eq(tasks.task_id, taskId));
    const target = await select(db, { session_id: tasks.session_id })
      .from(tasks)
      .where(eq(tasks.task_id, taskId))
      .one();
    if (!target || target.session_id !== sessionId) {
      throw new MessageParentIntegrityError(
        'task_session_mismatch',
        'task_id must belong to the Message Session'
      );
    }
  }

  /**
   * Messages derive tenant ownership from their Session. PostgreSQL's legacy
   * FK references only the globally unique session_id, so an RLS-visible
   * parent lookup is the repository-level tenant fence for every create.
   * Locking the parent keeps validation and insertion atomic with deletion.
   */
  private async assertSessionBelongsToTenant(db: Database, sessionId: SessionID): Promise<void> {
    await lockRowForUpdate(db, this.db, sessions, eq(sessions.session_id, sessionId));
    const parent = await select(db, { session_id: sessions.session_id })
      .from(sessions)
      .where(eq(sessions.session_id, sessionId))
      .one();
    if (!parent) {
      throw new MessageParentIntegrityError(
        'session_tenant_mismatch',
        'session_id must belong to the current tenant'
      );
    }
  }

  /**
   * Create a single message
   */
  async create(message: Message): Promise<Message> {
    const row = this.messageToRow(message);
    return this.runMetadataMutation(() =>
      runDatabaseTransaction(
        this.db,
        async (tx) => {
          await this.assertSessionBelongsToTenant(tx, message.session_id);
          if (message.task_id) {
            await this.assertTaskBelongsToSession(tx, message.task_id, message.session_id);
          }
          const inserted = await insert(tx, messages).values(row).returning().one();
          return this.rowToMessage(inserted);
        },
        { sqliteImmediate: true }
      )
    );
  }

  /**
   * Bulk insert messages (optimized for session loading)
   */
  async createMany(messageList: Message[]): Promise<Message[]> {
    const rows = messageList.map((m) => this.messageToRow(m));
    const sessionIds = new Set<SessionID>();
    const taskLinks = new Map<string, SessionID>();
    for (const message of messageList) {
      sessionIds.add(message.session_id);
      if (!message.task_id) continue;
      const previousSessionId = taskLinks.get(message.task_id);
      if (previousSessionId && previousSessionId !== message.session_id) {
        throw new MessageParentIntegrityError(
          'task_session_mismatch',
          'task_id must belong to the Message Session'
        );
      }
      taskLinks.set(message.task_id, message.session_id);
    }

    return this.runMetadataMutation(() =>
      runDatabaseTransaction(
        this.db,
        async (tx) => {
          for (const sessionId of [...sessionIds].sort()) {
            await this.assertSessionBelongsToTenant(tx, sessionId);
          }
          // A deterministic lock order prevents two import batches from
          // deadlocking when they reference the same Tasks in opposite order.
          for (const [taskId, sessionId] of [...taskLinks].sort(([a], [b]) => a.localeCompare(b))) {
            await this.assertTaskBelongsToSession(tx, taskId as TaskID, sessionId);
          }
          const inserted = await insert(tx, messages).values(rows).returning().all();
          return inserted.map((row: MessageRow) => this.rowToMessage(row));
        },
        { sqliteImmediate: true }
      )
    );
  }

  /**
   * Get message by ID
   */
  async findById(messageId: MessageID): Promise<Message | null> {
    const row = await select(this.db)
      .from(messages)
      .where(eq(messages.message_id, messageId))
      .one();

    return row ? this.rowToMessage(row) : null;
  }

  /**
   * Atomically transform one Message's metadata under a short row lock.
   *
   * The callback is deliberately synchronous: callers may decide a durable
   * state transition while holding the lock, but cannot accidentally perform
   * network/process work inside the transaction. Returning `null` leaves the
   * row unchanged and returns the latest locked value to the caller.
   */
  async mutateMetadataLocked(
    messageId: MessageID,
    mutation: (metadata: Message['metadata'], message: Message) => Message['metadata'] | null
  ): Promise<{ changed: boolean; message: Message }> {
    return this.runMetadataMutation(() =>
      runDatabaseTransaction(
        this.db,
        async (txDb) => {
          await lockRowForUpdate(txDb, this.db, messages, eq(messages.message_id, messageId));
          const row = await select(txDb)
            .from(messages)
            .where(eq(messages.message_id, messageId))
            .one();
          if (!row) throw new Error(`Message ${messageId} not found`);

          const current = this.rowToMessage(row);
          const metadata = mutation(current.metadata, current);
          if (metadata === null) return { changed: false, message: current };

          const data = row.data as {
            content: Message['content'];
            tool_uses?: Message['tool_uses'];
            metadata?: Message['metadata'];
          };
          let sanitizedData: MessageInsert['data'];
          try {
            sanitizedData = sanitizeJsonValue({ ...data, metadata });
          } catch (error) {
            if (!(error instanceof JsonSanitizationError)) throw error;
            console.warn(
              `[messages.persistence] content omitted category=${error.category} message_id=${messageId}`
            );
            sanitizedData = omittedMessageData(error.category);
          }
          const updatedRow = await update(txDb, messages)
            .set({ data: sanitizedData })
            .where(eq(messages.message_id, messageId))
            .returning()
            .one();
          return { changed: true, message: this.rowToMessage(updatedRow) };
        },
        { sqliteImmediate: true }
      )
    );
  }

  /**
   * Get all messages (used by FeathersJS service adapter)
   */
  async findAll(filter?: {
    sessionId?: SessionID;
    sessionIds?: SessionID[];
    taskId?: TaskID;
    type?: Message['type'];
    role?: Message['role'];
    visibleToUserId?: UUID;
  }): Promise<Message[]> {
    if (filter?.sessionIds !== undefined && filter.sessionIds.length === 0) return [];

    const conditions = [];
    if (filter?.sessionId) conditions.push(eq(messages.session_id, filter.sessionId));
    if (filter?.sessionIds !== undefined)
      conditions.push(inArray(messages.session_id, filter.sessionIds));
    if (filter?.taskId) conditions.push(eq(messages.task_id, filter.taskId));
    if (filter?.type) conditions.push(eq(messages.type, filter.type));
    if (filter?.role) conditions.push(eq(messages.role, filter.role));
    if (filter?.visibleToUserId) {
      conditions.push(
        visibleSessionReferenceAccessExists(this.db, filter.visibleToUserId, messages.session_id)
      );
    }

    let query = select(this.db).from(messages);
    if (conditions.length > 0) query = query.where(and(...conditions));
    const rows = await query.orderBy(messages.index).all();
    return rows.map((r: MessageRow) => this.rowToMessage(r));
  }

  /**
   * Find one exact SQL page. The same predicate is applied to the count and
   * data queries so Feathers pagination never counts rows that the page cannot
   * return, and only the requested page's JSON rows are hydrated.
   */
  async findPage(opts: MessageFindPageOptions = {}): Promise<{ data: Message[]; total: number }> {
    if (opts.sessionIds?.length === 0) return { data: [], total: 0 };

    const conditions: SQL[] = [];
    if (opts.messageId) conditions.push(eq(messages.message_id, opts.messageId));
    if (opts.afterMessageId) conditions.push(gt(messages.message_id, opts.afterMessageId));
    if (opts.throughMessageId) conditions.push(lte(messages.message_id, opts.throughMessageId));
    if (opts.sessionId) conditions.push(eq(messages.session_id, opts.sessionId));
    if (opts.sessionIds) conditions.push(inArray(messages.session_id, opts.sessionIds));
    if (opts.taskId) conditions.push(eq(messages.task_id, opts.taskId));
    if (opts.type) conditions.push(eq(messages.type, opts.type));
    if (opts.role) conditions.push(eq(messages.role, opts.role));
    if (opts.visibleToUserId) {
      conditions.push(
        visibleSessionReferenceAccessExists(this.db, opts.visibleToUserId, messages.session_id)
      );
    }
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    let countQuery = select(this.db, { count: sql<number>`count(*)` }).from(messages);
    if (whereClause) countQuery = countQuery.where(whereClause);
    const countRow = await countQuery.one();
    const total = Number(countRow?.count ?? 0);

    let dataQuery = select(this.db).from(messages);
    if (whereClause) dataQuery = dataQuery.where(whereClause);

    const sortColumns = {
      message_id: messages.message_id,
      session_id: messages.session_id,
      type: messages.type,
      role: messages.role,
      index: messages.index,
      timestamp: messages.timestamp,
      created_at: messages.created_at,
    } as const;
    const orderBy = Object.entries(opts.sort ?? {})
      .map(([field, direction]) => {
        const column = sortColumns[field as keyof typeof sortColumns];
        return column ? (direction === -1 ? desc(column) : asc(column)) : undefined;
      })
      .filter((expression): expression is SQL => expression !== undefined);
    if (orderBy.length === 0) orderBy.push(asc(messages.index));
    if (!Object.hasOwn(opts.sort ?? {}, 'message_id')) orderBy.push(asc(messages.message_id));
    dataQuery = dataQuery.orderBy(...orderBy);
    if (opts.limit !== undefined) dataQuery = dataQuery.limit(opts.limit);
    if (opts.skip) dataQuery = dataQuery.offset(opts.skip);

    const rows = await dataQuery.all();
    return { data: rows.map((row: MessageRow) => this.rowToMessage(row)), total };
  }

  /**
   * Get all messages for a session (ordered by index)
   */
  async findBySessionId(sessionId: SessionID): Promise<Message[]> {
    const rows = await select(this.db)
      .from(messages)
      .where(eq(messages.session_id, sessionId))
      .orderBy(messages.index)
      .all();

    return rows.map((r: MessageRow) => this.rowToMessage(r));
  }

  /**
   * Get all messages for a session filtered by type (ordered by index)
   */
  async findBySessionIdAndType(sessionId: SessionID, type: Message['type']): Promise<Message[]> {
    const rows = await select(this.db)
      .from(messages)
      .where(and(eq(messages.session_id, sessionId), eq(messages.type, type)))
      .orderBy(messages.index)
      .all();

    return rows.map((r: MessageRow) => this.rowToMessage(r));
  }

  /**
   * Get all messages for a task (ordered by index)
   */
  async findByTaskId(taskId: TaskID): Promise<Message[]> {
    const rows = await select(this.db)
      .from(messages)
      .where(eq(messages.task_id, taskId))
      .orderBy(messages.index)
      .all();

    return rows.map((r: MessageRow) => this.rowToMessage(r));
  }

  /**
   * Get messages in a range for a session
   * Used for task message_range queries
   */
  async findByRange(
    sessionId: SessionID,
    startIndex: number,
    endIndex: number
  ): Promise<Message[]> {
    const rows = await select(this.db)
      .from(messages)
      .where(eq(messages.session_id, sessionId))
      .orderBy(messages.index)
      .all();

    // Filter by range in memory (simpler than complex SQL)
    return rows
      .filter((r: MessageRow) => r.index >= startIndex && r.index <= endIndex)
      .map((r: MessageRow) => this.rowToMessage(r));
  }

  /**
   * Update message (used by FeathersJS service adapter)
   */
  async update(messageId: string, updates: Partial<Message>): Promise<Message> {
    const hasTaskAssignment = Object.hasOwn(updates, 'task_id');
    if (hasTaskAssignment && typeof updates.task_id !== 'string') {
      throw new MessageParentIntegrityError(
        'task_already_assigned',
        'Message task_id cannot be cleared'
      );
    }

    return this.runMetadataMutation(() =>
      runDatabaseTransaction(
        this.db,
        async (tx) => {
          // PATCH reconstructs the JSON data column from the current logical
          // Message. Lock before reading it so concurrent patches to distinct
          // mutable fields cannot overwrite one another with stale data.
          await lockRowForUpdate(tx, this.db, messages, eq(messages.message_id, messageId));
          const existingRow = await select(tx)
            .from(messages)
            .where(eq(messages.message_id, messageId))
            .one();
          if (!existingRow) throw new Error(`Message ${messageId} not found`);
          const existing = this.rowToMessage(existingRow);

          // Identity, Session membership, transcript ordering, and semantic
          // kind are immutable at the repository boundary.
          const updated = {
            ...existing,
            ...updates,
            message_id: existing.message_id,
            session_id: existing.session_id,
            index: existing.index,
            timestamp: existing.timestamp,
            type: existing.type,
            role: existing.role,
          };
          const row = this.messageToRow(updated);
          const { created_at: _createdAt, ...mutableRow } = row;

          const conditions: SQL[] = [eq(messages.message_id, messageId)];
          if (hasTaskAssignment && updates.task_id) {
            const targetTaskId = updates.task_id;
            const matchingTaskInMessageSession = exists(
              // Correlate the target Task to the Message row in the UPDATE so
              // the same-Session check and one-time assignment are one write.
              // biome-ignore lint/suspicious/noExplicitAny: Cross-dialect Drizzle subquery typing.
              (tx as any)
                .select({ _: sql`1` })
                .from(tasks)
                .where(
                  and(eq(tasks.task_id, targetTaskId), eq(tasks.session_id, messages.session_id))
                )
            );
            conditions.push(
              matchingTaskInMessageSession,
              or(isNull(messages.task_id), eq(messages.task_id, targetTaskId)) as SQL
            );
          }

          const returned = await update(tx, messages)
            .set(mutableRow)
            .where(and(...conditions))
            .returning()
            .all();
          const result = returned[0];
          if (result) return this.rowToMessage(result);

          const currentRow = await select(tx)
            .from(messages)
            .where(eq(messages.message_id, messageId))
            .one();
          if (!currentRow) throw new Error(`Message ${messageId} not found`);
          const current = this.rowToMessage(currentRow);
          if (
            hasTaskAssignment &&
            updates.task_id &&
            current.task_id &&
            current.task_id !== updates.task_id
          ) {
            throw new MessageParentIntegrityError(
              'task_already_assigned',
              'Message task_id cannot be reassigned'
            );
          }
          if (hasTaskAssignment && updates.task_id) {
            throw new MessageParentIntegrityError(
              'task_session_mismatch',
              'task_id must belong to the Message Session'
            );
          }
          throw new Error(`Message ${messageId} could not be updated`);
        },
        { sqliteImmediate: true }
      )
    );
  }

  /**
   * Update message task assignment
   */
  async assignToTask(messageId: MessageID, taskId: TaskID): Promise<Message> {
    return this.update(messageId, { task_id: taskId });
  }

  /**
   * Delete all messages for a session (cascades automatically via FK)
   */
  async deleteBySessionId(sessionId: SessionID): Promise<void> {
    await deleteFrom(this.db, messages).where(eq(messages.session_id, sessionId)).run();
  }

  /**
   * Delete a single message
   */
  async delete(messageId: MessageID): Promise<void> {
    await deleteFrom(this.db, messages).where(eq(messages.message_id, messageId)).run();
  }
}
