/**
 * Boards Service
 *
 * Provides REST + WebSocket API for board management.
 * Uses DrizzleService adapter with BoardRepository.
 */

import { BoardRepository, type Database } from '@agor/core/db';
import type {
  AuthenticatedParams,
  Board,
  BoardExportBlob,
  BoardObject,
  QueryParams,
} from '@agor/core/types';
import { NotFoundError } from '@agor/core/utils/errors';
import { DrizzleService } from '../adapters/drizzle';

/**
 * Board service params
 */
export interface BoardParams
  extends QueryParams<{
    slug?: string;
    name?: string;
  }> {
  user?: AuthenticatedParams['user'];
}

/**
 * Extended boards service with custom methods
 */
export class BoardsService extends DrizzleService<Board, Partial<Board>, BoardParams> {
  private boardRepo: BoardRepository;

  constructor(db: Database) {
    const boardRepo = new BoardRepository(db);
    super(boardRepo, {
      id: 'board_id',
      resourceType: 'Board',
      paginate: {
        default: 50,
        max: 100,
      },
    });

    this.boardRepo = boardRepo;
  }

  /**
   * Custom method: Find board by slug
   */
  async findBySlug(slug: string, _params?: BoardParams): Promise<Board | null> {
    return this.boardRepo.findBySlug(slug);
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
    return this.boardRepo.removeBoardObject(boardId, objectId);
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
   * Custom method: Delete a zone and handle associated sessions
   */
  async deleteZone(
    boardId: string,
    objectId: string,
    deleteAssociatedSessions: boolean,
    _params?: BoardParams
  ): Promise<{ board: Board; affectedSessions: string[] }> {
    return this.boardRepo.deleteZone(boardId, objectId, deleteAssociatedSessions);
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
    const userId = params?.user?.user_id || 'anonymous';
    this.boardRepo.validateBoardBlob(blob);
    const data = this.buildBoardDataFromBlob(blob, userId);

    // Create board through repository (not super.create to avoid double-emit issues)
    const board = await this.boardRepo.create(data);

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

    const userId = params?.user?.user_id || 'anonymous';
    const resolvedBoardId = await this.resolveBoardId(boardIdentifier);
    const blob = await this.boardRepo.toBlob(resolvedBoardId);
    const boardData = this.buildBoardDataFromBlob(blob, userId, name);
    // Create board through repository (not super.create to avoid double-emit issues)
    const clonedBoard = await this.boardRepo.create(boardData);

    // Note: Events must be emitted by the caller using app.service('boards').emit()
    // this.emit() doesn't work reliably in custom methods due to execution context
    // See: apps/agor-daemon/src/index.ts for examples of manual emission

    return clonedBoard;
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
      objects: blob.objects,
      custom_context: blob.custom_context,
      created_by: userId,
    };
  }
}

/**
 * Service factory function
 */
export function createBoardsService(db: Database): BoardsService {
  return new BoardsService(db);
}
