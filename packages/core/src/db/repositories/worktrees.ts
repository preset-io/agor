/**
 * Worktree Repository
 *
 * Type-safe CRUD operations for worktrees with short ID support.
 */

import type { UUID, Worktree, WorktreeID } from '@agor/core/types';
import { eq, like, sql } from 'drizzle-orm';
import { formatShortId, generateId } from '../../lib/ids';
import type { Database } from '../client';
import { type WorktreeInsert, type WorktreeRow, worktrees } from '../schema';
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
      worktree_unique_id: row.worktree_unique_id,
      start_command: row.start_command ?? undefined, // Static environment fields
      stop_command: row.stop_command ?? undefined,
      health_check_url: row.health_check_url ?? undefined,
      app_url: row.app_url ?? undefined,
      logs_command: row.logs_command ?? undefined,
      board_id: (row.board_id as UUID | null) ?? undefined, // Top-level column
      schedule_enabled: Boolean(row.schedule_enabled), // Convert SQLite integer (0/1) to boolean
      schedule_cron: row.schedule_cron ?? undefined,
      schedule_last_triggered_at: row.schedule_last_triggered_at ?? undefined,
      schedule_next_run_at: row.schedule_next_run_at ?? undefined,
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
      worktree_unique_id: worktree.worktree_unique_id!, // Required field
      // Static environment fields (initialized from templates, then user-editable)
      start_command: worktree.start_command ?? null,
      stop_command: worktree.stop_command ?? null,
      health_check_url: worktree.health_check_url ?? null,
      app_url: worktree.app_url ?? null,
      logs_command: worktree.logs_command ?? null,
      // Explicitly convert undefined to null for Drizzle (undefined values are ignored in set())
      board_id: worktree.board_id === undefined ? null : worktree.board_id || null,
      schedule_enabled: worktree.schedule_enabled ?? false,
      schedule_cron: worktree.schedule_cron ?? null,
      schedule_last_triggered_at: worktree.schedule_last_triggered_at ?? null,
      schedule_next_run_at: worktree.schedule_next_run_at ?? null,
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
    const insert = this.worktreeToInsert(worktree);
    const [row] = await this.db.insert(worktrees).values(insert).returning();
    return this.rowToWorktree(row);
  }

  /**
   * Find worktree by exact ID or short ID prefix
   */
  async findById(id: string): Promise<Worktree | null> {
    // Exact match (full UUID)
    if (id.length === 36 && id.includes('-')) {
      const [row] = await this.db
        .select()
        .from(worktrees)
        .where(eq(worktrees.worktree_id, id))
        .limit(1);
      return row ? this.rowToWorktree(row) : null;
    }

    // Short ID match (prefix) - just use the id directly as a prefix since it's already short
    const prefix = id.replace(/-/g, '').toLowerCase();
    const matches = await this.db
      .select()
      .from(worktrees)
      .where(like(worktrees.worktree_id, `${prefix}%`))
      .limit(2); // Fetch 2 to detect ambiguity

    if (matches.length === 0) return null;
    if (matches.length > 1) {
      throw new AmbiguousIdError(
        'Worktree',
        prefix,
        matches.map(m => formatShortId(m.worktree_id as UUID))
      );
    }

    return this.rowToWorktree(matches[0]);
  }

  /**
   * Find all worktrees (with optional filters)
   */
  async findAll(filter?: { repo_id?: UUID }): Promise<Worktree[]> {
    if (filter?.repo_id) {
      const rows = await this.db
        .select()
        .from(worktrees)
        .where(eq(worktrees.repo_id, filter.repo_id));
      return rows.map(row => this.rowToWorktree(row));
    }

    const rows = await this.db.select().from(worktrees);
    return rows.map(row => this.rowToWorktree(row));
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
    return await this.db.transaction(async tx => {
      // STEP 2: Re-read within transaction to ensure we have latest data
      const currentRow = await tx
        .select()
        .from(worktrees)
        .where(eq(worktrees.worktree_id, existing.worktree_id))
        .get();

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

      const insert = this.worktreeToInsert(merged);

      // STEP 4: Write merged worktree (within same transaction)
      const [row] = await tx
        .update(worktrees)
        .set(insert)
        .where(eq(worktrees.worktree_id, current.worktree_id))
        .returning();

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

    await this.db.delete(worktrees).where(eq(worktrees.worktree_id, existing.worktree_id));
  }

  /**
   * Find worktree by repo_id and name
   */
  async findByRepoAndName(repoId: UUID, name: string): Promise<Worktree | null> {
    const [row] = await this.db
      .select()
      .from(worktrees)
      .where(sql`${worktrees.repo_id} = ${repoId} AND ${worktrees.name} = ${name}`)
      .limit(1);

    return row ? this.rowToWorktree(row) : null;
  }
}
