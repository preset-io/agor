/**
 * Worktree Repository
 *
 * Type-safe CRUD operations for worktrees with short ID support.
 */

import type { UUID, Worktree, WorktreeID } from '@agor/core/types';
import { and, eq, inArray, like, sql } from 'drizzle-orm';
import { formatShortId, generateId } from '../../lib/ids';
import type { Database } from '../client';
import { deleteFrom, insert, select, update } from '../database-wrapper';
import { type WorktreeInsert, type WorktreeRow, worktreeOwners, worktrees } from '../schema';
import { AmbiguousIdError, type BaseRepository, EntityNotFoundError } from './base';
import { deepMerge } from './merge-utils';

/**
 * Worktree repository implementation
 */
export class WorktreeRepository implements BaseRepository<Worktree, Partial<Worktree>> {
  constructor(private db: Database) {}

  /**
   * Convert database row to Worktree type
   */
  private rowToWorktree(row: WorktreeRow): Worktree {
    return {
      worktree_id: row.worktree_id as WorktreeID,
      repo_id: row.repo_id as UUID,
      created_at: new Date(row.created_at).toISOString(),
      updated_at: row.updated_at
        ? new Date(row.updated_at).toISOString()
        : new Date(row.created_at).toISOString(),
      created_by: row.created_by as UUID,
      name: row.name,
      ref: row.ref,
      ref_type: row.ref_type ?? 'branch',
      worktree_unique_id: row.worktree_unique_id,
      start_command: row.start_command ?? undefined, // Static environment fields
      stop_command: row.stop_command ?? undefined,
      nuke_command: row.nuke_command ?? undefined,
      health_check_url: row.health_check_url ?? undefined,
      app_url: row.app_url ?? undefined,
      logs_command: row.logs_command ?? undefined,
      board_id: (row.board_id as UUID | null) ?? undefined, // Top-level column
      schedule_enabled: Boolean(row.schedule_enabled), // Convert SQLite integer (0/1) to boolean
      schedule_cron: row.schedule_cron ?? undefined,
      schedule_last_triggered_at: row.schedule_last_triggered_at ?? undefined,
      schedule_next_run_at: row.schedule_next_run_at ?? undefined,
      needs_attention: Boolean(row.needs_attention), // Convert SQLite integer (0/1) to boolean
      archived: Boolean(row.archived), // Convert SQLite integer (0/1) to boolean
      archived_at: row.archived_at ? new Date(row.archived_at).toISOString() : undefined,
      archived_by: (row.archived_by as UUID | null) ?? undefined,
      filesystem_status: row.filesystem_status ?? undefined,
      // RBAC fields
      others_can: row.others_can ?? undefined,
      others_fs_access: row.others_fs_access ?? undefined,
      unix_group: row.unix_group ?? undefined,
      ...row.data,
    };
  }

  /**
   * Convert Worktree to database insert format
   */
  private worktreeToInsert(worktree: Partial<Worktree>): WorktreeInsert {
    const now = Date.now();
    const worktreeId = worktree.worktree_id ?? (generateId() as WorktreeID);

    return {
      worktree_id: worktreeId,
      repo_id: worktree.repo_id!,
      created_at: worktree.created_at ? new Date(worktree.created_at) : new Date(now),
      updated_at: new Date(now),
      created_by: worktree.created_by ?? 'anonymous',
      name: worktree.name!,
      ref: worktree.ref!,
      ref_type: worktree.ref_type,
      worktree_unique_id: worktree.worktree_unique_id!, // Required field
      // Static environment fields (initialized from templates, then user-editable)
      start_command: worktree.start_command ?? null,
      stop_command: worktree.stop_command ?? null,
      nuke_command: worktree.nuke_command ?? null,
      health_check_url: worktree.health_check_url ?? null,
      app_url: worktree.app_url ?? null,
      logs_command: worktree.logs_command ?? null,
      // Explicitly convert undefined to null for Drizzle (undefined values are ignored in set())
      board_id: worktree.board_id === undefined ? null : worktree.board_id || null,
      schedule_enabled: worktree.schedule_enabled ?? false,
      schedule_cron: worktree.schedule_cron ?? null,
      schedule_last_triggered_at: worktree.schedule_last_triggered_at ?? null,
      schedule_next_run_at: worktree.schedule_next_run_at ?? null,
      needs_attention: worktree.needs_attention ?? true, // Default true for new worktrees
      archived: worktree.archived ?? false, // Default false for new worktrees
      archived_at: worktree.archived_at ? new Date(worktree.archived_at) : null,
      archived_by: worktree.archived_by ?? null,
      filesystem_status: worktree.filesystem_status ?? null,
      // RBAC fields (explicit null to ensure they're included in updates)
      others_can: worktree.others_can ?? null,
      others_fs_access: worktree.others_fs_access ?? null,
      unix_group: worktree.unix_group ?? null,
      data: {
        path: worktree.path!,
        base_ref: worktree.base_ref,
        base_sha: worktree.base_sha,
        last_commit_sha: worktree.last_commit_sha,
        tracking_branch: worktree.tracking_branch,
        new_branch: worktree.new_branch ?? false,
        issue_url: worktree.issue_url,
        pull_request_url: worktree.pull_request_url,
        notes: worktree.notes,
        environment_instance: worktree.environment_instance,
        last_used: worktree.last_used ?? new Date(now).toISOString(),
        custom_context: worktree.custom_context,
        schedule: worktree.schedule,
      },
    };
  }

