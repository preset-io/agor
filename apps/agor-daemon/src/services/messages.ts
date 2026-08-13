/**
 * Messages Service
 *
 * Provides REST + WebSocket API for message management.
 * Uses DrizzleService adapter with MessagesRepository.
 */

import { PAGINATION } from '@agor/core/config';
import { MessagesRepository, type TenantScopeAwareDatabase } from '@agor/core/db';
import { BadRequest } from '@agor/core/feathers';
import type {
  Message,
  MessageID,
  Paginated,
  QueryParams,
  SessionID,
  TaskID,
  UUID,
} from '@agor/core/types';
import { DrizzleService, type Query } from '../adapters/drizzle';

/**
 * Public Message transport surface. Full replacement and raw bulk insertion
 * stay daemon-internal so they cannot bypass widget lifecycle hooks.
 */
export const MESSAGES_SERVICE_TRANSPORT_METHODS = [
  'find',
  'get',
  'create',
  'patch',
  'remove',
  'findBySession',
  'findByTask',
  'findByRange',
] as const;

/**
 * Message service params
 */
export type MessageParams = QueryParams<{
  session_id?: SessionID;
  task_id?: TaskID;
  type?: Message['type'];
  role?: Message['role'];
}> & {
  /** Internal RBAC SQL pushdown marker set by register-hooks for external regular users. */
  _agorSqlSessionAccessUserId?: UUID;
};

function parseNonNegativeInteger(value: unknown, field: '$limit' | '$skip'): number {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new BadRequest(`${field} must be a finite non-negative integer`);
  }
  return parsed;
}

function normalizeSort(value: unknown): Record<string, 1 | -1> | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequest('$sort must be an object');
  }

  const normalized: Record<string, 1 | -1> = {};
  for (const [field, rawDirection] of Object.entries(value)) {
    if (rawDirection === 1 || rawDirection === '1') {
      normalized[field] = 1;
    } else if (rawDirection === -1 || rawDirection === '-1') {
      normalized[field] = -1;
    } else {
      throw new BadRequest(`$sort direction for ${field} must be 1 or -1`);
    }
  }
  return normalized;
}

function normalizeQuery(rawQuery: Record<string, unknown>): Query {
  const query = { ...rawQuery } as Query;
  if ('$limit' in rawQuery && rawQuery.$limit !== undefined) {
    query.$limit = parseNonNegativeInteger(rawQuery.$limit, '$limit');
  }
  if ('$skip' in rawQuery && rawQuery.$skip !== undefined) {
    query.$skip = parseNonNegativeInteger(rawQuery.$skip, '$skip');
  }
  if ('$sort' in rawQuery) query.$sort = normalizeSort(rawQuery.$sort);
  return query;
}

/**
 * Extended messages service with custom methods
 */
export class MessagesService extends DrizzleService<Message, Partial<Message>, MessageParams> {
  private messagesRepo: MessagesRepository;

  constructor(db: TenantScopeAwareDatabase) {
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
   * Find the exact SQL page for standard Feathers queries. Custom full-history
   * methods below intentionally keep their existing unpaginated semantics.
   */
  async find(params?: MessageParams): Promise<Message[] | Paginated<Message>> {
    const query = normalizeQuery((params?.query ?? {}) as Record<string, unknown>);
    const limit = query.$limit ?? this.paginate?.default ?? 100;
    const actualLimit = Math.min(limit, this.paginate?.max ?? 1000);
    const skip = query.$skip ?? 0;
    const sessionId = query.session_id;
    const pageOptions: Parameters<MessagesRepository['findPage']>[0] = {
      limit: actualLimit,
      skip,
      sort: query.$sort,
    };

    if (typeof sessionId === 'string') {
      pageOptions.sessionId = sessionId as SessionID;
    } else if (
      sessionId &&
      typeof sessionId === 'object' &&
      Array.isArray(sessionId.$in) &&
      sessionId.$in.every((value: unknown) => typeof value === 'string')
    ) {
      pageOptions.sessionIds = sessionId.$in as SessionID[];
    }
    if (typeof query.task_id === 'string') pageOptions.taskId = query.task_id as TaskID;
    if (typeof query.type === 'string') pageOptions.type = query.type as Message['type'];
    if (typeof query.role === 'string') pageOptions.role = query.role as Message['role'];
    if (params?._agorSqlSessionAccessUserId) {
      pageOptions.visibleToUserId = params._agorSqlSessionAccessUserId;
    }

    const page = await this.messagesRepo.findPage(pageOptions);
    return {
      total: page.total,
      limit: actualLimit,
      skip,
      data: this.selectFields(page.data, query.$select) as Message[],
    };
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
   * Internal helper for auth/scope checks that need to validate the current
   * owner fields of a message before allowing a partial update.
   */
  async findByIdForScopeCheck(messageId: MessageID): Promise<Message | null> {
    return this.messagesRepo.findById(messageId);
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
export function createMessagesService(db: TenantScopeAwareDatabase): MessagesService {
  return new MessagesService(db);
}
