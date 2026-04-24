/**
 * Messages Repository
 *
 * CRUD operations for conversation messages.
 * Supports bulk inserts for session loading and queries by session/task.
 */

import type { Message, MessageID, SessionID, TaskID, UUID } from '@agor/core/types';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../client';
import { deleteFrom, insert, select, update } from '../database-wrapper';
import { type MessageInsert, type MessageRow, messages } from '../schema';

export class MessagesRepository {
  constructor(private db: Database) {}

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
    return {
      message_id: message.message_id,
      created_at: new Date(),
      session_id: message.session_id,
      task_id: message.task_id,
      type: message.type,
      role: message.role,
      index: message.index,
      timestamp: new Date(message.timestamp),
      content_preview: message.content_preview,
      parent_tool_use_id: message.parent_tool_use_id || null,
      data: {
        content: message.content,
        tool_uses: message.tool_uses,
        metadata: message.metadata,
      },
    };
  }

  /**
   * Create a single message
   */
  async create(message: Message): Promise<Message> {
    const row = this.messageToRow(message);
    const inserted = await insert(this.db, messages).values(row).returning().one();
    return this.rowToMessage(inserted);
  }

  /**
   * Bulk insert messages (optimized for session loading)
   */
  async createMany(messageList: Message[]): Promise<Message[]> {
    const rows = messageList.map((m) => this.messageToRow(m));
    const inserted = await insert(this.db, messages).values(rows).returning().all();
    return inserted.map((r: MessageRow) => this.rowToMessage(r));
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
   * Get all messages (used by FeathersJS service adapter)
   */
  async findAll(): Promise<Message[]> {
    const rows = await select(this.db).from(messages).orderBy(messages.index).all();
    return rows.map((r: MessageRow) => this.rowToMessage(r));
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
    const existing = await this.findById(messageId as MessageID);
    if (!existing) {
      throw new Error(`Message ${messageId} not found`);
    }

    // Merge updates with existing message
    const updated = { ...existing, ...updates };
    const row = this.messageToRow(updated);

    const result = await update(this.db, messages)
      .set(row)
      .where(eq(messages.message_id, messageId))
      .returning()
      .one();

    return this.rowToMessage(result);
  }

  /**
   * Update message task assignment
   */
  async assignToTask(messageId: MessageID, taskId: TaskID): Promise<Message> {
    const updated = await update(this.db, messages)
      .set({ task_id: taskId })
      .where(eq(messages.message_id, messageId))
      .returning()
      .one();

    return this.rowToMessage(updated);
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
