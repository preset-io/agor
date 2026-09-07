/**
 * Branch Repository
 *
 * Type-safe CRUD operations for branches with short ID support.
 */

import type {
  AgenticToolName,
  BoardID,
  Branch,
  BranchID,
  EffectiveBranchAccess,
  GroupID,
  SessionPromptAuthority,
  SessionSdkHomeScope,
  SessionStatus,
  UUID,
} from '@agor/core/types';
import { and, asc, desc, eq, exists, inArray, isNull, like, or, type SQL, sql } from 'drizzle-orm';
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
  runDatabaseTransaction,
  select,
  txAsDb,
  update,
} from '../database-wrapper';
import {
  type BranchInsert,
  type BranchRow,
  branches,
  branchPermissionConfigs,
  branchPermissionEntries,
  groupMemberships,
  messages,
  schedules,
  sessions,
  users,
} from '../schema';
import {
  attachHiddenTenant,
  type BaseRepository,
  EntityNotFoundError,
  RESOLVE_SHORT_ID_FETCH_LIMIT,
  RepositoryError,
  resolveByShortIdPrefix,
} from './base';
import {
  minimumBranchAccessCondition,
  sessionBranchAccessCondition,
  visibleBranchAccessCondition,
  visibleBranchReferenceAccessExists,
} from './branch-access';
import { CapabilityPolicyRepository } from './capability-policies';
import { deepMerge } from './merge-utils';
import {
  extractMessageText,
  findLatestAssistantMessages,
  truncateMessageText,
} from './message-activity';

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
        primary_owner_user_id: row.primary_owner_user_id as UUID,
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
        permission_source: row.permission_binding === 'inherit' ? 'board' : 'override',
        permission_binding: row.permission_binding ?? 'override',
        others_can: row.others_can ?? undefined,
        others_fs_access: row.others_fs_access ?? undefined,
        // Branch storage mode
        storage_mode: row.storage_mode ?? 'worktree',
        clone_depth: row.clone_depth ?? undefined,
        // Per-branch SDK home intent (design §9.2)
        sdk_home: row.sdk_home ?? undefined,
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
    const permissionBinding =
      branch.permission_binding ?? (branch.permission_source === 'board' ? 'inherit' : 'override');
    if (permissionBinding === 'inherit' && !branch.board_id) {
      throw new RepositoryError('A branch without a board cannot inherit permissions');
    }

    return {
      branch_id: branchId,
      repo_id: branch.repo_id!,
      created_at: branch.created_at ? new Date(branch.created_at) : new Date(now),
      updated_at: new Date(now),
      created_by: branch.created_by,
      primary_owner_user_id: branch.primary_owner_user_id ?? branch.created_by,
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
      // Legacy authority columns remain only as a fail-closed compatibility
      // shell. Normalized capability tables are the sole source of truth.
      permission_source: 'override',
      permission_binding: permissionBinding,
      others_can: 'none',
      others_fs_access: 'none',
      // Branch storage mode (default 'worktree' matches schema default)
      storage_mode: branch.storage_mode ?? 'worktree',
      clone_depth: branch.clone_depth ?? null,
      data: {
        path: branch.path!,
        base_ref: branch.base_ref,
        base_remote_url: branch.base_remote_url,
        base_sha: branch.base_sha,
        last_commit_sha: branch.last_commit_sha,
        tracking_branch: branch.tracking_branch,
        new_branch: branch.new_branch ?? false,
        issue_url: branch.issue_url,
        pull_request_url: branch.pull_request_url,
        notes: branch.notes,
        error_message: branch.error_message,
        provisioning_attempt_id: branch.provisioning_attempt_id,
        provisioning_operation: branch.provisioning_operation,
        environment_instance: branch.environment_instance,
        last_used: branch.last_used ?? new Date(now).toISOString(),
        custom_context: branch.custom_context,
        mcp_server_ids: branch.mcp_server_ids,
      },
    };
  }

  /**
   * Create a new branch
   */
  async create(branch: Partial<Branch>): Promise<Branch> {
    const insertData = this.branchToInsert(branch);
    try {
      const row = await runDatabaseTransaction(
        this.db,
        async (tx) => {
          const owner = await select(tx, { user_id: users.user_id })
            .from(users)
            .where(eq(users.user_id, insertData.primary_owner_user_id))
            .one();
          if (!owner) {
            throw new RepositoryError(
              `Cannot create Branch: primary owner ${insertData.primary_owner_user_id} does not exist in this tenant`
            );
          }
          const created = await insert(tx, branches).values(insertData).returning().one();
          if (insertData.permission_binding === 'override') {
            await new CapabilityPolicyRepository(tx).initializeBranchOverrideInTransaction(
              tx,
              created.branch_id as BranchID,
              created.primary_owner_user_id as UUID,
              {
                othersCan: branch.others_can,
                othersFsAccess: branch.others_fs_access,
              }
            );
          }
          return created;
        },
        { sqliteImmediate: true }
      );
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
  async findRealtimeVisibilityBranch(id: string): Promise<Pick<Branch, 'branch_id'> | null> {
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
      })
        .from(branches)
        .where(eq(branches.branch_id, fullId))
        .one();
      if (!row) return null;
      return { branch_id: row.branch_id as BranchID };
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

    const baseQuery = select(this.db).from(branches);
    const rows =
      conditions.length > 0
        ? await baseQuery.where(and(...conditions)).all()
        : await baseQuery.all();

    const baseUrl = await getBaseUrl();
    return rows.map((row: BranchRow) => this.rowToBranch(row, baseUrl));
  }

  /** Fetch a simple branch list page with filtering, sorting, and pagination in SQL. */
  async findPage(opts: {
    repo_id?: UUID;
    board_id?: BoardID;
    archived?: boolean;
    branchIds?: BranchID[];
    visibleToUserId?: UUID;
    limit?: number;
    offset?: number;
    sort?: Record<string, 1 | -1>;
  }): Promise<{ data: Branch[]; total: number }> {
    if (opts.branchIds?.length === 0) return { data: [], total: 0 };

    const conditions: SQL[] = [];
    if (opts.repo_id) conditions.push(eq(branches.repo_id, opts.repo_id));
    if (opts.board_id) conditions.push(eq(branches.board_id, opts.board_id));
    if (opts.archived !== undefined) conditions.push(eq(branches.archived, opts.archived));
    if (opts.branchIds) conditions.push(inArray(branches.branch_id, opts.branchIds));
    if (opts.visibleToUserId) {
      conditions.push(visibleBranchAccessCondition(this.db, opts.visibleToUserId));
    }
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    let countQuery = select(this.db, { count: sql<number>`count(*)` }).from(branches);
    if (whereClause) countQuery = countQuery.where(whereClause);
    const countRow = await countQuery.one();
    const total = Number(countRow?.count ?? 0);

    const sortColumns = {
      branch_id: branches.branch_id,
      name: branches.name,
      ref: branches.ref,
      created_at: branches.created_at,
    } as const;
    const orderBy: SQL[] = [];
    for (const [field, direction] of Object.entries(opts.sort ?? {})) {
      if (field === 'updated_at') {
        const logicalUpdatedAt = sql`COALESCE(${branches.updated_at}, ${branches.created_at})`;
        orderBy.push(direction === -1 ? desc(logicalUpdatedAt) : asc(logicalUpdatedAt));
        continue;
      }
      const column = sortColumns[field as keyof typeof sortColumns];
      if (!column) continue;
      orderBy.push(direction === -1 ? desc(column) : asc(column));
    }
    if (orderBy.length === 0) orderBy.push(asc(branches.created_at));
    if (!Object.hasOwn(opts.sort ?? {}, 'branch_id')) orderBy.push(asc(branches.branch_id));

    let dataQuery = select(this.db).from(branches);
    if (whereClause) dataQuery = dataQuery.where(whereClause);
    dataQuery = dataQuery.orderBy(...orderBy);
    if (opts.limit !== undefined) dataQuery = dataQuery.limit(opts.limit);
    if (opts.offset) dataQuery = dataQuery.offset(opts.offset);

    const baseUrl = await getBaseUrl();
    const rows = await dataQuery.all();
    return { data: (rows as BranchRow[]).map((row) => this.rowToBranch(row, baseUrl)), total };
  }

  /**
   * Return the complete branch inventory for one repository without transport
   * pagination. Repository deletion uses this after locking the parent row so
   * every database-cascaded removal has a corresponding tombstone.
   */
  async findAllByRepoId(repoId: UUID): Promise<Branch[]> {
    return this.findAll({ repo_id: repoId });
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
      .where(
        and(eq(branches.archived, false), or(eq(statusExpr, 'running'), eq(statusExpr, 'starting')))
      )
      .all();

    return (rows as Array<{ branch_id: string; tenant_id?: unknown }>).map((row) => ({
      branch_id: row.branch_id as BranchID,
      ...(typeof row.tenant_id === 'string' && row.tenant_id.length > 0
        ? { tenant_id: row.tenant_id }
        : {}),
    }));
  }

  /**
   * Find active teammate branches without paginating the whole branch list first.
   *
   * A branch is discoverable as a teammate when it has the canonical teammate
   * marker in custom_context (new or legacy key), or as a read-time backfill for
   * older hand-bootstrapped teammates, when it has at least one enabled
   * first-class schedule.
   */
  async findTeammateBranches(filter?: {
    repo_id?: UUID;
    archived?: boolean;
    userId?: UUID;
    minimumPermission?: 'view' | 'session';
    limit?: number;
    offset?: number;
  }): Promise<Branch[]> {
    const teammateKindConditions = [
      eq(sql`${jsonExtract(this.db, branches.data, 'custom_context.teammate.kind')}`, 'teammate'),
      eq(sql`${jsonExtract(this.db, branches.data, 'custom_context.assistant.kind')}`, 'assistant'),
      eq(sql`${jsonExtract(this.db, branches.data, 'custom_context.assistant.kind')}`, 'teammate'),
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

    const conditions = [or(...teammateKindConditions, hasEnabledSchedule) ?? sql`false`];
    if (filter?.repo_id) conditions.push(eq(branches.repo_id, filter.repo_id));
    if (filter?.archived !== undefined) conditions.push(eq(branches.archived, filter.archived));
    if (filter?.userId) {
      conditions.push(
        filter.minimumPermission === 'session'
          ? sessionBranchAccessCondition(this.db, filter.userId)
          : visibleBranchAccessCondition(this.db, filter.userId)
      );
    }

    const rows = await select(this.db)
      .from(branches)
      .where(and(...conditions))
      .orderBy(desc(branches.branch_id))
      .limit(filter?.limit ?? 200)
      .offset(filter?.offset ?? 0)
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
  async update(
    id: string,
    updates: Partial<Branch>,
    options?: {
      preserveUpdatedAt?: boolean;
      /** Explicit lifecycle boundary, including starting -> starting retries. */
      invalidateEnvironmentObservation?: boolean;
    }
  ): Promise<Branch> {
    if (Object.hasOwn(updates, 'primary_owner_user_id')) {
      throw new RepositoryError('Primary ownership is immutable');
    }
    if (Object.hasOwn(updates, 'sdk_home')) {
      throw new RepositoryError(
        'Branch SDK-home intent is server-managed and must be adopted through adoptSdkHome()'
      );
    }
    if (
      ['permission_binding', 'permission_source', 'others_can', 'others_fs_access'].some((field) =>
        Object.hasOwn(updates, field)
      )
    ) {
      throw new RepositoryError(
        'Branch permissions must be changed through the branch permission policy service'
      );
    }
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

      if (
        Object.hasOwn(updates, 'board_id') &&
        currentRow.board_id !== (updates.board_id ?? null) &&
        currentRow.permission_binding === 'inherit'
      ) {
        throw new RepositoryError(
          'Switch this branch to an explicit permission override before moving it to another board.'
        );
      }

      const current = this.rowToBranch(currentRow, baseUrl);

      if (updates.archived === true && current.filesystem_status === 'creating') {
        throw new RepositoryError(
          'Cannot archive a branch while filesystem provisioning is in progress'
        );
      }

      // STEP 3: Deep merge updates into current branch (in memory)
      // Preserves nested objects like schedule, environment_instance, custom_context
      const merged = deepMerge(current, {
        ...updates,
        branch_id: current.branch_id, // Never change ID
        repo_id: current.repo_id, // Never change repo
        created_at: current.created_at, // Never change created timestamp
        updated_at: options?.preserveUpdatedAt ? current.updated_at : new Date().toISOString(),
      });
      // A materialization error describes only the failed filesystem state.
      // Clear it atomically with every explicit transition away from failed
      // so a successful retry/unarchive cannot remain visually poisoned by
      // the previous attempt. undefined cannot express deletion through
      // deepMerge because it intentionally means preserve.
      if (updates.filesystem_status !== undefined && updates.filesystem_status !== 'failed') {
        delete merged.error_message;
      }

      const insertData = this.branchToInsert(merged);
      if (options?.preserveUpdatedAt) {
        insertData.updated_at = new Date(current.updated_at);
      }

      // Any eligibility/lifecycle change invalidates an observation that may
      // currently be outside the database performing HTTP. The result writer
      // also compares this generation, so clearing the token is not the only
      // fence. Health observations use their dedicated repository and never
      // enter this generic update path.
      const currentStatus = current.environment_instance?.status;
      const mergedStatus = merged.environment_instance?.status;
      const invalidatesEnvironmentObservation =
        options?.invalidateEnvironmentObservation === true ||
        currentStatus !== mergedStatus ||
        current.health_check_url !== merged.health_check_url ||
        Boolean(current.archived) !== Boolean(merged.archived);
      const environmentCoordinationUpdate = invalidatesEnvironmentObservation
        ? {
            environment_generation: sql`${branches.environment_generation} + 1`,
            environment_health_claim_token: null,
            environment_health_claimed_at: null,
            environment_health_claim_expires_at: null,
            environment_health_next_observation_at: null,
            environment_health_claim_instance_id: null,
            environment_health_claim_boot_id: null,
          }
        : {};

      // STEP 4: Write merged branch (within same transaction)
      const row = await update(txAsDb(tx), branches)
        .set({ ...insertData, ...environmentCoordinationUpdate })
        .where(eq(branches.branch_id, current.branch_id))
        .returning()
        .one();

      return this.rowToBranch(row, baseUrl);
    });
  }

  /**
   * Atomically claim a `failed` branch for a provisioning retry: flip it to
   * `creating` and clear the stored error, but ONLY if it is still `failed`
   * while we hold the row lock. Returns `{ claimed: false }` when another caller
   * (a double-click on Retry, or a concurrent retry) already moved it out of
   * `failed`, so retry can never spawn two materializers for the same branch.
   *
   * This is the fencing that lets the daemon avoid a general provisioning-job
   * framework: the state transition itself is the lock.
   *
   * `attemptId` stamps the row with the generation that now owns `creating`, so
   * a superseded attempt's late acknowledgement can be told apart from the
   * current one's. The winner's branch (with the id applied) is returned; the
   * caller passes that same id to the executor it dispatches.
   */
  async claimFailedForProvisioningRetry(
    id: string,
    attemptId: string
  ): Promise<{ claimed: boolean; branch: Branch }> {
    const existing = await this.findById(id);
    if (!existing) {
      throw new EntityNotFoundError('Branch', id);
    }
    const baseUrl = await getBaseUrl();
    return await this.db.transaction(async (tx) => {
      await lockRowForUpdate(
        txAsDb(tx),
        this.db,
        branches,
        eq(branches.branch_id, existing.branch_id)
      );
      const currentRow = await select(txAsDb(tx))
        .from(branches)
        .where(eq(branches.branch_id, existing.branch_id))
        .one();
      if (!currentRow) {
        throw new EntityNotFoundError('Branch', id);
      }
      const current = this.rowToBranch(currentRow, baseUrl);
      if (current.archived || current.filesystem_status !== 'failed') {
        // Lost the race (or never eligible) — do not write, do not re-dispatch.
        return { claimed: false, branch: current };
      }
      const insertData = this.branchToInsert({
        ...current,
        filesystem_status: 'creating',
        error_message: undefined,
        provisioning_attempt_id: attemptId,
        provisioning_operation: current.provisioning_operation === 'restore' ? 'restore' : 'retry',
      });
      const row = await update(txAsDb(tx), branches)
        .set(insertData)
        .where(eq(branches.branch_id, current.branch_id))
        .returning()
        .one();
      return { claimed: true, branch: this.rowToBranch(row, baseUrl) };
    });
  }

  /**
   * Atomically move an interrupted provisioning attempt to a terminal `failed`
   * state with an actionable message, but ONLY if it is still `creating`.
   *
   * Used by the crash/on-exit safety net and the startup watchdog. It never
   * clobbers a status the executor already wrote (success/failure), and — by
   * design — it does NOT inspect the daemon-local filesystem or infer success
   * from a `.git` path. An interrupted attempt is surfaced as `failed` so a
   * human can retry, rather than the daemon guessing and auto-promoting.
   *
   * `expectedAttemptId` fences the write to one generation. The status check
   * alone is not enough: a superseded attempt's `onExit` can fire *after* a
   * retry has already claimed `creating`, and would otherwise mark the new,
   * healthy attempt `failed`. Pass the id the caller dispatched with and the
   * write applies only while that attempt still owns the row. Omit it for
   * callers that legitimately target whatever attempt is current (the startup
   * watchdog, which by definition runs when no attempt can still be live).
   */
  async markProvisioningFailedIfCreating(
    id: string,
    message: string,
    expectedAttemptId?: string
  ): Promise<{ changed: boolean; branch: Branch }> {
    const existing = await this.findById(id);
    if (!existing) {
      throw new EntityNotFoundError('Branch', id);
    }
    const baseUrl = await getBaseUrl();
    return await this.db.transaction(async (tx) => {
      await lockRowForUpdate(
        txAsDb(tx),
        this.db,
        branches,
        eq(branches.branch_id, existing.branch_id)
      );
      const currentRow = await select(txAsDb(tx))
        .from(branches)
        .where(eq(branches.branch_id, existing.branch_id))
        .one();
      if (!currentRow) {
        throw new EntityNotFoundError('Branch', id);
      }
      const current = this.rowToBranch(currentRow, baseUrl);
      if (current.filesystem_status !== 'creating') {
        return { changed: false, branch: current };
      }
      if (
        expectedAttemptId !== undefined &&
        current.provisioning_attempt_id !== expectedAttemptId
      ) {
        // A newer attempt owns `creating` now — this acknowledgement is stale.
        return { changed: false, branch: current };
      }
      const insertData = this.branchToInsert({
        ...current,
        filesystem_status: 'failed',
        error_message: message,
      });
      const row = await update(txAsDb(tx), branches)
        .set(insertData)
        .where(eq(branches.branch_id, current.branch_id))
        .returning()
        .one();
      return { changed: true, branch: this.rowToBranch(row, baseUrl) };
    });
  }

  async acknowledgeProvisioningAttempt(
    id: string,
    acknowledgement: Partial<Branch>,
    expectedAttemptId?: string
  ): Promise<{ applied: boolean; branch: Branch }> {
    const existing = await this.findById(id);
    if (!existing) throw new EntityNotFoundError('Branch', id);
    const baseUrl = await getBaseUrl();
    return this.db.transaction(async (tx) => {
      await lockRowForUpdate(
        txAsDb(tx),
        this.db,
        branches,
        eq(branches.branch_id, existing.branch_id)
      );
      const currentRow = await select(txAsDb(tx))
        .from(branches)
        .where(eq(branches.branch_id, existing.branch_id))
        .one();
      if (!currentRow) throw new EntityNotFoundError('Branch', id);
      const current = this.rowToBranch(currentRow, baseUrl);
      const generationMatches = expectedAttemptId
        ? current.provisioning_attempt_id === expectedAttemptId
        : current.provisioning_attempt_id === undefined;
      if (current.archived || current.filesystem_status !== 'creating' || !generationMatches) {
        return { applied: false, branch: current };
      }
      const merged = deepMerge(current, {
        ...acknowledgement,
        branch_id: current.branch_id,
        repo_id: current.repo_id,
        created_at: current.created_at,
        updated_at: new Date().toISOString(),
      });
      if (acknowledgement.filesystem_status !== 'failed') delete merged.error_message;
      const row = await update(txAsDb(tx), branches)
        .set(this.branchToInsert(merged))
        .where(eq(branches.branch_id, current.branch_id))
        .returning()
        .one();
      return { applied: true, branch: this.rowToBranch(row, baseUrl) };
    });
  }

  async findCreatingPage(limit: number): Promise<Branch[]> {
    const rows = await select(this.db)
      .from(branches)
      .where(and(eq(branches.filesystem_status, 'creating'), eq(branches.archived, false)))
      .orderBy(asc(branches.branch_id))
      .limit(limit)
      .all();
    const baseUrl = await getBaseUrl();
    return rows.map((row: BranchRow) => this.rowToBranch(row, baseUrl));
  }

  /**
   * Stickily adopt the server-managed per-branch SDK-home intent.
   *
   * This is deliberately separate from generic branch CRUD: clients may not
   * opt a branch in or clear an adopted home through create/patch, and the
   * only supported transition is the idempotent null -> per_branch adoption
   * performed by supported-tool session admission.
   */
  async adoptSdkHome(id: string): Promise<Branch> {
    const existing = await this.findById(id);
    if (!existing) {
      throw new EntityNotFoundError('Branch', id);
    }
    if (existing.sdk_home === 'per_branch') return existing;

    const row = await update(this.db, branches)
      .set({ sdk_home: 'per_branch', updated_at: new Date() })
      .where(and(eq(branches.branch_id, existing.branch_id), isNull(branches.sdk_home)))
      .returning()
      .one();
    if (!row) {
      const current = await this.findById(existing.branch_id);
      if (!current) throw new EntityNotFoundError('Branch', id);
      return current;
    }

    return this.rowToBranch(row, await getBaseUrl());
  }

  /**
   * Delete branch by ID
   */
  async delete(id: string): Promise<void> {
    const existing = await this.findById(id);
    if (!existing) {
      throw new EntityNotFoundError('Branch', id);
    }
    await this.db.transaction(async (tx) => {
      await lockRowForUpdate(
        txAsDb(tx),
        this.db,
        branches,
        eq(branches.branch_id, existing.branch_id)
      );
      const current = await select(txAsDb(tx))
        .from(branches)
        .where(eq(branches.branch_id, existing.branch_id))
        .one();
      if (!current) throw new EntityNotFoundError('Branch', id);
      if (current.filesystem_status === 'creating') {
        throw new RepositoryError(
          'Cannot delete a branch while filesystem provisioning is in progress'
        );
      }
      await deleteFrom(txAsDb(tx), branches)
        .where(eq(branches.branch_id, existing.branch_id))
        .run();
    });
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
    const row = await select(this.db, { owner: branches.primary_owner_user_id })
      .from(branches)
      .where(eq(branches.branch_id, branchId))
      .one();
    return row?.owner === userId;
  }

  /**
   * Resolve app-layer branch permission excluding global superadmin bypass.
   * Order: primary owner → direct user entry → additive group entries →
   * unmatched Others fallback.
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
    return new CapabilityPolicyRepository(this.db).resolveLegacyBranchAccess(
      branch.branch_id,
      userId as import('@agor/core/types').UserID
    ) as Promise<EffectiveBranchAccess>;
  }

  async resolveSessionPromptAuthority(
    branchId: BranchID,
    callerUserId: UUID,
    sessionOwnerUserId: UUID,
    sessionSdkHomeScope: SessionSdkHomeScope
  ): Promise<SessionPromptAuthority> {
    return new CapabilityPolicyRepository(this.db).resolveSessionPromptAuthority({
      branch_id: branchId,
      caller_user_id: callerUserId as import('@agor/core/types').UserID,
      session_owner_user_id: sessionOwnerUserId as import('@agor/core/types').UserID,
      session_sdk_home_scope: sessionSdkHomeScope,
    });
  }

  /**
   * Materialize the exact current realtime audience in one set-based query.
   *
   * Never represent a permissive Others role as "all authenticated": a direct
   * No access row or a matched non-view group suppresses Others for that user.
   * The same SQL predicate used by branch/session inventory therefore decides
   * every user included in a cached publication audience.
   */
  async findRealtimeViewUserIds(branchId: BranchID): Promise<UUID[]> {
    const rows = await select(this.db, { user_id: users.user_id })
      .from(users)
      .where(visibleBranchReferenceAccessExists(this.db, users.user_id, sql`${branchId}`))
      .all();
    return rows.map((row: { user_id: string }) => row.user_id as UUID);
  }

  private async findExplicitUsers(
    branchId: BranchID,
    accepts: (access: EffectiveBranchAccess) => boolean
  ): Promise<UUID[]> {
    const policy = await new CapabilityPolicyRepository(this.db).getBranchPolicy(branchId);
    const config =
      policy.binding_mode === 'inherit' ? policy.inherited_config : policy.override_config;
    if (!config) return [];
    const ids = new Set<UUID>([policy.primary_owner_user_id as UUID]);
    const groupIds: GroupID[] = [];
    for (const entry of config.access.entries) {
      if (entry.principal.principal_type === 'user') ids.add(entry.principal.user_id as UUID);
      else groupIds.push(entry.principal.group_id);
    }
    if (groupIds.length > 0) {
      const members = await select(this.db, { user_id: groupMemberships.user_id })
        .from(groupMemberships)
        .where(inArray(groupMemberships.group_id, groupIds))
        .all();
      for (const member of members) ids.add(member.user_id as UUID);
    }
    const result: UUID[] = [];
    for (const userId of ids) {
      const access = await this.resolveUserAccess({ branch_id: branchId } as Branch, userId);
      if (accepts(access)) result.push(userId);
    }
    return result;
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
    return this.findExplicitUsers(branchId, (access) => (access.fs_access ?? 'none') !== 'none');
  }

  /**
   * Find non-archived branches whose explicit filesystem access set can change
   * when membership in the given group changes.
   *
   * Keep this inverse lookup in lockstep with findExplicitFsAccessUserIds():
   * both encode which group grants materialize into branch-folder access.
   * App-only grants (`fs_access = 'none'`) are intentionally excluded because
   * membership changes for those grants do not require branch-folder mutation.
   */
  async findExplicitFsAccessBranchIdsForGroup(groupId: GroupID): Promise<BranchID[]> {
    const configRows = await select(this.db, {
      branch_id: branchPermissionConfigs.branch_id,
      board_id: branchPermissionConfigs.board_id,
    })
      .from(branchPermissionEntries)
      .innerJoin(
        branchPermissionConfigs,
        eq(branchPermissionConfigs.config_id, branchPermissionEntries.config_id)
      )
      .where(
        and(
          eq(branchPermissionEntries.group_id, groupId),
          inArray(branchPermissionEntries.fs_access, FS_ACCESS_BRANCH_PERMISSIONS)
        )
      )
      .all();
    const ids = new Set<BranchID>();
    const boardIds: BoardID[] = [];
    for (const row of configRows) {
      if (row.branch_id) ids.add(row.branch_id as BranchID);
      if (row.board_id) boardIds.push(row.board_id as BoardID);
    }
    if (boardIds.length > 0) {
      const inherited = await select(this.db, { branch_id: branches.branch_id })
        .from(branches)
        .where(
          and(
            inArray(branches.board_id, boardIds),
            eq(branches.permission_binding, 'inherit'),
            eq(branches.archived, false)
          )
        )
        .all();
      for (const row of inherited) ids.add(row.branch_id as BranchID);
    }
    return [...ids];
  }

  async findBoardAlignedBranches(boardId: BoardID): Promise<Branch[]> {
    const rows = await select(this.db)
      .from(branches)
      .where(
        and(
          eq(branches.board_id, boardId),
          eq(branches.permission_binding, 'inherit'),
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

    return [branch.primary_owner_user_id as UUID];
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

    throw new RepositoryError(
      'Primary ownership is immutable; grant Manager access through the branch permission policy'
    );
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

    throw new RepositoryError(
      userId === branch.primary_owner_user_id
        ? 'Primary ownership is immutable'
        : 'This user is not a branch owner; remove their permission entry instead'
    );
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

    const rows = await select(this.db, {
      branch_id: branches.branch_id,
      primary_owner_user_id: branches.primary_owner_user_id,
    })
      .from(branches)
      .where(inArray(branches.branch_id, branchIds))
      .all();

    const ownersByBranch = new Map<BranchID, UUID[]>();
    for (const row of rows) {
      ownersByBranch.set(row.branch_id as BranchID, [row.primary_owner_user_id as UUID]);
    }

    return ownersByBranch;
  }

  /**
   * Find all branches accessible to a user (optimized RBAC query)
   *
   * Uses the normalized, correlated access predicate in one query instead of
   * N+1 point checks. Direct user entries shadow groups, active groups are
   * additive, and Others applies only when neither one matches.
   *
   * The branch authorization hook uses this to resolve accessible Branch IDs
   * and compose them into the service query.
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

    const rows = await select(this.db)
      .from(branches)
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

  /** Find a branch by ID when the caller meets the requested point-access policy. */
  async findAccessibleById(
    branchId: string,
    userId: UUID,
    options: {
      /** Minimum app-layer permission required when access enforcement is enabled. */
      minimumPermission?: NonNullable<Branch['others_can']>;
      /** Disable the point check only for a separately authorized administrative bypass. */
      enforceAccess?: boolean;
    } = {}
  ): Promise<Branch | null> {
    if (options.enforceAccess === false) return this.findById(branchId);

    const minimumPermission = options.minimumPermission ?? 'view';
    const accessCondition = minimumBranchAccessCondition(this.db, userId, minimumPermission);
    try {
      const fullId = await resolveByShortIdPrefix(branchId, 'Branch', async (pattern) => {
        const rows = await select(this.db, { branch_id: branches.branch_id })
          .from(branches)
          .where(and(like(branches.branch_id, pattern), accessCondition))
          .limit(RESOLVE_SHORT_ID_FETCH_LIMIT)
          .all();
        return rows.map((row: { branch_id: string }) => row.branch_id);
      });

      // Reapply the authorization predicate on retrieval. Besides keeping the
      // point lookup self-contained, this fails closed if access changes after
      // short-ID resolution but before the row is read.
      const row = await select(this.db)
        .from(branches)
        .where(and(eq(branches.branch_id, fullId), accessCondition))
        .one();
      if (!row) return null;
      return this.rowToBranch(row as BranchRow, await getBaseUrl());
    } catch (error) {
      if (error instanceof EntityNotFoundError) return null;
      throw error;
    }
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

      // Query to get recent sessions for these branches
      const sessionRows = await select(this.db, {
        branch_id: sessions.branch_id,
        session_id: sessions.session_id,
        status: sessions.status,
        agentic_tool: sessions.agentic_tool,
        updated_at: sessions.updated_at,
        unix_username: sessions.unix_username,
      })
        .from(sessions)
        .where(inArray(sessions.branch_id, branchIds))
        .orderBy(sessions.updated_at)
        .all();

      const sessionIds = sessionRows.map((s: { session_id: unknown }) => s.session_id as string);

      if (sessionIds.length === 0) {
        // No sessions found, return branches as-is with empty sessions array
        return branches.map((wt) => ({ ...wt, sessions: [] }));
      }

      const lastMessageBySession = new Map<string, string>();
      const lastMessages = await findLatestAssistantMessages(this.db, sessionIds);
      for (const lastMessage of lastMessages) {
        lastMessageBySession.set(
          lastMessage.session_id,
          truncateMessageText(extractMessageText(lastMessage.data), truncationLength)
        );
      }

      // Batch count messages per session in one query
      const countRows = await select(this.db, {
        session_id: messages.session_id,
        count: sql<number>`count(*)`,
      })
        .from(messages)
        .where(inArray(messages.session_id, sessionIds))
        .groupBy(messages.session_id)
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
