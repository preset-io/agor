/**
 * Board Repository
 *
 * Type-safe CRUD operations for boards with short ID support.
 */

import type { Board, BoardObject, UUID } from '@agor/core/types';
import { and, eq, like, ne } from 'drizzle-orm';
import { formatShortId, generateId } from '../../lib/ids';
import { generateSlug } from '../../lib/slugs';
import type { Database } from '../client';
import { deleteFrom, insert, select, update } from '../database-wrapper';
import { type BoardInsert, type BoardRow, boards } from '../schema';
import {
  AmbiguousIdError,
  type BaseRepository,
  EntityNotFoundError,
  RepositoryError,
} from './base';

/**
 * Board repository implementation
 */
export class BoardRepository implements BaseRepository<Board, Partial<Board>> {
  constructor(private db: Database) {}

  /**
   * Convert database row to Board type
   */
  private rowToBoard(row: BoardRow): Board {
    const data = row.data as {
      description?: string;
      color?: string;
      icon?: string;
      background_color?: string;
      objects?: Record<string, BoardObject>;
      custom_context?: Record<string, unknown>;
    };

    return {
      board_id: row.board_id as UUID,
      name: row.name,
      slug: row.slug !== null ? row.slug : undefined,
      created_at: new Date(row.created_at).toISOString(),
      last_updated: row.updated_at
        ? new Date(row.updated_at).toISOString()
        : new Date(row.created_at).toISOString(),
      created_by: row.created_by,
      ...data,
    };
  }

  /**
   * Convert Board to database insert format
   */
  private boardToInsert(board: Partial<Board>): BoardInsert {
    const now = Date.now();
    const boardId = board.board_id ?? generateId();

    return {
      board_id: boardId,
      name: board.name ?? 'Untitled Board',
      slug: board.slug !== undefined ? board.slug : null,
      created_at: new Date(board.created_at ?? now),
      updated_at: board.last_updated ? new Date(board.last_updated) : new Date(now),
      created_by: board.created_by ?? 'anonymous',
      data: {
        description: board.description,
        color: board.color,
        icon: board.icon,
        background_color: board.background_color,
        objects: board.objects,
        custom_context: board.custom_context,
      },
    };
  }

  /**
   * Resolve short ID to full ID
   */
  private async resolveId(id: string): Promise<string> {
    // If already a full UUID, return as-is
    if (id.length === 36 && id.includes('-')) {
      return id;
    }

    // Short ID - need to resolve
    const normalized = id.replace(/-/g, '').toLowerCase();
    const pattern = `${normalized}%`;

    const results = await select(this.db).from(boards).where(like(boards.board_id, pattern)).all();

    if (results.length === 0) {
      throw new EntityNotFoundError('Board', id);
    }

    if (results.length > 1) {
      throw new AmbiguousIdError(
        'Board',
        id,
        results.map((r: { board_id: string }) => formatShortId(r.board_id as UUID))
      );
    }

    return results[0].board_id as UUID;
  }

  /**
   * Generate a unique slug for a board.
   * Returns empty string if the name contains no alphanumeric characters.
   *
   * @param name - Board name to slugify
   * @param excludeId - Optional board ID to exclude from uniqueness check
   * @returns Unique slug, or empty string if name has no alphanumeric chars
   */
  private async generateUniqueSlug(name: string, excludeId?: string): Promise<string> {
    const baseSlug = generateSlug(name);
    if (!baseSlug) {
      // Name contains no alphanumeric chars (e.g., emoji-only)
      // Return empty string - caller will store null
      return '';
    }

    // Check if base slug is available
    const existingQuery = excludeId
      ? select(this.db)
          .from(boards)
          .where(and(eq(boards.slug, baseSlug), ne(boards.board_id, excludeId)))
      : select(this.db).from(boards).where(eq(boards.slug, baseSlug));

    const existing = await existingQuery.one();
    if (!existing) return baseSlug;

    // Find next available suffix
    let counter = 1;
    while (true) {
      const candidateSlug = `${baseSlug}-${counter}`;
      const checkQuery = excludeId
        ? select(this.db)
            .from(boards)
            .where(and(eq(boards.slug, candidateSlug), ne(boards.board_id, excludeId)))
        : select(this.db).from(boards).where(eq(boards.slug, candidateSlug));

      const found = await checkQuery.one();
      if (!found) return candidateSlug;
      counter++;
    }
  }

