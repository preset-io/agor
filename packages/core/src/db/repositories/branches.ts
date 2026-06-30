/**
 * Branch Repository
 *
 * Type-safe CRUD operations for branches with short ID support.
 */

import type {
  AgenticToolName,
  BoardID,
  Branch,
  BranchFsAccessLevel,
  BranchID,
  EffectiveBranchAccess,
  SessionStatus,
  UUID,
} from '@agor/core/types';
import { BRANCH_PERMISSION_LEVELS } from '@agor/core/types';
import { and, desc, eq, exists, getTableColumns, inArray, like, or, sql } from 'drizzle-orm';
import { getBaseUrl } from '../../config/config-manager';
import { generateId } from '../../lib/ids';
import { getBranchUrl } from '../../utils/url';
import type { Database } from '../client';
import {
  deleteFrom,
  insert,
  isPostgresDatabase,
  jsonExtract,
  lockRowForUpdate,
  select,
  txAsDb,
  update,
} from '../database-wrapper';
import {
  type BranchGroupGrantRow,
  type BranchInsert,
  type BranchRow,
  boardGroupGrants,
  boardOwners,
  boards,
  branches,
  branchGroupGrants,
  branchOwners,
  groupMemberships,
  groups,
  schedules,
} from '../schema';
import {
  attachHiddenTenant,
  type BaseRepository,
  EntityNotFoundError,
  RESOLVE_SHORT_ID_FETCH_LIMIT,
  RepositoryError,
  resolveByShortIdPrefix,
} from './base';
import { visibleBranchAccessCondition } from './branch-access';
import { GroupRepository } from './groups';
import { deepMerge } from './merge-utils';

const BRANCH_PERMISSION_RANK = Object.fromEntries(
  BRANCH_PERMISSION_LEVELS.map((level, index) => [level, index - 1])
) as Record<NonNullable<Branch['others_can']>, number>;
const FS_ACCESS_RANK: Record<BranchFsAccessLevel, number> = {
  none: 0,
  read: 1,
  write: 2,
};
const VIEW_OR_BETTER_BRANCH_PERMISSIONS = ['view', 'session', 'prompt', 'all'] as const;
const BRANCH_PERMISSION_SOURCES = ['board', 'override'] as const;
const FS_ACCESS_BRANCH_PERMISSIONS = ['read', 'write'] as const;

/**
 * Session activity summary for a branch
 */
export interface BranchSessionActivity {
  session_id: string;
  status: SessionStatus;
  agentic_tool: AgenticToolName;
  last_updated: string;
  last_message: string;
  message_count: number;
  unix_username: string;
}

/**
 * Branch with enriched zone information
 */
export interface BranchWithZone extends Branch {
  zone_id?: string;
  zone_label?: string;
  board_object_id?: string;
  position?: { x: number; y: number };
}

/**
 * Branch with enriched zone and session information
 */
export interface BranchWithZoneAndSessions extends BranchWithZone {
  sessions?: BranchSessionActivity[];
}

export interface ActiveEnvironmentBranchRef {
  branch_id: BranchID;
  tenant_id?: string;
}

/**
 * Branch repository implementation
 */
export class BranchRepository implements BaseRepository<Branch, Partial<Branch>> {
  constructor(private db: Database) {}

  /**
   * Convert database row to Branch type.
   *
   * `baseUrl` (from `getBaseUrl()`) is required to compute the
   * `url` field. When omitted (e.g., tight internal paths that don't
   * await config), `url` is `null`. We also return `null` when the
   * branch isn't placed on a board — the `/w/<short>/` URL would
   * resolve the branch but have nowhere to switch the canvas to.
   */
  private rowToBranch(row: BranchRow, baseUrl?: string): Branch {
    const branchId = row.branch_id as BranchID;
    const url = baseUrl && row.board_id ? getBranchUrl(branchId, baseUrl) : null;
    return attachHiddenTenant(
      {
        branch_id: branchId,
        repo_id: row.repo_id as UUID,
        created_at: new Date(row.created_at).toISOString(),
        updated_at: row.updated_at
          ? new Date(row.updated_at).toISOString()
          : new Date(row.created_at).toISOString(),
        created_by: row.created_by as UUID,
        name: row.name,
        ref: row.ref,
        ref_type: row.ref_type ?? 'branch',
        branch_unique_id: row.branch_unique_id,
        start_command: row.start_command ?? undefined, // Static environment fields
        stop_command: row.stop_command ?? undefined,
        nuke_command: row.nuke_command ?? undefined,
        health_check_url: row.health_check_url ?? undefined,
        app_url: row.app_url ?? undefined,
        logs_command: row.logs_command ?? undefined,
        environment_variant: row.environment_variant ?? undefined,
        board_id: (row.board_id as BoardID | null) ?? undefined, // Top-level column
        needs_attention: Boolean(row.needs_attention), // Convert SQLite integer (0/1) to boolean
        archived: Boolean(row.archived), // Convert SQLite integer (0/1) to boolean
        archived_at: row.archived_at ? new Date(row.archived_at).toISOString() : undefined,
        archived_by: (row.archived_by as UUID | null) ?? undefined,
        filesystem_status: row.filesystem_status ?? undefined,
        // RBAC fields
        permission_source: row.permission_source ?? 'override',
        others_can: row.others_can ?? undefined,
        others_fs_access: row.others_fs_access ?? undefined,
        unix_group: row.unix_group ?? undefined,
        // Branch storage mode
        storage_mode: row.storage_mode ?? 'worktree',
        clone_depth: row.clone_depth ?? undefined,
        ...row.data,
        url,
      },
      row
    );
  }

