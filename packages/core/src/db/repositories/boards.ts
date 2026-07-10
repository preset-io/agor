/**
 * Board Repository
 *
 * Type-safe CRUD operations for boards with short ID support.
 */

import type {
  Board,
  BoardAccessMode,
  BoardExportBlob,
  BoardID,
  BoardObject,
  Branch,
  BranchPermissionLevel,
  UUID,
} from '@agor/core/types';
import { isTeammate } from '@agor/core/types';
import { and, eq, inArray, isNull, like, ne, type SQL } from 'drizzle-orm';
import * as yaml from 'js-yaml';
import { getBaseUrl } from '../../config/config-manager';
import { generateId } from '../../lib/ids';
import { generateSlug } from '../../lib/slugs';
import { normalizeExactEmojiShortcode } from '../../utils/emoji-shortcodes';
import { getBoardUrl } from '../../utils/url';
import type { Database } from '../client';
import { deleteFrom, insert, select, update } from '../database-wrapper';
import {
  type BoardInsert,
  type BoardRow,
  boardGroupGrants,
  boardOwners,
  boards,
  groupMemberships,
  groups,
} from '../schema';
import {
  AmbiguousIdError,
  attachHiddenTenant,
  type BaseRepository,
  EntityNotFoundError,
  RESOLVE_SHORT_ID_FETCH_LIMIT,
  RepositoryError,
  resolveByShortIdPrefix,
} from './base';
import { visibleBoardAccessCondition } from './branch-access';
import { BranchRepository } from './branches';

const BOARD_ACCESS_MODES = ['private', 'shared'] as const;
const BOARD_DEFAULT_FS_ACCESS = ['none', 'read', 'write'] as const;
const BOARD_DEFAULT_OTHERS_CAN = ['none', 'view', 'session', 'prompt', 'all'] as const;

function validateBoardPermissionDefaults(board: Partial<Board>): void {
  if (board.access_mode !== undefined && !BOARD_ACCESS_MODES.includes(board.access_mode)) {
    throw new RepositoryError(`Invalid board access_mode: ${board.access_mode}`);
  }
  if (
    board.default_others_can !== undefined &&
    !BOARD_DEFAULT_OTHERS_CAN.includes(board.default_others_can)
  ) {
    throw new RepositoryError(`Invalid board default_others_can: ${board.default_others_can}`);
  }
  if (
    board.default_others_fs_access !== undefined &&
    !BOARD_DEFAULT_FS_ACCESS.includes(board.default_others_fs_access)
  ) {
    throw new RepositoryError(
      `Invalid board default_others_fs_access: ${board.default_others_fs_access}`
    );
  }
}

/**
 * Board repository implementation
 */
export class BoardRepository implements BaseRepository<Board, Partial<Board>> {
  constructor(private db: Database) {}

  /**
   * Convert database row to Board type
   *
   * @param row - Database row
   * @param baseUrl - Base URL for generating board URLs
   * @param options.lean - Omit the heavy `objects` / `custom_css` annotations
   *   (used by the boards list path; single-board reads always stay full).
   */
  private rowToBoard(row: BoardRow, baseUrl?: string, options?: { lean?: boolean }): Board {
    const data = row.data as {
      description?: string;
      color?: string;
      icon?: string;
      background_color?: string;
      custom_css?: string;
      objects?: Record<string, BoardObject>;
      custom_context?: Record<string, unknown>;
      access_mode?: BoardAccessMode;
      default_others_can?: BranchPermissionLevel;
      default_others_fs_access?: 'none' | 'read' | 'write';
      default_dangerously_allow_session_sharing?: boolean;
    };

    const boardId = row.board_id as UUID;
    const slug = row.slug !== null ? row.slug : undefined;
    const url = baseUrl ? getBoardUrl(boardId, slug, baseUrl) : '';

    // Lean projection drops the two heavy JSON fields nested in `data` (zones /
    // text / markdown annotations + per-board CSS). A client `$select` can't do
    // this — they live inside the `data` column, not as top-level columns.
    const { objects: _objects, custom_css: _customCss, ...leanData } = data;
    const effectiveData = options?.lean ? leanData : data;

    return attachHiddenTenant(
      {
        board_id: boardId,
        name: row.name,
        slug,
        primary_teammate_id:
          ((row.primary_teammate_id ?? row.primary_assistant_id) as Board['primary_teammate_id']) ??
          undefined,
        created_at: new Date(row.created_at).toISOString(),
        last_updated: row.updated_at
          ? new Date(row.updated_at).toISOString()
          : new Date(row.created_at).toISOString(),
        created_by: row.created_by,
        url,
        archived: Boolean(row.archived),
        archived_at: row.archived_at ? new Date(row.archived_at).toISOString() : undefined,
        archived_by: row.archived_by ?? undefined,
        ...effectiveData,
        icon: normalizeExactEmojiShortcode(data.icon),
        access_mode: data.access_mode ?? 'shared',
        default_others_can: data.default_others_can ?? 'session',
        default_others_fs_access: data.default_others_fs_access ?? 'read',
        default_dangerously_allow_session_sharing:
          data.default_dangerously_allow_session_sharing ?? false,
      },
      row
    );
  }

