/**
 * Board Objects Service
 *
 * Provides REST + WebSocket API for managing positioned entities on boards.
 * Supports both session cards and worktree cards (Phase 1: Hybrid support).
 */

import { BoardObjectRepository, type Database } from '@agor/core/db';
import type { BoardEntityObject, BoardID, QueryParams, WorktreeID } from '@agor/core/types';

/**
 * Board object service params
 */
export type BoardObjectParams = QueryParams<{
  board_id?: BoardID;
  worktree_id?: WorktreeID;
}>;

/**
 * Board objects service implementation
 */
export class BoardObjectsService {
  private boardObjectRepo: BoardObjectRepository;
  public emit?: (event: string, data: BoardEntityObject, params?: BoardObjectParams) => void;

  constructor(db: Database) {
    this.boardObjectRepo = new BoardObjectRepository(db);
  }

  /**
   * Create board object (add worktree to board)
   */
  async create(
    data: Partial<BoardEntityObject>,
    params?: BoardObjectParams
  ): Promise<BoardEntityObject> {
    // Validate: worktree_id is provided
    if (!data.worktree_id) {
      throw new Error('worktree_id is required');
    }

    // Validate: position is provided
    if (!data.position) {
      throw new Error('position is required');
    }

    // Validate: board_id is provided
    if (!data.board_id) {
      throw new Error('board_id is required');
    }

    // Use repository to create
    const boardObject = await this.boardObjectRepo.create({
      board_id: data.board_id,
      worktree_id: data.worktree_id,
      position: data.position,
      zone_id: data.zone_id,
    });

    // Emit WebSocket event
    this.emit?.('created', boardObject, params);

    return boardObject;
  }

  /**
   * Find board objects
   */
  async find(params?: BoardObjectParams) {
    const { board_id } = params?.query || {};

    // If board_id filter is provided, use repository method
    if (board_id) {
      const objects = await this.boardObjectRepo.findByBoardId(board_id);

      return {
        total: objects.length,
        limit: params?.query?.$limit || 100,
        skip: params?.query?.$skip || 0,
        data: objects,
      };
    }

    // No board_id - return ALL board objects
    const allObjects = await this.boardObjectRepo.findAll();

    return {
      total: allObjects.length,
      limit: params?.query?.$limit || 100,
      skip: params?.query?.$skip || 0,
      data: allObjects,
    };
  }

  /**
   * Get single board object
   */
  async get(id: string, _params?: BoardObjectParams): Promise<BoardEntityObject> {
    const object = await this.boardObjectRepo.findByObjectId(id);
    if (!object) {
      throw new Error(`Board object ${id} not found`);
    }
    return object;
  }

  /**
   * Patch (update) board object
   */
  async patch(
    id: string,
    data: Partial<BoardEntityObject>,
    params?: BoardObjectParams
  ): Promise<BoardEntityObject> {
    // Handle simultaneous position + zone_id update
    if (data.position && 'zone_id' in data) {
      // Update both atomically without emitting intermediate events
      await this.boardObjectRepo.updatePosition(id, data.position);
      const boardObject = await this.boardObjectRepo.updateZone(id, data.zone_id);

      // Emit single WebSocket event with both updates
      // Explicitly include zone_id field (even if undefined) to signal zone changes to clients
      const eventPayload = {
        ...boardObject,
        ...(boardObject.zone_id === undefined ? { zone_id: null } : {}),
      };
      this.emit?.('patched', eventPayload as BoardEntityObject, params);

      return boardObject;
    }

    if (data.position) {
      return this.updatePosition(id, data.position, params);
    }

    if ('zone_id' in data) {
      return this.updateZone(id, data.zone_id, params);
    }

    throw new Error('Only position and zone_id updates are supported via patch');
  }

  /**
   * Remove board object
   */
  async remove(id: string, params?: BoardObjectParams): Promise<BoardEntityObject> {
    const object = await this.get(id, params);
    await this.boardObjectRepo.remove(id);

    // Emit WebSocket event
    this.emit?.('removed', object, params);

    return object;
  }

  /**
   * Custom method: Update position
   */
  async updatePosition(
    objectId: string,
    position: { x: number; y: number },
    params?: BoardObjectParams
  ): Promise<BoardEntityObject> {
    const boardObject = await this.boardObjectRepo.updatePosition(objectId, position);

    // Emit WebSocket event
    this.emit?.('patched', boardObject, params);

    return boardObject;
  }

  /**
   * Custom method: Update zone pinning
   */
  async updateZone(
    objectId: string,
    zoneId: string | undefined | null,
    params?: BoardObjectParams
  ): Promise<BoardEntityObject> {
    const boardObject = await this.boardObjectRepo.updateZone(objectId, zoneId);

    // Emit WebSocket event with explicit null for undefined zone_id
    // JSON.stringify strips undefined fields, so convert to null to signal zone was cleared
    const eventPayload = {
      ...boardObject,
      ...(boardObject.zone_id === undefined ? { zone_id: null } : {}),
    };
    this.emit?.('patched', eventPayload as BoardEntityObject, params);

    return boardObject;
  }

  /**
   * Custom method: Find by worktree ID
   */
  async findByWorktreeId(
    worktreeId: WorktreeID,
    _params?: BoardObjectParams
  ): Promise<BoardEntityObject | null> {
    return this.boardObjectRepo.findByWorktreeId(worktreeId);
  }
}

/**
 * Service factory function
 */
export function createBoardObjectsService(db: Database): BoardObjectsService {
  return new BoardObjectsService(db);
}