  /**
   * Convert Branch to database insert format
   */
  private branchToInsert(branch: Partial<Branch>): BranchInsert {
    if (
      branch.permission_source !== undefined &&
      !BRANCH_PERMISSION_SOURCES.includes(branch.permission_source)
    ) {
      throw new RepositoryError(`Invalid branch permission_source: ${branch.permission_source}`);
    }
    const now = Date.now();
    const branchId = branch.branch_id ?? (generateId() as BranchID);
    if (!branch.created_by) {
      throw new RepositoryError('Branch must have a created_by');
    }

    return {
      branch_id: branchId,
      repo_id: branch.repo_id!,
      created_at: branch.created_at ? new Date(branch.created_at) : new Date(now),
      updated_at: new Date(now),
      created_by: branch.created_by,
      name: branch.name!,
      ref: branch.ref!,
      ref_type: branch.ref_type,
      branch_unique_id: branch.branch_unique_id!, // Required field
      // Static environment fields (initialized from templates, then user-editable)
      start_command: branch.start_command ?? null,
      stop_command: branch.stop_command ?? null,
      nuke_command: branch.nuke_command ?? null,
      health_check_url: branch.health_check_url ?? null,
      app_url: branch.app_url ?? null,
      logs_command: branch.logs_command ?? null,
      environment_variant: branch.environment_variant ?? null,
      // Explicitly convert undefined to null for Drizzle (undefined values are ignored in set())
      board_id: branch.board_id === undefined ? null : branch.board_id || null,
      needs_attention: branch.needs_attention ?? true, // Default true for new branches
      archived: branch.archived ?? false, // Default false for new branches
      archived_at: branch.archived_at ? new Date(branch.archived_at) : null,
      archived_by: branch.archived_by ?? null,
      filesystem_status: branch.filesystem_status ?? null,
      // RBAC fields (default 'session' for others_can matches schema default)
      permission_source: branch.permission_source ?? 'override',
      others_can: branch.others_can ?? 'session',
      others_fs_access: branch.others_fs_access ?? null,
      unix_group: branch.unix_group ?? null,
      // Branch storage mode (default 'worktree' matches schema default)
      storage_mode: branch.storage_mode ?? 'worktree',
      clone_depth: branch.clone_depth ?? null,
      data: {
        path: branch.path!,
        base_ref: branch.base_ref,
        base_sha: branch.base_sha,
        last_commit_sha: branch.last_commit_sha,
        tracking_branch: branch.tracking_branch,
        new_branch: branch.new_branch ?? false,
        issue_url: branch.issue_url,
        pull_request_url: branch.pull_request_url,
        notes: branch.notes,
        error_message: branch.error_message,
        environment_instance: branch.environment_instance,
        last_used: branch.last_used ?? new Date(now).toISOString(),
        custom_context: branch.custom_context,
        mcp_server_ids: branch.mcp_server_ids,
        dangerously_allow_session_sharing: branch.dangerously_allow_session_sharing,
      },
    };
  }

  /**
   * Create a new branch
   */
  async create(branch: Partial<Branch>): Promise<Branch> {
    const insertData = this.branchToInsert(branch);
    try {
      const row = await insert(this.db, branches).values(insertData).returning().one();
      const baseUrl = await getBaseUrl();
      return this.rowToBranch(row, baseUrl);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      // Surface helpful messages for common constraint violations
      if (msg.includes('FOREIGN KEY constraint failed')) {
        throw new RepositoryError(
          `Failed to create branch '${branch.name}': a referenced entity does not exist. ` +
            `Check that repo_id ('${branch.repo_id}') and board_id ('${branch.board_id ?? 'none'}') are valid.`,
          error
        );
      }
      if (msg.includes('UNIQUE constraint failed') || msg.includes('already exists')) {
        throw new RepositoryError(
          `Failed to create branch '${branch.name}': a record with the same key already exists. ${msg}`,
          error
        );
      }
      throw new RepositoryError(`Failed to create branch '${branch.name}': ${msg}`, error);
    }
  }

  /**
   * Find branch by exact ID or short ID prefix.
   *
   * Goes through the centralized `resolveByShortIdPrefix` so the LIKE pattern
   * is built via `prefixToLikePattern` — which re-inserts hyphens at the
   * canonical UUID positions. Without this normalization, a prefix that
   * spans a hyphen boundary (anything ≥9 chars) silently matches nothing
   * because stored IDs are hyphenated.
   */
  async findById(id: string): Promise<Branch | null> {
    try {
      const fullId = await resolveByShortIdPrefix(id, 'Branch', async (pattern) => {
        const rows = await select(this.db)
          .from(branches)
          .where(like(branches.branch_id, pattern))
          .limit(RESOLVE_SHORT_ID_FETCH_LIMIT)
          .all();
        return rows.map((r: { branch_id: string }) => r.branch_id);
      });
      const row = await select(this.db).from(branches).where(eq(branches.branch_id, fullId)).one();
      if (!row) return null;
      const baseUrl = await getBaseUrl();
      return this.rowToBranch(row, baseUrl);
    } catch (error) {
      if (error instanceof EntityNotFoundError) return null;
      throw error;
    }
  }

  /**
   * Find only the fields needed by realtime delivery visibility checks.
   */
  async findRealtimeVisibilityBranch(
    id: string
  ): Promise<Pick<Branch, 'branch_id' | 'others_can'> | null> {
    try {
      const fullId = await resolveByShortIdPrefix(id, 'Branch', async (pattern) => {
        const rows = await select(this.db, { branch_id: branches.branch_id })
          .from(branches)
          .where(like(branches.branch_id, pattern))
          .limit(RESOLVE_SHORT_ID_FETCH_LIMIT)
          .all();
        return rows.map((r: { branch_id: string }) => r.branch_id);
      });
      const row = await select(this.db, {
        branch_id: branches.branch_id,
        others_can: branches.others_can,
        board_id: branches.board_id,
        permission_source: branches.permission_source,
      })
        .from(branches)
        .where(eq(branches.branch_id, fullId))
        .one();
      if (!row) return null;

      let othersCan = row.others_can;
      if (row.permission_source === 'board' && row.board_id) {
        const board = await select(this.db, { data: boards.data })
          .from(boards)
          .where(eq(boards.board_id, row.board_id))
          .one();
        const boardData = board?.data as
          | { access_mode?: 'private' | 'shared'; default_others_can?: Branch['others_can'] }
          | undefined;
        othersCan =
          (boardData?.access_mode ?? 'shared') === 'private'
            ? 'none'
            : (boardData?.default_others_can ?? row.others_can);
      }

      return { branch_id: row.branch_id as BranchID, others_can: othersCan };
    } catch (error) {
      if (error instanceof EntityNotFoundError) return null;
      throw error;
    }
  }