  /**
   * Create a new worktree
   */
  async create(worktree: Partial<Worktree>): Promise<Worktree> {
    const insertData = this.worktreeToInsert(worktree);
    const row = await insert(this.db, worktrees).values(insertData).returning().one();
    return this.rowToWorktree(row);
  }

  /**
   * Find worktree by exact ID or short ID prefix
   */
  async findById(id: string): Promise<Worktree | null> {
    // Exact match (full UUID)
    if (id.length === 36 && id.includes('-')) {
      const row = await select(this.db).from(worktrees).where(eq(worktrees.worktree_id, id)).one();
      return row ? this.rowToWorktree(row) : null;
    }

    // Short ID match (prefix) - just use the id directly as a prefix since it's already short
    const prefix = id.replace(/-/g, '').toLowerCase();
    const matches = await select(this.db)
      .from(worktrees)
      .where(like(worktrees.worktree_id, `${prefix}%`))
      .limit(2); // Fetch 2 to detect ambiguity

    if (matches.length === 0) return null;
    if (matches.length > 1) {
      throw new AmbiguousIdError(
        'Worktree',
        prefix,
        matches.map((m: { worktree_id: string }) => formatShortId(m.worktree_id as UUID))
      );
    }

    return this.rowToWorktree(matches[0]);
  }

  /**
   * Find all worktrees (with optional filters)
   *
   * @param filter - Optional filters (repo_id, includeArchived)
   * @param filter.repo_id - Filter by repository ID
   * @param filter.includeArchived - Include archived worktrees (default: false)
   */
  async findAll(filter?: { repo_id?: UUID; includeArchived?: boolean }): Promise<Worktree[]> {
    const includeArchived = filter?.includeArchived ?? false;

    // Build where conditions
    const conditions = [];
    if (filter?.repo_id) {
      conditions.push(eq(worktrees.repo_id, filter.repo_id));
    }
    if (!includeArchived) {
      conditions.push(eq(worktrees.archived, false));
    }

    const query = select(this.db).from(worktrees);
    const rows =
      conditions.length > 0 ? await query.where(and(...conditions)).all() : await query.all();

    return rows.map((row: WorktreeRow) => this.rowToWorktree(row));
  }

  /**
   * Update worktree by ID (atomic with database-level transaction)
   *
   * Uses a transaction to ensure read-merge-write is atomic, preventing race conditions
   * when multiple updates happen concurrently (e.g., schedule config + environment updates).
   */
  async update(id: string, updates: Partial<Worktree>): Promise<Worktree> {
    // STEP 1: Read current worktree (outside transaction for short ID resolution)
    const existing = await this.findById(id);
    if (!existing) {
      throw new EntityNotFoundError('Worktree', id);
    }

    // Use transaction to make read-merge-write atomic
    return await this.db.transaction(async (tx) => {
      // STEP 2: Re-read within transaction to ensure we have latest data
      // biome-ignore lint/suspicious/noExplicitAny: Transaction context requires type assertion for database wrapper functions
      const currentRow = await select(tx as any)
        .from(worktrees)
        .where(eq(worktrees.worktree_id, existing.worktree_id))
        .one();

      if (!currentRow) {
        throw new EntityNotFoundError('Worktree', id);
      }

      const current = this.rowToWorktree(currentRow);

      // STEP 3: Deep merge updates into current worktree (in memory)
      // Preserves nested objects like schedule, environment_instance, custom_context
      const merged = deepMerge(current, {
        ...updates,
        worktree_id: current.worktree_id, // Never change ID
        repo_id: current.repo_id, // Never change repo
        created_at: current.created_at, // Never change created timestamp
        updated_at: new Date().toISOString(), // Always update timestamp
      });

      const insertData = this.worktreeToInsert(merged);

      // STEP 4: Write merged worktree (within same transaction)
      // biome-ignore lint/suspicious/noExplicitAny: Transaction context requires type assertion for database wrapper functions
      const row = await update(tx as any, worktrees)
        .set(insertData)
        .where(eq(worktrees.worktree_id, current.worktree_id))
        .returning()
        .one();

      return this.rowToWorktree(row);
    });
  }

