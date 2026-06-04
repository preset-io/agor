/**
 * Schedule Repository
 *
 * Type-safe CRUD operations for the first-class `schedules` table.
 * See docs/internal/schedules-first-class-design-2026-05-24.md.
 */

import type {
  BranchID,
  Schedule,
  ScheduleAgenticToolConfig,
  ScheduleID,
  SessionID,
  TimezoneMode,
  UUID,
} from '@agor/core/types';
import { and, asc, desc, eq, isNull, like, lte, or, sql } from 'drizzle-orm';
import { generateId } from '../../lib/ids';
import type { Database } from '../client';
import { deleteFrom, insert, lockRowForUpdate, select, txAsDb, update } from '../database-wrapper';
import {
  branches,
  branchOwners,
  type ScheduleInsert,
  type ScheduleRow,
  schedules,
} from '../schema';
import {
  type BaseRepository,
  EntityNotFoundError,
  RESOLVE_SHORT_ID_FETCH_LIMIT,
  RepositoryError,
  resolveByShortIdPrefix,
} from './base';
import { activeGroupGrantAccessExists, visibleBranchAccessCondition } from './branch-access';
import { deepMerge } from './merge-utils';

export class ScheduleRepository implements BaseRepository<Schedule, Partial<Schedule>> {
  constructor(private db: Database) {}

  /**
   * Convert database row to Schedule type.
   *
   * `agentic_tool_config` round-trips through JSON: on Postgres it's
   * already an object (jsonb); on SQLite it's a string we parse here.
   */
  private rowToSchedule(row: ScheduleRow): Schedule {
    const config =
      typeof row.agentic_tool_config === 'string'
        ? (JSON.parse(row.agentic_tool_config) as ScheduleAgenticToolConfig)
        : (row.agentic_tool_config as ScheduleAgenticToolConfig);

    return {
      schedule_id: row.schedule_id as ScheduleID,
      branch_id: row.branch_id as BranchID,
      name: row.name,
      description: row.description ?? undefined,
      cron_expression: row.cron_expression,
      timezone_mode: row.timezone_mode as TimezoneMode,
      timezone: row.timezone ?? undefined,
      prompt: row.prompt,
      agentic_tool_config: config,
      enabled: Boolean(row.enabled),
      allow_concurrent_runs: Boolean(row.allow_concurrent_runs),
      retention: row.retention,
      last_run_at: row.last_run_at ?? undefined,
      last_run_session_id: (row.last_run_session_id as SessionID | null) ?? undefined,
      next_run_at: row.next_run_at ?? undefined,
      created_at: new Date(row.created_at).toISOString(),
      updated_at: new Date(row.updated_at).toISOString(),
      created_by: row.created_by as UUID,
    };
  }

  private scheduleToInsert(s: Partial<Schedule>): ScheduleInsert {
    const now = Date.now();
    const scheduleId = (s.schedule_id ?? (generateId() as ScheduleID)) as string;

    if (!s.branch_id) throw new RepositoryError('Schedule must have a branch_id');
    if (!s.created_by) throw new RepositoryError('Schedule must have a created_by');
    if (!s.name) throw new RepositoryError('Schedule must have a name');
    if (!s.cron_expression) throw new RepositoryError('Schedule must have a cron_expression');
    if (!s.prompt) throw new RepositoryError('Schedule must have a prompt');
    if (!s.agentic_tool_config) {
      throw new RepositoryError('Schedule must have an agentic_tool_config');
    }

    return {
      schedule_id: scheduleId,
      branch_id: s.branch_id,
      name: s.name,
      description: s.description ?? null,
      cron_expression: s.cron_expression,
      timezone_mode: s.timezone_mode ?? 'local',
      timezone: s.timezone ?? null,
      prompt: s.prompt,
      // Drizzle's jsonb / text-with-json roundtrip handles this for us;
      // pass the object through.
      agentic_tool_config: s.agentic_tool_config as unknown,
      enabled: s.enabled ?? true,
      allow_concurrent_runs: s.allow_concurrent_runs ?? false,
      retention: s.retention ?? 5,
      last_run_at: s.last_run_at ?? null,
      last_run_session_id: s.last_run_session_id ?? null,
      next_run_at: s.next_run_at ?? null,
      created_at: s.created_at ? new Date(s.created_at) : new Date(now),
      updated_at: new Date(now),
      created_by: s.created_by,
    } as ScheduleInsert;
  }