  /**
   * Find all branches (with optional filters)
   *
   * By default, returns ALL branches including archived. This matches the generic
   * Repository interface contract and allows the DrizzleService adapter to apply
   * client-side filtering (e.g., `archived: true` or `archived: false` query params).
   *
   * Callers that explicitly want to exclude archived branches should pass
   * `{ includeArchived: false }`.
   *
   * The `board_id`, `archived`, and `branchIds` filters let the list read path
   * (`BranchesService.find`) push its high-selectivity predicates into SQL so it
   * no longer materializes the whole table before filtering in memory.
   *
   * @param filter - Optional filters
   * @param filter.repo_id - Filter by repository ID
   * @param filter.includeArchived - Include archived branches (default: true)
   * @param filter.board_id - Filter to a single board
   * @param filter.archived - Filter to an exact archived state (takes precedence
   *   over `includeArchived`)
   * @param filter.branchIds - Restrict to a set of branch IDs (empty set yields
   *   no rows, matching an `{ $in: [] }` filter)
   * @param filter.visibleToUserId - Restrict to branches visible to this user
   *   under branch RBAC, pushed down as a SQL predicate instead of a preloaded
   *   `branch_id IN (...)` list.
   */
  async findAll(filter?: {
    repo_id?: UUID;
    includeArchived?: boolean;
    board_id?: BoardID;
    archived?: boolean;
    branchIds?: BranchID[];
    visibleToUserId?: UUID;
  }): Promise<Branch[]> {
    // An explicit empty id set can never match a row; short-circuit so we skip
    // the read entirely and avoid emitting an empty `IN ()` predicate.
    if (filter?.branchIds !== undefined && filter.branchIds.length === 0) {
      return [];
    }

    const includeArchived = filter?.includeArchived ?? true;

    // Build where conditions
    const conditions = [];
    if (filter?.repo_id) {
      conditions.push(eq(branches.repo_id, filter.repo_id));
    }
    if (filter?.board_id) {
      conditions.push(eq(branches.board_id, filter.board_id));
    }
    if (filter?.archived !== undefined) {
      conditions.push(eq(branches.archived, filter.archived));
    } else if (!includeArchived) {
      conditions.push(eq(branches.archived, false));
    }
    if (filter?.branchIds !== undefined) {
      conditions.push(inArray(branches.branch_id, filter.branchIds));
    }
    if (filter?.visibleToUserId) {
      conditions.push(visibleBranchAccessCondition(this.db, filter.visibleToUserId));
    }

    // The join shape differs only when RBAC SQL scoping is active. Keep the
    // execution below uniform; Drizzle's cross-dialect builder types are more
    // precise than this conditional can express.
    // biome-ignore lint/suspicious/noExplicitAny: Conditional query builder shape differs with the RBAC join
    const baseQuery: any = filter?.visibleToUserId
      ? select(this.db, getTableColumns(branches))
          .from(branches)
          .leftJoin(
            branchOwners,
            and(
              eq(branchOwners.branch_id, branches.branch_id),
              eq(branchOwners.user_id, filter.visibleToUserId)
            )
          )
      : select(this.db).from(branches);
    const rows =
      conditions.length > 0
        ? await baseQuery.where(and(...conditions)).all()
        : await baseQuery.all();

    const baseUrl = await getBaseUrl();
    return rows.map((row: BranchRow) => this.rowToBranch(row, baseUrl));
  }

  /**
   * Health-monitor discovery query. Returns only routing metadata so the
   * background monitor can enter the correct tenant DB scope before loading
   * branch contents or patching health state.
   */
  async findActiveEnvironmentRefs(): Promise<ActiveEnvironmentBranchRef[]> {
    const tenantColumn = (branches as unknown as { tenant_id?: unknown }).tenant_id;
    const columns =
      isPostgresDatabase(this.db) && tenantColumn
        ? { branch_id: branches.branch_id, tenant_id: tenantColumn }
        : { branch_id: branches.branch_id };

    const statusExpr = sql`${jsonExtract(this.db, branches.data, 'environment_instance.status')}`;
    const rows = await select(this.db, columns)
      .from(branches)
      .where(or(eq(statusExpr, 'running'), eq(statusExpr, 'starting')))
      .all();

    return (rows as Array<{ branch_id: string; tenant_id?: unknown }>).map((row) => ({
      branch_id: row.branch_id as BranchID,
      ...(typeof row.tenant_id === 'string' && row.tenant_id.length > 0
        ? { tenant_id: row.tenant_id }
        : {}),
    }));
  }

  /**
   * Find active assistant branches without paginating the whole branch list first.
   *
   * A branch is discoverable as an assistant when it has the canonical assistant
   * marker in custom_context (new or legacy key), or as a read-time backfill for
   * older hand-bootstrapped assistants, when it has at least one enabled
   * first-class schedule.
   */
  async findAssistantBranches(filter?: {
    repo_id?: UUID;
    archived?: boolean;
    userId?: UUID;
    limit?: number;
  }): Promise<Branch[]> {
    const assistantKindConditions = [
      eq(sql`${jsonExtract(this.db, branches.data, 'custom_context.assistant.kind')}`, 'assistant'),
      eq(
        sql`${jsonExtract(this.db, branches.data, 'custom_context.assistant.kind')}`,
        'persisted-agent'
      ),
      eq(sql`${jsonExtract(this.db, branches.data, 'custom_context.agent.kind')}`, 'assistant'),
      eq(
        sql`${jsonExtract(this.db, branches.data, 'custom_context.agent.kind')}`,
        'persisted-agent'
      ),
    ];

    const hasEnabledSchedule = exists(
      // biome-ignore lint/suspicious/noExplicitAny: Drizzle select has complex cross-dialect overloads
      (this.db as any)
        .select({ _: sql`1` })
        .from(schedules)
        .where(and(eq(schedules.branch_id, branches.branch_id), eq(schedules.enabled, true)))
    );

    const conditions = [or(...assistantKindConditions, hasEnabledSchedule) ?? sql`false`];
    if (filter?.repo_id) conditions.push(eq(branches.repo_id, filter.repo_id));
    if (filter?.archived !== undefined) conditions.push(eq(branches.archived, filter.archived));
    if (filter?.userId) conditions.push(visibleBranchAccessCondition(this.db, filter.userId));

    const baseQuery = select(this.db, getTableColumns(branches)).from(branches);
    const query = filter?.userId
      ? baseQuery.leftJoin(
          branchOwners,
          and(
            eq(branchOwners.branch_id, branches.branch_id),
            eq(branchOwners.user_id, filter.userId)
          )
        )
      : baseQuery;

    const rows = await query
      .where(and(...conditions))
      .limit(filter?.limit ?? 200)
      .all();

    const baseUrl = await getBaseUrl();
    return (rows as BranchRow[]).map((row) => this.rowToBranch(row, baseUrl));
  }

