/**
 * Messages Service
 *
 * Provides REST + WebSocket API for message management.
 * Uses DrizzleService adapter with MessagesRepository.
 */

import { MESSAGE_PAGINATION } from '@agor/core/config';
import { MessagesRepository, TaskRepository, type TenantScopeAwareDatabase } from '@agor/core/db';
import { BadRequest } from '@agor/core/feathers';
import {
  type Message,
  type MessageID,
  type MessagePatch,
  MESSAGE_PATCH_FIELDS,
  MessageRole,
  type Paginated,
  type QueryParams,
  type SessionID,
  type TaskID,
  type UUID,
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
    if (!MESSAGE_SORT_FIELDS.has(field)) {
      throw new BadRequest(`Unsupported $sort field: ${field}`);
    }
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
  for (const field of Object.keys(rawQuery)) {
    if (!MESSAGE_QUERY_FIELDS.has(field)) {
      throw new BadRequest(`Unsupported messages query field: ${field}`);
    }
  }
  const query = { ...rawQuery } as Query;
  if ('$limit' in rawQuery && rawQuery.$limit !== undefined) {
    query.$limit = parseNonNegativeInteger(rawQuery.$limit, '$limit');
  }
  if ('$skip' in rawQuery && rawQuery.$skip !== undefined) {
    query.$skip = parseNonNegativeInteger(rawQuery.$skip, '$skip');
  }
  if ('$sort' in rawQuery) query.$sort = normalizeSort(rawQuery.$sort);
  if ('$select' in rawQuery) {
    if (
      !Array.isArray(rawQuery.$select) ||
      rawQuery.$select.some(
        (field) => typeof field !== 'string' || !MESSAGE_SELECT_FIELDS.has(field)
      )
    ) {
      throw new BadRequest('$select contains an unsupported Message field');
    }
  }

  const sessionId = rawQuery.session_id;
  if (
    sessionId !== undefined &&
    !(
      typeof sessionId === 'string' ||
      (sessionId !== null &&
        typeof sessionId === 'object' &&
        !Array.isArray(sessionId) &&
        Object.keys(sessionId).length === 1 &&
        Array.isArray((sessionId as { $in?: unknown }).$in) &&
        (sessionId as { $in: unknown[] }).$in.length <= 1_000 &&
        (sessionId as { $in: unknown[] }).$in.every((value) => typeof value === 'string'))
    )
  ) {
    throw new BadRequest('session_id must be an ID or a bounded $in array of IDs');
  }
  if (rawQuery.task_id !== undefined && typeof rawQuery.task_id !== 'string') {
    throw new BadRequest('task_id must be an ID');
  }
  if (rawQuery.type !== undefined && !MESSAGE_TYPES.has(rawQuery.type as Message['type'])) {
    throw new BadRequest('Unsupported Message type');
  }
  if (rawQuery.role !== undefined && !MESSAGE_ROLES.has(rawQuery.role as Message['role'])) {
    throw new BadRequest('Unsupported Message role');
  }
  return query;
}

const MESSAGE_QUERY_FIELDS = new Set([
  'session_id',
  'task_id',
  'type',
  'role',
  '$limit',
  '$skip',
  '$sort',
  '$select',
]);
const MESSAGE_SORT_FIELDS = new Set([
  'message_id',
  'session_id',
  'type',
  'role',
  'index',
  'timestamp',
  'created_at',
]);
const MESSAGE_SELECT_FIELDS = new Set([
  'message_id',
  'session_id',
  'task_id',
  'type',
  'role',
  'index',
  'timestamp',
  'content_preview',
  'content',
  'tool_uses',
  'parent_tool_use_id',
  'metadata',
]);
const MESSAGE_TYPES = new Set<Message['type']>([
  'user',
  'assistant',
  'system',
  'file-history-snapshot',
  'permission_request',
  'input_request',
  'daemon_restart',
  'daemon_crash',
  'widget_request',
]);
const MESSAGE_ROLES = new Set<Message['role']>([
  MessageRole.USER,
  MessageRole.ASSISTANT,
  MessageRole.SYSTEM,
]);
const MESSAGE_PATCH_FIELD_SET = new Set<keyof MessagePatch>(MESSAGE_PATCH_FIELDS);

/**
 * Extended messages service with custom methods
 */
export class MessagesService extends DrizzleService<Message, Partial<Message>, MessageParams> {
  private messagesRepo: MessagesRepository;
  private taskRepo: TaskRepository;

  constructor(db: TenantScopeAwareDatabase) {
    const messagesRepo = new MessagesRepository(db);
    super(messagesRepo, {
      id: 'message_id',
      resourceType: 'Message',
      paginate: {
        default: MESSAGE_PAGINATION.DEFAULT_LIMIT,
        max: MESSAGE_PAGINATION.MAX_LIMIT,
      },
      multi: ['create', 'remove'], // Allow bulk creates and removes
    });

    this.messagesRepo = messagesRepo;
    this.taskRepo = new TaskRepository(db);
  }

  /**
   * Keep generic PATCH calls inside one narrow DTO. In particular, a caller
   * that can prompt one Session must not be able to move its Message into
   * another Session/Task or change a pagination key.
   */
  async patch(
    id: string | null,
    data: MessagePatch,
    params?: MessageParams
  ): Promise<Message | Message[]> {
    if (id === null) throw new BadRequest('Bulk Message patch is not supported');

    const unsupported = Object.keys(data).filter(
      (field) => !MESSAGE_PATCH_FIELD_SET.has(field as keyof MessagePatch)
    );
    if (unsupported.length > 0) {
      throw new BadRequest(`Message fields are immutable: ${unsupported.join(', ')}`);
    }

    if (Object.hasOwn(data, 'task_id')) {
      if (typeof data.task_id !== 'string') {
        throw new BadRequest('task_id must be a Task ID');
      }
      const existing = await this.messagesRepo.findById(id as MessageID);
      if (existing) {
        if (existing.task_id && existing.task_id !== data.task_id) {
          throw new BadRequest('Message task_id cannot be reassigned');
        }
        if (existing.task_id !== data.task_id) {
          const targetTask = await this.taskRepo.findById(data.task_id);
          if (!targetTask || targetTask.session_id !== existing.session_id) {
            throw new BadRequest('task_id must belong to the Message Session');
          }
        }
      }
    }

    return super.patch(id, data, params);
  }

  /**
   * Find the exact SQL page for standard Feathers queries. Complete Task
   * hydration is a client concern: `findAll({ task_id })` walks these bounded
   * pages rather than opening an unbounded transport route.
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
   * Daemon-internal helper: get messages by session.
   */
  async findBySession(sessionId: SessionID): Promise<Message[]> {
    return this.messagesRepo.findBySessionId(sessionId);
  }

  /**
   * Daemon-internal helper: get messages by task.
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
   * Daemon-internal helper: get messages in a range.
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
