/**
 * Board Objects Service
 *
 * Provides REST + WebSocket API for managing positioned entities on boards.
 * Supports both session cards and branch cards (Phase 1: Hybrid support).
 */

import { BoardObjectRepository, type Database } from '@agor/core/db';
import type {
  BoardEntityObject,
  BoardEntityType,
  BoardID,
  BranchID,
  CardID,
  QueryParams,
} from '@agor/core/types';

export type BoardObjectPatchedEventPayload = Omit<BoardEntityObject, 'zone_id'> & {
  zone_id?: string | null;
};

export function toBoardObjectPatchedEventPayload(
  boardObject: BoardEntityObject
): BoardObjectPatchedEventPayload {
  return {
    ...boardObject,
    ...(boardObject.zone_id === undefined ? { zone_id: null } : {}),
  };
}

/**
 * Board object service params
 */
export type BoardObjectParams = QueryParams<{
  board_id?: BoardID;
  branch_id?: BranchID;
  card_id?: CardID;
  zone_id?: string;
  entity_type?: BoardEntityType;
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
   * Create board object (add branch to board)
   */
  async create(
    data: Partial<BoardEntityObject>,
    params?: BoardObjectParams
  ): Promise<BoardEntityObject> {
    // Validate: branch_id is provided
    if (!data.branch_id) {
      throw new Error('branch_id is required');
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
      branch_id: data.branch_id,
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
    const { board_id, branch_id, card_id, zone_id, entity_type } = params?.query || {};

    let objects: BoardEntityObject[];

    // If board_id filter is provided, use repository method
    if (board_id) {
      objects = await this.boardObjectRepo.findByBoardId(board_id);
    } else {
      // No board_id - return ALL board objects
      objects = await this.boardObjectRepo.findAll();
    }

    if (branch_id) {
      objects = objects.filter((object) => object.branch_id === branch_id);
    }
    if (card_id) {
      objects = objects.filter((object) => object.card_id === card_id);
    }
    if (zone_id) {
      objects = objects.filter((object) => object.zone_id === zone_id);
    }
    if (entity_type) {
      objects = objects.filter((object) => object.entity_type === entity_type);
    }

    const total = objects.length;
    const requestedSkip = params?.query?.$skip ?? 0;
    const requestedLimit = params?.query?.$limit;
    const data =
      requestedLimit !== undefined || requestedSkip > 0
        ? objects.slice(
            requestedSkip,
            requestedLimit === undefined ? undefined : requestedSkip + requestedLimit
          )
        : objects;

    return {
      total,
      limit: requestedLimit ?? 100,
      skip: requestedSkip,
      data,
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
      this.emit?.(
        'patched',
        toBoardObjectPatchedEventPayload(boardObject) as BoardEntityObject,
        params
      );

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

    // Emit WebSocket event with explicit null for undefined zone_id.
    this.emit?.(
      'patched',
      toBoardObjectPatchedEventPayload(boardObject) as BoardEntityObject,
      params
    );

    return boardObject;
  }

  /**
   * Clear zone_id on all board objects referencing a deleted zone.
   */
  async clearZoneReferences(
    boardId: BoardID,
    zoneId: string,
    zonePosition?: { x: number; y: number },
    params?: BoardObjectParams
  ): Promise<BoardEntityObject[]> {
    const cleared = await this.boardObjectRepo.clearZoneReferences(boardId, zoneId, zonePosition);

    for (const boardObject of cleared) {
      this.emit?.(
        'patched',
        toBoardObjectPatchedEventPayload(boardObject) as BoardEntityObject,
        params
      );
    }

    return cleared;
  }

  /**
   * Custom method: Find by branch ID
   */
  async findByBranchId(
    branchId: BranchID,
    _params?: BoardObjectParams
  ): Promise<BoardEntityObject | null> {
    return this.boardObjectRepo.findByBranchId(branchId);
  }
}

/**
 * Service factory function
 */
export function createBoardObjectsService(db: Database): BoardObjectsService {
  return new BoardObjectsService(db);
}