  /**
   * Update branch by ID (atomic with database-level transaction)
   *
   * Uses a transaction to ensure read-merge-write is atomic, preventing race conditions
   * when multiple updates happen concurrently (e.g., schedule config + environment updates).
   */
  async update(id: string, updates: Partial<Branch>): Promise<Branch> {
    // STEP 1: Read current branch (outside transaction for short ID resolution)
    const existing = await this.findById(id);
    if (!existing) {
      throw new EntityNotFoundError('Branch', id);
    }

    const baseUrl = await getBaseUrl();

    // Use transaction to make read-merge-write atomic
    return await this.db.transaction(async (tx) => {
      // Acquire row-level lock on PostgreSQL to prevent lost updates
      await lockRowForUpdate(
        txAsDb(tx),
        this.db,
        branches,
        eq(branches.branch_id, existing.branch_id)
      );

      // STEP 2: Re-read within transaction to ensure we have latest data
      const currentRow = await select(txAsDb(tx))
        .from(branches)
        .where(eq(branches.branch_id, existing.branch_id))
        .one();

      if (!currentRow) {
        throw new EntityNotFoundError('Branch', id);
      }

      const current = this.rowToBranch(currentRow, baseUrl);

      // STEP 3: Deep merge updates into current branch (in memory)
      // Preserves nested objects like schedule, environment_instance, custom_context
      const merged = deepMerge(current, {
        ...updates,
        branch_id: current.branch_id, // Never change ID
        repo_id: current.repo_id, // Never change repo
        created_at: current.created_at, // Never change created timestamp
        updated_at: new Date().toISOString(), // Always update timestamp
      });

      const insertData = this.branchToInsert(merged);

      // STEP 4: Write merged branch (within same transaction)
      const row = await update(txAsDb(tx), branches)
        .set(insertData)
        .where(eq(branches.branch_id, current.branch_id))
        .returning()
        .one();

      return this.rowToBranch(row, baseUrl);
    });
  }

  /**
   * Delete branch by ID
   */
  async delete(id: string): Promise<void> {
    const existing = await this.findById(id);
    if (!existing) {
      throw new EntityNotFoundError('Branch', id);
    }

    await deleteFrom(this.db, branches).where(eq(branches.branch_id, existing.branch_id)).run();
  }

  /**
   * Find branch by repo_id and name
   */
  async findByRepoAndName(repoId: UUID, name: string): Promise<Branch | null> {
    const row = await select(this.db)
      .from(branches)
      .where(and(eq(branches.repo_id, repoId), eq(branches.name, name)))
      .one();

    if (!row) return null;
    const baseUrl = await getBaseUrl();
    return this.rowToBranch(row, baseUrl);
  }

  /**
   * Find active (non-archived) branch by repo_id and name
   */
  async findActiveByRepoAndName(repoId: UUID, name: string): Promise<Branch | null> {
    const row = await select(this.db)
      .from(branches)
      .where(
        and(eq(branches.repo_id, repoId), eq(branches.name, name), eq(branches.archived, false))
      )
      .one();

    if (!row) return null;
    const baseUrl = await getBaseUrl();
    return this.rowToBranch(row, baseUrl);
  }

  /**
   * Get all branch_unique_id values across ALL branches (including archived).
   * Used for collision-free ID assignment — archived branches still hold their IDs.
   */
  async getAllUsedUniqueIds(): Promise<number[]> {
    const rows = await select(this.db, { branch_unique_id: branches.branch_unique_id })
      .from(branches)
      .all();
    return rows.map((row: { branch_unique_id: number }) => row.branch_unique_id);
  }

  /**
   * Get all active (non-archived) branch names for a given repo.
   * Used for auto-suffix name conflict resolution — bypasses Feathers pagination.
   */
  async getActiveNamesByRepo(repoId: UUID): Promise<string[]> {
    const rows = await select(this.db, { name: branches.name })
      .from(branches)
      .where(and(eq(branches.repo_id, repoId), eq(branches.archived, false)))
      .all();
    return rows.map((row: { name: string }) => row.name);
  }

  // ===== RBAC: Ownership Management =====

  /**
   * Check if a user is an owner of a branch
   *
   * @param branchId - Branch ID (full UUID)
   * @param userId - User ID to check
   * @returns true if user is an owner
   */
  async isOwner(branchId: BranchID, userId: UUID): Promise<boolean> {
    const row = await select(this.db)
      .from(branchOwners)
      .where(and(eq(branchOwners.branch_id, branchId), eq(branchOwners.user_id, userId)))
      .one();

    return row != null; // Use != to check for both null and undefined
  }

  /**
   * Resolve the highest group grant for a user on a branch.
   *
   * Direct branch owners are handled separately; this only considers groups
   * the user belongs to and explicit branch_group_grants rows.
   */
  async getBestGroupGrantForUser(
    branchId: BranchID,
    userId: UUID
  ): Promise<{ can: NonNullable<Branch['others_can']>; groupIds: string[] } | null> {
    const rows = await select(this.db)
      .from(branchGroupGrants)
      .innerJoin(
        groupMemberships,
        and(
          eq(groupMemberships.group_id, branchGroupGrants.group_id),
          eq(groupMemberships.user_id, userId)
        )
      )
      .innerJoin(
        groups,
        and(eq(groups.group_id, branchGroupGrants.group_id), eq(groups.archived, false))
      )
      .where(
        and(
          eq(branchGroupGrants.branch_id, branchId),
          inArray(branchGroupGrants.can, BRANCH_PERMISSION_LEVELS)
        )
      )
      .all();

    let best: NonNullable<Branch['others_can']> | null = null;
    const groupIds: string[] = [];
    for (const row of rows as Array<{ branch_group_grants: BranchGroupGrantRow }>) {
      const can = row.branch_group_grants.can as NonNullable<Branch['others_can']>;
      groupIds.push(row.branch_group_grants.group_id);
      if (!best || BRANCH_PERMISSION_RANK[can] > BRANCH_PERMISSION_RANK[best]) {
        best = can;
      }
    }
    return best ? { can: best, groupIds } : null;
  }

  /**
   * Resolve app-layer branch permission excluding global superadmin bypass.
   * Order: direct owner → highest group grant → others_can fallback.
   */
  async resolveUserPermission(
    branch: Branch,
    userId: UUID
  ): Promise<NonNullable<Branch['others_can']>> {
    return (await this.resolveUserAccess(branch, userId)).can;
  }