  /**
   * Resolve a short ID prefix to the full schedule ID.
   */
  private async resolveId(id: string): Promise<string> {
    return resolveByShortIdPrefix(id, 'Schedule', async (pattern) => {
      const rows = await select(this.db)
        .from(schedules)
        .where(like(schedules.schedule_id, pattern))
        .limit(RESOLVE_SHORT_ID_FETCH_LIMIT)
        .all();
      return rows.map((r: { schedule_id: string }) => r.schedule_id);
    });
  }

  async create(data: Partial<Schedule>): Promise<Schedule> {
    try {
      const insertData = this.scheduleToInsert(data);
      const row = await insert(this.db, schedules).values(insertData).returning().one();
      return this.rowToSchedule(row);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('FOREIGN KEY constraint failed')) {
        throw new RepositoryError(
          `Failed to create schedule: a referenced entity does not exist. ` +
            `Check that branch_id ('${data.branch_id}') and created_by ('${data.created_by}') are valid.`,
          error
        );
      }
      throw new RepositoryError(`Failed to create schedule: ${msg}`, error);
    }
  }

  async findById(id: string): Promise<Schedule | null> {
    try {
      const fullId = await this.resolveId(id);
      const row = await select(this.db)
        .from(schedules)
        .where(eq(schedules.schedule_id, fullId))
        .one();
      if (!row) return null;
      return this.rowToSchedule(row);
    } catch (error) {
      if (error instanceof EntityNotFoundError) return null;
      throw error;
    }
  }

  /**
   * Find all schedules, with optional filters.
   *
   * @param filter.branch_id - only schedules for this branch
   * @param filter.enabled - filter by enabled flag
   * @param filter.created_by - filter by creator user ID
   */
  async findAll(filter?: {
    branch_id?: BranchID;
    enabled?: boolean;
    created_by?: UUID;
  }): Promise<Schedule[]> {
    const conditions = [];
    if (filter?.branch_id) conditions.push(eq(schedules.branch_id, filter.branch_id));
    if (filter?.enabled !== undefined) conditions.push(eq(schedules.enabled, filter.enabled));
    if (filter?.created_by) conditions.push(eq(schedules.created_by, filter.created_by));

    const query = select(this.db).from(schedules);
    const rows =
      conditions.length > 0 ? await query.where(and(...conditions)).all() : await query.all();

    return rows.map((row: ScheduleRow) => this.rowToSchedule(row));
  }

  /**
   * All schedules on a branch (newest first by created_at).
   */
  async findByBranchId(branchId: BranchID): Promise<Schedule[]> {
    const rows = await select(this.db)
      .from(schedules)
      .where(eq(schedules.branch_id, branchId))
      .orderBy(desc(schedules.created_at))
      .all();
    return rows.map((row: ScheduleRow) => this.rowToSchedule(row));
  }

  /**
   * Scheduler hot-path query: all enabled schedules that are due.
   *
   * Returns rows where `next_run_at <= now`, OR `next_run_at IS NULL`
   * (schedules that have never fired and need their first `next_run_at`
   * computed). Ordered by `next_run_at ASC` so the most overdue fires
   * first; NULL `next_run_at` sorts last (`asc` puts NULL last on
   * Postgres but first on SQLite — practically irrelevant since the
   * caller iterates the whole result set per tick).
   *
   * Uses the `schedules_enabled_next_run_idx` covering index.
   */
  async findDue(now: number = Date.now()): Promise<Schedule[]> {
    const rows = await select(this.db)
      .from(schedules)
      .where(
        and(
          eq(schedules.enabled, true),
          or(isNull(schedules.next_run_at), lte(schedules.next_run_at, now))
        )
      )
      .orderBy(asc(schedules.next_run_at))
      .all();
    return rows.map((row: ScheduleRow) => this.rowToSchedule(row));
  }

  /**
   * Find schedules visible to a user via branch RBAC.
   *
   * Mirrors `SessionRepository.findAccessibleSessions`: returns schedules
   * whose parent branch the user can `view` — either as a branch owner
   * or because `branches.others_can != 'none'`.
   *
   * Only call when RBAC is enabled. When disabled, the `scopeScheduleQuery`
   * hook is not registered and `findAll` is used instead.
   */
  async findAccessibleSchedules(
    userId: UUID,
    filter?: { branch_id?: BranchID; enabled?: boolean; created_by?: UUID }
  ): Promise<Schedule[]> {
    const conditions = [
      visibleBranchAccessCondition(activeGroupGrantAccessExists(this.db, userId)),
    ];
    if (filter?.branch_id) conditions.push(eq(schedules.branch_id, filter.branch_id));
    if (filter?.enabled !== undefined) conditions.push(eq(schedules.enabled, filter.enabled));
    if (filter?.created_by) conditions.push(eq(schedules.created_by, filter.created_by));

    const results = await select(this.db)
      .from(schedules)
      .innerJoin(branches, eq(schedules.branch_id, branches.branch_id))
      .leftJoin(
        branchOwners,
        and(eq(branchOwners.branch_id, branches.branch_id), eq(branchOwners.user_id, userId))
      )
      .where(and(...conditions))
      .all();

    const seen = new Set<string>();
    const out: Schedule[] = [];
    for (const r of results as Array<{ schedules: ScheduleRow }>) {
      if (seen.has(r.schedules.schedule_id)) continue;
      seen.add(r.schedules.schedule_id);
      out.push(this.rowToSchedule(r.schedules));
    }
    return out;
  }

  /**
   * Update schedule by ID (atomic with database-level transaction).
   *
   * Mirrors `BranchRepository.update` — read-merge-write inside a single
   * transaction with row-level lock on Postgres to prevent lost updates
   * when two writers race on the same schedule (e.g., scheduler updating
   * `next_run_at` while the user toggles `enabled`).
   */
  async update(id: string, updates: Partial<Schedule>): Promise<Schedule> {
    const fullId = await this.resolveId(id);

    return await this.db.transaction(async (tx) => {
      await lockRowForUpdate(txAsDb(tx), this.db, schedules, eq(schedules.schedule_id, fullId));

      const currentRow = await select(txAsDb(tx))
        .from(schedules)
        .where(eq(schedules.schedule_id, fullId))
        .one();
      if (!currentRow) throw new EntityNotFoundError('Schedule', id);

      const current = this.rowToSchedule(currentRow);
      const merged = deepMerge(current, {
        ...updates,
        schedule_id: current.schedule_id,
        branch_id: current.branch_id, // never reparent
        created_at: current.created_at,
        created_by: current.created_by,
        updated_at: new Date().toISOString(),
      });

      const insertData = this.scheduleToInsert(merged);
      insertData.updated_at = new Date();

      const row = await update(txAsDb(tx), schedules)
        .set(insertData)
        .where(eq(schedules.schedule_id, fullId))
        .returning()
        .one();
      return this.rowToSchedule(row);
    });
  }

  async delete(id: string): Promise<void> {
    const fullId = await this.resolveId(id);
    const result = await deleteFrom(this.db, schedules)
      .where(eq(schedules.schedule_id, fullId))
      .run();
    if (result.rowsAffected === 0) throw new EntityNotFoundError('Schedule', id);
  }

  /**
   * Count schedules (optionally filtered).
   */
  async count(filter?: { branch_id?: BranchID; enabled?: boolean }): Promise<number> {
    const conditions = [];
    if (filter?.branch_id) conditions.push(eq(schedules.branch_id, filter.branch_id));
    if (filter?.enabled !== undefined) conditions.push(eq(schedules.enabled, filter.enabled));

    const query = select(this.db, { count: sql<number>`count(*)` }).from(schedules);
    const row =
      conditions.length > 0 ? await query.where(and(...conditions)).one() : await query.one();
    return Number(row?.count ?? 0);
  }
}
