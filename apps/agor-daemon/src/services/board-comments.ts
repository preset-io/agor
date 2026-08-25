/**
 * Board Comments Service
 *
 * Provides REST + WebSocket API for board comments (human-to-human conversations).
 * Uses DrizzleService adapter with BoardCommentsRepository.
 *
 * Features:
 * - Board-level conversations (Phase 1)
 * - Object attachments: session, task, message, branch (Phase 2)
 * - Spatial positioning: absolute/relative (Phase 3)
 * - Mentions and notifications (Phase 4)
 */

import { PAGINATION } from '@agor/core/config';
import { BoardCommentsRepository, type TenantScopeAwareDatabase } from '@agor/core/db';
import { BadRequest } from '@agor/core/feathers';
import type {
  BoardComment,
  BoardCommentCreate,
  BoardCommentPatch,
  BoardCommentReposition,
  QueryParams,
  UUID,
} from '@agor/core/types';
import { DrizzleService } from '../adapters/drizzle';

const PUBLIC_BOARD_COMMENT_CREATE_FIELDS = new Set([
  'board_id',
  'content',
  'branch_id',
  'session_id',
  'task_id',
  'message_id',
  'position',
  'mentions',
]);
const PUBLIC_BOARD_COMMENT_PATCH_FIELDS = new Set(['content', 'resolved']);

/**
 * Enforce the public thread-root contract. Ownership, ids, previews, state,
 * reactions, timestamps, and parent links are server-owned. Replies have a
 * separate operation that authorizes the parent and inherits its attachments.
 */
export function publicBoardCommentCreateInput(data: unknown): BoardCommentCreate {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new BadRequest('Board comment input must be an object');
  }
  const record = data as Record<string, unknown>;
  const unsupported = Object.keys(record).filter(
    (field) => !PUBLIC_BOARD_COMMENT_CREATE_FIELDS.has(field)
  );
  if (unsupported.length > 0) {
    throw new BadRequest(
      `Unsupported board comment create fields: ${unsupported.sort().join(', ')}`
    );
  }
  if (typeof record.board_id !== 'string' || !record.board_id) {
    throw new BadRequest('board_id required');
  }
  if (typeof record.content !== 'string' || !record.content) {
    throw new BadRequest('content required');
  }

  const projected: Record<string, unknown> = {};
  for (const field of PUBLIC_BOARD_COMMENT_CREATE_FIELDS) {
    if (Object.hasOwn(record, field)) projected[field] = record[field];
  }
  return projected as BoardCommentCreate;
}

/**
 * Project external generic patches onto the public mutation contract. Comment
 * identity, attachment/audience, previews, edited state, and reactions are
 * owned by the daemon or by dedicated authorized operations.
 */
export function publicBoardCommentPatchInput(data: unknown): BoardCommentPatch {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new BadRequest('Board comment patch input must be an object');
  }
  const record = data as Record<string, unknown>;
  const unsupported = Object.keys(record).filter(
    (field) => !PUBLIC_BOARD_COMMENT_PATCH_FIELDS.has(field)
  );
  if (unsupported.length > 0) {
    throw new BadRequest(
      `Unsupported board comment patch fields: ${unsupported.sort().join(', ')}`
    );
  }
  if (Object.keys(record).length === 0) {
    throw new BadRequest('Board comment patch requires content or resolved');
  }
  if (Object.hasOwn(record, 'content') && (typeof record.content !== 'string' || !record.content)) {
    throw new BadRequest('content must be a non-empty string');
  }
  if (Object.hasOwn(record, 'resolved') && typeof record.resolved !== 'boolean') {
    throw new BadRequest('resolved must be a boolean');
  }

  return {
    ...(Object.hasOwn(record, 'content') ? { content: record.content as string } : {}),
    ...(Object.hasOwn(record, 'resolved') ? { resolved: record.resolved as boolean } : {}),
  };
}

/** Full replacement would necessarily accept daemon-owned fields. */
export function rejectPublicBoardCommentUpdate(): never {
  throw new BadRequest('Board comments do not support external update; use patch');
}

const POSITION_ABSOLUTE_FIELDS = new Set(['x', 'y']);
const POSITION_RELATIVE_FIELDS = new Set(['parent_id', 'parent_type', 'offset_x', 'offset_y']);