  /**
   * Resolve effective branch access across direct branch ACLs and board-aligned defaults.
   *
   * Keep this as the central app-layer resolver for point checks. SQL list
   * predicates in branch-access.ts mirror the visibility subset for set-based
   * queries, but callers that need the effective permission payload should use
   * this method.
   */
  async resolveUserAccess(branch: Branch, userId: UUID): Promise<EffectiveBranchAccess> {
    const board =
      branch.permission_source === 'board' && branch.board_id
        ? await select(this.db, { data: boards.data, board_id: boards.board_id })
            .from(boards)
            .where(eq(boards.board_id, branch.board_id))
            .one()
        : null;
    const boardData = board?.data as
      | {
          access_mode?: 'private' | 'shared';
          default_others_can?: Branch['others_can'];
          default_others_fs_access?: BranchFsAccessLevel;
          default_dangerously_allow_session_sharing?: boolean;
        }
      | undefined;
    const boardIsShared = (boardData?.access_mode ?? 'shared') === 'shared';
    const sharing =
      branch.permission_source === 'board' && boardIsShared
        ? (boardData?.default_dangerously_allow_session_sharing ?? false)
        : (branch.dangerously_allow_session_sharing ?? false);

    if (await this.isOwner(branch.branch_id, userId)) {
      return {
        can: 'all',
        fs_access: 'write',
        dangerously_allow_session_sharing: sharing,
        is_owner: true,
        source: 'owner',
      };
    }

    const groupRepo = new GroupRepository(this.db);
    const branchGroupGrants = await groupRepo.getBranchGrantsForUser(branch.branch_id, userId);
    if (branch.permission_source === 'board' && branch.board_id) {
      const boardOwner = await select(this.db)
        .from(boardOwners)
        .where(and(eq(boardOwners.board_id, branch.board_id), eq(boardOwners.user_id, userId)))
        .one();
      if (boardOwner) {
        return {
          can: 'all',
          fs_access: 'write',
          dangerously_allow_session_sharing: sharing,
          is_owner: true,
          source: 'board',
        };
      }
    }
    const boardGroupGrants =
      board && boardIsShared && branch.board_id
        ? await groupRepo.getBoardGrantsForUser(branch.board_id, userId)
        : [];
    const others =
      branch.permission_source === 'board' && boardIsShared
        ? ((boardData?.default_others_can as NonNullable<Branch['others_can']> | undefined) ??
          'session')
        : branch.permission_source === 'board'
          ? 'none'
          : (branch.others_can ?? 'session');
    const othersFs =
      branch.permission_source === 'board' && boardIsShared
        ? (boardData?.default_others_fs_access ?? 'read')
        : branch.permission_source === 'board'
          ? 'none'
          : (branch.others_fs_access ?? 'read');

    const candidates: EffectiveBranchAccess[] = [
      {
        can: others,
        fs_access: othersFs,
        dangerously_allow_session_sharing: sharing,
        is_owner: false,
        source: branch.permission_source === 'board' ? 'board' : 'others',
      },
      ...branchGroupGrants.map((grant) => ({
        can: grant.can,
        fs_access: grant.fs_access ?? 'read',
        dangerously_allow_session_sharing: sharing,
        is_owner: false,
        source: 'group' as const,
        group_ids: [grant.group_id],
      })),
      ...boardGroupGrants.map((grant) => ({
        can: grant.can,
        fs_access: grant.fs_access ?? 'read',
        dangerously_allow_session_sharing: sharing,
        is_owner: false,
        source: 'board_group' as const,
        group_ids: [grant.group_id],
      })),
    ];

    return candidates.reduce((best, candidate) => {
      const canDelta = BRANCH_PERMISSION_RANK[candidate.can] - BRANCH_PERMISSION_RANK[best.can];
      if (canDelta !== 0) return canDelta > 0 ? candidate : best;
      const candidateFsRank = FS_ACCESS_RANK[candidate.fs_access ?? 'none'];
      const bestFsRank = FS_ACCESS_RANK[best.fs_access ?? 'none'];
      return candidateFsRank > bestFsRank ? candidate : best;
    });
  }

  /**
   * Find users with explicit view-or-better access to a branch through direct
   * ownership or active group grants. This intentionally does not expand
   * `others_can`; callers can handle public branch visibility without loading
   * every user row.
   */
  async findExplicitViewUserIds(branchId: BranchID): Promise<UUID[]> {
    const branchRow = await select(this.db, {
      board_id: branches.board_id,
      permission_source: branches.permission_source,
    })
      .from(branches)
      .where(eq(branches.branch_id, branchId))
      .one();

    const ownerRows = await select(this.db, { user_id: branchOwners.user_id })
      .from(branchOwners)
      .where(eq(branchOwners.branch_id, branchId))
      .all();

    const groupRows = await select(this.db, { user_id: groupMemberships.user_id })
      .from(branchGroupGrants)
      .innerJoin(groupMemberships, eq(groupMemberships.group_id, branchGroupGrants.group_id))
      .innerJoin(
        groups,
        and(eq(groups.group_id, branchGroupGrants.group_id), eq(groups.archived, false))
      )
      .where(
        and(
          eq(branchGroupGrants.branch_id, branchId),
          inArray(branchGroupGrants.can, VIEW_OR_BETTER_BRANCH_PERMISSIONS)
        )
      )
      .all();

    const boardOwnerRows =
      branchRow?.permission_source === 'board' && branchRow.board_id
        ? await select(this.db, { user_id: boardOwners.user_id })
            .from(boardOwners)
            .where(eq(boardOwners.board_id, branchRow.board_id))
            .all()
        : [];

    const boardGroupRows =
      branchRow?.permission_source === 'board' && branchRow.board_id
        ? await select(this.db, { user_id: groupMemberships.user_id })
            .from(boardGroupGrants)
            .innerJoin(groupMemberships, eq(groupMemberships.group_id, boardGroupGrants.group_id))
            .innerJoin(
              groups,
              and(eq(groups.group_id, boardGroupGrants.group_id), eq(groups.archived, false))
            )
            .innerJoin(
              boards,
              and(
                eq(boards.board_id, boardGroupGrants.board_id),
                eq(
                  sql`coalesce(${jsonExtract(this.db, boards.data, 'access_mode')}, 'shared')`,
                  'shared'
                )
              )
            )
            .where(
              and(
                eq(boardGroupGrants.board_id, branchRow.board_id),
                inArray(boardGroupGrants.can, VIEW_OR_BETTER_BRANCH_PERMISSIONS)
              )
            )
            .all()
        : [];

    const userIds = new Set<UUID>();
    for (const row of ownerRows as Array<{ user_id: string }>) {
      userIds.add(row.user_id as UUID);
    }
    for (const row of groupRows as Array<{ user_id: string }>) {
      userIds.add(row.user_id as UUID);
    }
    for (const row of boardOwnerRows as Array<{ user_id: string }>) {
      userIds.add(row.user_id as UUID);
    }
    for (const row of boardGroupRows as Array<{ user_id: string }>) {
      userIds.add(row.user_id as UUID);
    }
    return Array.from(userIds);
  }

