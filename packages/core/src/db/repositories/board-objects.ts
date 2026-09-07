/**
 * Board Objects Repository
 *
 * Manages positioned entities (sessions and branches) on boards.
 * Phase 1: Hybrid support for both session cards and branch cards.
 */

import type {
  BoardEntityObject,
  BoardEntityType,
  BoardID,
  BoardLayoutPlacementUpdate,
  BranchID,
  CardID,
  UUID,
} from '@agor/core/types';
import { and, asc, eq, getTableColumns, isNotNull, isNull, or, type SQL, sql } from 'drizzle-orm';
import { isBoardEntityDensityExpandable } from '../../layout/zone-layout.js';
import { generateId } from '../../lib/ids';
import { toAbsolutePosition } from '../../utils/board-placement.js';
import type { Database } from '../client';
import { deleteFrom, insert, jsonExtract, select, update } from '../database-wrapper';
import {
  type BoardObjectInsert,
  type BoardObjectRow,
  boardObjects,
  branches,
  cards,
} from '../schema';
import { EntityNotFoundError, RepositoryError } from './base';
import {
  visibleBoardReferenceAccessExists,
  visibleBranchReferenceAccessExists,
} from './branch-access';

export interface BoardObjectFindFilters {
  board_id?: BoardID;
  branch_id?: BranchID;
  card_id?: CardID;
  zone_id?: string;
  entity_type?: BoardEntityType;
}

export interface BoardObjectFindOptions {
  limit?: number;
  offset?: number;
}

function validateFinitePosition(position: { x: number; y: number }, objectId: string): void {
  if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) {
    throw new RepositoryError(`Board object ${objectId} requires finite x/y geometry`);
  }
}

function validateFiniteSize(size: { width: number; height: number }, objectId: string): void {
  if (
    !Number.isFinite(size.width) ||
    size.width <= 0 ||
    !Number.isFinite(size.height) ||
    size.height <= 0
  ) {
    throw new RepositoryError(`Board object ${objectId} requires a positive finite size`);
  }
}

/**
 * Board object repository implementation
 */
export class BoardObjectRepository {
  constructor(private db: Database) {}

  private buildFindConditions(filters: BoardObjectFindFilters = {}): SQL[] {
    const conditions: SQL[] = [];

    if (filters.board_id) {
      conditions.push(eq(boardObjects.board_id, filters.board_id));
    }
    if (filters.branch_id) {
      conditions.push(eq(boardObjects.branch_id, filters.branch_id));
    }
    if (filters.card_id) {
      conditions.push(eq(boardObjects.card_id, filters.card_id));
    }
    if (filters.zone_id) {
      conditions.push(
        sql`${jsonExtract(this.db, boardObjects.data, 'zone_id')} = ${filters.zone_id}`
      );
    }
    if (filters.entity_type === 'branch') {
      conditions.push(isNull(boardObjects.card_id));
    } else if (filters.entity_type === 'card') {
      conditions.push(isNotNull(boardObjects.card_id));
    }

    return conditions;
  }

  private buildVisibleToUserCondition(userId: UUID): SQL {
    return (
      and(
        // Board visibility is authoritative for the canvas itself. Access to a
        // branch on a private board must not leak that board's object/position.
        visibleBoardReferenceAccessExists(this.db, userId, boardObjects.board_id),
        or(
          isNull(boardObjects.branch_id),
          and(
            isNotNull(boardObjects.branch_id),
            visibleBranchReferenceAccessExists(this.db, userId, boardObjects.branch_id)
          )
        )
      ) ?? sql`false`
    );
  }