function hasOnlyFields(record: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(record).every((field) => allowed.has(field));
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Strict DTO boundary for the dedicated, separately authorized spatial route. */
export function publicBoardCommentRepositionInput(data: unknown): BoardCommentReposition {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new BadRequest('Board comment reposition input must be an object');
  }
  const record = data as Record<string, unknown>;
  if (!hasOnlyFields(record, new Set(['position', 'branch_id']))) {
    throw new BadRequest('Unsupported board comment reposition fields');
  }
  if (!Object.hasOwn(record, 'branch_id')) {
    throw new BadRequest('branch_id audience precondition required');
  }
  if (record.branch_id !== null && (typeof record.branch_id !== 'string' || !record.branch_id)) {
    throw new BadRequest('branch_id must be a non-empty string or null');
  }
  if (!record.position || typeof record.position !== 'object' || Array.isArray(record.position)) {
    throw new BadRequest('position required');
  }
  const position = record.position as Record<string, unknown>;
  const hasAbsolute = Object.hasOwn(position, 'absolute');
  const hasRelative = Object.hasOwn(position, 'relative');
  if (hasAbsolute === hasRelative || !hasOnlyFields(position, new Set(['absolute', 'relative']))) {
    throw new BadRequest('position must contain exactly one of absolute or relative');
  }

  let projectedPosition: BoardCommentReposition['position'];
  if (hasAbsolute) {
    const absolute = position.absolute;
    if (!absolute || typeof absolute !== 'object' || Array.isArray(absolute)) {
      throw new BadRequest('absolute position must be an object');
    }
    const value = absolute as Record<string, unknown>;
    if (
      !hasOnlyFields(value, POSITION_ABSOLUTE_FIELDS) ||
      !finiteNumber(value.x) ||
      !finiteNumber(value.y)
    ) {
      throw new BadRequest('absolute position requires finite x and y');
    }
    projectedPosition = { absolute: { x: value.x, y: value.y } };
  } else {
    const relative = position.relative;
    if (!relative || typeof relative !== 'object' || Array.isArray(relative)) {
      throw new BadRequest('relative position must be an object');
    }
    const value = relative as Record<string, unknown>;
    if (
      !hasOnlyFields(value, POSITION_RELATIVE_FIELDS) ||
      typeof value.parent_id !== 'string' ||
      !value.parent_id ||
      !['session', 'zone', 'branch'].includes(String(value.parent_type)) ||
      !finiteNumber(value.offset_x) ||
      !finiteNumber(value.offset_y)
    ) {
      throw new BadRequest('relative position is invalid');
    }
    projectedPosition = {
      relative: {
        parent_id: value.parent_id,
        parent_type: value.parent_type as 'session' | 'zone' | 'branch',
        offset_x: value.offset_x,
        offset_y: value.offset_y,
      },
    };
  }

  return {
    position: projectedPosition,
    branch_id: record.branch_id as BoardCommentReposition['branch_id'],
  };
}

/**
 * Board comments service params
 */
export type BoardCommentsParams = QueryParams<{
  board_id?: string;
  session_id?: string;
  task_id?: string;
  message_id?: string;
  branch_id?: string;
  resolved?: boolean;
  created_by?: string;
}> & {
  /** Internal RBAC SQL pushdown marker set by register-hooks for external regular users. */
  _agorSqlBoardAccessUserId?: UUID;
};

/**
 * Extended board comments service with custom methods
 */
export class BoardCommentsService extends DrizzleService<
  BoardComment,
  Partial<BoardComment>,
  BoardCommentsParams,
  BoardCommentPatch