  /**
   * Find users whose explicit branch or aligned-board grants should materialize
   * into filesystem access for the branch.
   *
   * This intentionally excludes ambient "others" access because there is no
   * bounded user set to expand. Board owners apply whenever the branch is
   * explicitly aligned to board permissions (`permission_source = 'board'`);
   * board group grants additionally require a shared board. Override branches
   * must not inherit board grants.
   */
  async findExplicitFsAccessUserIds(branchId: BranchID): Promise<UUID[]> {
    const branchRow = await select(this.db, {
      board_id: branches.board_id,
      permission_source: branches.permission_source,
    })
      .from(branches)
      .where(eq(branches.branch_id, branchId))
      .one();

    const ownerRows = await select(this.db, { user_id: branchOwners.user_id })
      .from(branchOwners)
      .where(eq(branchOwners.branch_id, branchId))
      .all();

    const groupRows = await select(this.db, { user_id: groupMemberships.user_id })
      .from(branchGroupGrants)
      .innerJoin(groupMemberships, eq(groupMemberships.group_id, branchGroupGrants.group_id))
      .innerJoin(
        groups,
        and(eq(groups.group_id, branchGroupGrants.group_id), eq(groups.archived, false))
      )
      .where(
        and(
          eq(branchGroupGrants.branch_id, branchId),
          inArray(
            sql`coalesce(${branchGroupGrants.fs_access}, 'read')`,
            FS_ACCESS_BRANCH_PERMISSIONS
          )
        )
      )
      .all();

    const isBoardAligned = branchRow?.permission_source === 'board' && branchRow.board_id;
    const boardOwnerRows = isBoardAligned
      ? await select(this.db, { user_id: boardOwners.user_id })
          .from(boardOwners)
          .where(eq(boardOwners.board_id, branchRow.board_id))
          .all()
      : [];

    const boardGroupRows = isBoardAligned
      ? await select(this.db, { user_id: groupMemberships.user_id })
          .from(boardGroupGrants)
          .innerJoin(groupMemberships, eq(groupMemberships.group_id, boardGroupGrants.group_id))
          .innerJoin(
            groups,
            and(eq(groups.group_id, boardGroupGrants.group_id), eq(groups.archived, false))
          )
          .innerJoin(
            boards,
            and(
              eq(boards.board_id, boardGroupGrants.board_id),
              eq(
                sql`coalesce(${jsonExtract(this.db, boards.data, 'access_mode')}, 'shared')`,
                'shared'
              )
            )
          )
          .where(
            and(
              eq(boardGroupGrants.board_id, branchRow.board_id),
              inArray(
                sql`coalesce(${boardGroupGrants.fs_access}, 'read')`,
                FS_ACCESS_BRANCH_PERMISSIONS
              )
            )
          )
          .all()
      : [];

    const userIds = new Set<UUID>();
    for (const row of ownerRows as Array<{ user_id: string }>) {
      userIds.add(row.user_id as UUID);
    }
    for (const row of groupRows as Array<{ user_id: string }>) {
      userIds.add(row.user_id as UUID);
    }
    for (const row of boardOwnerRows as Array<{ user_id: string }>) {
      userIds.add(row.user_id as UUID);
    }
    for (const row of boardGroupRows as Array<{ user_id: string }>) {
      userIds.add(row.user_id as UUID);
    }
    return Array.from(userIds);
  }

  async findBoardAlignedBranches(boardId: BoardID): Promise<Branch[]> {
    const rows = await select(this.db)
      .from(branches)
      .where(
        and(
          eq(branches.board_id, boardId),
          eq(branches.permission_source, 'board'),
          eq(branches.archived, false)
        )
      )
      .all();

    const baseUrl = await getBaseUrl();
    return rows.map((row: BranchRow) => this.rowToBranch(row, baseUrl));
  }

  /**
   * Get all owners of a branch
   *
   * @param branchId - Branch ID (full UUID or short ID)
   * @returns Array of user IDs
   */
  async getOwners(branchId: string): Promise<UUID[]> {
    // Resolve short ID to full ID
    const branch = await this.findById(branchId);
    if (!branch) {
      throw new EntityNotFoundError('Branch', branchId);
    }

    const rows = await select(this.db)
      .from(branchOwners)
      .where(eq(branchOwners.branch_id, branch.branch_id))
      .all();

    return rows.map((row: { user_id: string }) => row.user_id as UUID);
  }

  /**
   * Add an owner to a branch
   *
   * Idempotent - does nothing if user is already an owner.
   *
   * @param branchId - Branch ID (full UUID or short ID)
   * @param userId - User ID to add
   */
  async addOwner(branchId: string, userId: UUID): Promise<void> {
    // Resolve short ID to full ID
    const branch = await this.findById(branchId);
    if (!branch) {
      throw new EntityNotFoundError('Branch', branchId);
    }

    // Check if already an owner (idempotent)
    const isExisting = await this.isOwner(branch.branch_id, userId);
    if (isExisting) {
      return; // Already an owner, nothing to do
    }

    // Add ownership
    await insert(this.db, branchOwners)
      .values({
        branch_id: branch.branch_id,
        user_id: userId,
        created_at: new Date(), // Explicitly set timestamp (migration has wrong default)
      })
      .run();
  }

  /**
   * Remove an owner from a branch
   *
   * Idempotent - does nothing if user is not an owner.
   *
   * @param branchId - Branch ID (full UUID or short ID)
   * @param userId - User ID to remove
   */
  async removeOwner(branchId: string, userId: UUID): Promise<void> {
    // Resolve short ID to full ID
    const branch = await this.findById(branchId);
    if (!branch) {
      throw new EntityNotFoundError('Branch', branchId);
    }

    // Remove ownership (idempotent - will do nothing if not an owner)
    await deleteFrom(this.db, branchOwners)
      .where(and(eq(branchOwners.branch_id, branch.branch_id), eq(branchOwners.user_id, userId)))
      .run();
  }

  /**
   * Bulk-load ownership for multiple branches
   *
   * Returns a Map of branch_id -> user_ids[] for efficient lookups.
   * Used to avoid N+1 queries when checking ownership for multiple branches.
   *
   * @param branchIds - Array of branch IDs (full UUIDs)
   * @returns Map of branch_id -> array of owner user_ids
   */
  async bulkLoadOwners(branchIds: BranchID[]): Promise<Map<BranchID, UUID[]>> {
    if (branchIds.length === 0) {
      return new Map();
    }

    // Query all owners for the given branches using inArray
    const rows = await select(this.db)
      .from(branchOwners)
      .where(inArray(branchOwners.branch_id, branchIds))
      .all();

    // Group by branch_id
    const ownersByBranch = new Map<BranchID, UUID[]>();
    for (const row of rows) {
      const wtId = row.branch_id as BranchID;
      const userId = row.user_id as UUID;

      if (!ownersByBranch.has(wtId)) {
        ownersByBranch.set(wtId, []);
      }
      ownersByBranch.get(wtId)!.push(userId);
    }

    return ownersByBranch;
  }

