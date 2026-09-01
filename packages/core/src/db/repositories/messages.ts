/**
 * Messages Repository
 *
 * CRUD operations for conversation messages.
 * Supports transcript queries by session and task.
 */

import type { Message, MessageCreate, MessageID, SessionID, TaskID, UUID } from '@agor/core/types';
import { and, asc, desc, eq, gt, gte, inArray, lte, type SQL, sql } from 'drizzle-orm';
import { generateId } from '../../lib/ids';
import { isCanonicalFullUuid } from '../../types/id';
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
  select?: readonly (keyof Message)[];
  limit?: number;
  skip?: number;
};

/** Optional hook executed after a Message insert and before its transaction commits. */
export type MessageCreateTransactionHook = (db: Database, message: Message) => Promise<void>;

export class MessageParentIntegrityError extends Error {
  constructor(
    readonly reason: 'session_tenant_mismatch' | 'task_session_mismatch',
    message: string
  ) {
    super(message);
    this.name = 'MessageParentIntegrityError';
  }
}

export class MessageIdentifierIntegrityError extends Error {
  constructor(readonly field: 'message_id' | 'session_id' | 'task_id') {
    super(`${field} must be a canonical full UUID`);
    this.name = 'MessageIdentifierIntegrityError';
  }
}

function omittedMessageData(reason: JsonSanitizationError['category']): MessageInsert['data'] {
  return {
    content: MESSAGE_CONTENT_OMITTED,
    metadata: { persistence_omission: { reason } },
  };
}

export class MessagesRepository {
  constructor(
    private db: Database,
    private readonly onCreateInTransaction?: MessageCreateTransactionHook
  ) {}

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

  /** Decode only fields selected by the SQL projection. */
  private projectedRowToMessage(
    row: Partial<MessageRow>,
    fields: readonly (keyof Message)[]
  ): Partial<Message> {
    const message: Partial<Message> = {};
    const data = row.data as
      | {
          content?: Message['content'];
          tool_uses?: Message['tool_uses'];
          metadata?: Message['metadata'];
        }
      | undefined;
    for (const field of fields) {
      switch (field) {
        case 'message_id':
          if (row.message_id !== undefined) message.message_id = row.message_id as MessageID;
          break;
        case 'session_id':
          if (row.session_id !== undefined) message.session_id = row.session_id as SessionID;
          break;
        case 'task_id':
          message.task_id = row.task_id ? (row.task_id as TaskID) : undefined;
          break;
        case 'type':
          if (row.type !== undefined) message.type = row.type;
          break;
        case 'role':
          if (row.role !== undefined) message.role = row.role as Message['role'];
          break;
        case 'index':
          if (row.index !== undefined) message.index = row.index;
          break;
        case 'timestamp':
          if (row.timestamp !== undefined)
            message.timestamp = new Date(row.timestamp).toISOString();
          break;
        case 'content_preview':
          message.content_preview = row.content_preview || '';
          break;
        case 'content':
          if (data && 'content' in data) message.content = data.content;
          break;
        case 'tool_uses':
          message.tool_uses = data?.tool_uses;
          break;
        case 'parent_tool_use_id':
          message.parent_tool_use_id = row.parent_tool_use_id || undefined;
          break;
        case 'metadata':
          message.metadata = data?.metadata;
          break;
      }
    }
    return message;
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
  async create(input: MessageCreate): Promise<Message> {
    const message: Message = {
      ...input,
      message_id: input.message_id ?? (generateId() as MessageID),
    };
    if (!isCanonicalFullUuid(message.message_id)) {
      throw new MessageIdentifierIntegrityError('message_id');
    }
    if (!isCanonicalFullUuid(message.session_id)) {
      throw new MessageIdentifierIntegrityError('session_id');
    }
    if (message.task_id && !isCanonicalFullUuid(message.task_id)) {
      throw new MessageIdentifierIntegrityError('task_id');
    }
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
          const created = this.rowToMessage(inserted);
          if (this.onCreateInTransaction) await this.onCreateInTransaction(tx, created);
          return created;
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
  async findPage(
    opts: MessageFindPageOptions = {}
  ): Promise<{ data: Partial<Message>[]; total: number }> {
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

    const selectedFields = opts.select?.length ? opts.select : undefined;
    const physicalColumns = {
      message_id: messages.message_id,
      session_id: messages.session_id,
      task_id: messages.task_id,
      type: messages.type,
      role: messages.role,
      index: messages.index,
      timestamp: messages.timestamp,
      content_preview: messages.content_preview,
      parent_tool_use_id: messages.parent_tool_use_id,
    } as const;
    const projection: Record<string, unknown> | undefined = selectedFields ? {} : undefined;
    for (const field of selectedFields ?? []) {
      if (field === 'content' || field === 'tool_uses' || field === 'metadata') {
        if (projection) projection.data = messages.data;
        continue;
      }
      const column = physicalColumns[field as keyof typeof physicalColumns];
      if (projection && column) projection[field] = column;
    }

    let dataQuery = select(this.db, projection).from(messages);
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
    return {
      data: selectedFields
        ? rows.map((row: unknown) =>
            this.projectedRowToMessage(row as Partial<MessageRow>, selectedFields)
          )
        : rows.map((row: unknown) => this.rowToMessage(row as MessageRow)),
      total,
    };
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
      .where(
        and(
          eq(messages.session_id, sessionId),
          gte(messages.index, startIndex),
          lte(messages.index, endIndex)
        )
      )
      .orderBy(messages.index)
      .all();

    return rows.map((r: MessageRow) => this.rowToMessage(r));
  }

  /**
   * Update message (used by FeathersJS service adapter)
   */
  async update(messageId: string, updates: Partial<Message>): Promise<Message> {
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
            task_id: existing.task_id,
            index: existing.index,
            timestamp: existing.timestamp,
            type: existing.type,
            role: existing.role,
          };
          const row = this.messageToRow(updated);
          const { created_at: _createdAt, ...mutableRow } = row;

          const result = await update(tx, messages)
            .set(mutableRow)
            .where(eq(messages.message_id, messageId))
            .returning()
            .one();
          if (result) return this.rowToMessage(result);
          throw new Error(`Message ${messageId} could not be updated`);
        },
        { sqliteImmediate: true }
      )
    );
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
