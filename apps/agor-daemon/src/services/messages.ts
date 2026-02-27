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
    // If filtering by task_id, use repository method
    if (params?.query?.task_id) {
      const messages = await this.messagesRepo.findByTaskId(params.query.task_id);

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

    // If filtering by session_id, use repository method
    if (params?.query?.session_id) {
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