  /**
   * Convert Board to database insert format
   */
  private boardToInsert(board: Partial<Board>): BoardInsert {
    validateBoardPermissionDefaults(board);
    const now = Date.now();
    const boardId = board.board_id ?? generateId();
    if (!board.created_by) {
      throw new RepositoryError('Board must have a created_by');
    }

    return {
      board_id: boardId,
      name: board.name ?? 'Untitled Board',
      slug: board.slug !== undefined ? board.slug : null,
      primary_teammate_id: board.primary_teammate_id ?? null,
      created_at: new Date(board.created_at ?? now),
      updated_at: board.last_updated ? new Date(board.last_updated) : new Date(now),
      created_by: board.created_by,
      data: {
        description: board.description,
        access_mode: board.access_mode ?? 'shared',
        default_others_can: board.default_others_can ?? 'session',
        default_others_fs_access: board.default_others_fs_access ?? 'read',
        default_dangerously_allow_session_sharing:
          board.default_dangerously_allow_session_sharing ?? false,
        color: board.color,
        icon: normalizeExactEmojiShortcode(board.icon),
        background_color: board.background_color,
        custom_css: board.custom_css,
        objects: board.objects,
        custom_context: board.custom_context,
      },
    };
  }

  private rejectGenericPrimaryTeammateWrite(data: Partial<Board>, operation: string): void {
    if (Object.hasOwn(data, 'primary_teammate_id')) {
      throw new RepositoryError(
        `Cannot ${operation} primary_teammate_id via generic board writes; use setPrimaryTeammate() or clearPrimaryTeammate()`
      );
    }
  }

