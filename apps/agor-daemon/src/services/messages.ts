/**
 * Messages Service
 *
 * Provides REST + WebSocket API for message management.
 * Uses DrizzleService adapter with MessagesRepository.
 */

import { PAGINATION } from '@agor/core/config';
import { type Database, MessagesRepository } from '@agor/core/db';
import type { Message, Paginated, QueryParams, SessionID, TaskID } from '@agor/core/types';
import { DrizzleService } from '../adapters/drizzle';

/**
 * Message service params
 */
export type MessageParams = QueryParams<{
  session_id?: SessionID;
  task_id?: TaskID;
  type?: Message['type'];
  role?: Message['role'];
}>;

/**
 * Extended messages service with custom methods
 */
export class MessagesService extends DrizzleService<Message, Partial<Message>, MessageParams> {
  private messagesRepo: MessagesRepository;

  constructor(db: Database) {
    const messagesRepo = new MessagesRepository(db);
    super(messagesRepo, {
      id: 'message_id',
      resourceType: 'Message',
      paginate: {
        default: PAGINATION.DEFAULT_LIMIT,
        max: PAGINATION.MAX_LIMIT,
      },
      multi: ['create', 'remove'], // Allow bulk creates and removes
    });

    this.messagesRepo = messagesRepo;
  }

  /**
   * Override find to support task-based and session-based filtering
   */
  async find(params?: MessageParams): Promise<Message[] | Paginated<Message>> {
    // If filtering by task_id (scalar string), use repository method.
    // The RBAC scoping hook may also inject `session_id` (scalar or `$in`)
    // alongside a user-supplied `task_id`; without intersecting here, callers
    // with only `task_id` would bypass worktree scoping. Filter the task_id
    // rows by the accessible session_id set before returning.
    if (typeof params?.query?.task_id === 'string') {
      let messages = await this.messagesRepo.findByTaskId(params.query.task_id);

      const sid = params.query.session_id;
      if (typeof sid === 'string') {
        messages = messages.filter((m) => m.session_id === sid);
      } else if (sid && typeof sid === 'object' && Array.isArray((sid as { $in?: unknown }).$in)) {
        const allowed = new Set((sid as { $in: string[] }).$in);
        messages = messages.filter((m) => allowed.has(m.session_id as string));
      }

      // Apply pagination if enabled
      if (this.paginate) {
        const limit = params.query.$limit ?? this.paginate.default ?? 100;
        const skip = params.query.$skip ?? 0;

        return {
          total: messages.length,
          limit,
          skip,
          data: messages.slice(skip, skip + limit),
        };
      }

      return messages;
    }

    // If filtering by session_id as a scalar string, use repository shortcut.
    // A `$in` object (from the RBAC scoping hook) falls through to `super.find`
    // where the adapter's `filterData` handles $in natively.
    if (typeof params?.query?.session_id === 'string') {
      // Use type-filtered query when type is specified (e.g., 'permission_request')
      const messages = params.query.type
        ? await this.messagesRepo.findBySessionIdAndType(params.query.session_id, params.query.type)
        : await this.messagesRepo.findBySessionId(params.query.session_id);

      // Apply pagination if enabled
      if (this.paginate) {
        const limit = params.query.$limit ?? this.paginate.default ?? 100;
        const skip = params.query.$skip ?? 0;

        return {
          total: messages.length,
          limit,
          skip,
          data: messages.slice(skip, skip + limit),
        };
      }

      return messages;
    }

    // Otherwise use default find
    return super.find(params);
  }

  /**
   * Custom method: Get messages by session
   */
  async findBySession(sessionId: SessionID): Promise<Message[]> {
    return this.messagesRepo.findBySessionId(sessionId);
  }

  /**
   * Custom method: Get messages by task
   */
  async findByTask(taskId: TaskID): Promise<Message[]> {
    return this.messagesRepo.findByTaskId(taskId);
  }

  /**
   * Custom method: Get messages in a range
   */
  async findByRange(
    sessionId: SessionID,
    startIndex: number,
    endIndex: number
  ): Promise<Message[]> {
    return this.messagesRepo.findByRange(sessionId, startIndex, endIndex);
  }

  /**
   * Custom method: Bulk insert messages
   */
  async createMany(messages: Message[]): Promise<Message[]> {
    return this.messagesRepo.createMany(messages);
  }
}

/**
 * Service factory function
 */
export function createMessagesService(db: Database): MessagesService {
  return new MessagesService(db);
}