  /**
   * Find all branches accessible to a user (optimized RBAC query)
   *
   * Uses LEFT JOIN to check ownership in one query instead of N+1.
   * Returns branches where user is an owner OR others_can allows at least 'view' access.
   *
   * NOTE: This method should only be called when RBAC is enabled. The branch
   * find RBAC hook uses it to resolve accessible branch IDs and compose them
   * into the service query; when RBAC is disabled, default Feathers query
   * handling returns all branches without access filtering.
   *
   * @param userId - User ID to check access for
   * @param filter - Optional filters
   * @param filter.archived - If true, return only archived. If false, only non-archived. If undefined, return all.
   * @returns Array of accessible branches
   */
  async findAccessibleBranches(userId: UUID, filter?: { archived?: boolean }): Promise<Branch[]> {
    const conditions = [visibleBranchAccessCondition(this.db, userId)];

    // Apply archived filter at SQL level
    if (filter?.archived === true) {
      conditions.push(eq(branches.archived, true));
    } else if (filter?.archived === false) {
      conditions.push(eq(branches.archived, false));
    }

    const rows = await select(this.db, getTableColumns(branches))
      .from(branches)
      .leftJoin(
        branchOwners,
        and(eq(branchOwners.branch_id, branches.branch_id), eq(branchOwners.user_id, userId))
      )
      .where(and(...conditions))
      .all();

    const baseUrl = await getBaseUrl();
    const seen = new Set<string>();
    const result: Branch[] = [];
    for (const row of rows as BranchRow[]) {
      if (seen.has(row.branch_id)) continue;
      seen.add(row.branch_id);
      result.push(this.rowToBranch(row, baseUrl));
    }
    return result;
  }

  /**
   * Find branch IDs pinned to a specific board zone.
   *
   * Zone membership lives on board_objects.data.zone_id, not on the branches
   * table. BranchesService.find() uses this helper to turn a zone_id query into
   * a branch_id filter before the generic adapter applies pagination.
   */
  async findBranchIdsByZone(zoneId: string): Promise<BranchID[]> {
    const { boardObjects: boardObjectsTable } = await import('../schema');
    const { jsonExtract } = await import('../database-wrapper');

    const rows = await select(this.db, {
      branch_id: boardObjectsTable.branch_id,
    })
      .from(boardObjectsTable)
      .where(sql`${jsonExtract(this.db, boardObjectsTable.data, 'zone_id')} = ${zoneId}`)
      .all();

    const uniqueIds = new Set<BranchID>();
    for (const row of rows as { branch_id: string | null }[]) {
      if (row.branch_id) {
        uniqueIds.add(row.branch_id as BranchID);
      }
    }

    return Array.from(uniqueIds);
  }

  /**
   * Enrich a single branch with zone information
   *
   * Uses the batch enrichment method for consistency and efficiency.
   * Just wraps the branch in an array and unwraps the result.
   *
   * @param branch - Branch to enrich
   * @returns Branch with board_object_id, position, zone_id, and zone_label added (if on a board)
   */
  async enrichWithZoneInfo(branch: Branch): Promise<BranchWithZone> {
    // Use batch enrichment for single branch (same efficient query)
    const enriched = await this.enrichManyWithZoneInfo([branch]);
    return enriched[0] || branch;
  }

  /**
   * Enrich multiple branches with zone information (batch operation)
   *
   * Uses a single efficient query with LEFT JOINs to fetch board_objects + boards.
   * No N+1 queries - all data fetched in one round trip to the database.
   *
   * IMPORTANT: This only enriches branches that have board_objects entries.
   * Branches on a board but not yet positioned (no board_object) will not have zone info.
   * This is correct behavior - if there's no board_object, the branch isn't in a zone.
   *
   * @param branches - Array of branches to enrich
   * @returns Array of branches with board object + zone info added (where applicable)
   */
  async enrichManyWithZoneInfo(branches: Branch[]): Promise<BranchWithZone[]> {
    // Quick path: if no branches, return empty array
    if (branches.length === 0) {
      return [];
    }

    try {
      // Get branch IDs that are on boards
      const branchIds = branches.filter((wt) => wt.board_id).map((wt) => wt.branch_id);

      // If no branches are on boards, return as-is
      if (branchIds.length === 0) {
        return branches;
      }

      // Single query with LEFT JOINs to get board_objects and boards
      // NOTE: This only fetches branches that have board_objects entries.
      // Branches on a board without board_objects (not positioned yet) won't appear here.
      // This is correct - no board_object means no zone assignment.
      const { boardObjects: boardObjectsTable, boards: boardsTable } = await import('../schema');
      const { jsonExtract } = await import('../database-wrapper');

      const rows = await select(this.db, {
        branch_id: boardObjectsTable.branch_id,
        object_id: boardObjectsTable.object_id,
        zone_id: jsonExtract(this.db, boardObjectsTable.data, 'zone_id'),
        position: jsonExtract(this.db, boardObjectsTable.data, 'position'),
        board_data: boardsTable.data,
      })
        .from(boardObjectsTable)
        .leftJoin(boardsTable, eq(boardObjectsTable.board_id, boardsTable.board_id))
        .where(inArray(boardObjectsTable.branch_id, branchIds))
        .all();

      // Build a map of branch_id -> board object info for O(1) lookup
      const boardObjectInfoByBranch = new Map<
        string,
        {
          board_object_id: string;
          position?: { x: number; y: number };
          zone_id?: string;
          zone_label?: string;
        }
      >();

      for (const row of rows) {
        const info: {
          board_object_id: string;
          position?: { x: number; y: number };
          zone_id?: string;
          zone_label?: string;
        } = {
          board_object_id: row.object_id as string,
        };

        // Parse position from JSON extract
        if (row.position) {
          try {
            const pos = typeof row.position === 'string' ? JSON.parse(row.position) : row.position;
            if (pos && typeof pos.x === 'number' && typeof pos.y === 'number') {
              info.position = { x: pos.x, y: pos.y };
            }
          } catch {
            // Invalid position JSON, skip
          }
        }

        // Extract zone info if present
        if (row.zone_id) {
          info.zone_id = row.zone_id;

          const boardData = row.board_data as {
            objects?: Record<string, { type: string; label?: string }>;
          } | null;

          const zone = boardData?.objects?.[row.zone_id];
          info.zone_label = zone?.type === 'zone' ? zone.label : undefined;
        }

        boardObjectInfoByBranch.set(row.branch_id as string, info);
      }

      // Enrich branches with board object info using O(1) map lookup
      // Branches not in the map are returned unchanged (no board object)
      return branches.map((wt) => {
        const info = boardObjectInfoByBranch.get(wt.branch_id);
        if (!info) {
          // Branch not on a board or no board_object yet
          return wt;
        }

        return {
          ...wt,
          board_object_id: info.board_object_id,
          position: info.position,
          zone_id: info.zone_id,
          zone_label: info.zone_label,
        };
      });
    } catch (error) {
      console.warn(
        'Failed to batch enrich branches with zone info:',
        error instanceof Error ? error.message : String(error)
      );
      // Return branches without zone info on error
      return branches;
    }
  }