  /**
   * Create a new board
   */
  async create(data: Partial<Board>): Promise<Board> {
    try {
      // Auto-generate slug if not provided
      if (!data.slug && data.name) {
        const generatedSlug = await this.generateUniqueSlug(data.name);
        // Only set slug if we got a non-empty result
        // Empty string means name has no alphanumeric chars - store as null
        data.slug = generatedSlug || undefined;
      }

      const insertData = this.boardToInsert(data);
      await insert(this.db, boards).values(insertData).run();

      const row = await select(this.db)
        .from(boards)
        .where(eq(boards.board_id, insertData.board_id))
        .one();

      if (!row) {
        throw new RepositoryError('Failed to retrieve created board');
      }

      return this.rowToBoard(row);
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      throw new RepositoryError(
        `Failed to create board: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find board by ID (supports short ID)
   */
  async findById(id: string): Promise<Board | null> {
    try {
      const fullId = await this.resolveId(id);
      const row = await select(this.db).from(boards).where(eq(boards.board_id, fullId)).one();

      return row ? this.rowToBoard(row) : null;
    } catch (error) {
      if (error instanceof EntityNotFoundError) return null;
      if (error instanceof AmbiguousIdError) throw error;
      throw new RepositoryError(
        `Failed to find board: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find board by slug
   */
  async findBySlug(slug: string): Promise<Board | null> {
    try {
      const row = await select(this.db).from(boards).where(eq(boards.slug, slug)).one();

      return row ? this.rowToBoard(row) : null;
    } catch (error) {
      throw new RepositoryError(
        `Failed to find board by slug: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find board by slug or ID (for URL routing)
   *
   * Always tries slug lookup first, then falls back to ID lookup.
   * This enables beautiful URLs like /b/my-board while still supporting /b/550e8400
   * and handles edge cases like hex-looking slugs (e.g., board named "deadbeef")
   */
  async findBySlugOrId(param: string): Promise<Board | null> {
    // Always try slug lookup first, regardless of what the param looks like
    // This handles edge cases where a board name looks like a hex ID (e.g., "deadbeef")
    const bySlug = await this.findBySlug(param);
    if (bySlug) return bySlug;

    // Fall back to ID lookup (short or full UUID)
    return this.findById(param);
  }

  /**
   * Find all boards
   */
  async findAll(): Promise<Board[]> {
    try {
      const rows = await select(this.db).from(boards).all();
      return rows.map((row: BoardRow) => this.rowToBoard(row));
    } catch (error) {
      throw new RepositoryError(
        `Failed to find all boards: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Update board by ID
   */
  async update(id: string, updates: Partial<Board>): Promise<Board> {
    try {
      const fullId = await this.resolveId(id);

      // Get current board to merge updates
      const current = await this.findById(fullId);
      if (!current) {
        throw new EntityNotFoundError('Board', id);
      }

      const merged = { ...current, ...updates };
      const insertData = this.boardToInsert(merged);

      await update(this.db, boards)
        .set({
          name: insertData.name,
          slug: insertData.slug,
          updated_at: new Date(),
          data: insertData.data,
        })
        .where(eq(boards.board_id, fullId))
        .run();

      const updated = await this.findById(fullId);
      if (!updated) {
        throw new RepositoryError('Failed to retrieve updated board');
      }

      return updated;
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      if (error instanceof EntityNotFoundError) throw error;
      throw new RepositoryError(
        `Failed to update board: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Delete board by ID
   */
  async delete(id: string): Promise<void> {
    try {
      const fullId = await this.resolveId(id);

      const result = await deleteFrom(this.db, boards).where(eq(boards.board_id, fullId)).run();

      if (result.rowsAffected === 0) {
        throw new EntityNotFoundError('Board', id);
      }
    } catch (error) {
      if (error instanceof EntityNotFoundError) throw error;
      throw new RepositoryError(
        `Failed to delete board: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * DEPRECATED: Add session to board
   * Use board-objects service instead
   */
  // async addSession(boardId: string, sessionId: string): Promise<Board> {
  //   throw new RepositoryError('addSession is deprecated - use board-objects service');
  // }

  /**
   * DEPRECATED: Remove session from board
   * Use board-objects service instead
   */
  // async removeSession(boardId: string, sessionId: string): Promise<Board> {
  //   throw new RepositoryError('removeSession is deprecated - use board-objects service');
  // }

  /**
   * Get default board (or create if doesn't exist)
   */
  async getDefault(): Promise<Board> {
    try {
      const defaultBoard = await this.findBySlug('default');

      if (defaultBoard) {
        return defaultBoard;
      }

      // Create default board
      return this.create({
        name: 'Main Board',
        slug: 'default',
        description: 'Main board for all sessions',
        color: '#1677ff',
        icon: '⭐',
      });
    } catch (error) {
      throw new RepositoryError(
        `Failed to get default board: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Atomically add or update a board object (text label or zone)
   *
   * Uses read-modify-write approach with proper serialization via update() method.
   */
  async upsertBoardObject(
    boardId: string,
    objectId: string,
    objectData: BoardObject
  ): Promise<Board> {
    try {
      const fullId = await this.resolveId(boardId);

      const current = await this.findById(fullId);
      if (!current) {
        throw new EntityNotFoundError('Board', boardId);
      }

      // Add or update the object
      const updatedObjects = { ...(current.objects || {}), [objectId]: objectData };

      // Use the standard update method to ensure proper serialization
      return this.update(fullId, { objects: updatedObjects });
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      if (error instanceof EntityNotFoundError) throw error;
      throw new RepositoryError(
        `Failed to upsert board object: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Atomically remove a board object
   */
  async removeBoardObject(boardId: string, objectId: string): Promise<Board> {
    try {
      const fullId = await this.resolveId(boardId);

      const current = await this.findById(fullId);
      if (!current) {
        throw new EntityNotFoundError('Board', boardId);
      }

      // Remove the object
      const updatedObjects = { ...(current.objects || {}) };
      delete updatedObjects[objectId];

      // Use the standard update method to ensure proper serialization
      return this.update(fullId, { objects: updatedObjects });
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      if (error instanceof EntityNotFoundError) throw error;
      throw new RepositoryError(
        `Failed to remove board object: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Batch upsert multiple objects (sequential atomic updates)
   *
   * Note: Not a single transaction - each object is updated atomically.
   * This is safe for independent objects but may have partial failures.
   */
  async batchUpsertBoardObjects(
    boardId: string,
    objects: Record<string, BoardObject>
  ): Promise<Board> {
    try {
      for (const [objectId, objectData] of Object.entries(objects)) {
        await this.upsertBoardObject(boardId, objectId, objectData);
      }

      const fullId = await this.resolveId(boardId);
      const updated = await this.findById(fullId);
      if (!updated) {
        throw new RepositoryError('Failed to retrieve updated board');
      }

      return updated;
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      if (error instanceof EntityNotFoundError) throw error;
      throw new RepositoryError(
        `Failed to batch upsert board objects: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * DEPRECATED: Delete a zone and handle associated sessions
   * TODO: Reimplement using board-objects table
   */
  async deleteZone(
    boardId: string,
    objectId: string,
    _deleteAssociatedSessions: boolean
  ): Promise<{ board: Board; affectedSessions: string[] }> {
    // For now, just delete the zone object from annotations
    // Session pinning will be handled by board-objects table in the future
    const updatedBoard = await this.removeBoardObject(boardId, objectId);
    return {
      board: updatedBoard,
      affectedSessions: [], // No sessions to track yet
    };
  }
}
