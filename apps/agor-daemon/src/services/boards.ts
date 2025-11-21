/**
 * Boards Service
 *
 * Provides REST + WebSocket API for board management.
 * Uses DrizzleService adapter with BoardRepository.
 */

import { BoardRepository, type Database } from '@agor/core/db';
import type { Board, BoardObject, QueryParams } from '@agor/core/types';
import { DrizzleService } from '../adapters/drizzle';

/**
 * Board service params
 */
export type BoardParams = QueryParams<{
  slug?: string;
  name?: string;
}>;

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
}

/**
 * Service factory function
 */
export function createBoardsService(db: Database): BoardsService {
  return new BoardsService(db);
}