  /**
   * Enrich a single branch with session activity information
   *
   * @param branch - Branch to enrich
   * @param truncationLength - Maximum length for last_message (default: 500)
   * @returns Branch with sessions array added
   */
  async enrichWithSessionActivity(
    branch: BranchWithZone,
    truncationLength = 500
  ): Promise<BranchWithZoneAndSessions> {
    const enriched = await this.enrichManyWithSessionActivity([branch], truncationLength);
    return enriched[0] || branch;
  }

  /**
   * Enrich multiple branches with session activity information (batch operation)
   *
   * Uses efficient LEFT JOINs to fetch sessions, tasks, and messages in bulk.
   * Returns recent session activity (most recent first) with last message truncated.
   *
   * @param branches - Array of branches to enrich
   * @param truncationLength - Maximum length for last_message (default: 500)
   * @returns Array of branches with sessions array added
   */
  async enrichManyWithSessionActivity(
    branches: BranchWithZone[],
    truncationLength = 500
  ): Promise<BranchWithZoneAndSessions[]> {
    // Quick path: if no branches, return empty array
    if (branches.length === 0) {
      return [];
    }

    try {
      const branchIds = branches.map((wt) => wt.branch_id);

      // Import schema tables dynamically
      const { sessions: sessionsTable, messages: messagesTable } = await import('../schema');

      // Query to get recent sessions for these branches
      const sessionRows = await select(this.db, {
        branch_id: sessionsTable.branch_id,
        session_id: sessionsTable.session_id,
        status: sessionsTable.status,
        agentic_tool: sessionsTable.agentic_tool,
        updated_at: sessionsTable.updated_at,
        unix_username: sessionsTable.unix_username,
      })
        .from(sessionsTable)
        .where(inArray(sessionsTable.branch_id, branchIds))
        .orderBy(sessionsTable.updated_at)
        .all();

      const sessionIds = sessionRows.map((s: { session_id: unknown }) => s.session_id as string);

      if (sessionIds.length === 0) {
        // No sessions found, return branches as-is with empty sessions array
        return branches.map((wt) => ({ ...wt, sessions: [] }));
      }

      // Get last assistant message for each session using N+1 queries
      // This is acceptable since we typically have 1-5 sessions per branch
      // Much better than fetching all messages which could be huge for long-running sessions
      const lastMessageBySession = new Map<string, string>();

      for (const sessionId of sessionIds) {
        const query = select(this.db, {
          data: messagesTable.data,
        })
          .from(messagesTable)
          .where(and(eq(messagesTable.session_id, sessionId), eq(messagesTable.role, 'assistant')));

        // Chain orderBy and limit, then execute with one()
        // The spread operator in the wrapper passes through these methods
        const lastMessage = await query.orderBy(desc(messagesTable.index)).limit(1).one();

        if (lastMessage) {
          // Extract text content from message data and truncate to requested length
          const messageData = lastMessage.data as {
            content?: Array<{ type: string; text?: string }>;
          };
          let fullText = '';

          // Extract text from content blocks (messages can have multiple content blocks)
          if (messageData?.content && Array.isArray(messageData.content)) {
            fullText = messageData.content
              .filter((block) => block.type === 'text' && block.text)
              .map((block) => block.text)
              .join('\n');
          }

          // Truncate to requested length
          if (fullText.length > truncationLength) {
            fullText = `${fullText.substring(0, truncationLength)}...`;
          }

          lastMessageBySession.set(sessionId, fullText);
        }
      }

      // Batch count messages per session in one query
      const countRows = await select(this.db, {
        session_id: messagesTable.session_id,
        count: sql<number>`count(*)`,
      })
        .from(messagesTable)
        .where(inArray(messagesTable.session_id, sessionIds))
        .groupBy(messagesTable.session_id)
        .all();
      const messageCountBySession = new Map<string, number>();
      for (const r of countRows) {
        messageCountBySession.set(r.session_id as string, Number(r.count));
      }

      // Build sessions map grouped by branch_id
      const sessionsByBranch = new Map<string, BranchSessionActivity[]>();

      for (const row of sessionRows) {
        const branchId = row.branch_id as string;
        const sessionId = row.session_id as string;

        // Get last message and truncate if needed
        let lastMessage = lastMessageBySession.get(sessionId) || '';
        if (lastMessage.length > truncationLength) {
          lastMessage = `${lastMessage.substring(0, truncationLength)}...truncated`;
        }

        const sessionActivity: BranchSessionActivity = {
          session_id: sessionId,
          status: row.status as BranchSessionActivity['status'],
          agentic_tool: row.agentic_tool as BranchSessionActivity['agentic_tool'],
          last_updated: row.updated_at
            ? new Date(row.updated_at).toISOString()
            : new Date().toISOString(),
          last_message: lastMessage,
          message_count: messageCountBySession.get(sessionId) ?? 0,
          unix_username: (row.unix_username as string) || 'unknown',
        };

        if (!sessionsByBranch.has(branchId)) {
          sessionsByBranch.set(branchId, []);
        }
        sessionsByBranch.get(branchId)!.push(sessionActivity);
      }

      // Sort sessions by last_updated DESC within each branch
      for (const sessions of sessionsByBranch.values()) {
        sessions.sort((a, b) => {
          return new Date(b.last_updated).getTime() - new Date(a.last_updated).getTime();
        });
      }

      // Enrich branches with session activity
      const result = branches.map((wt) => {
        const sessions = sessionsByBranch.get(wt.branch_id) || [];
        return {
          ...wt,
          sessions,
        };
      });
      return result;
    } catch (error) {
      console.error(
        'Failed to enrich branches with session activity:',
        error instanceof Error ? error.message : String(error)
      );
      // Return branches without session activity on error
      return branches.map((wt) => ({ ...wt, sessions: [] }));
    }
  }
}
