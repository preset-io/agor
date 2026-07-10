/**
 * Boards Service
 *
 * Provides REST + WebSocket API for board management.
 * Uses DrizzleService adapter with BoardRepository.
 */

import { PAGINATION } from '@agor/core/config';
import {
  BoardObjectRepository,
  BoardRepository,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import {
  buildTeammateWelcomeNoteObject,
  TEAMMATE_WELCOME_NOTE_OBJECT_ID,
} from '@agor/core/templates/teammate-welcome-note';
import type {
  AuthenticatedParams,
  Board,
  BoardExportBlob,
  BoardID,
  BoardObject,
  QueryParams,
  TeammateWelcomeNoteRequest,
  UUID,
} from '@agor/core/types';
import { NotFoundError } from '@agor/core/utils/errors';
import { DrizzleService, type Query } from '../adapters/drizzle';
import {
  type BoardObjectPatchedEventPayload,
  toBoardObjectPatchedEventPayload,
} from './board-objects.js';

/**
 * Board service params
 */
export interface BoardParams
  extends QueryParams<{
    slug?: string;
    name?: string;
  }> {
  user?: AuthenticatedParams['user'];
  /** Internal hook signal; set only when ensureTeammateWelcomeNote writes. */
  teammateWelcomeNoteMutated?: boolean;
  /** Internal RBAC SQL pushdown marker set by register-hooks for external regular users. */
  _agorSqlBoardAccessUserId?: UUID;
}

/**
 * Extended boards service with custom methods
 */
export class BoardsService extends DrizzleService<Board, Partial<Board>, BoardParams> {
  private boardRepo: BoardRepository;
  private boardObjectRepo: BoardObjectRepository;
  private emitBoardObjectPatched?: (
    boardObject: BoardObjectPatchedEventPayload,
    params?: BoardParams
  ) => void;

  constructor(
    db: TenantScopeAwareDatabase,
    emitBoardObjectPatched?: (
      boardObject: BoardObjectPatchedEventPayload,
      params?: BoardParams
    ) => void
  ) {
    const boardRepo = new BoardRepository(db);
    super(boardRepo, {
      id: 'board_id',
      resourceType: 'Board',
      paginate: {
        default: PAGINATION.DEFAULT_LIMIT,
        max: PAGINATION.MAX_LIMIT,
      },
    });

    this.boardRepo = boardRepo;
    this.boardObjectRepo = new BoardObjectRepository(db);
    this.emitBoardObjectPatched = emitBoardObjectPatched;
  }

  /**
   * Push the list read's high-selectivity predicates into SQL.
   *
   * The generic adapter would read the entire boards table and filter in
   * memory. `boards` is fetched on initial app load, so we narrow the read to
   * explicit board ids and any RBAC SQL visibility marker before rows leave the
   * database. `find` still re-applies every query filter in memory, so this
   * only ever returns a superset of the matching rows and the downstream
   * sort/pagination is unaffected.
   *
   * `lean` is a list-only projection flag — it omits each board's heavy
   * `data.objects` / `data.custom_css` (a client `$select` can't trim them:
   * they live inside the `data` JSON column). Routing it through this one
   * repository read is exactly what keeps the lean list from ever widening
   * board visibility — it inherits the same RBAC + id pushdown as every other
   * list read. It is NOT a board column, so we strip it from `query` before
   * `find` hands the query to `filterData`, which would otherwise treat it as an
   * equality filter on a non-existent `lean` column and empty the result;
   * `$sort` / `$select` / pagination never touch the omitted fields, and
   * `boards.get(id)` is unaffected and always returns the full board.
   *
   * The boards query validator (`boardQuerySchema`) accepts `board_id` and
   * `lean` but strips `archived`, so there is no archived predicate to push. A
   * `{ $in }` is only pushed when every element is a string, keeping the
   * superset invariant unconditional.
   */
  protected async fetchData(query: Query, params?: BoardParams): Promise<Board[]> {
    const filter: { boardIds?: BoardID[]; visibleToUserId?: UUID; lean?: boolean } = {};

    if (params?._agorSqlBoardAccessUserId) {
      filter.visibleToUserId = params._agorSqlBoardAccessUserId;
    }

    const leanQuery = query as Query & { lean?: boolean };
    if (leanQuery.lean) {
      filter.lean = true;
    }
    delete leanQuery.lean;

    const boardId = query.board_id;
    if (typeof boardId === 'string') {
      filter.boardIds = [boardId as BoardID];
    } else if (
      boardId &&
      typeof boardId === 'object' &&
      Array.isArray(boardId.$in) &&
      boardId.$in.every((el: unknown) => typeof el === 'string')
    ) {
      filter.boardIds = boardId.$in as BoardID[];
    }

    return this.boardRepo.findAll(filter);
  }

  /**
   * Custom method: Find board by slug
   */
  async findBySlug(slug: string, _params?: BoardParams): Promise<Board | null> {
    return this.boardRepo.findBySlug(slug);
  }

  async create(
    data: Partial<Board> | Partial<Board>[],
    params?: BoardParams
  ): Promise<Board | Board[]> {
    const result = (await super.create(data, params)) as Board | Board[];
    const creatorId = params?.user?.user_id;
    if (!creatorId) return result;

    const boards = Array.isArray(result) ? result : [result];
    await Promise.all(
      boards.map((board) => this.boardRepo.addOwner(board.board_id, creatorId as UUID))
    );
    return result;
  }

  /**
   * Custom method: Find board by slug or ID (for URL routing)
   */
  async findBySlugOrId(param: string, _params?: BoardParams): Promise<Board | null> {
    return this.boardRepo.findBySlugOrId(param);
  }

  /**
   * DEPRECATED: Add session to board
   * Use board-objects service instead
   */
  async addSession(_id: string, _sessionId: string, _params?: BoardParams): Promise<Board> {
    throw new Error('addSession is deprecated - use board-objects service');
  }

  /**
   * DEPRECATED: Remove session from board
   * Use board-objects service instead
   */
  async removeSession(_id: string, _sessionId: string, _params?: BoardParams): Promise<Board> {
    throw new Error('removeSession is deprecated - use board-objects service');
  }

  /**
   * Custom method: Atomically add or update a board object
   */
  async upsertBoardObject(
    boardId: string,
    objectId: string,
    objectData: BoardObject,
    _params?: BoardParams
  ): Promise<Board> {
    return this.boardRepo.upsertBoardObject(boardId, objectId, objectData);
  }

  /**
   * Custom method: Atomically remove a board object
   */
  async removeBoardObject(
    boardId: string,
    objectId: string,
    _params?: BoardParams
  ): Promise<Board> {
    const board = await this.boardRepo.findBySlugOrId(boardId);
    const object = board?.objects?.[objectId];

    // A generic removeObject path can remove zones too (e.g. MCP
    // agor_boards_update.removeObjects). Clear entity zone references first so
    // future board renders do not construct React Flow children with a missing
    // parent. Convert zone-relative positions to absolute while the zone origin
    // is still available.
    if (board && object?.type === 'zone') {
      const cleared = await this.boardObjectRepo.clearZoneReferences(board.board_id, objectId, {
        x: object.x,
        y: object.y,
      });

      for (const boardObject of cleared) {
        const payload = toBoardObjectPatchedEventPayload(boardObject);
        if (_params) this.emitBoardObjectPatched?.(payload, _params);
        else this.emitBoardObjectPatched?.(payload);
      }
    }

    return this.boardRepo.removeBoardObject(boardId, objectId);
  }

  /**
   * Custom method: Create the bundled teammate welcome note when missing.
   *
   * Rendering is intentionally server-side from a static Handlebars template so
   * the browser bundle does not import Handlebars (blocked by CSP unsafe-eval),
   * and callers never provide template source for this path.
   */
  async ensureTeammateWelcomeNote(
    data: TeammateWelcomeNoteRequest,
    params?: BoardParams
  ): Promise<Board> {
    const boardIdentifier = data.boardId ?? data.id;
    if (!boardIdentifier) throw new Error('Board ID required');

    const board = await this.boardRepo.findBySlugOrId(String(boardIdentifier));
    if (!board) {
      throw new NotFoundError('Board', String(boardIdentifier));
    }

    const teammateName = typeof data.teammateName === 'string' ? data.teammateName : '';
    const teammateEmoji = typeof data.teammateEmoji === 'string' ? data.teammateEmoji : null;
    const objectData = buildTeammateWelcomeNoteObject({
      teammateName,
      teammateEmoji,
    });

    const existing = board.objects?.[TEAMMATE_WELCOME_NOTE_OBJECT_ID];
    if (existing) return board;

    if (params) {
      params.teammateWelcomeNoteMutated = true;
    }
    return this.boardRepo.upsertBoardObject(
      board.board_id,
      TEAMMATE_WELCOME_NOTE_OBJECT_ID,
      objectData
    );
  }

  /**
   * Custom method: Set the board's primary teammate branch.
   */
  async setPrimaryTeammate(
    data: { boardId?: string; id?: string; branchId?: string } | string,
    branchIdOrParams?: string | BoardParams,
    _maybeParams?: BoardParams
  ): Promise<Board> {
    const boardId = typeof data === 'string' ? data : (data.boardId ?? data.id);
    const branchId = typeof data === 'string' ? branchIdOrParams : data.branchId;
    if (!boardId) throw new Error('Board ID required');
    if (!branchId || typeof branchId !== 'string') throw new Error('Branch ID required');
    return this.boardRepo.setPrimaryTeammate(boardId, branchId);
  }

  /**
   * Custom method: Clear the board's primary teammate branch.
   */
  async clearPrimaryTeammate(boardId: string, _params?: BoardParams): Promise<Board> {
    return this.boardRepo.clearPrimaryTeammate(boardId);
  }

  /**
   * Custom method: Batch upsert board objects
   */
  async batchUpsertBoardObjects(
    boardId: string,
    objects: Record<string, BoardObject>,
    _params?: BoardParams
  ): Promise<Board> {
    return this.boardRepo.batchUpsertBoardObjects(boardId, objects);
  }

  /**
   * Custom method: Atomically shallow-merge field patches into existing board
   * objects (used by z-order reorder to persist only the changed zIndex).
   */
  async mergeBoardObjectFields(
    boardId: string,
    patches: Record<string, Partial<BoardObject>>,
    _params?: BoardParams
  ): Promise<Board> {
    return this.boardRepo.mergeBoardObjectFields(boardId, patches);
  }

  /**
   * Custom method: Delete a zone and handle associated sessions
   */
  async deleteZone(
    boardId: string,
    objectId: string,
    _deleteAssociatedSessions: boolean,
    _params?: BoardParams
  ): Promise<{ board: Board; affectedSessions: string[] }> {
    const board = await this.removeBoardObject(boardId, objectId);
    return {
      board,
      affectedSessions: [],
    };
  }

  /**
   * Export board to blob (JSON)
   */
  async toBlob(
    data: { boardId?: string; id?: string; slug?: string } | string,
    _params?: BoardParams
  ): Promise<BoardExportBlob> {
    const boardId = await this.resolveBoardId(data);
    return this.boardRepo.toBlob(boardId);
  }

  /**
   * Import board from blob (JSON)
   */
  async fromBlob(blob: BoardExportBlob, params?: BoardParams): Promise<Board> {
    // Hook chain enforces auth before we get here.
    const userId = params!.user!.user_id;
    this.boardRepo.validateBoardBlob(blob);
    const data = this.buildBoardDataFromBlob(blob, userId);

    // Create board through repository (not super.create to avoid double-emit issues)
    const board = await this.boardRepo.create(data);
    await this.boardRepo.addOwner(board.board_id, userId as UUID);

    // Note: Events must be emitted by the caller using app.service('boards').emit()
    // this.emit() doesn't work reliably in custom methods due to execution context

    return board;
  }

  /**
   * Export board to YAML string
   */
  async toYaml(
    data: { boardId?: string; id?: string; slug?: string } | string,
    _params?: BoardParams
  ): Promise<string> {
    const boardId = await this.resolveBoardId(data);
    return this.boardRepo.toYaml(boardId);
  }

  /**
   * Import board from YAML string
   */
  async fromYaml(
    data: { yaml?: string; content?: string } | string,
    params?: BoardParams
  ): Promise<Board> {
    const yamlContent = typeof data === 'string' ? data : (data.yaml ?? data.content);
    if (!yamlContent) throw new Error('YAML content required');
    const blob = this.boardRepo.parseYamlToBlob(yamlContent);
    return this.fromBlob(blob, params);
  }

  /**
   * Clone board (create copy with new ID)
   */
  async clone(
    data: { boardId?: string; id?: string; name?: string; slug?: string } | string,
    newNameOrParams?: string | BoardParams,
    maybeParams?: BoardParams
  ): Promise<Board> {
    let boardIdentifier: string | undefined;
    let name: string | undefined;
    let params: BoardParams | undefined;

    if (typeof data === 'string') {
      boardIdentifier = data;
      if (typeof newNameOrParams !== 'string') {
        throw new Error('Board name required');
      }
      name = newNameOrParams;
      params = maybeParams;
    } else {
      boardIdentifier = data.boardId ?? data.id ?? data.slug;
      name = data.name;
      params = (newNameOrParams as BoardParams | undefined) ?? maybeParams;
    }

    if (!boardIdentifier) throw new Error('Board ID or slug required');
    if (!name) throw new Error('Board name required');

    // Hook chain enforces auth before we get here.
    const userId = params!.user!.user_id;
    const resolvedBoardId = await this.resolveBoardId(boardIdentifier);
    const blob = await this.boardRepo.toBlob(resolvedBoardId);
    const boardData = this.buildBoardDataFromBlob(blob, userId, name);
    // Create board through repository (not super.create to avoid double-emit issues)
    const clonedBoard = await this.boardRepo.create(boardData);
    await this.boardRepo.addOwner(clonedBoard.board_id, userId as UUID);

    // Note: Events must be emitted by the caller using app.service('boards').emit()
    // this.emit() doesn't work reliably in custom methods due to execution context
    // See: apps/agor-daemon/src/index.ts for examples of manual emission

    return clonedBoard;
  }

  /**
   * Custom method: Archive a board (soft delete)
   */
  async archive(id: string, params?: BoardParams): Promise<Board> {
    const board = await this.get(id, params);

    if (board.archived) {
      throw new Error(`Board "${board.name}" is already archived`);
    }

    console.log(`📦 Archiving board: ${board.name}`);

    // Hook chain enforces auth before we get here.
    const currentUserId = params!.user!.user_id;
    const archivedBoard = await this.patch(
      id,
      {
        archived: true,
        archived_at: new Date().toISOString(),
        archived_by: currentUserId,
      } as Partial<Board>,
      params
    );

    console.log(`✅ Archived board ${board.name}`);
    return archivedBoard as Board;
  }

  /**
   * Custom method: Unarchive a board
   */
  async unarchive(id: string, params?: BoardParams): Promise<Board> {
    const board = await this.get(id, params);

    if (!board.archived) {
      throw new Error(`Board "${board.name}" is not archived`);
    }

    console.log(`📦 Unarchiving board: ${board.name}`);

    const unarchivedBoard = await this.patch(
      id,
      {
        archived: false,
        archived_at: undefined,
        archived_by: undefined,
      } as Partial<Board>,
      params
    );

    console.log(`✅ Unarchived board ${board.name}`);
    return unarchivedBoard as Board;
  }

  private async resolveBoardId(
    data: { boardId?: string; id?: string; slug?: string } | string
  ): Promise<string> {
    const identifier = typeof data === 'string' ? data : (data.boardId ?? data.id ?? data.slug);

    if (!identifier) {
      throw new Error('Board ID or slug required');
    }

    const board = await this.boardRepo.findBySlugOrId(identifier);
    if (!board) {
      throw new NotFoundError('Board', identifier);
    }

    return board.board_id;
  }

  private buildBoardDataFromBlob(
    blob: BoardExportBlob,
    userId: string,
    nameOverride?: string
  ): Partial<Board> {
    const name = nameOverride ?? blob.name;
    const slug = nameOverride ? nameOverride : (blob.slug ?? blob.name);

    return {
      name,
      slug,
      description: blob.description,
      icon: blob.icon,
      color: blob.color,
      background_color: blob.background_color,
      custom_css: blob.custom_css,
      objects: blob.objects,
      custom_context: blob.custom_context,
      created_by: userId,
    };
  }
}

/**
 * Service factory function
 */
export function createBoardsService(
  db: TenantScopeAwareDatabase,
  emitBoardObjectPatched?: (
    boardObject: BoardObjectPatchedEventPayload,
    params?: BoardParams
  ) => void
): BoardsService {
  return new BoardsService(db, emitBoardObjectPatched);
}
