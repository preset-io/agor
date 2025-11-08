/**
 * Messages Repository
 *
 * CRUD operations for conversation messages.
 * Supports bulk inserts for session loading and queries by session/task.
 */

import type { Message, MessageID, SessionID, TaskID, UUID } from '@agor/core/types';
import { eq } from 'drizzle-orm';
import type { Database } from '../client';
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
      status: row.status as Message['status'],
      queue_position: row.queue_position ?? undefined,
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
      status: message.status || null,
      queue_position: message.queue_position ?? null,
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
    const [inserted] = await this.db.insert(messages).values(row).returning();
    return this.rowToMessage(inserted);
  }

  /**
   * Bulk insert messages (optimized for session loading)
   */
  async createMany(messageList: Message[]): Promise<Message[]> {
    const rows = messageList.map(m => this.messageToRow(m));
    const inserted = await this.db.insert(messages).values(rows).returning();
    return inserted.map(r => this.rowToMessage(r));
  }

  /**
   * Get message by ID
   */
  async findById(messageId: MessageID): Promise<Message | null> {
    const rows = await this.db
      .select()
      .from(messages)
      .where(eq(messages.message_id, messageId))
      .limit(1);

    return rows[0] ? this.rowToMessage(rows[0]) : null;
  }

  /**
   * Get all messages (used by FeathersJS service adapter)
   */
  async findAll(): Promise<Message[]> {
    const rows = await this.db.select().from(messages).orderBy(messages.index);
    return rows.map(r => this.rowToMessage(r));
  }

  /**
   * Get all messages for a session (ordered by index)
   */
  async findBySessionId(sessionId: SessionID): Promise<Message[]> {
    const rows = await this.db
      .select()
      .from(messages)
      .where(eq(messages.session_id, sessionId))
      .orderBy(messages.index);

    return rows.map(r => this.rowToMessage(r));
  }

  /**
   * Get all messages for a task (ordered by index)
   */
  async findByTaskId(taskId: TaskID): Promise<Message[]> {
    const rows = await this.db
      .select()
      .from(messages)
      .where(eq(messages.task_id, taskId))
      .orderBy(messages.index);

    return rows.map(r => this.rowToMessage(r));
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
    const rows = await this.db
      .select()
      .from(messages)
      .where(eq(messages.session_id, sessionId))
      .orderBy(messages.index);

    // Filter by range in memory (simpler than complex SQL)
    return rows
      .filter(r => r.index >= startIndex && r.index <= endIndex)
      .map(r => this.rowToMessage(r));
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

    const [result] = await this.db
      .update(messages)
      .set(row)
      .where(eq(messages.message_id, messageId))
      .returning();

    return this.rowToMessage(result);
  }

  /**
   * Update message task assignment
   */
  async assignToTask(messageId: MessageID, taskId: TaskID): Promise<Message> {
    const [updated] = await this.db
      .update(messages)
      .set({ task_id: taskId })
      .where(eq(messages.message_id, messageId))
      .returning();

    return this.rowToMessage(updated);
  }

  /**
   * Delete all messages for a session (cascades automatically via FK)
   */
  async deleteBySessionId(sessionId: SessionID): Promise<void> {
    await this.db.delete(messages).where(eq(messages.session_id, sessionId));
  }

  /**
   * Delete a single message
   */
  async delete(messageId: MessageID): Promise<void> {
    await this.db.delete(messages).where(eq(messages.message_id, messageId));
  }

  /**
   * Create a queued message
   * NOTE: Queued messages always store prompt as string content
   * This ensures compatibility with prompt execution endpoint
   */
  async createQueued(sessionId: SessionID, prompt: string): Promise<Message> {
    if (!prompt || typeof prompt !== 'string') {
      throw new Error('Prompt must be a non-empty string');
    }

    const { generateId } = await import('../../lib/ids');
    const { max, and, asc } = await import('drizzle-orm');

    // Get current max queue position for session
    const result = await this.db
      .select({ max: max(messages.queue_position) })
      .from(messages)
      .where(and(eq(messages.session_id, sessionId), eq(messages.status, 'queued')));

    const nextPosition = (result[0]?.max || 0) + 1;

    // Create queued message
    const message: Message = {
      message_id: generateId() as MessageID,
      session_id: sessionId,
      type: 'user',
      role: 'user' as Message['role'],
      index: -1, // Not in conversation yet
      timestamp: new Date().toISOString(),
      content_preview: prompt.substring(0, 200),
      content: prompt, // Always string for queued messages
      status: 'queued',
      queue_position: nextPosition,
      task_id: undefined,
    };

    return this.create(message);
  }

  /**
   * Find queued messages for a session
   */
  async findQueued(sessionId: SessionID): Promise<Message[]> {
    const { and, asc } = await import('drizzle-orm');

    const rows = await this.db
      .select()
      .from(messages)
      .where(and(eq(messages.session_id, sessionId), eq(messages.status, 'queued')))
      .orderBy(asc(messages.queue_position));

    return rows.map(r => this.rowToMessage(r));
  }

  /**
   * Get next queued message
   */
  async getNextQueued(sessionId: SessionID): Promise<Message | null> {
    const queued = await this.findQueued(sessionId);
    return queued[0] || null;
  }

  /**
   * Delete queued message (when processing or user cancels)
   */
  async deleteQueued(messageId: MessageID): Promise<void> {
    await this.delete(messageId);
  }
}
