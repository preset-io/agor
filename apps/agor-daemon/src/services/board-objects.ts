/**
 * Board Objects Service
 *
 * Provides REST + WebSocket API for managing positioned entities on boards.
 * Supports both session cards and branch cards (Phase 1: Hybrid support).
 */

import {
  type BoardObjectFindFilters,
  type BoardObjectFindOptions,
  BoardObjectRepository,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type {
  BoardEntityObject,
  BoardEntityType,
  BoardID,
  BranchID,
  CardID,
  QueryParams,
  UUID,
} from '@agor/core/types';
import { emitServiceEvent } from '../utils/emit-service-event.js';

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
}> & {
  /** Internal RBAC SQL pushdown marker set by register-hooks for external regular users. */
  _agorSqlBoardAccessUserId?: UUID;
};

export interface NormalizedBoardObjectFindQuery {
  filters: BoardObjectFindFilters;
  pagination: BoardObjectFindOptions;
  limit: number;
  skip: number;
}

export function normalizeBoardObjectFindQuery(
  query: BoardObjectParams['query'] = {}
): NormalizedBoardObjectFindQuery {
  const { board_id, branch_id, card_id, zone_id, entity_type } = query;
  const requestedSkip = Number(query.$skip ?? 0);
  const requestedLimit = typeof query.$limit === 'number' ? query.$limit : undefined;
  const filters = Object.fromEntries(
    Object.entries({ board_id, branch_id, card_id, zone_id, entity_type }).filter(
      ([, value]) => value !== undefined
    )
  ) as BoardObjectFindFilters;

  return {
    filters,
    pagination:
      requestedLimit !== undefined || requestedSkip > 0
        ? { limit: requestedLimit, offset: requestedSkip }
        : {},
    limit: requestedLimit ?? 100,
    skip: requestedSkip,
  };
}

/**
 * Board objects service implementation
 */
export class BoardObjectsService {
  private boardObjectRepo: BoardObjectRepository;
  public emit?: (event: string, data: BoardEntityObject, params?: BoardObjectParams) => void;

  constructor(
    db: TenantScopeAwareDatabase,
    private app?: Application
  ) {
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

    return boardObject;
  }

  /**
   * Find board objects
   */
  async find(params?: BoardObjectParams) {
    const normalized = normalizeBoardObjectFindQuery(params?.query);
    const visibleToUserId = params?._agorSqlBoardAccessUserId;
    const [total, data] = await Promise.all(
      visibleToUserId
        ? [
            this.boardObjectRepo.countVisibleToUser(visibleToUserId, normalized.filters),
            this.boardObjectRepo.findVisibleToUser(
              visibleToUserId,
              normalized.filters,
              normalized.pagination
            ),
          ]
        : [
            this.boardObjectRepo.count(normalized.filters),
            this.boardObjectRepo.findAll(normalized.filters, normalized.pagination),
          ]
    );

    return {
      total,
      limit: normalized.limit,
      skip: normalized.skip,
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
    _params?: BoardObjectParams
  ): Promise<BoardEntityObject> {
    // Handle simultaneous position + zone_id update
    if (data.position && 'zone_id' in data) {
      // Update both atomically without emitting intermediate events
      await this.boardObjectRepo.updatePosition(id, data.position);
      const boardObject = await this.boardObjectRepo.updateZone(id, data.zone_id);

      return toBoardObjectPatchedEventPayload(boardObject) as BoardEntityObject;
    }

    if (data.position) {
      return this.boardObjectRepo.updatePosition(id, data.position);
    }

    if ('zone_id' in data) {
      const boardObject = await this.boardObjectRepo.updateZone(id, data.zone_id);
      return toBoardObjectPatchedEventPayload(boardObject) as BoardEntityObject;
    }

    throw new Error('Only position and zone_id updates are supported via patch');
  }

  /**
   * Remove board object
   */
  async remove(id: string, params?: BoardObjectParams): Promise<BoardEntityObject> {
    const object = await this.get(id, params);
    await this.boardObjectRepo.remove(id);

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

    this.emitPatched(boardObject, params);

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

    this.emitPatched(toBoardObjectPatchedEventPayload(boardObject) as BoardEntityObject, params);

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
      this.emitPatched(toBoardObjectPatchedEventPayload(boardObject) as BoardEntityObject, params);
    }

    return cleared;
  }

  private emitPatched(boardObject: BoardEntityObject, params?: BoardObjectParams): void {
    if (!this.app) return;
    emitServiceEvent(this.app, {
      path: 'board-objects',
      event: 'patched',
      data: boardObject,
      params,
      id: boardObject.object_id,
    });
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
export function createBoardObjectsService(
  db: TenantScopeAwareDatabase,
  app?: Application
): BoardObjectsService {
  return new BoardObjectsService(db, app);
}