  /**
   * Find all board objects
   */
  async findAll(
    filters: BoardObjectFindFilters = {},
    options: BoardObjectFindOptions = {}
  ): Promise<BoardEntityObject[]> {
    try {
      const conditions = this.buildFindConditions(filters);
      let query = select(this.db).from(boardObjects);

      if (conditions.length > 0) {
        query = query.where(and(...conditions));
      }
      query = query.orderBy(asc(boardObjects.created_at), asc(boardObjects.object_id));
      if (options.limit !== undefined) {
        query = query.limit(options.limit);
      }
      if (options.offset !== undefined) {
        query = query.offset(options.offset);
      }

      const rows = await query.all();

      return rows.map(this.rowToEntity);
    } catch (error) {
      throw new RepositoryError(
        `Failed to find all board objects: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Count board objects matching filters without hydrating/parsing JSON rows.
   */
  async count(filters: BoardObjectFindFilters = {}): Promise<number> {
    try {
      const conditions = this.buildFindConditions(filters);
      const query = select(this.db, { count: sql<number>`count(*)` }).from(boardObjects);
      const row =
        conditions.length > 0 ? await query.where(and(...conditions)).one() : await query.one();

      return Number(row?.count ?? 0);
    } catch (error) {
      throw new RepositoryError(
        `Failed to count board objects: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find board objects visible to a user under branch RBAC.
   *
   * Branch-bound rows require view+ access to the referenced branch. Rows
   * without a branch reference (card/layout rows) are preserved.
   */
  async findVisibleToUser(
    userId: UUID,
    filters: BoardObjectFindFilters = {},
    options: BoardObjectFindOptions = {}
  ): Promise<BoardEntityObject[]> {
    try {
      const conditions = [
        ...this.buildFindConditions(filters),
        this.buildVisibleToUserCondition(userId),
      ];
      let query = select(this.db, getTableColumns(boardObjects))
        .from(boardObjects)
        .where(and(...conditions));

      query = query.orderBy(asc(boardObjects.created_at), asc(boardObjects.object_id));
      if (options.limit !== undefined) {
        query = query.limit(options.limit);
      }
      if (options.offset !== undefined) {
        query = query.offset(options.offset);
      }

      const rows = await query.all();
      return rows.map(this.rowToEntity);
    } catch (error) {
      throw new RepositoryError(
        `Failed to find visible board objects: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Count board objects visible to a user without hydrating rows.
   */
  async countVisibleToUser(userId: UUID, filters: BoardObjectFindFilters = {}): Promise<number> {
    try {
      const conditions = [
        ...this.buildFindConditions(filters),
        this.buildVisibleToUserCondition(userId),
      ];
      const row = await select(this.db, { count: sql<number>`count(*)` })
        .from(boardObjects)
        .where(and(...conditions))
        .one();

      return Number(row?.count ?? 0);
    } catch (error) {
      throw new RepositoryError(
        `Failed to count visible board objects: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find all board objects for a board
   */
  async findByBoardId(boardId: BoardID): Promise<BoardEntityObject[]> {
    return this.findAll({ board_id: boardId });
  }

  /**
   * Find board object by object ID
   */
  async findByObjectId(objectId: string): Promise<BoardEntityObject | null> {
    try {
      const row = await select(this.db)
        .from(boardObjects)
        .where(eq(boardObjects.object_id, objectId))
        .one();

      return row ? this.rowToEntity(row) : null;
    } catch (error) {
      throw new RepositoryError(
        `Failed to find board object by object_id: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find a board object by object ID only when it is visible to the user under
   * the same branch/board RBAC predicate used by list queries.
   */
  async findVisibleByObjectId(userId: UUID, objectId: string): Promise<BoardEntityObject | null> {
    try {
      const row = await select(this.db, getTableColumns(boardObjects))
        .from(boardObjects)
        .where(and(eq(boardObjects.object_id, objectId), this.buildVisibleToUserCondition(userId)))
        .one();

      return row ? this.rowToEntity(row) : null;
    } catch (error) {
      throw new RepositoryError(
        `Failed to find visible board object by object_id: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Authorize a prospective branch-bound object before it exists.
   *
   * This deliberately uses the same correlated branch predicate as
   * `findVisibleByObjectId`; board visibility is not a substitute for access
   * to the branch being placed on that board.
   */
  async canViewBranchReference(userId: UUID, branchId: BranchID): Promise<boolean> {
    try {
      // Select from the referenced branch so a missing reference naturally
      // returns no authorization row, without first creating an object.
      const row = await select(this.db, {
        allowed: visibleBranchReferenceAccessExists(this.db, userId, sql`${branchId}`),
      })
        .from(branches)
        .where(eq(branches.branch_id, branchId))
        .one();
      return row?.allowed === true || row?.allowed === 1;
    } catch (error) {
      throw new RepositoryError(
        `Failed to authorize board object branch reference: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find board object by branch ID
   */
  async findByBranchId(branchId: BranchID): Promise<BoardEntityObject | null> {
    try {
      const row = await select(this.db)
        .from(boardObjects)
        .where(eq(boardObjects.branch_id, branchId))
        .one();

      return row ? this.rowToEntity(row) : null;
    } catch (error) {
      throw new RepositoryError(
        `Failed to find board object by branch: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find board object by card ID
   */
  async findByCardId(cardId: CardID): Promise<BoardEntityObject | null> {
    try {
      const row = await select(this.db)
        .from(boardObjects)
        .where(eq(boardObjects.card_id, cardId))
        .one();

      return row ? this.rowToEntity(row) : null;
    } catch (error) {
      throw new RepositoryError(
        `Failed to find board object by card: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Remove all board objects for a card
   */
  async removeByCardId(cardId: CardID): Promise<void> {
    try {
      await deleteFrom(this.db, boardObjects).where(eq(boardObjects.card_id, cardId)).run();
    } catch (error) {
      throw new RepositoryError(
        `Failed to remove board objects by card: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Create a board object (add branch or card to board)
   */
  async create(data: {
    board_id: BoardID;
    branch_id?: BranchID;
    card_id?: CardID;
    position: { x: number; y: number };
    size?: { width: number; height: number };
    zone_id?: string;
    compact?: boolean;
  }): Promise<BoardEntityObject> {
    try {
      validateFinitePosition(data.position, 'create');
      if (data.size) validateFiniteSize(data.size, 'create');
      // Validate: exactly one of branch_id or card_id must be provided
      if (!data.branch_id && !data.card_id) {
        throw new RepositoryError('Either branch_id or card_id is required');
      }
      if (data.branch_id && data.card_id) {
        throw new RepositoryError('Cannot set both branch_id and card_id');
      }

      // Check for duplicates
      if (data.branch_id) {
        const existing = await select(this.db)
          .from(boardObjects)
          .where(eq(boardObjects.branch_id, data.branch_id))
          .one();
        if (existing) {
          throw new RepositoryError(`Branch already on a board (object_id: ${existing.object_id})`);
        }
      }

      const newObject: BoardObjectInsert = {
        object_id: generateId(),
        board_id: data.board_id,
        branch_id: data.branch_id ?? null,
        card_id: data.card_id ?? null,
        created_at: new Date(),
        data: {
          position: data.position,
          size: data.size,
          zone_id: data.zone_id,
          compact: data.compact,
        },
      };

      await insert(this.db, boardObjects).values(newObject).run();

      // Fetch and return created object
      const row = await select(this.db)
        .from(boardObjects)
        .where(eq(boardObjects.object_id, newObject.object_id))
        .one();

      if (!row) {
        throw new RepositoryError('Failed to retrieve created board object');
      }

      return this.rowToEntity(row);
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      throw new RepositoryError(
        `Failed to create board object: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Update position of board object (preserves zone_id)
   */
  async updatePosition(
    objectId: string,
    position: { x: number; y: number }
  ): Promise<BoardEntityObject> {
    try {
      validateFinitePosition(position, objectId);
      const existing = await select(this.db)
        .from(boardObjects)
        .where(eq(boardObjects.object_id, objectId))
        .one();

      if (!existing) {
        throw new EntityNotFoundError('BoardObject', objectId);
      }

      // Preserve existing zone_id when updating position
      const existingData =
        typeof existing.data === 'string' ? JSON.parse(existing.data) : existing.data;

      await update(this.db, boardObjects)
        .set({
          data: {
            ...existingData,
            position,
          },
        })
        .where(eq(boardObjects.object_id, objectId))
        .run();

      const row = await select(this.db)
        .from(boardObjects)
        .where(eq(boardObjects.object_id, objectId))
        .one();

      if (!row) {
        throw new RepositoryError('Failed to retrieve updated board object');
      }

      return this.rowToEntity(row);
    } catch (error) {
      if (error instanceof EntityNotFoundError) throw error;
      throw new RepositoryError(
        `Failed to update board object position: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /** Update the last measured rendered size while preserving placement. */
  async updateSize(
    objectId: string,
    size: { width: number; height: number }
  ): Promise<BoardEntityObject> {
    try {
      validateFiniteSize(size, objectId);
      const existing = await select(this.db)
        .from(boardObjects)
        .where(eq(boardObjects.object_id, objectId))
        .one();
      if (!existing) throw new EntityNotFoundError('BoardObject', objectId);
      const existingData =
        typeof existing.data === 'string' ? JSON.parse(existing.data) : existing.data;
      await update(this.db, boardObjects)
        .set({
          data: {
            ...existingData,
            size,
          },
        })
        .where(eq(boardObjects.object_id, objectId))
        .run();
      const row = await select(this.db)
        .from(boardObjects)
        .where(eq(boardObjects.object_id, objectId))
        .one();
      if (!row) throw new RepositoryError('Failed to retrieve resized board object');
      return this.rowToEntity(row);
    } catch (error) {
      if (error instanceof EntityNotFoundError) throw error;
      throw new RepositoryError(
        `Failed to update board object size: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /** Update layout fields in one row write so realtime never sees half a placement. */
  async updateLayout(
    objectId: string,
    layout: {
      position?: { x: number; y: number };
      size?: { width: number; height: number };
      compact?: boolean;
    }
  ): Promise<BoardEntityObject> {
    try {
      if (layout.position) validateFinitePosition(layout.position, objectId);
      if (layout.size) validateFiniteSize(layout.size, objectId);
      const existing = await select(this.db)
        .from(boardObjects)
        .where(eq(boardObjects.object_id, objectId))
        .one();
      if (!existing) throw new EntityNotFoundError('BoardObject', objectId);
      const existingData =
        typeof existing.data === 'string' ? JSON.parse(existing.data) : existing.data;
      await update(this.db, boardObjects)
        .set({
          data: {
            ...existingData,
            ...(layout.position ? { position: layout.position } : {}),
            ...(layout.size ? { size: layout.size } : {}),
            ...(layout.compact !== undefined ? { compact: layout.compact } : {}),
          },
        })
        .where(eq(boardObjects.object_id, objectId))
        .run();
      const row = await select(this.db)
        .from(boardObjects)
        .where(eq(boardObjects.object_id, objectId))
        .one();
      if (!row) throw new RepositoryError('Failed to retrieve updated board object layout');
      return this.rowToEntity(row);
    } catch (error) {
      if (error instanceof EntityNotFoundError) throw error;
      throw new RepositoryError(
        `Failed to update board object layout: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Update layout only when the entity belongs to the authoritative board.
   * Whole-board commits use this inside the board repository transaction so a
   * caller cannot smuggle another board's placement into an otherwise valid
   * layout request.
   */
  async updateLayoutForBoard(
    boardId: BoardID,
    objectId: string,
    layout: BoardLayoutPlacementUpdate
  ): Promise<{ entity: BoardEntityObject; changed: boolean }> {
    try {
      if (
        !Number.isFinite(layout.position.x) ||
        !Number.isFinite(layout.position.y) ||
        !Number.isFinite(layout.size.width) ||
        layout.size.width <= 0 ||
        !Number.isFinite(layout.size.height) ||
        layout.size.height <= 0
      ) {
        throw new RepositoryError(
          `Board object ${objectId} requires complete finite position and positive size geometry`
        );
      }
      const condition = and(
        eq(boardObjects.object_id, objectId),
        eq(boardObjects.board_id, boardId)
      );
      const existing = await select(this.db).from(boardObjects).where(condition).one();
      if (!existing) throw new EntityNotFoundError('BoardObject', objectId);
      const existingData =
        typeof existing.data === 'string' ? JSON.parse(existing.data) : existing.data;
      const current = this.rowToEntity(existing);
      if (layout.compact !== undefined) {
        const card = existing.card_id
          ? await select(this.db, {
              board_id: cards.board_id,
              description: cards.description,
              note: cards.note,
            })
              .from(cards)
              .where(and(eq(cards.card_id, existing.card_id), eq(cards.board_id, boardId)))
              .one()
          : undefined;
        if (!isBoardEntityDensityExpandable(current.entity_type, card ?? undefined)) {
          throw new RepositoryError(
            `Board object ${objectId} does not own collapsible body content`
          );
        }
      }
      const changed =
        current.position.x !== layout.position.x ||
        current.position.y !== layout.position.y ||
        current.size?.width !== layout.size.width ||
        current.size?.height !== layout.size.height ||
        (layout.compact !== undefined && current.compact !== layout.compact);
      if (!changed) return { entity: current, changed: false };
      await update(this.db, boardObjects)
        .set({
          data: {
            ...existingData,
            position: layout.position,
            size: layout.size,
            ...(layout.compact !== undefined ? { compact: layout.compact } : {}),
          },
        })
        .where(condition)
        .run();
      const row = await select(this.db).from(boardObjects).where(condition).one();
      if (!row) throw new RepositoryError('Failed to retrieve updated board object layout');
      return { entity: this.rowToEntity(row), changed: true };
    } catch (error) {
      if (error instanceof EntityNotFoundError) throw error;
      throw new RepositoryError(
        `Failed to update board object layout: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Update zone pinning for board object
   */
  async updateZone(
    objectId: string,
    zoneId: string | undefined | null
  ): Promise<BoardEntityObject> {
    try {
      const existing = await select(this.db)
        .from(boardObjects)
        .where(eq(boardObjects.object_id, objectId))
        .one();

      if (!existing) {
        throw new EntityNotFoundError('BoardObject', objectId);
      }

      // Preserve existing position when updating zone
      const existingData =
        typeof existing.data === 'string' ? JSON.parse(existing.data) : existing.data;

      await update(this.db, boardObjects)
        .set({
          data: {
            ...existingData,
            // Convert null to undefined for consistency
            zone_id: zoneId === null ? undefined : zoneId,
          },
        })
        .where(eq(boardObjects.object_id, objectId))
        .run();

      const row = await select(this.db)
        .from(boardObjects)
        .where(eq(boardObjects.object_id, objectId))
        .one();

      if (!row) {
        throw new RepositoryError('Failed to retrieve updated board object');
      }

      return this.rowToEntity(row);
    } catch (error) {
      if (error instanceof EntityNotFoundError) throw error;
      throw new RepositoryError(
        `Failed to update board object zone: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Update shared compact presentation state while preserving placement data.
   *
   * A measured size describes one presentation mode, so it becomes stale as
   * soon as compactness changes. Drop it here and let the active renderer
   * publish a measurement for the new mode before a later layout trusts it.
   */
  async updateCompact(objectId: string, compact: boolean): Promise<BoardEntityObject> {
    const existing = await select(this.db)
      .from(boardObjects)
      .where(eq(boardObjects.object_id, objectId))
      .one();
    if (!existing) throw new EntityNotFoundError('BoardObject', objectId);
    const existingData =
      typeof existing.data === 'string' ? JSON.parse(existing.data) : existing.data;
    // Missing compact is the historical expanded state. Treat an explicit
    // false request as equal so repeated density actions neither rewrite the
    // row nor discard the authoritative measurement for the current mode.
    if ((existingData.compact === true) === compact) {
      return this.rowToEntity(existing);
    }
    const { size: _staleSize, ...placementData } = existingData;
    await update(this.db, boardObjects)
      .set({ data: { ...placementData, compact } })
      .where(eq(boardObjects.object_id, objectId))
      .run();
    const row = await select(this.db)
      .from(boardObjects)
      .where(eq(boardObjects.object_id, objectId))
      .one();
    if (!row) throw new RepositoryError('Failed to retrieve updated board object');
    return this.rowToEntity(row);
  }

  /**
   * Remove board object (remove entity from board)
   */
  async remove(objectId: string): Promise<void> {
    try {
      const result = await deleteFrom(this.db, boardObjects)
        .where(eq(boardObjects.object_id, objectId))
        .run();

      if (result.rowsAffected === 0) {
        throw new EntityNotFoundError('BoardObject', objectId);
      }
    } catch (error) {
      if (error instanceof EntityNotFoundError) throw error;
      throw new RepositoryError(
        `Failed to remove board object: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Clear zone_id on all board objects referencing a deleted zone.
   * Called when a zone is deleted to prevent stale parent references.
   */
  async clearZoneReferences(
    boardId: BoardID,
    zoneId: string,
    zonePosition?: { x: number; y: number }
  ): Promise<BoardEntityObject[]> {
    try {
      const rows = await select(this.db)
        .from(boardObjects)
        .where(eq(boardObjects.board_id, boardId))
        .all();

      const cleared: BoardEntityObject[] = [];
      for (const row of rows) {
        const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
        if (data.zone_id === zoneId) {
          const relPos = data.position ?? { x: 0, y: 0 };
          const absolutePosition = zonePosition ? toAbsolutePosition(relPos, zonePosition) : relPos;

          await update(this.db, boardObjects)
            .set({
              data: {
                position: absolutePosition,
                size: data.size,
                zone_id: undefined,
              },
            })
            .where(eq(boardObjects.object_id, row.object_id))
            .run();

          const updated = await select(this.db)
            .from(boardObjects)
            .where(eq(boardObjects.object_id, row.object_id))
            .one();
          if (updated) {
            cleared.push(this.rowToEntity(updated));
          }
        }
      }

      return cleared;
    } catch (error) {
      throw new RepositoryError(
        `Failed to clear zone references: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Remove all board objects for a branch
   */
  async removeByBranchId(branchId: BranchID): Promise<void> {
    try {
      await deleteFrom(this.db, boardObjects).where(eq(boardObjects.branch_id, branchId)).run();
    } catch (error) {
      throw new RepositoryError(
        `Failed to remove board objects by branch: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Convert database row to entity
   */
  private rowToEntity(row: BoardObjectRow): BoardEntityObject {
    const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;

    const entityType: BoardEntityType = row.card_id ? 'card' : 'branch';

    return {
      object_id: row.object_id,
      board_id: row.board_id as BoardID,
      branch_id: (row.branch_id as BranchID) ?? undefined,
      card_id: (row.card_id as CardID) ?? undefined,
      entity_type: entityType,
      position: data.position,
      size: data.size,
      compact: data.compact === true,
      zone_id: data.zone_id,
      created_at: new Date(row.created_at).toISOString(),
    };
  }
}
