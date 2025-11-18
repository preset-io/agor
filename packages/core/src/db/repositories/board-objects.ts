/**
 * Board Objects Repository
 *
 * Manages positioned entities (sessions and worktrees) on boards.
 * Phase 1: Hybrid support for both session cards and worktree cards.
 */

import type { BoardEntityObject, BoardID, WorktreeID } from '@agor/core/types';
import { eq } from 'drizzle-orm';
import { generateId } from '../../lib/ids';
import type { Database } from '../client';
import { deleteFrom, insert, select, update } from '../database-wrapper';
import { type BoardObjectInsert, type BoardObjectRow, boardObjects } from '../schema';
import { EntityNotFoundError, RepositoryError } from './base';

/**
 * Board object repository implementation
 */
export class BoardObjectRepository {
  constructor(private db: Database) {}

  /**
   * Find all board objects
   */
  async findAll(): Promise<BoardEntityObject[]> {
    try {
      const rows = await select(this.db).from(boardObjects).all();

      return rows.map(this.rowToEntity);
    } catch (error) {
      throw new RepositoryError(
        `Failed to find all board objects: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find all board objects for a board
   */
  async findByBoardId(boardId: BoardID): Promise<BoardEntityObject[]> {
    try {
      const rows = await select(this.db)
        .from(boardObjects)
        .where(eq(boardObjects.board_id, boardId))
        .all();

      return rows.map(this.rowToEntity);
    } catch (error) {
      throw new RepositoryError(
        `Failed to find board objects: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
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
   * Find board object by worktree ID
   */
  async findByWorktreeId(worktreeId: WorktreeID): Promise<BoardEntityObject | null> {
    try {
      const row = await select(this.db)
        .from(boardObjects)
        .where(eq(boardObjects.worktree_id, worktreeId))
        .one();

      return row ? this.rowToEntity(row) : null;
    } catch (error) {
      throw new RepositoryError(
        `Failed to find board object by worktree: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Create a board object (add worktree to board)
   */
  async create(data: {
    board_id: BoardID;
    worktree_id: WorktreeID;
    position: { x: number; y: number };
    zone_id?: string;
  }): Promise<BoardEntityObject> {
    try {
      // Check if worktree already on a board
      const existing = await select(this.db)
        .from(boardObjects)
        .where(eq(boardObjects.worktree_id, data.worktree_id))
        .one();

      if (existing) {
        throw new RepositoryError(`Worktree already on a board (object_id: ${existing.object_id})`);
      }

      const newObject: BoardObjectInsert = {
        object_id: generateId(),
        board_id: data.board_id,
        worktree_id: data.worktree_id,
        created_at: new Date(),
        data: {
          position: data.position,
          zone_id: data.zone_id,
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
            position,
            zone_id: existingData.zone_id,
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
            position: existingData.position,
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
   * Remove all board objects for a worktree
   */
  async removeByWorktreeId(worktreeId: WorktreeID): Promise<void> {
    try {
      await deleteFrom(this.db, boardObjects).where(eq(boardObjects.worktree_id, worktreeId)).run();
    } catch (error) {
      throw new RepositoryError(
        `Failed to remove board objects by worktree: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Convert database row to entity
   */
  private rowToEntity(row: BoardObjectRow): BoardEntityObject {
    const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;

    return {
      object_id: row.object_id,
      board_id: row.board_id as BoardID,
      worktree_id: row.worktree_id as WorktreeID,
      position: data.position,
      zone_id: data.zone_id,
      created_at: new Date(row.created_at).toISOString(),
    };
  }
}