> {
  private commentsRepo: BoardCommentsRepository;

  constructor(db: TenantScopeAwareDatabase) {
    const commentsRepo = new BoardCommentsRepository(db);
    super(commentsRepo, {
      id: 'comment_id',
      resourceType: 'BoardComment',
      paginate: {
        default: PAGINATION.DEFAULT_LIMIT,
        max: PAGINATION.MAX_LIMIT,
      },
    });

    this.commentsRepo = commentsRepo;
  }

  /**
   * Override find to support filtering by board, session, etc.
   * Returns paginated results for FeathersJS compatibility.
   */
  async find(params?: BoardCommentsParams) {
    const filters = params?.query || {};

    const queryFilters = {
      board_id: filters.board_id,
      session_id: filters.session_id,
      task_id: filters.task_id,
      message_id: filters.message_id,
      branch_id: filters.branch_id,
      resolved: filters.resolved,
      created_by: filters.created_by,
      visibleToUserId: params?._agorSqlBoardAccessUserId,
    };

    const $limit = filters.$limit ?? PAGINATION.DEFAULT_LIMIT;
    const $skip = filters.$skip ?? 0;
    const [total, data] = await Promise.all([
      this.commentsRepo.count(queryFilters),
      this.commentsRepo.findAll(queryFilters, { limit: $limit, offset: $skip }),
    ]);

    return {
      total,
      limit: $limit,
      skip: $skip,
      data,
    };
  }

  /** Apply the same attachment-aware predicate to point reads as list reads. */
  async get(id: string, params?: BoardCommentsParams): Promise<BoardComment> {
    const visibleToUserId = params?._agorSqlBoardAccessUserId;
    const comment = visibleToUserId
      ? await this.commentsRepo.findVisibleById(visibleToUserId, id)
      : await this.commentsRepo.findById(id);
    if (!comment) throw new Error(`Board comment ${id} not found`);
    return comment;
  }

  /**
   * Custom method: Resolve comment
   */
  async resolve(id: string, _params?: BoardCommentsParams): Promise<BoardComment> {
    return this.commentsRepo.resolve(id);
  }

  /**
   * Custom method: Unresolve comment
   */
  async unresolve(id: string, _params?: BoardCommentsParams): Promise<BoardComment> {
    return this.commentsRepo.unresolve(id);
  }

  /**
   * Custom method: Find comments by board
   */
  async findByBoard(
    boardId: string,
    filters?: {
      resolved?: boolean;
      created_by?: string;
      session_id?: string;
    },
    _params?: BoardCommentsParams
  ): Promise<BoardComment[]> {
    return this.commentsRepo.findByBoard(boardId, filters);
  }

  /**
   * Custom method: Find comments by session
   */
  async findBySession(sessionId: string, _params?: BoardCommentsParams): Promise<BoardComment[]> {
    return this.commentsRepo.findBySession(sessionId);
  }

  /**
   * Custom method: Find comments by task
   */
  async findByTask(taskId: string, _params?: BoardCommentsParams): Promise<BoardComment[]> {
    return this.commentsRepo.findByTask(taskId);
  }

  /**
   * Custom method: Find comments mentioning a user
   */
  async findMentions(
    userId: string,
    boardId?: string,
    _params?: BoardCommentsParams
  ): Promise<BoardComment[]> {
    return this.commentsRepo.findMentions(userId, boardId);
  }

  /**
   * Custom method: Bulk create comments
   */
  async bulkCreate(
    comments: Partial<BoardComment>[],
    _params?: BoardCommentsParams
  ): Promise<BoardComment[]> {
    return this.commentsRepo.bulkCreate(comments);
  }

  // ============================================================================
  // Phase 2: Threading + Reactions
  // ============================================================================

  /**
   * Custom method: Toggle reaction on a comment
   * If user has already reacted with this emoji, remove it. Otherwise, add it.
   */
  async toggleReaction(
    commentId: string,
    data: { user_id: string; emoji: string },
    _params?: BoardCommentsParams
  ): Promise<BoardComment> {
    return this.commentsRepo.toggleReaction(commentId, data.user_id, data.emoji);
  }

  /**
   * Custom method: Create a reply to a comment (thread root)
   * Validates that parent exists and is a thread root
   */
  async createReply(
    parentId: string,
    data: Partial<BoardComment>,
    _params?: BoardCommentsParams
  ): Promise<BoardComment> {
    return this.commentsRepo.createReply(parentId, data);
  }

  /** Dedicated internal target for the authorized spatial route. */
  async reposition(
    commentId: string,
    data: BoardCommentReposition,
    _params?: BoardCommentsParams
  ): Promise<BoardComment> {
    return this.commentsRepo.update(commentId, { position: data.position });
  }
}

/**
 * Service factory function
 */
export function createBoardCommentsService(db: TenantScopeAwareDatabase): BoardCommentsService {
  return new BoardCommentsService(db);
}