  /**
   * Resolve short ID to full ID via the centralized helper.
   */
  private async resolveId(id: string): Promise<string> {
    return resolveByShortIdPrefix(id, 'Board', async (pattern) => {
      const rows = await select(this.db)
        .from(boards)
        .where(like(boards.board_id, pattern))
        .limit(RESOLVE_SHORT_ID_FETCH_LIMIT)
        .all();
      return rows.map((r: { board_id: string }) => r.board_id);
    });
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
      this.rejectGenericPrimaryTeammateWrite(data, 'set');
      const boardId = data.board_id ?? generateId();
      const baseUrl = await getBaseUrl();
      let finalSlug: string | undefined;

      if (data.slug === null) {
        finalSlug = undefined;
      } else {
        const slugSource = data.slug ?? data.name ?? 'board';
        if (slugSource) {
          const uniqueSlug = await this.generateUniqueSlug(slugSource);
          if (uniqueSlug) {
            finalSlug = uniqueSlug;
          }
        }
      }

      const insertData = this.boardToInsert({
        ...data,
        board_id: boardId,
        slug: finalSlug,
      });

      await insert(this.db, boards).values(insertData).run();

      const row = await select(this.db)
        .from(boards)
        .where(eq(boards.board_id, insertData.board_id))
        .one();

      if (!row) {
        throw new RepositoryError('Failed to retrieve created board');
      }

      return this.rowToBoard(row, baseUrl);
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
      const baseUrl = await getBaseUrl();
      const row = await select(this.db).from(boards).where(eq(boards.board_id, fullId)).one();

      return row ? this.rowToBoard(row, baseUrl) : null;
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
      const baseUrl = await getBaseUrl();
      const row = await select(this.db).from(boards).where(eq(boards.slug, slug)).one();

      return row ? this.rowToBoard(row, baseUrl) : null;
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

  private visibleBoardCondition(userId: UUID): SQL {
    return visibleBoardAccessCondition(this.db, userId);
  }

  /**
   * Find all boards (with optional filters and projection).
   *
   * The `boardIds`, `archived`, and `visibleToUserId` filters let the list read
   * path (`BoardsService.find` via the adapter's `fetchData`) push
   * high-selectivity predicates — including board RBAC visibility — into SQL so
   * it no longer materializes the whole table before filtering in memory.
   *
   * @param filter - Optional filters and projection
   * @param filter.archived - Filter to an exact archived state
   * @param filter.boardIds - Restrict to a set of board IDs (empty set yields no
   *   rows, matching an `{ $in: [] }` filter)
   * @param filter.visibleToUserId - Restrict to boards visible to this user
   *   under branch RBAC.
   * @param filter.lean - Omit each board's heavy `objects` / `custom_css`
   *   annotations from the result. The displayed board's full record is fetched
   *   separately via `findById`, so the list path never needs them. RBAC and
   *   the id pushdown stay in force, so the lean list can never widen visibility.
   */
  async findAll(filter?: {
    archived?: boolean;
    boardIds?: BoardID[];
    visibleToUserId?: UUID;
    lean?: boolean;
  }): Promise<Board[]> {
    try {
      // An explicit empty id set can never match a row; short-circuit so we skip
      // the read entirely and avoid emitting an empty `IN ()` predicate.
      if (filter?.boardIds !== undefined && filter.boardIds.length === 0) {
        return [];
      }

      const conditions = [];
      if (filter?.archived !== undefined) {
        conditions.push(eq(boards.archived, filter.archived));
      }
      if (filter?.boardIds !== undefined) {
        conditions.push(inArray(boards.board_id, filter.boardIds));
      }
      if (filter?.visibleToUserId) {
        conditions.push(this.visibleBoardCondition(filter.visibleToUserId));
      }

      const baseUrl = await getBaseUrl();
      const query = select(this.db).from(boards);
      const rows =
        conditions.length > 0 ? await query.where(and(...conditions)).all() : await query.all();
      return rows.map((row: BoardRow) => this.rowToBoard(row, baseUrl, { lean: filter?.lean }));
    } catch (error) {
      throw new RepositoryError(
        `Failed to find all boards: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find the ids of boards visible to a user under branch RBAC.
   *
   * A board is visible if either:
   * - The user created it (self-created boards are always visible, even when
   *   they carry no branches yet), OR
   * - At least one branch on the board is accessible to the user, OR
   * - The board's primary teammate branch is accessible to the user, even if
   *   that teammate branch currently lives on another board.
   *
   * Implemented as a single correlated `EXISTS` subquery against `boards` so
   * each board row is emitted at most once — no `DISTINCT` or `UNION` needed.
   * Portable SQL: `EXISTS`, `LEFT JOIN`, `IN`, `OR`, `IS NOT NULL` behave
   * identically on SQLite and Postgres, and both planners short-circuit the
   * semi-join on the first qualifying branch per board.
   *
   * Should only be called when branch RBAC is enabled.
   *
   * @param userId - User ID to check board visibility for
   * @returns Array of board ids the user can see
   */
  async findVisibleBoardIds(userId: UUID): Promise<string[]> {
    const rows = await select(this.db, { board_id: boards.board_id })
      .from(boards)
      .where(this.visibleBoardCondition(userId))
      .all();
    return rows.map((r: { board_id: string }) => r.board_id);
  }

  async isOwner(boardId: string, userId: UUID): Promise<boolean> {
    const row = await select(this.db)
      .from(boardOwners)
      .where(and(eq(boardOwners.board_id, boardId), eq(boardOwners.user_id, userId)))
      .one();
    return row != null;
  }

  async canMutate(boardId: string, userId: UUID): Promise<boolean> {
    const board = await this.findById(boardId);
    if (!board) throw new EntityNotFoundError('Board', boardId);
    if (board.created_by === userId) return true;
    if (await this.isOwner(board.board_id, userId)) return true;
    if (board.access_mode === 'private') return false;

    const row = await select(this.db)
      .from(boardGroupGrants)
      .innerJoin(
        groupMemberships,
        and(
          eq(groupMemberships.group_id, boardGroupGrants.group_id),
          eq(groupMemberships.user_id, userId)
        )
      )
      .innerJoin(
        groups,
        and(eq(groups.group_id, boardGroupGrants.group_id), eq(groups.archived, false))
      )
      .where(and(eq(boardGroupGrants.board_id, board.board_id), eq(boardGroupGrants.can, 'all')))
      .one();

    return row != null;
  }

  async canView(boardId: string, userId: UUID): Promise<boolean> {
    const board = await this.findById(boardId);
    if (!board) throw new EntityNotFoundError('Board', boardId);
    if (board.access_mode === 'shared') return true;
    return (await this.findVisibleBoardIds(userId)).includes(board.board_id);
  }

  async getOwners(boardId: string): Promise<UUID[]> {
    const board = await this.findById(boardId);
    if (!board) throw new EntityNotFoundError('Board', boardId);
    const rows = await select(this.db)
      .from(boardOwners)
      .where(eq(boardOwners.board_id, board.board_id))
      .all();
    return rows.map((row: { user_id: string }) => row.user_id as UUID);
  }

  async addOwner(boardId: string, userId: UUID): Promise<void> {
    const board = await this.findById(boardId);
    if (!board) throw new EntityNotFoundError('Board', boardId);
    if (await this.isOwner(board.board_id, userId)) return;
    await insert(this.db, boardOwners)
      .values({
        board_id: board.board_id,
        user_id: userId,
        created_at: new Date(),
      })
      .run();
  }

  async removeOwner(boardId: string, userId: UUID): Promise<void> {
    const board = await this.findById(boardId);
    if (!board) throw new EntityNotFoundError('Board', boardId);
    await deleteFrom(this.db, boardOwners)
      .where(and(eq(boardOwners.board_id, board.board_id), eq(boardOwners.user_id, userId)))
      .run();
  }

  /**
   * Update board by ID
   */
  async update(id: string, updates: Partial<Board>): Promise<Board> {
    try {
      this.rejectGenericPrimaryTeammateWrite(updates, 'set');
      const fullId = await this.resolveId(id);

      // Get current board to merge updates
      const current = await this.findById(fullId);
      if (!current) {
        throw new EntityNotFoundError('Board', id);
      }

      const slugUpdateProvided = Object.hasOwn(updates, 'slug');
      let nextSlug: string | undefined = current.slug;

      if (slugUpdateProvided) {
        const slugValue = updates.slug;
        if (!slugValue) {
          nextSlug = undefined;
        } else {
          const uniqueSlug = await this.generateUniqueSlug(slugValue, fullId);
          nextSlug = uniqueSlug || undefined;
        }
      }

      const merged = {
        ...current,
        ...updates,
        ...(slugUpdateProvided ? { slug: nextSlug } : {}),
      };
      const insertData = this.boardToInsert(merged);

      const setData: Record<string, unknown> = {
        name: insertData.name,
        slug: insertData.slug,
        primary_teammate_id: insertData.primary_teammate_id,
        updated_at: new Date(),
        data: insertData.data,
      };

      // Include archive fields if provided
      if (updates.archived !== undefined) setData.archived = updates.archived;
      if (Object.hasOwn(updates, 'archived_at')) {
        setData.archived_at = updates.archived_at ? new Date(updates.archived_at) : null;
      }
      if (Object.hasOwn(updates, 'archived_by')) {
        setData.archived_by = updates.archived_by ?? null;
      }

      await update(this.db, boards).set(setData).where(eq(boards.board_id, fullId)).run();

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
   * Get the branch designated as this board's primary teammate.
   */
  async getPrimaryTeammate(boardId: string): Promise<Branch | null> {
    try {
      const board = await this.findById(boardId);
      if (!board?.primary_teammate_id) return null;

      const branchRepo = new BranchRepository(this.db);
      return branchRepo.findById(board.primary_teammate_id);
    } catch (error) {
      if (error instanceof EntityNotFoundError) return null;
      if (error instanceof AmbiguousIdError) throw error;
      throw new RepositoryError(
        `Failed to get primary teammate: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Set a board's primary teammate after validating that the branch is an
   * teammate branch already attached to the board.
   */
  async setPrimaryTeammate(boardId: string, branchId: string): Promise<Board> {
    try {
      const fullBoardId = await this.resolveId(boardId);
      const board = await this.findById(fullBoardId);
      if (!board) throw new EntityNotFoundError('Board', boardId);

      const branch = await this.getValidatedPrimaryTeammateBranch(fullBoardId, branchId);

      await update(this.db, boards)
        .set({
          primary_teammate_id: branch.branch_id,
          updated_at: new Date(),
        })
        .where(eq(boards.board_id, fullBoardId))
        .run();

      const updated = await this.findById(fullBoardId);
      if (!updated) throw new RepositoryError('Failed to retrieve updated board');
      return updated;
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      if (error instanceof EntityNotFoundError) throw error;
      if (error instanceof AmbiguousIdError) throw error;
      throw new RepositoryError(
        `Failed to set primary teammate: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Set a board's primary teammate only when it is currently unset.
   *
   * Returns the updated board when this call wins the race, or null when the
   * board already had a primary teammate by the time the conditional update
   * ran. The same branch/board/teammate invariants as setPrimaryTeammate()
   * are validated before attempting the conditional write.
   */
  async setPrimaryTeammateIfUnset(boardId: string, branchId: string): Promise<Board | null> {
    try {
      const fullBoardId = await this.resolveId(boardId);
      const branch = await this.getValidatedPrimaryTeammateBranch(fullBoardId, branchId);

      const result = await update(this.db, boards)
        .set({
          primary_teammate_id: branch.branch_id,
          updated_at: new Date(),
        })
        .where(and(eq(boards.board_id, fullBoardId), isNull(boards.primary_teammate_id)))
        .run();

      if (result.rowsAffected === 0) return null;

      const updated = await this.findById(fullBoardId);
      if (!updated) throw new RepositoryError('Failed to retrieve updated board');
      return updated;
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      if (error instanceof EntityNotFoundError) throw error;
      if (error instanceof AmbiguousIdError) throw error;
      throw new RepositoryError(
        `Failed to set primary teammate if unset: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Clear a board's primary teammate only if it still points at branchId.
   *
   * This keeps board metadata consistent when a teammate branch is moved off
   * a board without clearing a newer primary teammate assignment by mistake.
   */
  async clearPrimaryTeammateIfMatches(boardId: string, branchId: string): Promise<Board | null> {
    try {
      const fullBoardId = await this.resolveId(boardId);
      const branch = await new BranchRepository(this.db).findById(branchId);
      if (!branch) throw new EntityNotFoundError('Branch', branchId);

      const result = await update(this.db, boards)
        .set({ primary_teammate_id: null, updated_at: new Date() })
        .where(
          and(eq(boards.board_id, fullBoardId), eq(boards.primary_teammate_id, branch.branch_id))
        )
        .run();

      if (result.rowsAffected === 0) return null;

      const updated = await this.findById(fullBoardId);
      if (!updated) throw new EntityNotFoundError('Board', boardId);
      return updated;
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      if (error instanceof EntityNotFoundError) throw error;
      if (error instanceof AmbiguousIdError) throw error;
      throw new RepositoryError(
        `Failed to clear primary teammate if matched: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Clear a board's primary teammate pointer without deleting either entity.
   */
  async clearPrimaryTeammate(boardId: string): Promise<Board> {
    try {
      const fullBoardId = await this.resolveId(boardId);
      await update(this.db, boards)
        .set({ primary_teammate_id: null, updated_at: new Date() })
        .where(eq(boards.board_id, fullBoardId))
        .run();

      const updated = await this.findById(fullBoardId);
      if (!updated) throw new EntityNotFoundError('Board', boardId);
      return updated;
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      if (error instanceof EntityNotFoundError) throw error;
      if (error instanceof AmbiguousIdError) throw error;
      throw new RepositoryError(
        `Failed to clear primary teammate: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  private async getValidatedPrimaryTeammateBranch(
    fullBoardId: string,
    branchId: string
  ): Promise<Branch> {
    const branchRepo = new BranchRepository(this.db);
    const branch = await branchRepo.findById(branchId);
    if (!branch) throw new EntityNotFoundError('Branch', branchId);

    if (branch.board_id !== fullBoardId) {
      throw new RepositoryError('Primary teammate branch must belong to the board');
    }
    if (!isTeammate(branch)) {
      throw new RepositoryError('Primary teammate branch must be a teammate branch');
    }
    if (branch.archived) {
      throw new RepositoryError('Primary teammate branch must be active');
    }

    return branch;
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

      // Create default board with the legacy sentinel; the first-run admin
      // bootstrap re-attributes it to the bootstrapped admin on next start.
      const { LEGACY_ANONYMOUS_OWNER_ID } = await import('../first-run-bootstrap');
      return this.create({
        name: 'Main Board',
        slug: 'default',
        description: 'Main board for all sessions',
        color: '#1677ff',
        icon: '⭐',
        created_by: LEGACY_ANONYMOUS_OWNER_ID,
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
   * Shallow-merge field patches into existing board objects in a single
   * read-modify-write.
   *
   * Unlike upsertBoardObject (which fully replaces the object value, dropping
   * omitted fields), this overwrites ONLY the provided keys and leaves the rest
   * of each object intact — so a narrow change (e.g. a zIndex reorder) has a
   * smaller blast radius and won't clobber a field edited via a different patch
   * call. Multiple objects in one call are merged before a single write, so a
   * forward/backward swap touches both neighbors in one update.
   *
   * Objects that no longer exist are SKIPPED, never re-created — so a swap can't
   * resurrect a neighbor deleted between the client's read and this write.
   *
   * Only an explicit allowlist of fields can be merged (currently just `zIndex`,
   * which is also clamped into the board-object band [1, 499] so it can never be
   * pushed onto the card (500) / comment (1000) layers). Any other key in a
   * patch is ignored, so this narrow action cannot reshape an object (e.g. flip
   * its `type`) the way a full upsert could.
   *
   * NOTE: this is NOT atomic against concurrent writers. Like every other board
   * writer, the findById → update sequence has a lost-update window: a write
   * that lands between the read and the update can be overwritten (last-write-
   * wins). Merging only the patched keys narrows that window's blast radius
   * versus a full-object upsert, but does not close it.
   */
  async mergeBoardObjectFields(
    boardId: string,
    patches: Record<string, Partial<BoardObject>>
  ): Promise<Board> {
    // Board objects stay strictly below the card (500) / comment (1000) layers.
    const Z_MIN = 1;
    const Z_MAX = 499;
    try {
      const fullId = await this.resolveId(boardId);

      const current = await this.findById(fullId);
      if (!current) {
        throw new EntityNotFoundError('Board', boardId);
      }

      const updatedObjects = { ...(current.objects || {}) };
      for (const [objectId, fields] of Object.entries(patches)) {
        const existing = updatedObjects[objectId];
        if (!existing) continue; // never resurrect a concurrently-deleted object

        // Allowlist: only `zIndex` is mergeable, and it is clamped server-side.
        // Everything else in the patch is ignored so this action can't reshape
        // an object's persisted fields.
        const { zIndex } = fields as { zIndex?: unknown };
        if (typeof zIndex !== 'number' || !Number.isFinite(zIndex)) continue;
        const safeZIndex = Math.min(Z_MAX, Math.max(Z_MIN, zIndex));
        updatedObjects[objectId] = { ...existing, zIndex: safeZIndex } as BoardObject;
      }

      return this.update(fullId, { objects: updatedObjects });
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      if (error instanceof EntityNotFoundError) throw error;
      throw new RepositoryError(
        `Failed to merge board object fields: ${error instanceof Error ? error.message : String(error)}`,
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

  /**
   * Export board to blob (JSON)
   *
   * Strips runtime-specific fields (IDs, timestamps, user attribution).
   * Returns a portable board template.
   */
  async toBlob(boardId: string): Promise<BoardExportBlob> {
    const board = await this.findById(boardId);
    if (!board) {
      throw new EntityNotFoundError('Board', boardId);
    }

    return {
      name: board.name,
      slug: board.slug,
      description: board.description,
      icon: board.icon,
      color: board.color,
      background_color: board.background_color,
      custom_css: board.custom_css,
      access_mode: board.access_mode,
      default_others_can: board.default_others_can,
      default_others_fs_access: board.default_others_fs_access,
      default_dangerously_allow_session_sharing: board.default_dangerously_allow_session_sharing,
      objects: board.objects,
      custom_context: board.custom_context,
    };
  }

  /**
   * Import board from blob (JSON)
   *
   * Creates a new board with fresh IDs and timestamps.
   * Returns the created board.
   */
  async fromBlob(blob: BoardExportBlob, userId: string): Promise<Board> {
    // Validate blob structure
    this.validateBoardBlob(blob);

    return this.create({
      name: blob.name,
      slug: blob.slug ?? blob.name,
      description: blob.description,
      icon: blob.icon,
      color: blob.color,
      background_color: blob.background_color,
      objects: blob.objects,
      custom_context: blob.custom_context,
      access_mode: blob.access_mode,
      default_others_can: blob.default_others_can,
      default_others_fs_access: blob.default_others_fs_access,
      default_dangerously_allow_session_sharing: blob.default_dangerously_allow_session_sharing,
      created_by: userId,
    });
  }

  /**
   * Export board to YAML string
   */
  async toYaml(boardId: string): Promise<string> {
    const blob = await this.toBlob(boardId);

    // Add header comment with metadata
    const header = [
      '# Agor Board Export',
      `# Generated: ${new Date().toISOString()}`,
      '# Version: 1.0',
      '',
    ].join('\n');

    return header + yaml.dump(blob, { indent: 2, lineWidth: -1 });
  }

  /**
   * Import board from YAML string
   */
  async fromYaml(yamlContent: string, userId: string): Promise<Board> {
    const blob = this.parseYamlToBlob(yamlContent);
    return this.fromBlob(blob, userId);
  }

  /**
   * Parse YAML string into a validated BoardExportBlob without creating a board
   * Uses JSON_SCHEMA to prevent code execution via malicious YAML tags
   * while still correctly parsing numbers, booleans, and null
   */
  parseYamlToBlob(yamlContent: string): BoardExportBlob {
    try {
      // Use JSON_SCHEMA to prevent RCE via !!js/function or other code-executing tags
      // while still parsing numbers, booleans, and null correctly
      // (FAILSAFE_SCHEMA parses everything as strings, breaking numeric validations)
      const blob = yaml.load(yamlContent, { schema: yaml.JSON_SCHEMA }) as BoardExportBlob;
      this.validateBoardBlob(blob);
      return blob;
    } catch (error) {
      throw new RepositoryError(
        `Failed to parse YAML: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Clone board (create copy with new ID)
   *
   * Convenience method that combines toBlob + fromBlob.
   */
  async clone(boardId: string, newName: string, userId: string): Promise<Board> {
    const blob = await this.toBlob(boardId);
    return this.create({
      name: newName,
      slug: newName,
      description: blob.description,
      icon: blob.icon,
      color: blob.color,
      background_color: blob.background_color,
      objects: blob.objects,
      custom_context: blob.custom_context,
      access_mode: blob.access_mode,
      default_others_can: blob.default_others_can,
      default_others_fs_access: blob.default_others_fs_access,
      default_dangerously_allow_session_sharing: blob.default_dangerously_allow_session_sharing,
      created_by: userId,
    });
  }

  /**
   * Validate board export blob structure
   */
  public validateBoardBlob(blob: unknown): asserts blob is BoardExportBlob {
    if (!blob || typeof blob !== 'object') {
      throw new RepositoryError('Invalid board export: must be an object');
    }

    const b = blob as Partial<BoardExportBlob>;

    if (!b.name || typeof b.name !== 'string') {
      throw new RepositoryError('Invalid board export: name is required');
    }

    // Validate objects structure
    if (b.objects) {
      for (const [id, obj] of Object.entries(b.objects)) {
        if (!obj || typeof obj !== 'object') {
          throw new RepositoryError(`Invalid object ${id}: must be an object`);
        }

        if (!obj.type || !['zone', 'text', 'markdown'].includes(obj.type)) {
          throw new RepositoryError(`Invalid object ${id}: unsupported type`);
        }

        // Type-specific validation
        if (obj.type === 'zone') {
          const zone = obj as { x?: unknown; y?: unknown; width?: unknown; height?: unknown };
          if (
            typeof zone.x !== 'number' ||
            typeof zone.y !== 'number' ||
            typeof zone.width !== 'number' ||
            typeof zone.height !== 'number'
          ) {
            throw new RepositoryError(`Invalid zone ${id}: missing position/dimensions`);
          }
        }
      }
    }

    // Validate custom_context if present
    if (b.custom_context) {
      try {
        JSON.parse(JSON.stringify(b.custom_context));
      } catch (_error) {
        throw new RepositoryError('Invalid custom_context: must be valid JSON');
      }
    }
  }
}