  /**
   * Delete worktree by ID
   */
  async delete(id: string): Promise<void> {
    const existing = await this.findById(id);
    if (!existing) {
      throw new EntityNotFoundError('Worktree', id);
    }

    await deleteFrom(this.db, worktrees)
      .where(eq(worktrees.worktree_id, existing.worktree_id))
      .run();
  }

  /**
   * Find worktree by repo_id and name
   */
  async findByRepoAndName(repoId: UUID, name: string): Promise<Worktree | null> {
    const row = await select(this.db)
      .from(worktrees)
      .where(sql`${worktrees.repo_id} = ${repoId} AND ${worktrees.name} = ${name}`)
      .one();

    return row ? this.rowToWorktree(row) : null;
  }

  // ===== RBAC: Ownership Management =====

  /**
   * Check if a user is an owner of a worktree
   *
   * @param worktreeId - Worktree ID (full UUID)
   * @param userId - User ID to check
   * @returns true if user is an owner
   */
  async isOwner(worktreeId: WorktreeID, userId: UUID): Promise<boolean> {
    const row = await select(this.db)
      .from(worktreeOwners)
      .where(and(eq(worktreeOwners.worktree_id, worktreeId), eq(worktreeOwners.user_id, userId)))
      .one();

    return row != null; // Use != to check for both null and undefined
  }

  /**
   * Get all owners of a worktree
   *
   * @param worktreeId - Worktree ID (full UUID or short ID)
   * @returns Array of user IDs
   */
  async getOwners(worktreeId: string): Promise<UUID[]> {
    // Resolve short ID to full ID
    const worktree = await this.findById(worktreeId);
    if (!worktree) {
      throw new EntityNotFoundError('Worktree', worktreeId);
    }

    const rows = await select(this.db)
      .from(worktreeOwners)
      .where(eq(worktreeOwners.worktree_id, worktree.worktree_id))
      .all();

    return rows.map((row: { user_id: string }) => row.user_id as UUID);
  }

  /**
   * Add an owner to a worktree
   *
   * Idempotent - does nothing if user is already an owner.
   *
   * @param worktreeId - Worktree ID (full UUID or short ID)
   * @param userId - User ID to add
   */
  async addOwner(worktreeId: string, userId: UUID): Promise<void> {
    // Resolve short ID to full ID
    const worktree = await this.findById(worktreeId);
    if (!worktree) {
      throw new EntityNotFoundError('Worktree', worktreeId);
    }

    // Check if already an owner (idempotent)
    const isExisting = await this.isOwner(worktree.worktree_id, userId);
    if (isExisting) {
      return; // Already an owner, nothing to do
    }

    // Add ownership
    await insert(this.db, worktreeOwners)
      .values({
        worktree_id: worktree.worktree_id,
        user_id: userId,
        created_at: new Date(), // Explicitly set timestamp (migration has wrong default)
      })
      .run();
  }

  /**
   * Remove an owner from a worktree
   *
   * Idempotent - does nothing if user is not an owner.
   *
   * @param worktreeId - Worktree ID (full UUID or short ID)
   * @param userId - User ID to remove
   */
  async removeOwner(worktreeId: string, userId: UUID): Promise<void> {
    // Resolve short ID to full ID
    const worktree = await this.findById(worktreeId);
    if (!worktree) {
      throw new EntityNotFoundError('Worktree', worktreeId);
    }

    // Remove ownership (idempotent - will do nothing if not an owner)
    await deleteFrom(this.db, worktreeOwners)
      .where(
        and(
          eq(worktreeOwners.worktree_id, worktree.worktree_id),
          eq(worktreeOwners.user_id, userId)
        )
      )
      .run();
  }

  /**
   * Bulk-load ownership for multiple worktrees
   *
   * Returns a Map of worktree_id -> user_ids[] for efficient lookups.
   * Used to avoid N+1 queries when checking ownership for multiple worktrees.
   *
   * @param worktreeIds - Array of worktree IDs (full UUIDs)
   * @returns Map of worktree_id -> array of owner user_ids
   */
  async bulkLoadOwners(worktreeIds: WorktreeID[]): Promise<Map<WorktreeID, UUID[]>> {
    if (worktreeIds.length === 0) {
      return new Map();
    }

    // Query all owners for the given worktrees using inArray
    const rows = await select(this.db)
      .from(worktreeOwners)
      .where(inArray(worktreeOwners.worktree_id, worktreeIds))
      .all();

    // Group by worktree_id
    const ownersByWorktree = new Map<WorktreeID, UUID[]>();
    for (const row of rows) {
      const wtId = row.worktree_id as WorktreeID;
      const userId = row.user_id as UUID;

      if (!ownersByWorktree.has(wtId)) {
        ownersByWorktree.set(wtId, []);
      }
      ownersByWorktree.get(wtId)!.push(userId);
    }

    return ownersByWorktree;
  }
}
