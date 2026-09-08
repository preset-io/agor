/**
 * Task Repository
 *
 * Type-safe CRUD operations for tasks with short ID support.
 */

import { createHash } from 'node:crypto';

import type {
  CapabilityPolicyFsAccess,
  ExecutorPulse,
  ExecutorTerminationCompleteInput,
  MCPRuntimeRecovery,
  MCPServerID,
  MCPSlackRecoveryNotice,
  SdkFailure,
  SessionID,
  Task,
  TaskID,
  TaskMetadata,
  TaskPendingDispatchStatus,
  TerminationCause,
  TerminationCoordinationClaim,
  UserID,
  UUID,
} from '@agor/core/types';
import {
  EXECUTING_TASK_STATUSES,
  isTerminalTaskStatus,
  NONTERMINAL_TASK_STATUSES,
  SessionStatus,
  sessionCanStartTask,
  TaskStatus,
} from '@agor/core/types';
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  like,
  lt,
  lte,
  ne,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import { generateId, shortId } from '../../lib/ids';
import type { Database } from '../client';
import {
  deleteFrom,
  insert,
  isPostgresDatabase,
  isSQLiteDatabase,
  lockRowForUpdate,
  runDatabaseTransaction,
  select,
  update,
} from '../database-wrapper';
import {
  type SessionRow,
  sessionMcpServers,
  sessions,
  type TaskInsert,
  type TaskRow,
  tasks,
  users,
} from '../schema';
import { getCurrentTenantId } from '../tenant-context';
import {
  AmbiguousIdError,
  type BaseRepository,
  EntityNotFoundError,
  RESOLVE_SHORT_ID_FETCH_LIMIT,
  RepositoryError,
  resolveByShortIdPrefix,
} from './base';
import {
  resolveSessionRuntimeBranchAccess,
  visibleSessionReferenceAccessExists,
} from './branch-access';
import { ExecutorSessionTokenAuthorityRepository } from './executor-session-token-authorities';
import { deepMerge } from './merge-utils';

function executorOwnsTask(row: Pick<TaskRow, 'status' | 'executor_connected_at'>): boolean {
  return (
    !!row.executor_connected_at &&
    (row.status === TaskStatus.RUNNING ||
      row.status === TaskStatus.AWAITING_PERMISSION ||
      row.status === TaskStatus.AWAITING_INPUT)
  );
}

function mcpReprojectionAuthorityDigest(authorityFingerprints: readonly string[]): string {
  return createHash('sha256')
    .update('agor:mcp-reprojection-authority:v1\0')
    .update(
      JSON.stringify(
        [...new Set(authorityFingerprints)].sort((left, right) => left.localeCompare(right))
      )
    )
    .digest('base64url');
}

function executorMayReportTelemetry(
  row: Pick<TaskRow, 'status' | 'executor_connected_at' | 'data'>
): boolean {
  if (executorOwnsTask(row)) return true;
  if (!row.executor_connected_at || row.status !== TaskStatus.STOPPING) {
    return false;
  }
  return !!row.data.termination_request && !row.data.termination_request.executor_quiesced_at;
}

function isExecutorResultStatus(status: Task['status']): boolean {
  return (
    status === TaskStatus.RUNNING ||
    status === TaskStatus.AWAITING_PERMISSION ||
    status === TaskStatus.AWAITING_INPUT ||
    isTerminalTaskStatus(status)
  );
}

function isSQLiteBusyError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.message.includes('SQLITE_BUSY') || error.message.includes('database is locked')) {
    return true;
  }
  return 'cause' in error && isSQLiteBusyError(error.cause);
}

function fsAccessRank(access: CapabilityPolicyFsAccess): number {
  return access === 'write' ? 2 : access === 'read' ? 1 : 0;
}

function requireRuntimeTenantId(): string {
  const tenantId = getCurrentTenantId();
  if (!tenantId) throw new RepositoryError('Runtime authority tenant scope is unavailable');
  return tenantId;
}

function withTerminalTiming(
  current: Task,
  updates: Partial<Task>,
  now = new Date()
): Partial<Task> {
  if (!isTerminalTaskStatus(updates.status) || isTerminalTaskStatus(current.status)) return updates;

  const completedAt = updates.completed_at ?? now.toISOString();
  const startAt =
    current.started_at ?? current.message_range?.start_timestamp ?? current.created_at;
  const durationMs =
    updates.duration_ms ??
    current.duration_ms ??
    (startAt ? Math.max(0, Date.parse(completedAt) - Date.parse(startAt)) : undefined);
  const range = current.message_range;
  const messageRange =
    range && (!range.end_timestamp || range.end_timestamp === range.start_timestamp)
      ? { ...range, ...updates.message_range, end_timestamp: completedAt }
      : updates.message_range;

  return {
    ...updates,
    completed_at: completedAt,
    duration_ms: durationMs,
    ...(messageRange ? { message_range: messageRange } : {}),
  };
}

export interface TerminationClaimInput {
  taskId: string;
  cause: TerminationCause;
  errorMessage: string;
  sdkFailure?: SdkFailure;
  expectedStatus?: Task['status'];
  expectedHeartbeatAt?: string;
  heartbeatStaleBefore?: string;
  requireExecutorDisconnected?: boolean;
  now?: Date;
}

export interface ExecutorLaunchAuthorityOptions {
  branchRbacEnabled: boolean;
}

export interface ExecutorLaunchAuthority {
  principal_user_id: string;
  session_id: string;
  branch_id: string;
  fs_access: CapabilityPolicyFsAccess;
}

/** Server-authenticated Task-token scope supplied to the repository hot path. */
export interface TaskRuntimeAuthorityScope extends ExecutorLaunchAuthorityOptions {
  token_fingerprint: string;
  principal_user_id: string;
  session_id: string;
  branch_id: string;
  /** O(1) standalone authority decision; PostgreSQL validates its durable row in-transaction. */
  standalone_token_current?: boolean;
}

export type RuntimeTelemetryAuthorityDenialReason =
  | 'token_revoked'
  | 'principal_unavailable'
  | 'branch_capability_revoked'
  | 'filesystem_access_revoked'
  | 'launch_authority_missing';

export type RuntimeTelemetryReportResult =
  | { outcome: 'continued'; task: Task }
  | { outcome: 'control'; task: Task }
  | { outcome: 'scope_mismatch'; task: Task }
  | {
      outcome: 'authorization_revoked';
      task: Task;
      reason: RuntimeTelemetryAuthorityDenialReason;
    };

export interface TerminationClaimResult {
  outcome: 'claimed' | 'unchanged' | 'condition_changed' | 'terminal';
  task: Task;
}

interface TerminationSettlementInputBase {
  taskId: string;
  errorMessage?: string;
  sdkFailure?: SdkFailure;
  now?: Date;
}

export type TerminationSettlementInput =
  | (TerminationSettlementInputBase & {
      outcome: 'verified_absent' | 'unverified';
      /** Exact, currently persisted containment-coordination fence. */
      coordinationToken: string;
    })
  | (TerminationSettlementInputBase & {
      outcome: 'forced_unverified';
      /** Exact termination request confirmed by the authorized operator. */
      expectedTerminationRequestedAt: string;
      coordinationToken?: never;
    })
  | (TerminationSettlementInputBase & {
      outcome: 'restart_unverified';
      coordinationToken?: never;
    });

export interface TerminationSettlementResult {
  outcome: 'transitioned' | 'unverified' | 'condition_changed' | 'terminal';
  task: Task;
}

export interface TaskDispatchClaimResult {
  outcome: 'claimed' | 'already_claimed' | 'condition_changed' | 'actor_missing';
  task: Task;
}

export interface QueuedTaskActorCheckResult {
  outcome: 'actor_available' | 'actor_missing' | 'condition_changed';
  task: Task;
}

export const MISSING_TASK_ACTOR_ERROR =
  'The user who created this queued task is no longer available.';

/** Routing-only row returned to the all-daemon queue recovery scanner. */
export interface QueuedSessionRef {
  session_id: SessionID;
  first_queued_at: number;
  tenant_id?: string;
}

export type QueuedSessionCursor = Pick<QueuedSessionRef, 'session_id' | 'tenant_id'>;

export interface TaskTerminationCoordinationClaimInput {
  taskId: string;
  claimToken: string;
  leaseDurationMs: number;
  instanceId: string;
  bootId: string;
  /** Refuse the claim until the durable request reaches this DB-authored age. */
  minimumRequestAgeMs?: number;
  /** Deterministic SQLite/test clock. PostgreSQL uses database time when omitted. */
  now?: Date;
}

export interface TaskTerminationCoordinationClaimResult {
  outcome: 'claimed' | 'unchanged' | 'condition_changed' | 'terminal';
  task: Task;
}

export interface TaskRuntimeDiscoveryRef {
  task_id: TaskID;
  tenant_id?: string;
  /** Exact liveness fact observed by a stale-heartbeat scan. */
  executor_heartbeat_at?: string;
  /** Stable keyset position in this discovery category's ordered result set. */
  cursor: TaskRuntimeDiscoveryCursor;
}

export interface TaskRuntimeDiscoveryCursor {
  task_id: TaskID;
  /** Absent only for the NULL coordination-expiry group, ordered last. */
  order_at?: string;
}

export interface TaskRuntimeDiscoveryOptions {
  limit?: number;
  /** Continue after this keyset position; an empty page lets the caller wrap. */
  after?: TaskRuntimeDiscoveryCursor;
  /** Deterministic test clock. PostgreSQL uses database time when omitted. */
  now?: Date;
}

export interface TaskFindPageOptions {
  taskId?: TaskID;
  afterTaskId?: TaskID;
  throughTaskId?: TaskID;
  sessionId?: SessionID;
  sessionIds?: SessionID[];
  status?: Task['status'];
  createdAt?: Date;
  createdBy?: UUID;
  visibleToUserId?: UUID;
  sort?: Record<string, 1 | -1>;
  selectTaskIdOnly?: boolean;
  limit?: number;
  skip?: number;
}

/**
 * Task repository implementation
 */
export class TaskRepository implements BaseRepository<Task, Partial<Task>> {
  constructor(private db: Database) {}

  /** Retry an entire SQLite mutation so a contending writer re-reads fresh state. */
  private async runTaskMutation<T>(mutation: () => Promise<T>, attempt = 0): Promise<T> {
    try {
      return await mutation();
    } catch (error) {
      // libSQL reports write contention immediately even with busy_timeout.
      if (isSQLiteDatabase(this.db) && attempt < 4 && isSQLiteBusyError(error)) {
        await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
        return this.runTaskMutation(mutation, attempt + 1);
      }
      throw error;
    }
  }

  /** Run a mutation against the latest row under the dialect's write lock. */
  private async mutateLockedTask<T>(
    id: string,
    mutation: (txDb: Database, row: TaskRow, fullId: string) => Promise<T>
  ): Promise<T> {
    const fullId = await this.resolveId(id);
    return this.runTaskMutation(() =>
      runDatabaseTransaction(
        this.db,
        async (txDb) => {
          await lockRowForUpdate(txDb, this.db, tasks, eq(tasks.task_id, fullId));
          const row = await select(txDb).from(tasks).where(eq(tasks.task_id, fullId)).one();
          if (!row) throw new EntityNotFoundError('Task', id);
          return mutation(txDb, row, fullId);
        },
        { sqliteImmediate: true }
      )
    );
  }

  /**
   * Lock a Task together with its owning Session, always Session first.
   *
   * Session-first ordering is the cross-daemon turn mutex. It serializes
   * claims for different Tasks in the same Session, whereas a Task-only lock
   * can prevent duplicate launch of one Task but cannot prevent two distinct
   * Tasks from launching concurrently.
   */
  private async mutateLockedSessionTask<T>(
    id: string,
    mutation: (
      txDb: Database,
      taskRow: TaskRow,
      sessionRow: SessionRow,
      fullId: string
    ) => Promise<T>
  ): Promise<T> {
    const fullId = await this.resolveId(id);
    const routing = await select(this.db, { session_id: tasks.session_id })
      .from(tasks)
      .where(eq(tasks.task_id, fullId))
      .one();
    if (!routing) throw new EntityNotFoundError('Task', id);

    return this.runTaskMutation(() =>
      runDatabaseTransaction(
        this.db,
        async (txDb) => {
          await lockRowForUpdate(
            txDb,
            this.db,
            sessions,
            eq(sessions.session_id, routing.session_id)
          );
          const sessionRow = await select(txDb)
            .from(sessions)
            .where(eq(sessions.session_id, routing.session_id))
            .one();
          if (!sessionRow) throw new EntityNotFoundError('Session', routing.session_id);

          await lockRowForUpdate(txDb, this.db, tasks, eq(tasks.task_id, fullId));
          const taskRow = await select(txDb).from(tasks).where(eq(tasks.task_id, fullId)).one();
          if (!taskRow) throw new EntityNotFoundError('Task', id);
          if (taskRow.session_id !== sessionRow.session_id) {
            throw new RepositoryError('Task changed Session during dispatch admission');
          }
          return mutation(txDb, taskRow, sessionRow, fullId);
        },
        { sqliteImmediate: true }
      )
    );
  }

  /**
   * Resolve a mutation timestamp from PostgreSQL's clock. SQLite retains its
   * historical process-clock behavior, and callers may inject a clock for
   * deterministic tests in either dialect.
   */
  private async mutationNow(txDb: Database, fullId: string, override?: Date): Promise<Date> {
    if (override || isSQLiteDatabase(this.db)) return override ?? new Date();
    const row = await select(txDb, { value: sql<Date>`CURRENT_TIMESTAMP` })
      .from(tasks)
      .where(eq(tasks.task_id, fullId))
      .one();
    if (!row) throw new EntityNotFoundError('Task', fullId);
    return row.value instanceof Date ? row.value : new Date(row.value);
  }

  /**
   * Convert database row to Task type
   */
  private rowToTask(row: TaskRow): Task {
    const storedTerminationRequest = row.data.termination_request;
    const { executor_launch_fs_access_floor: _executorLaunchFsAccessFloor, ...publicData } =
      row.data;
    const coordination: TerminationCoordinationClaim | undefined =
      row.termination_coordination_token &&
      row.termination_coordination_claimed_at &&
      row.termination_coordination_expires_at &&
      row.termination_coordination_instance_id &&
      row.termination_coordination_boot_id
        ? {
            claim_token: row.termination_coordination_token,
            claimed_at: new Date(row.termination_coordination_claimed_at).toISOString(),
            lease_expires_at: new Date(row.termination_coordination_expires_at).toISOString(),
            instance_id: row.termination_coordination_instance_id,
            boot_id: row.termination_coordination_boot_id,
          }
        : undefined;
    return {
      task_id: row.task_id as UUID,
      session_id: row.session_id as UUID,
      status: row.status,
      queue_position: row.queue_position ?? undefined,
      created_at: new Date(row.created_at).toISOString(),
      started_at: row.started_at ? new Date(row.started_at).toISOString() : undefined,
      executor_connected_at: row.executor_connected_at
        ? new Date(row.executor_connected_at).toISOString()
        : undefined,
      completed_at: row.completed_at ? new Date(row.completed_at).toISOString() : undefined,
      last_executor_heartbeat_at: row.last_executor_heartbeat_at
        ? new Date(row.last_executor_heartbeat_at).toISOString()
        : undefined,
      created_by: row.created_by,
      ...publicData,
      ...(storedTerminationRequest
        ? {
            termination_request: {
              ...storedTerminationRequest,
              ...(coordination ? { coordination } : {}),
            },
          }
        : {}),
    };
  }

  /**
   * Convert Task to database insert format
   */
  private taskToInsert(task: Partial<Task>): TaskInsert {
    const now = Date.now();
    const taskId = task.task_id ?? generateId();

    if (!task.session_id) {
      throw new RepositoryError('session_id is required when creating a task');
    }
    if (!task.created_by) {
      throw new RepositoryError('created_by is required when creating a task');
    }

    // Ensure git_state always has required fields
    const git_state = task.git_state ?? {
      ref_at_start: 'unknown',
      sha_at_start: 'unknown',
    };

    const coordination = task.termination_request?.coordination;
    const storedTerminationRequest = task.termination_request
      ? (({ coordination: _coordination, ...request }) => request)(task.termination_request)
      : undefined;

    return {
      task_id: taskId,
      session_id: task.session_id,
      created_at: new Date(now), // Always use server timestamp, ignore client-provided value
      started_at: task.started_at ? new Date(task.started_at) : undefined,
      executor_connected_at: task.executor_connected_at
        ? new Date(task.executor_connected_at)
        : undefined,
      completed_at: task.completed_at ? new Date(task.completed_at) : undefined,
      last_executor_heartbeat_at: task.last_executor_heartbeat_at
        ? new Date(task.last_executor_heartbeat_at)
        : undefined,
      termination_coordination_token: coordination?.claim_token,
      termination_coordination_claimed_at: coordination
        ? new Date(coordination.claimed_at)
        : undefined,
      termination_coordination_expires_at: coordination
        ? new Date(coordination.lease_expires_at)
        : undefined,
      termination_coordination_instance_id: coordination?.instance_id,
      termination_coordination_boot_id: coordination?.boot_id,
      termination_unverified_at:
        task.sdk_failure?.termination === 'unverified'
          ? new Date(task.sdk_failure.detected_at)
          : undefined,
      status: task.status ?? TaskStatus.CREATED,
      queue_position: task.queue_position ?? null,
      created_by: task.created_by,
      mcp_slack_recovery_due_at: task.metadata?.mcp_slack_recovery_notice?.next_repair_at
        ? new Date(task.metadata.mcp_slack_recovery_notice.next_repair_at)
        : undefined,
      data: {
        full_prompt: task.full_prompt ?? '',
        message_range: task.message_range ?? {
          start_index: 0,
          end_index: 0,
          start_timestamp: new Date(now).toISOString(),
        },
        git_state,
        // Filled in by the executor after the turn — don't substitute a default.
        ...(task.model ? { model: task.model } : {}),
        tool_use_count: task.tool_use_count ?? 0,
        duration_ms: task.duration_ms, // Task execution duration
        agent_session_id: task.agent_session_id, // SDK session ID
        error_message: task.error_message, // Human-readable failure reason when status='failed'
        raw_sdk_response: task.raw_sdk_response, // Raw SDK response - single source of truth for token accounting
        normalized_sdk_response: task.normalized_sdk_response, // Normalized for UI consumption
        computed_context_window: task.computed_context_window, // Cumulative context window (computed by tool.computeContextWindow())
        report: task.report,
        permission_request: task.permission_request, // Permission state for UI approval flow
        metadata: task.metadata, // Generic metadata bag (e.g., is_agor_callback, source)
        executor_mode: task.executor_mode,
        latest_executor_pulse: task.latest_executor_pulse,
        sdk_failure: task.sdk_failure,
        termination_request: storedTerminationRequest,
        sdk_watchdog_mode: task.sdk_watchdog_mode,
      },
    };
  }

  /**
   * Resolve short ID to full ID via the centralized helper.
   */
  private async resolveId(id: string): Promise<string> {
    return resolveByShortIdPrefix(id, 'Task', async (pattern) => {
      const rows = await select(this.db)
        .from(tasks)
        .where(like(tasks.task_id, pattern))
        .limit(RESOLVE_SHORT_ID_FETCH_LIMIT)
        .all();
      return rows.map((r: { task_id: string }) => r.task_id);
    });
  }

  /**
   * Create a new task
   */
  async create(data: Partial<Task>): Promise<Task> {
    try {
      const insertData = this.taskToInsert(data);
      await insert(this.db, tasks).values(insertData).run();

      const row = await select(this.db)
        .from(tasks)
        .where(eq(tasks.task_id, insertData.task_id))
        .one();

      if (!row) {
        throw new RepositoryError('Failed to retrieve created task');
      }

      return this.rowToTask(row);
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      throw new RepositoryError(
        `Failed to create task: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find task by ID (supports short ID)
   */
  async findById(id: string): Promise<Task | null> {
    try {
      const fullId = await this.resolveId(id);
      const row = await select(this.db).from(tasks).where(eq(tasks.task_id, fullId)).one();

      return row ? this.rowToTask(row) : null;
    } catch (error) {
      if (error instanceof EntityNotFoundError) return null;
      if (error instanceof AmbiguousIdError) throw error;
      throw new RepositoryError(
        `Failed to find task: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find all tasks
   */
  async findAll(filter?: {
    sessionId?: SessionID;
    sessionIds?: SessionID[];
    status?: Task['status'];
    visibleToUserId?: UUID;
  }): Promise<Task[]> {
    try {
      if (filter?.sessionIds !== undefined && filter.sessionIds.length === 0) return [];

      const conditions = [];
      if (filter?.sessionId) conditions.push(eq(tasks.session_id, filter.sessionId));
      if (filter?.sessionIds !== undefined)
        conditions.push(inArray(tasks.session_id, filter.sessionIds));
      if (filter?.status) conditions.push(eq(tasks.status, filter.status));
      if (filter?.visibleToUserId) {
        conditions.push(
          visibleSessionReferenceAccessExists(this.db, filter.visibleToUserId, tasks.session_id)
        );
      }

      const query = select(this.db).from(tasks);
      const rows =
        conditions.length > 0 ? await query.where(and(...conditions)).all() : await query.all();
      return rows.map((row: TaskRow) => this.rowToTask(row));
    } catch (error) {
      throw new RepositoryError(
        `Failed to find all tasks: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find one exact SQL page for the public Task list contract. Count and data
   * share the same tenant/RBAC predicate, and only returned rows hydrate their
   * potentially large JSON payloads.
   */
  async findPage(
    opts: TaskFindPageOptions = {}
  ): Promise<{ data: Partial<Task>[]; total: number }> {
    if (opts.sessionIds?.length === 0) return { data: [], total: 0 };

    const conditions: SQL[] = [];
    if (opts.taskId) conditions.push(eq(tasks.task_id, opts.taskId));
    if (opts.afterTaskId) conditions.push(gt(tasks.task_id, opts.afterTaskId));
    if (opts.throughTaskId) conditions.push(lte(tasks.task_id, opts.throughTaskId));
    if (opts.sessionId) conditions.push(eq(tasks.session_id, opts.sessionId));
    if (opts.sessionIds) conditions.push(inArray(tasks.session_id, opts.sessionIds));
    if (opts.status) conditions.push(eq(tasks.status, opts.status));
    if (opts.createdAt) conditions.push(eq(tasks.created_at, opts.createdAt));
    if (opts.createdBy) conditions.push(eq(tasks.created_by, opts.createdBy));
    if (opts.visibleToUserId) {
      conditions.push(
        visibleSessionReferenceAccessExists(this.db, opts.visibleToUserId, tasks.session_id)
      );
    }
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    let countQuery = select(this.db, { count: sql<number>`count(*)` }).from(tasks);
    if (whereClause) countQuery = countQuery.where(whereClause);
    const countRow = await countQuery.one();

    let dataQuery = select(
      this.db,
      opts.selectTaskIdOnly ? { task_id: tasks.task_id } : undefined
    ).from(tasks);
    if (whereClause) dataQuery = dataQuery.where(whereClause);
    const sortColumns = {
      task_id: tasks.task_id,
      session_id: tasks.session_id,
      status: tasks.status,
      created_at: tasks.created_at,
      created_by: tasks.created_by,
    } as const;
    const orderBy = Object.entries(opts.sort ?? {})
      .map(([field, direction]) => {
        const column = sortColumns[field as keyof typeof sortColumns];
        return column ? (direction === -1 ? desc(column) : asc(column)) : undefined;
      })
      .filter((expression): expression is SQL => expression !== undefined);
    if (orderBy.length === 0) orderBy.push(asc(tasks.created_at));
    if (!Object.hasOwn(opts.sort ?? {}, 'task_id')) orderBy.push(asc(tasks.task_id));
    dataQuery = dataQuery.orderBy(...orderBy);
    if (opts.limit !== undefined) dataQuery = dataQuery.limit(opts.limit);
    if (opts.skip) dataQuery = dataQuery.offset(opts.skip);

    const rows = await dataQuery.all();
    return {
      data: opts.selectTaskIdOnly
        ? rows.map((row: unknown) => ({
            task_id: (row as Pick<TaskRow, 'task_id'>).task_id as TaskID,
          }))
        : rows.map((row: unknown) => this.rowToTask(row as TaskRow)),
      total: Number(countRow?.count ?? 0),
    };
  }

  /**
   * Find all tasks for a session
   */
  async findBySession(sessionId: string): Promise<Task[]> {
    try {
      const rows = await select(this.db)
        .from(tasks)
        .where(eq(tasks.session_id, sessionId))
        .orderBy(tasks.created_at, tasks.task_id)
        .all();

      return rows.map((row: TaskRow) => this.rowToTask(row));
    } catch (error) {
      throw new RepositoryError(
        `Failed to find tasks by session: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /** Whether deleting this Session would cascade any unfinished Task. */
  async hasNonterminalForSession(sessionId: string): Promise<boolean> {
    try {
      const row = await select(this.db, { task_id: tasks.task_id })
        .from(tasks)
        .where(
          and(
            eq(tasks.session_id, sessionId),
            inArray(tasks.status, [...NONTERMINAL_TASK_STATUSES])
          )
        )
        .limit(1)
        .one();
      return !!row;
    } catch (error) {
      throw new RepositoryError(
        `Failed to inspect unfinished session tasks: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /** Whether deleting this Branch would cascade any unfinished Task. */
  async hasNonterminalForBranch(branchId: string): Promise<boolean> {
    try {
      const row = await select(this.db, { task_id: tasks.task_id })
        .from(tasks)
        .innerJoin(sessions, eq(sessions.session_id, tasks.session_id))
        .where(
          and(
            eq(sessions.branch_id, branchId),
            inArray(tasks.status, [...NONTERMINAL_TASK_STATUSES])
          )
        )
        .limit(1)
        .one();
      return !!row;
    } catch (error) {
      throw new RepositoryError(
        `Failed to inspect unfinished branch tasks: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find running tasks across all sessions
   */
  async findRunning(): Promise<Task[]> {
    try {
      const rows = await select(this.db)
        .from(tasks)
        .where(eq(tasks.status, TaskStatus.RUNNING))
        .all();

      return rows.map((row: TaskRow) => this.rowToTask(row));
    } catch (error) {
      throw new RepositoryError(
        `Failed to find running tasks: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /** Active executor turns attributed to one immutable prompt actor. */
  async findExecutingByCreator(userId: string): Promise<Task[]> {
    try {
      const rows = await select(this.db)
        .from(tasks)
        .where(
          and(eq(tasks.created_by, userId), inArray(tasks.status, [...EXECUTING_TASK_STATUSES]))
        )
        .all();

      return rows.map((row: TaskRow) => this.rowToTask(row));
    } catch (error) {
      throw new RepositoryError(
        `Failed to find executing tasks for creator: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find orphaned tasks (dispatching, running, stopping, awaiting permission, or awaiting input)
   * These are tasks that were interrupted when daemon stopped.
   *
   * NOTE: QUEUED tasks are intentionally NOT considered orphans — they were
   * never spawned, so they have no executor to recover. The startup queue
   * drainer (see register-routes.ts processNextQueuedTask) picks them up
   * once any session goes idle. See never-lose-prompt §C.
   */
  async findOrphaned(): Promise<Task[]> {
    try {
      const rows = await select(this.db)
        .from(tasks)
        .where(
          sql`${tasks.status} IN ('dispatching', 'running', 'stopping', 'awaiting_permission', 'awaiting_input')`
        )
        .all();

      return rows.map((row: TaskRow) => this.rowToTask(row));
    } catch (error) {
      throw new RepositoryError(
        `Failed to find orphaned tasks: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Bounded newest-first deterministic page for live MCP authority fanout. Unlike
   * `findOrphaned`, this excludes dispatching/stopping and bounds returned work
   * and continuation state. The database may still scan/sort active rows using
   * existing status/task indexes; the application never materializes an
   * unbounded tenant result.
   */
  async findActiveMCPRefreshPage(
    options: {
      beforeTaskId?: TaskID;
      sessionId?: SessionID;
      attachedServerId?: MCPServerID;
      authorityUserId?: UserID;
      credentialUserId?: UserID;
      limit?: number;
    } = {}
  ): Promise<{ tasks: Task[]; nextTaskId?: TaskID }> {
    const limit = options.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new RepositoryError('MCP refresh fanout limit must be between 1 and 100');
    }
    try {
      const rows = await select(this.db)
        .from(tasks)
        .where(
          and(
            sql`${tasks.status} IN ('running', 'awaiting_permission', 'awaiting_input')`,
            options.beforeTaskId ? lt(tasks.task_id, options.beforeTaskId) : undefined,
            options.sessionId ? eq(tasks.session_id, options.sessionId) : undefined,
            options.attachedServerId
              ? sql`EXISTS (
                  SELECT 1 FROM ${sessionMcpServers}
                  WHERE ${sessionMcpServers.session_id} = ${tasks.session_id}
                    AND ${sessionMcpServers.mcp_server_id} = ${options.attachedServerId}
                    AND ${sessionMcpServers.enabled} = ${true}
                )`
              : undefined,
            options.authorityUserId ? eq(tasks.created_by, options.authorityUserId) : undefined,
            options.credentialUserId ? eq(tasks.created_by, options.credentialUserId) : undefined
          )
        )
        .orderBy(desc(tasks.task_id))
        .limit(limit + 1)
        .all();
      const page = rows.slice(0, limit);
      return {
        tasks: page.map((row: TaskRow) => this.rowToTask(row)),
        ...(rows.length > limit && page.length
          ? { nextTaskId: page[page.length - 1]!.task_id as TaskID }
          : {}),
      };
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      throw new RepositoryError(
        `Failed to page active MCP Tasks: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /** One hard-bounded due-work batch backed by a tenant-aware partial index. */
  async findMcpSlackRecoveryNoticePage(
    options: { now?: Date; horizon?: Date; limit?: number } = {}
  ): Promise<{ tasks: Task[] }> {
    const limit = options.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new RepositoryError('MCP Slack recovery repair limit must be between 1 and 100');
    }
    try {
      const now = options.now ?? new Date();
      const horizon = options.horizon ?? new Date(now.getTime() - 24 * 60 * 60_000);
      const rows = await select(this.db)
        .from(tasks)
        .where(
          and(
            isNotNull(tasks.mcp_slack_recovery_due_at),
            lte(tasks.mcp_slack_recovery_due_at, now),
            gte(tasks.mcp_slack_recovery_due_at, horizon)
          )
        )
        .orderBy(asc(tasks.mcp_slack_recovery_due_at), asc(tasks.task_id))
        .limit(limit)
        .all();
      return {
        tasks: rows.map((row: TaskRow) => this.rowToTask(row)),
      };
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      throw new RepositoryError(
        `Failed to page MCP Slack recovery notices: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find active tasks that have emitted at least one executor heartbeat.
   *
   * Tasks with a null heartbeat are intentionally skipped so enabling the
   * supervisor does not fail legacy/pre-migration rows or tasks still inside
   * startup grace before the executor sends its first heartbeat.
   */
  async findActiveWithExecutorHeartbeat(): Promise<Task[]> {
    try {
      const rows = await select(this.db)
        .from(tasks)
        .where(
          sql`${tasks.status} IN ('running', 'stopping', 'awaiting_permission', 'awaiting_input') AND ${tasks.last_executor_heartbeat_at} IS NOT NULL`
        )
        .all();

      return rows.map((row: TaskRow) => this.rowToTask(row));
    } catch (error) {
      throw new RepositoryError(
        `Failed to find active tasks with executor heartbeat: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  private runtimeDiscoveryColumns() {
    const tenantColumn = (tasks as unknown as { tenant_id?: unknown }).tenant_id;
    return {
      task_id: tasks.task_id,
      ...(isSQLiteDatabase(this.db) || !tenantColumn ? {} : { tenant_id: tenantColumn }),
    };
  }

  private runtimeDiscoveryRefs(rows: Array<Record<string, unknown>>): TaskRuntimeDiscoveryRef[] {
    return rows.map((row) => ({
      task_id: row.task_id as TaskID,
      ...(typeof row.tenant_id === 'string' && row.tenant_id.length > 0
        ? { tenant_id: row.tenant_id }
        : {}),
      ...(row.last_executor_heartbeat_at
        ? {
            executor_heartbeat_at: new Date(
              row.last_executor_heartbeat_at as string | number | Date
            ).toISOString(),
          }
        : {}),
      cursor: {
        task_id: row.task_id as TaskID,
        ...(row.runtime_order_at
          ? {
              order_at: new Date(row.runtime_order_at as string | number | Date).toISOString(),
            }
          : {}),
      },
    }));
  }

  private runtimeCursorDate(
    cursor: TaskRuntimeDiscoveryCursor | undefined,
    category: string
  ): Date | undefined {
    if (!cursor) return undefined;
    if (!cursor.order_at) {
      throw new RepositoryError(`${category} runtime cursor requires an ordering timestamp`);
    }
    const value = new Date(cursor.order_at);
    if (!Number.isFinite(value.getTime())) {
      throw new RepositoryError(`${category} runtime cursor timestamp is invalid`);
    }
    return value;
  }

  private validateRuntimeDiscovery(limit = 25): number {
    if (!Number.isInteger(limit) || limit <= 0 || limit > 1_000) {
      throw new RepositoryError('Task runtime discovery limit must be between 1 and 1000');
    }
    return limit;
  }

  private databaseCutoff(timeoutMs: number, now?: Date) {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      throw new RepositoryError('Task runtime timeout must be non-negative');
    }
    if (now || isSQLiteDatabase(this.db)) {
      return new Date((now?.getTime() ?? Date.now()) - timeoutMs);
    }
    return sql`CURRENT_TIMESTAMP - (${timeoutMs} * INTERVAL '1 millisecond')`;
  }

  private databaseNow(now?: Date) {
    if (now || isSQLiteDatabase(this.db)) return now ?? new Date();
    return sql`CURRENT_TIMESTAMP`;
  }

  /** Bounded routing-only discovery for dispatches whose executor never connected. */
  async findExpiredDispatchRefs(
    timeoutMs: number,
    options: TaskRuntimeDiscoveryOptions = {}
  ): Promise<TaskRuntimeDiscoveryRef[]> {
    const limit = this.validateRuntimeDiscovery(options.limit);
    const afterAt = this.runtimeCursorDate(options.after, 'Dispatch');
    const rows = await select(this.db, {
      ...this.runtimeDiscoveryColumns(),
      runtime_order_at: tasks.started_at,
    })
      .from(tasks)
      .where(
        and(
          eq(tasks.status, TaskStatus.DISPATCHING),
          isNull(tasks.executor_connected_at),
          isNull(tasks.dispatch_timeout_observed_at),
          lte(tasks.started_at, this.databaseCutoff(timeoutMs, options.now)),
          afterAt
            ? or(
                gt(tasks.started_at, afterAt),
                and(eq(tasks.started_at, afterAt), gt(tasks.task_id, options.after!.task_id))
              )
            : undefined
        )
      )
      .orderBy(asc(tasks.started_at), asc(tasks.task_id))
      .limit(limit)
      .all();
    return this.runtimeDiscoveryRefs(rows as Array<Record<string, unknown>>);
  }

  /** Bounded routing-only discovery for connected executors with stale heartbeats. */
  async findStaleHeartbeatRefs(
    staleAfterMs: number,
    options: TaskRuntimeDiscoveryOptions = {}
  ): Promise<TaskRuntimeDiscoveryRef[]> {
    const limit = this.validateRuntimeDiscovery(options.limit);
    const afterAt = this.runtimeCursorDate(options.after, 'Heartbeat');
    const rows = await select(this.db, {
      ...this.runtimeDiscoveryColumns(),
      last_executor_heartbeat_at: tasks.last_executor_heartbeat_at,
      runtime_order_at: tasks.last_executor_heartbeat_at,
    })
      .from(tasks)
      .where(
        and(
          sql`${tasks.status} IN ('running', 'awaiting_permission', 'awaiting_input')`,
          lte(tasks.last_executor_heartbeat_at, this.databaseCutoff(staleAfterMs, options.now)),
          afterAt
            ? or(
                gt(tasks.last_executor_heartbeat_at, afterAt),
                and(
                  eq(tasks.last_executor_heartbeat_at, afterAt),
                  gt(tasks.task_id, options.after!.task_id)
                )
              )
            : undefined
        )
      )
      .orderBy(asc(tasks.last_executor_heartbeat_at), asc(tasks.task_id))
      .limit(limit)
      .all();
    return this.runtimeDiscoveryRefs(rows as Array<Record<string, unknown>>);
  }

  /** Bounded routing-only discovery for unowned or expired STOPPING coordination. */
  async findStrandedTerminationRefs(
    options: TaskRuntimeDiscoveryOptions = {}
  ): Promise<TaskRuntimeDiscoveryRef[]> {
    const limit = this.validateRuntimeDiscovery(options.limit);
    const afterAt = options.after?.order_at ? new Date(options.after.order_at) : undefined;
    if (afterAt && !Number.isFinite(afterAt.getTime())) {
      throw new RepositoryError('Termination runtime cursor timestamp is invalid');
    }
    const after = options.after
      ? afterAt
        ? or(
            and(
              isNotNull(tasks.termination_coordination_expires_at),
              gt(tasks.termination_coordination_expires_at, afterAt)
            ),
            and(
              eq(tasks.termination_coordination_expires_at, afterAt),
              gt(tasks.task_id, options.after.task_id)
            ),
            isNull(tasks.termination_coordination_expires_at)
          )
        : and(
            isNull(tasks.termination_coordination_expires_at),
            gt(tasks.task_id, options.after.task_id)
          )
      : undefined;
    const rows = await select(this.db, {
      ...this.runtimeDiscoveryColumns(),
      runtime_order_at: tasks.termination_coordination_expires_at,
    })
      .from(tasks)
      .where(
        and(
          eq(tasks.status, TaskStatus.STOPPING),
          isNull(tasks.termination_unverified_at),
          or(
            isNull(tasks.termination_coordination_expires_at),
            lte(tasks.termination_coordination_expires_at, this.databaseNow(options.now))
          ),
          after
        )
      )
      .orderBy(sql`${tasks.termination_coordination_expires_at} ASC NULLS LAST`, asc(tasks.task_id))
      .limit(limit)
      .all();
    return this.runtimeDiscoveryRefs(rows as Array<Record<string, unknown>>);
  }

  /**
   * Find tasks by status
   */
  async findByStatus(status: Task['status']): Promise<Task[]> {
    try {
      const rows = await select(this.db).from(tasks).where(eq(tasks.status, status)).all();

      return rows.map((row: TaskRow) => this.rowToTask(row));
    } catch (error) {
      throw new RepositoryError(
        `Failed to find tasks by status: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Atomically claim a daemon-dispatched task for its authenticated executor.
   * Repeated claims after the first successful transition are idempotent.
   */
  async connectExecutor(
    id: string,
    now?: Date
  ): Promise<{ task: Task; transitioned: boolean } | null> {
    try {
      return await this.mutateLockedTask(id, async (txDb, row, fullId) => {
        if (row.status === TaskStatus.RUNNING && row.executor_connected_at) {
          return { task: this.rowToTask(row), transitioned: false };
        }
        if (row.status !== TaskStatus.DISPATCHING) return null;

        const connectedAt = await this.mutationNow(txDb, fullId, now);
        // Successful connection resolves any nonterminal startup diagnostic.
        const data = { ...row.data };
        delete data.error_message;
        await update(txDb, tasks)
          .set({
            status: TaskStatus.RUNNING,
            executor_connected_at: connectedAt,
            last_executor_heartbeat_at: connectedAt,
            data,
          })
          .where(eq(tasks.task_id, fullId))
          .run();

        return {
          task: this.rowToTask({
            ...row,
            status: TaskStatus.RUNNING,
            executor_connected_at: connectedAt,
            last_executor_heartbeat_at: connectedAt,
            data,
          }),
          transitioned: true,
        };
      });
    } catch (error) {
      if (error instanceof RepositoryError || error instanceof EntityNotFoundError) throw error;
      throw new RepositoryError(
        `Failed to connect executor: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /** Record a nonterminal warning only while a templated executor is still pending. */
  async recordExecutorStartupWarning(
    id: string,
    warning: string,
    observedAt?: Date
  ): Promise<Task | null> {
    return this.mutateLockedTask(id, async (txDb, row, fullId) => {
      if (
        row.status !== TaskStatus.DISPATCHING ||
        row.executor_connected_at ||
        row.data.executor_mode !== 'templated'
      ) {
        return null;
      }
      if (row.data.error_message === warning && row.dispatch_timeout_observed_at) return null;

      const data = { ...row.data, error_message: warning };
      const timeoutObservedAt = await this.mutationNow(txDb, fullId, observedAt);
      await update(txDb, tasks)
        .set({ data, dispatch_timeout_observed_at: timeoutObservedAt })
        .where(eq(tasks.task_id, fullId))
        .run();
      return this.rowToTask({
        ...row,
        data,
        dispatch_timeout_observed_at: timeoutObservedAt,
      });
    });
  }

  /**
   * Resolve and immutably bind the filesystem floor used for one Task launch.
   *
   * Task.created_by and Task -> Session -> Branch are the only principal and
   * resource sources. A retry may observe the same floor, but it can never
   * replace a write projection with read/none (or read with none).
   */
  async bindExecutorLaunchAuthority(
    id: string,
    options: ExecutorLaunchAuthorityOptions
  ): Promise<ExecutorLaunchAuthority> {
    return this.mutateLockedTask(id, async (txDb, row, fullId) => {
      if (
        row.status !== TaskStatus.DISPATCHING ||
        row.executor_connected_at ||
        row.data.termination_request
      ) {
        throw new RepositoryError('Task is not awaiting executor launch authority');
      }
      const access = await resolveSessionRuntimeBranchAccess(txDb, {
        sessionId: row.session_id,
        principalUserId: row.created_by,
        ...options,
      });
      if (!access?.can_prompt_session) {
        throw new RepositoryError('Authorization to launch this task is unavailable');
      }

      const existingFloor = row.data.executor_launch_fs_access_floor;
      const requestedFloor = access.fs_access;
      if (existingFloor && fsAccessRank(access.fs_access) < fsAccessRank(existingFloor)) {
        throw new RepositoryError('Authorization to launch this task is unavailable');
      }
      const floor = existingFloor ?? requestedFloor;
      const data = existingFloor
        ? row.data
        : { ...row.data, executor_launch_fs_access_floor: floor };
      if (!existingFloor) {
        await update(txDb, tasks).set({ data }).where(eq(tasks.task_id, fullId)).run();
      }
      return {
        principal_user_id: row.created_by,
        session_id: row.session_id,
        branch_id: access.branch_id,
        fs_access: floor,
      };
    });
  }

  /**
   * Revalidate exact runtime authority, then atomically stamp heartbeat/pulse.
   * Explicit denial returns the unchanged Task so the service can claim the
   * existing fenced termination path. Store/query errors throw and roll back,
   * leaving the stale-heartbeat supervisor as the existing bounded backstop.
   */
  async reportRuntimeTelemetry(
    id: string,
    authority: TaskRuntimeAuthorityScope,
    pulse?: Omit<ExecutorPulse, 'observed_at'>,
    observedAt?: Date
  ): Promise<RuntimeTelemetryReportResult> {
    return this.mutateLockedTask(id, async (txDb, row, fullId) => {
      const current = this.rowToTask(row);
      // STOPPING remains executor-owned until the scoped executor reports
      // quiescence. An unverified containment guard is not proof of absence,
      // so a still-live executor may continue publishing useful evidence and
      // eventually recover the request with a late task/request-fenced ack.
      if (!executorMayReportTelemetry(row)) return { outcome: 'control', task: current };

      const access = await resolveSessionRuntimeBranchAccess(txDb, {
        sessionId: row.session_id,
        principalUserId: row.created_by,
        branchRbacEnabled: authority.branchRbacEnabled,
      });
      if (
        authority.principal_user_id !== row.created_by ||
        authority.session_id !== row.session_id ||
        !access ||
        authority.branch_id !== access.branch_id
      ) {
        return { outcome: 'scope_mismatch', task: current };
      }

      const floor = row.data.executor_launch_fs_access_floor;
      if (!floor) {
        return {
          outcome: 'authorization_revoked',
          task: current,
          reason: 'launch_authority_missing',
        };
      }
      if (!access.principal_available) {
        return {
          outcome: 'authorization_revoked',
          task: current,
          reason: 'principal_unavailable',
        };
      }
      if (!access.can_prompt_session) {
        return {
          outcome: 'authorization_revoked',
          task: current,
          reason: 'branch_capability_revoked',
        };
      }
      if (fsAccessRank(access.fs_access) < fsAccessRank(floor)) {
        return {
          outcome: 'authorization_revoked',
          task: current,
          reason: 'filesystem_access_revoked',
        };
      }

      const tokenCurrent = isPostgresDatabase(this.db)
        ? await new ExecutorSessionTokenAuthorityRepository(txDb).isCurrent({
            tenantId: requireRuntimeTenantId(),
            tokenFingerprint: authority.token_fingerprint,
            sessionId: authority.session_id,
            taskId: fullId,
            branchId: authority.branch_id,
            userId: authority.principal_user_id,
          })
        : authority.standalone_token_current === true;
      if (!tokenCurrent) {
        return {
          outcome: 'authorization_revoked',
          task: current,
          reason: 'token_revoked',
        };
      }

      const heartbeatAt = observedAt ?? access.observed_at;
      if (!Number.isFinite(heartbeatAt.getTime())) {
        throw new RepositoryError('Runtime authority observation time is invalid');
      }

      const previous = row.data.latest_executor_pulse;
      const latest =
        pulse && (!previous || pulse.sequence > previous.sequence)
          ? { ...pulse, observed_at: heartbeatAt.toISOString() }
          : previous;
      const data = { ...row.data, latest_executor_pulse: latest };
      await update(txDb, tasks)
        .set({ last_executor_heartbeat_at: heartbeatAt, data })
        .where(eq(tasks.task_id, fullId))
        .run();
      return {
        outcome: 'continued',
        task: this.rowToTask({ ...row, last_executor_heartbeat_at: heartbeatAt, data }),
      };
    });
  }

  /**
   * Persist the scoped executor's cooperative-stop completion.
   *
   * The request timestamp fences delayed reports, while the row lock makes the
   * report idempotent against duplicate socket delivery/reconnect recovery.
   */
  async recordExecutorQuiescence(
    input: ExecutorTerminationCompleteInput,
    observedAt?: Date
  ): Promise<Task | null> {
    return this.mutateLockedTask(input.task_id, async (txDb, row, fullId) => {
      const current = this.rowToTask(row);
      const request = current.termination_request;
      if (
        current.status !== TaskStatus.STOPPING ||
        !request ||
        request.requested_at !== input.requested_at
      ) {
        return null;
      }
      if (request.executor_quiesced_at) return current;

      const quiescedAt = await this.mutationNow(txDb, fullId, observedAt);

      const { coordination: _coordination, ...storedRequest } = request;
      // An unverified marker guards against an old coordinator terminalizing
      // without proof. A new, correctly task/request-fenced executor report is
      // new evidence, so make the same request recoverable again. If renewed
      // containment is still unverified it writes a fresh guard after this
      // quiescence timestamp; duplicate reports cannot clear that newer guard.
      const recoveringUnverified =
        !!row.termination_unverified_at || current.sdk_failure?.termination === 'unverified';
      const sdkFailure = recoveringUnverified
        ? current.sdk_failure?.reason === 'termination_unverified'
          ? undefined
          : current.sdk_failure
            ? { ...current.sdk_failure, termination: 'requested' as const }
            : undefined
        : current.sdk_failure;
      const data = {
        ...row.data,
        ...(sdkFailure ? { sdk_failure: sdkFailure } : {}),
        termination_request: {
          ...storedRequest,
          executor_quiesced_at: quiescedAt.toISOString(),
        },
      };
      if (recoveringUnverified) {
        // The guard wrote this diagnostic while absence was unknown. New
        // evidence supersedes it; do not leave a successfully stopped Task
        // carrying the obsolete "may still be running" error. Preserve only
        // a real preceding SDK-health diagnosis, not the synthetic guard.
        delete data.error_message;
        if (!sdkFailure) delete data.sdk_failure;
      }
      await update(txDb, tasks)
        .set({
          data,
          ...(recoveringUnverified ? { termination_unverified_at: null } : {}),
        })
        .where(eq(tasks.task_id, fullId))
        .run();
      return this.rowToTask({
        ...row,
        data,
        ...(recoveringUnverified ? { termination_unverified_at: null } : {}),
      });
    });
  }

  /** Record observe-only SDK health evidence only while the executor still owns the task. */
  async recordSdkHealthObservation(id: string, failure: SdkFailure): Promise<Task | null> {
    return this.mutateLockedTask(id, async (txDb, row, fullId) => {
      if (!executorOwnsTask(row)) return null;

      const data = { ...row.data, sdk_failure: failure };
      await update(txDb, tasks).set({ data }).where(eq(tasks.task_id, fullId)).run();
      return this.rowToTask({ ...row, data });
    });
  }

  /** Atomically validate and persist ownership of a termination request. */
  async claimTermination(input: TerminationClaimInput): Promise<TerminationClaimResult> {
    return this.mutateLockedSessionTask(input.taskId, async (txDb, row, sessionRow, fullId) => {
      const current = this.rowToTask(row);
      if (isTerminalTaskStatus(current.status)) return { outcome: 'terminal', task: current };

      const staleBefore = input.heartbeatStaleBefore
        ? Date.parse(input.heartbeatStaleBefore)
        : undefined;
      const heartbeatAt = current.last_executor_heartbeat_at
        ? Date.parse(current.last_executor_heartbeat_at)
        : undefined;
      const conditionChanged =
        (input.expectedStatus !== undefined && current.status !== input.expectedStatus) ||
        (input.expectedHeartbeatAt !== undefined &&
          current.last_executor_heartbeat_at !== input.expectedHeartbeatAt) ||
        (staleBefore !== undefined &&
          (!Number.isFinite(heartbeatAt) || heartbeatAt! > staleBefore)) ||
        (input.requireExecutorDisconnected === true && !!current.executor_connected_at);
      if (conditionChanged) return { outcome: 'condition_changed', task: current };

      const existing = current.termination_request;
      const cause = input.cause === 'user_stop' || !existing ? input.cause : existing.cause;
      if (current.status === TaskStatus.STOPPING && existing?.cause === cause) {
        return { outcome: 'unchanged', task: current };
      }
      const incomingWins =
        !existing || input.cause === 'user_stop' || existing.cause === input.cause;
      const mutationAt = await this.mutationNow(txDb, fullId, input.now);
      const requestedAt = existing?.requested_at ?? mutationAt.toISOString();
      const request = {
        cause,
        requested_at: requestedAt,
        error_message:
          cause === input.cause
            ? input.errorMessage
            : (existing?.error_message ?? input.errorMessage),
        ...(existing?.executor_quiesced_at
          ? { executor_quiesced_at: existing.executor_quiesced_at }
          : {}),
      };
      const sdkFailure = incomingWins
        ? (input.sdkFailure ?? current.sdk_failure)
        : current.sdk_failure;
      const failureTermination: SdkFailure['termination'] =
        sdkFailure?.termination === 'unverified' ? 'unverified' : 'requested';
      const data = {
        ...row.data,
        termination_request: request,
        ...(sdkFailure ? { sdk_failure: { ...sdkFailure, termination: failureTermination } } : {}),
      };
      await update(txDb, tasks)
        .set({ status: TaskStatus.STOPPING, data })
        .where(eq(tasks.task_id, fullId))
        .run();
      await update(txDb, sessions)
        .set({
          status: SessionStatus.STOPPING,
          ready_for_prompt: false,
          updated_at: mutationAt,
        })
        .where(eq(sessions.session_id, sessionRow.session_id))
        .run();
      return {
        outcome: 'claimed',
        task: this.rowToTask({ ...row, status: TaskStatus.STOPPING, data }),
      };
    });
  }

  /**
   * Claim one expiring containment attempt while keeping the termination
   * request epoch stable. The conditional update is the database fence; the
   * daemon identity is diagnostic only.
   */
  async claimTerminationCoordination(
    input: TaskTerminationCoordinationClaimInput
  ): Promise<TaskTerminationCoordinationClaimResult> {
    if (!input.claimToken.trim()) throw new RepositoryError('Coordination claim token is required');
    if (!Number.isFinite(input.leaseDurationMs) || input.leaseDurationMs <= 0) {
      throw new RepositoryError('Coordination lease duration must be positive');
    }
    if (
      input.minimumRequestAgeMs !== undefined &&
      (!Number.isFinite(input.minimumRequestAgeMs) || input.minimumRequestAgeMs < 0)
    ) {
      throw new RepositoryError('Minimum termination-request age must be non-negative');
    }
    return this.mutateLockedTask(input.taskId, async (txDb, row, fullId) => {
      const current = this.rowToTask(row);
      if (isTerminalTaskStatus(current.status)) return { outcome: 'terminal', task: current };
      if (current.status !== TaskStatus.STOPPING || !current.termination_request) {
        return { outcome: 'condition_changed', task: current };
      }
      if (row.termination_unverified_at || current.sdk_failure?.termination === 'unverified') {
        return { outcome: 'condition_changed', task: current };
      }
      if (current.termination_request.coordination?.claim_token === input.claimToken) {
        return { outcome: 'unchanged', task: current };
      }

      const claimedAt = await this.mutationNow(txDb, fullId, input.now);
      if (input.minimumRequestAgeMs !== undefined) {
        const requestedAt = Date.parse(current.termination_request.requested_at);
        if (
          !Number.isFinite(requestedAt) ||
          claimedAt.getTime() - requestedAt < input.minimumRequestAgeMs
        ) {
          return { outcome: 'condition_changed', task: current };
        }
      }
      const expiresAt = new Date(claimedAt.getTime() + input.leaseDurationMs);
      const result = await update(txDb, tasks)
        .set({
          termination_coordination_token: input.claimToken,
          termination_coordination_claimed_at: claimedAt,
          termination_coordination_expires_at: expiresAt,
          termination_coordination_instance_id: input.instanceId,
          termination_coordination_boot_id: input.bootId,
        })
        .where(
          and(
            eq(tasks.task_id, fullId),
            eq(tasks.status, TaskStatus.STOPPING),
            or(
              isNull(tasks.termination_coordination_token),
              isNull(tasks.termination_coordination_expires_at),
              lte(tasks.termination_coordination_expires_at, claimedAt)
            )
          )
        )
        .run();

      const latestRow = await select(txDb).from(tasks).where(eq(tasks.task_id, fullId)).one();
      if (!latestRow) throw new EntityNotFoundError('Task', input.taskId);
      const latest = this.rowToTask(latestRow);
      return result.rowsAffected > 0
        ? { outcome: 'claimed', task: latest }
        : { outcome: 'unchanged', task: latest };
    });
  }

  /** Atomically record containment evidence and, when safe, terminalize the task. */
  async settleTermination(input: TerminationSettlementInput): Promise<TerminationSettlementResult> {
    return this.mutateLockedSessionTask(input.taskId, async (txDb, row, sessionRow, fullId) => {
      const current = this.rowToTask(row);
      if (isTerminalTaskStatus(current.status)) return { outcome: 'terminal', task: current };
      const restartRelease = input.outcome === 'restart_unverified';
      if (
        !restartRelease &&
        (current.status !== TaskStatus.STOPPING || !current.termination_request)
      ) {
        return { outcome: 'condition_changed', task: current };
      }

      if (input.outcome === 'verified_absent' || input.outcome === 'unverified') {
        const coordinationToken = current.termination_request?.coordination?.claim_token;
        if (
          row.termination_unverified_at ||
          current.sdk_failure?.termination === 'unverified' ||
          !coordinationToken ||
          coordinationToken !== input.coordinationToken
        ) {
          return { outcome: 'condition_changed', task: current };
        }
      }

      if (restartRelease && (!input.sdkFailure || !input.errorMessage)) {
        throw new RepositoryError('restart settlement requires unverified failure evidence');
      }

      if (input.outcome === 'unverified') {
        const failure = input.sdkFailure ?? current.sdk_failure;
        if (!failure || !input.errorMessage) {
          throw new RepositoryError('unverified settlement requires failure evidence');
        }
        const data = {
          ...row.data,
          sdk_failure: { ...failure, termination: 'unverified' as const },
          error_message: input.errorMessage,
        };
        const unverifiedAt = await this.mutationNow(txDb, fullId, input.now);
        await update(txDb, tasks)
          .set({
            data,
            termination_coordination_token: null,
            termination_coordination_claimed_at: null,
            termination_coordination_expires_at: null,
            termination_coordination_instance_id: null,
            termination_coordination_boot_id: null,
            termination_unverified_at: unverifiedAt,
          })
          .where(eq(tasks.task_id, fullId))
          .run();
        return {
          outcome: 'unverified',
          task: this.rowToTask({
            ...row,
            data,
            termination_coordination_token: null,
            termination_coordination_claimed_at: null,
            termination_coordination_expires_at: null,
            termination_coordination_instance_id: null,
            termination_coordination_boot_id: null,
            termination_unverified_at: unverifiedAt,
          }),
        };
      }

      if (
        input.outcome === 'forced_unverified' &&
        (current.sdk_failure?.termination !== 'unverified' ||
          current.termination_request?.requested_at !== input.expectedTerminationRequestedAt)
      ) {
        return { outcome: 'condition_changed', task: current };
      }

      const finalStatus = restartRelease
        ? TaskStatus.STOPPED
        : input.outcome === 'forced_unverified'
          ? TaskStatus.FAILED
          : current.termination_request!.cause === 'user_stop'
            ? TaskStatus.STOPPED
            : TaskStatus.FAILED;
      const settlementAt = await this.mutationNow(txDb, fullId, input.now);
      const terminal = withTerminalTiming(current, { status: finalStatus }, settlementAt);
      const completedAt = new Date(terminal.completed_at!);
      const failure = input.sdkFailure ?? current.sdk_failure;
      const data = {
        ...row.data,
        duration_ms: terminal.duration_ms,
        message_range: terminal.message_range ?? current.message_range,
        ...(failure
          ? {
              sdk_failure: {
                ...failure,
                termination:
                  input.outcome === 'forced_unverified' || restartRelease
                    ? ('unverified' as const)
                    : ('verified' as const),
              },
            }
          : {}),
        ...(finalStatus === TaskStatus.FAILED || restartRelease
          ? {
              error_message:
                input.errorMessage ??
                current.termination_request?.error_message ??
                current.error_message,
            }
          : {}),
      };
      await update(txDb, tasks)
        .set({
          status: finalStatus,
          completed_at: completedAt,
          data,
          termination_coordination_token: null,
          termination_coordination_claimed_at: null,
          termination_coordination_expires_at: null,
          termination_coordination_instance_id: null,
          termination_coordination_boot_id: null,
          termination_unverified_at: null,
        })
        .where(eq(tasks.task_id, fullId))
        .run();

      // Task terminality is authoritative. Project the promptability fields
      // in the same short transaction, after the Task write, so a coordinator
      // cannot die in a durable Task-terminal/Session-stopping gap. The
      // service layer still republishes the Session and owns queue/callback
      // side effects after commit.
      const sessionProjection = await update(txDb, sessions)
        .set({
          status: finalStatus === TaskStatus.FAILED ? SessionStatus.FAILED : SessionStatus.IDLE,
          ready_for_prompt: true,
          updated_at: settlementAt,
        })
        .where(eq(sessions.session_id, sessionRow.session_id))
        .run();
      if (sessionProjection.rowsAffected === 0) {
        throw new EntityNotFoundError('Session', current.session_id);
      }
      return {
        outcome: 'transitioned',
        task: this.rowToTask({
          ...row,
          status: finalStatus,
          completed_at: completedAt,
          data,
          termination_coordination_token: null,
          termination_coordination_claimed_at: null,
          termination_coordination_expires_at: null,
          termination_coordination_instance_id: null,
          termination_coordination_boot_id: null,
          termination_unverified_at: null,
        }),
      };
    });
  }

  /**
   * Update task by ID (atomic with database-level transaction)
   *
   * Uses a transaction to ensure read-merge-write is atomic, preventing race conditions
   * when multiple updates happen concurrently (e.g., task status + message_range updates).
   */
  private async updateTask(
    id: string,
    updates: Partial<Task>,
    executorUpdate: boolean
  ): Promise<Task> {
    try {
      return await this.mutateLockedTask(id, async (txDb, currentRow, fullId) => {
        console.debug(
          `🔄 [TaskRepo] Updating task ${shortId(fullId)}${updates.status ? ` (status: ${updates.status})` : ''}`
        );
        const current = this.rowToTask(currentRow);

        if (executorUpdate) {
          if (!executorOwnsTask(currentRow)) {
            throw new RepositoryError('Task is not connected and executor-writable');
          }
          if (updates.status !== undefined && !isExecutorResultStatus(updates.status)) {
            throw new RepositoryError('Task status is not executor-managed');
          }
          if (
            updates.status === TaskStatus.RUNNING &&
            current.status !== TaskStatus.AWAITING_PERMISSION &&
            current.status !== TaskStatus.AWAITING_INPUT
          ) {
            throw new RepositoryError('running task status is server-managed');
          }
        }

        // Terminal task status is immutable at the row-locked mutation boundary.
        // Service-level checks are useful for friendly idempotence, but cannot
        // make a terminal-vs-resume race safe because their read happens before
        // this transaction acquires the lock. Metadata-only updates remain
        // allowed for existing callers.
        if (
          isTerminalTaskStatus(current.status) &&
          updates.status !== undefined &&
          updates.status !== current.status
        ) {
          throw new RepositoryError(
            `terminal task status cannot be changed from ${current.status}`
          );
        }

        // The authenticated executor claim is the only path allowed to cross
        // this boundary. connectExecutor performs its own guarded SQL update
        // above; generic service update/patch calls flow through this method.
        if (current.status === TaskStatus.DISPATCHING && updates.status === TaskStatus.RUNNING) {
          throw new RepositoryError('dispatching tasks must be claimed through connectExecutor');
        }
        if (updates.status === TaskStatus.STOPPING && current.status !== TaskStatus.STOPPING) {
          throw new RepositoryError('stopping tasks must be claimed through claimTermination');
        }
        if (
          current.status === TaskStatus.STOPPING &&
          current.termination_request &&
          updates.status !== undefined &&
          updates.status !== TaskStatus.STOPPING
        ) {
          throw new RepositoryError(
            'termination-owned tasks must be settled through settleTermination'
          );
        }

        const merged = {
          ...deepMerge(current, withTerminalTiming(current, updates)),
          task_id: current.task_id,
          session_id: current.session_id,
          created_by: current.created_by,
          created_at: current.created_at,
        };
        const insertData = this.taskToInsert(merged);

        await update(txDb, tasks)
          .set({
            status: insertData.status,
            queue_position: insertData.queue_position,
            started_at: insertData.started_at,
            executor_connected_at: insertData.executor_connected_at,
            completed_at: insertData.completed_at,
            last_executor_heartbeat_at: insertData.last_executor_heartbeat_at,
            termination_coordination_token: insertData.termination_coordination_token,
            termination_coordination_claimed_at: insertData.termination_coordination_claimed_at,
            termination_coordination_expires_at: insertData.termination_coordination_expires_at,
            termination_coordination_instance_id: insertData.termination_coordination_instance_id,
            termination_coordination_boot_id: insertData.termination_coordination_boot_id,
            termination_unverified_at: insertData.termination_unverified_at,
            data: {
              ...insertData.data,
              ...(currentRow.data.executor_launch_fs_access_floor
                ? {
                    executor_launch_fs_access_floor:
                      currentRow.data.executor_launch_fs_access_floor,
                  }
                : {}),
            },
          })
          .where(eq(tasks.task_id, fullId))
          .run();

        return merged;
      });
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      throw new RepositoryError(
        `Failed to update task: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  async update(id: string, updates: Partial<Task>): Promise<Task> {
    return this.updateTask(id, updates, false);
  }

  /** Serialize the latest MCP recovery projection and its stale-tab generation. */
  async recordMCPRecovery(
    id: string,
    build: (
      current: MCPRuntimeRecovery | undefined,
      task: Task,
      txDb: Database
    ) => MCPRuntimeRecovery | null | Promise<MCPRuntimeRecovery | null>
  ): Promise<Task> {
    return this.runTaskMutation(() =>
      runDatabaseTransaction(
        this.db,
        async (txDb) => {
          const fullId = await this.resolveId(id);
          await lockRowForUpdate(txDb, this.db, tasks, eq(tasks.task_id, fullId));
          const row = await select(txDb).from(tasks).where(eq(tasks.task_id, fullId)).one();
          if (!row) throw new EntityNotFoundError('Task', id);
          const currentTask = this.rowToTask(row);
          const requestedRecovery = await build(
            currentTask.metadata?.mcp_recovery,
            currentTask,
            txDb
          );
          if (!requestedRecovery) return currentTask;
          const tombstone = currentTask.metadata?.mcp_recovery_generation ?? 0;
          const generationFloor = currentTask.metadata?.mcp_recovery
            ? Math.max(currentTask.metadata.mcp_recovery.generation, tombstone)
            : tombstone + 1;
          const recovery = {
            ...requestedRecovery,
            generation: Math.max(requestedRecovery.generation, generationFloor),
          };
          const data = {
            ...row.data,
            metadata: { ...currentTask.metadata, mcp_recovery: recovery },
          };
          const updated = await update(txDb, tasks)
            .set({ data })
            .where(eq(tasks.task_id, fullId))
            .returning()
            .one();
          return this.rowToTask(updated);
        },
        { sqliteImmediate: true }
      )
    );
  }

  /**
   * Serialize internal Slack notice delivery against the same Task row that
   * owns authoritative MCP recovery. Callers must perform provider I/O only
   * after this short transaction returns.
   */
  async mutateMCPSlackRecoveryNotice(
    id: string,
    build: (
      current: MCPSlackRecoveryNotice | undefined,
      task: Task,
      txDb: Database
    ) => MCPSlackRecoveryNotice | null | Promise<MCPSlackRecoveryNotice | null>
  ): Promise<{ task: Task; changed: boolean }> {
    return this.runTaskMutation(() =>
      runDatabaseTransaction(
        this.db,
        async (txDb) => {
          const fullId = await this.resolveId(id);
          await lockRowForUpdate(txDb, this.db, tasks, eq(tasks.task_id, fullId));
          const row = await select(txDb).from(tasks).where(eq(tasks.task_id, fullId)).one();
          if (!row) throw new EntityNotFoundError('Task', id);
          const task = this.rowToTask(row);
          const next = await build(task.metadata?.mcp_slack_recovery_notice, task, txDb);
          if (!next) return { task, changed: false };
          const updated = await update(txDb, tasks)
            .set({
              mcp_slack_recovery_due_at: next.next_repair_at ? new Date(next.next_repair_at) : null,
              data: {
                ...row.data,
                metadata: { ...task.metadata, mcp_slack_recovery_notice: next },
              },
            })
            .where(eq(tasks.task_id, fullId))
            .returning()
            .one();
          return { task: this.rowToTask(updated), changed: true };
        },
        { sqliteImmediate: true }
      )
    );
  }

  /** Atomically fence one exact recovery request before capabilities are reprojected. */
  async claimMCPReprojection(
    id: string,
    input: {
      sessionId: SessionID;
      principalUserId: string;
      requestId: string;
      expectedGeneration: number;
      fingerprint: string;
    }
  ): Promise<{ task: Task; outcome: 'claimed' | 'duplicate' | 'stale' }> {
    return this.runTaskMutation(() =>
      runDatabaseTransaction(
        this.db,
        async (txDb) => {
          const fullId = await this.resolveId(id);
          await lockRowForUpdate(txDb, this.db, tasks, eq(tasks.task_id, fullId));
          const row = await select(txDb).from(tasks).where(eq(tasks.task_id, fullId)).one();
          if (!row) throw new EntityNotFoundError('Task', id);
          const task = this.rowToTask(row);
          const recovery = task.metadata?.mcp_recovery;
          if (
            task.session_id !== input.sessionId ||
            task.created_by !== input.principalUserId ||
            !executorOwnsTask({
              status: task.status,
              executor_connected_at: task.executor_connected_at
                ? new Date(task.executor_connected_at)
                : null,
            }) ||
            !recovery ||
            recovery.generation !== input.expectedGeneration ||
            recovery.request_id !== input.requestId
          ) {
            return { task, outcome: 'stale' as const };
          }
          const existing = task.metadata?.mcp_reprojection_claim;
          if (
            existing?.request_id === input.requestId &&
            existing.recovery_generation === input.expectedGeneration &&
            existing.fingerprint === input.fingerprint &&
            (recovery.status === 'refresh_requested' || recovery.status === 'action_required')
          ) {
            return { task, outcome: 'duplicate' as const };
          }
          if (recovery.status !== 'refresh_requested') {
            return { task, outcome: 'stale' as const };
          }
          if (existing && existing.recovery_generation >= input.expectedGeneration) {
            return { task, outcome: 'stale' as const };
          }
          const data = {
            ...row.data,
            metadata: {
              ...task.metadata,
              mcp_reprojection_claim: {
                request_id: input.requestId,
                recovery_generation: input.expectedGeneration,
                fingerprint: input.fingerprint,
                claimed_at: new Date().toISOString(),
              },
            },
          };
          const updated = await update(txDb, tasks)
            .set({ data })
            .where(eq(tasks.task_id, fullId))
            .returning()
            .one();
          return { task: this.rowToTask(updated), outcome: 'claimed' as const };
        },
        { sqliteImmediate: true }
      )
    );
  }

  /**
   * Revalidate an exact durable reprojection claim immediately before the
   * provider transport is changed. This deliberately returns no projection:
   * callers can survive daemon restarts without relying on a process cache or
   * minting a second capability set.
   */
  async validateMCPReprojectionClaim(
    id: string,
    input: {
      sessionId: SessionID;
      principalUserId: string;
      requestId: string;
      expectedGeneration: number;
      fingerprint: string;
    }
  ): Promise<{ task: Task; outcome: 'current' | 'stale' }> {
    return this.runTaskMutation(() =>
      runDatabaseTransaction(
        this.db,
        async (txDb) => {
          const fullId = await this.resolveId(id);
          await lockRowForUpdate(txDb, this.db, tasks, eq(tasks.task_id, fullId));
          const row = await select(txDb).from(tasks).where(eq(tasks.task_id, fullId)).one();
          if (!row) throw new EntityNotFoundError('Task', id);
          const task = this.rowToTask(row);
          const recovery = task.metadata?.mcp_recovery;
          const claim = task.metadata?.mcp_reprojection_claim;
          const current =
            task.session_id === input.sessionId &&
            task.created_by === input.principalUserId &&
            executorOwnsTask({
              status: task.status,
              executor_connected_at: task.executor_connected_at
                ? new Date(task.executor_connected_at)
                : null,
            }) &&
            !!recovery &&
            (recovery.status === 'refresh_requested' || recovery.status === 'action_required') &&
            recovery.generation === input.expectedGeneration &&
            recovery.request_id === input.requestId &&
            claim?.request_id === input.requestId &&
            claim.recovery_generation === input.expectedGeneration &&
            claim.fingerprint === input.fingerprint;
          return { task, outcome: current ? ('current' as const) : ('stale' as const) };
        },
        { sqliteImmediate: true }
      )
    );
  }

  /** Bind the exact authority projection once; duplicate claims may attest only that projection. */
  async bindMCPReprojectionAuthority(
    id: string,
    input: {
      sessionId: SessionID;
      principalUserId: string;
      requestId: string;
      expectedGeneration: number;
      fingerprint: string;
      authorityFingerprints: string[];
    }
  ): Promise<{ task: Task; outcome: 'bound' | 'stale' }> {
    return this.runTaskMutation(() =>
      runDatabaseTransaction(
        this.db,
        async (txDb) => {
          const fullId = await this.resolveId(id);
          await lockRowForUpdate(txDb, this.db, tasks, eq(tasks.task_id, fullId));
          const row = await select(txDb).from(tasks).where(eq(tasks.task_id, fullId)).one();
          if (!row) throw new EntityNotFoundError('Task', id);
          const task = this.rowToTask(row);
          const recovery = task.metadata?.mcp_recovery;
          const claim = task.metadata?.mcp_reprojection_claim;
          if (
            task.session_id !== input.sessionId ||
            task.created_by !== input.principalUserId ||
            !executorOwnsTask({
              status: task.status,
              executor_connected_at: task.executor_connected_at
                ? new Date(task.executor_connected_at)
                : null,
            }) ||
            !recovery ||
            recovery.generation !== input.expectedGeneration ||
            recovery.request_id !== input.requestId ||
            claim?.request_id !== input.requestId ||
            claim.recovery_generation !== input.expectedGeneration ||
            claim.fingerprint !== input.fingerprint
          ) {
            return { task, outcome: 'stale' as const };
          }
          const projectionFingerprint = mcpReprojectionAuthorityDigest(input.authorityFingerprints);
          const existingProjectionFingerprint =
            claim.projection_fingerprint ??
            (claim.authority_fingerprints !== undefined
              ? mcpReprojectionAuthorityDigest(claim.authority_fingerprints)
              : undefined);
          if (existingProjectionFingerprint !== undefined) {
            return existingProjectionFingerprint === projectionFingerprint
              ? { task, outcome: 'bound' as const }
              : { task, outcome: 'stale' as const };
          }
          const authorityFingerprints = [...new Set(input.authorityFingerprints)]
            .sort((left, right) => left.localeCompare(right))
            .slice(0, 256);
          const updated = await update(txDb, tasks)
            .set({
              data: {
                ...row.data,
                metadata: {
                  ...task.metadata,
                  mcp_reprojection_claim: {
                    ...claim,
                    projection_fingerprint: projectionFingerprint,
                    authority_fingerprints: authorityFingerprints,
                  },
                },
              },
            })
            .where(eq(tasks.task_id, fullId))
            .returning()
            .one();
          return { task: this.rowToTask(updated), outcome: 'bound' as const };
        },
        { sqliteImmediate: true }
      )
    );
  }

  /**
   * Settle an exact claimed refresh. A fully ready projection is cleared and
   * leaves its monotonic tombstone; a partial projection keeps its actionable
   * per-server state but releases the one-shot apply claim.
   */
  async settleMCPReprojection(
    id: string,
    input: {
      sessionId: SessionID;
      principalUserId: string;
      requestId: string;
      expectedGeneration: number;
      ok: boolean;
      failure?: 'transport_outcome_uncertain';
    }
  ): Promise<{ task: Task; outcome: 'settled' | 'stale' }> {
    return this.runTaskMutation(() =>
      runDatabaseTransaction(
        this.db,
        async (txDb) => {
          const fullId = await this.resolveId(id);
          await lockRowForUpdate(txDb, this.db, tasks, eq(tasks.task_id, fullId));
          const row = await select(txDb).from(tasks).where(eq(tasks.task_id, fullId)).one();
          if (!row) throw new EntityNotFoundError('Task', id);
          const task = this.rowToTask(row);
          const recovery = task.metadata?.mcp_recovery;
          const claim = task.metadata?.mcp_reprojection_claim;
          if (
            task.session_id !== input.sessionId ||
            task.created_by !== input.principalUserId ||
            !executorOwnsTask({
              status: task.status,
              executor_connected_at: task.executor_connected_at
                ? new Date(task.executor_connected_at)
                : null,
            }) ||
            !recovery ||
            (recovery.status !== 'refresh_requested' && recovery.status !== 'action_required') ||
            recovery.generation !== input.expectedGeneration ||
            recovery.request_id !== input.requestId ||
            claim?.request_id !== input.requestId ||
            claim.recovery_generation !== input.expectedGeneration ||
            (claim.projection_fingerprint === undefined &&
              claim.authority_fingerprints === undefined)
          ) {
            return { task, outcome: 'stale' as const };
          }

          const metadata = { ...task.metadata };
          delete metadata.mcp_reprojection_claim;
          if (input.ok && recovery.status === 'refresh_requested') {
            delete metadata.mcp_recovery;
            metadata.mcp_recovery_generation = Math.max(
              metadata.mcp_recovery_generation ?? 0,
              recovery.generation
            );
            metadata.mcp_recovery_settled_request_id = recovery.request_id;
            metadata.mcp_recovery_settled_at = new Date().toISOString();
            metadata.mcp_recovery_settled_authority_fingerprints =
              claim.authority_fingerprints ?? [];
            metadata.mcp_recovery_settled_projection_fingerprint =
              claim.projection_fingerprint ??
              mcpReprojectionAuthorityDigest(claim.authority_fingerprints ?? []);
          } else if (!input.ok) {
            const uncertain = input.failure === 'transport_outcome_uncertain';
            metadata.mcp_recovery = {
              ...recovery,
              generation: recovery.generation + 1,
              code: uncertain ? 'transport_refresh_uncertain' : 'provider_refresh_failed',
              status: uncertain ? 'action_required' : 'failed',
              action: uncertain ? 'retry_next_turn' : 'reconnect_mcp',
              message: uncertain
                ? 'The provider did not confirm whether MCP transport refresh completed. No MCP call was retried, and this task will not attempt another live transport change; current authority applies on the next turn.'
                : 'The provider could not rebuild MCP transport safely. No tool call was retried; reconnect MCP to try again.',
              observed_at: new Date().toISOString(),
              refresh_deadline_at: undefined,
            };
          }
          const updated = await update(txDb, tasks)
            .set({ data: { ...row.data, metadata } })
            .where(eq(tasks.task_id, fullId))
            .returning()
            .one();
          return { task: this.rowToTask(updated), outcome: 'settled' as const };
        },
        { sqliteImmediate: true }
      )
    );
  }

  /** Clear a matching recovery projection after a successful transport rebuild. */
  async clearMCPRecovery(
    id: string,
    matches: (current: MCPRuntimeRecovery, task: Task) => boolean
  ): Promise<Task> {
    return this.runTaskMutation(() =>
      runDatabaseTransaction(
        this.db,
        async (txDb) => {
          const fullId = await this.resolveId(id);
          await lockRowForUpdate(txDb, this.db, tasks, eq(tasks.task_id, fullId));
          const row = await select(txDb).from(tasks).where(eq(tasks.task_id, fullId)).one();
          if (!row) throw new EntityNotFoundError('Task', id);
          const currentTask = this.rowToTask(row);
          const current = currentTask.metadata?.mcp_recovery;
          if (!current || !matches(current, currentTask)) return currentTask;
          const claim = currentTask.metadata?.mcp_reprojection_claim;
          const metadata = { ...currentTask.metadata };
          delete metadata.mcp_recovery;
          delete metadata.mcp_reprojection_claim;
          metadata.mcp_recovery_generation = Math.max(
            metadata.mcp_recovery_generation ?? 0,
            current.generation
          );
          metadata.mcp_recovery_settled_request_id = current.request_id;
          metadata.mcp_recovery_settled_at = new Date().toISOString();
          metadata.mcp_recovery_settled_authority_fingerprints =
            claim?.authority_fingerprints ?? [];
          if (claim) {
            metadata.mcp_recovery_settled_projection_fingerprint =
              claim.projection_fingerprint ??
              mcpReprojectionAuthorityDigest(claim.authority_fingerprints ?? []);
          } else {
            delete metadata.mcp_recovery_settled_projection_fingerprint;
          }
          const updated = await update(txDb, tasks)
            .set({ data: { ...row.data, metadata } })
            .where(eq(tasks.task_id, fullId))
            .returning()
            .one();
          return this.rowToTask(updated);
        },
        { sqliteImmediate: true }
      )
    );
  }

  /** Apply executor-owned result fields only while the executor still owns the locked row. */
  async updateFromExecutor(id: string, updates: Partial<Task>): Promise<Task> {
    return this.updateTask(id, updates, true);
  }

  /**
   * Delete task by ID
   */
  async delete(id: string): Promise<void> {
    try {
      const fullId = await this.resolveId(id);

      const result = await deleteFrom(this.db, tasks)
        .where(and(eq(tasks.task_id, fullId), eq(tasks.status, TaskStatus.QUEUED)))
        .run();

      if (result.rowsAffected === 0) {
        const existing = await select(this.db).from(tasks).where(eq(tasks.task_id, fullId)).one();
        if (!existing) throw new EntityNotFoundError('Task', id);
        throw new RepositoryError('Only queued tasks can be deleted');
      }
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      if (error instanceof EntityNotFoundError) throw error;
      throw new RepositoryError(
        `Failed to delete task: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Create a pending task — either CREATED (will spawn immediately) or
   * QUEUED (will drain later) — owning the sentinel defaults that the
   * caller would otherwise have to assemble by hand.
   *
   * For QUEUED tasks, `queue_position = max(queue_position) + 1` is computed
   * while holding the owning Session row lock. A transaction by itself does
   * not serialize PostgreSQL READ COMMITTED readers; the Session lock is the
   * durable per-queue sequencer shared by every daemon. (The schema also
   * carries a partial unique index as defense in depth.)
   *
   * Sentinel contract: while a task carries `message_range.start_index = -1`
   * and `git_state.sha_at_start = ''`, it has not yet been pinned to real
   * conversation/git state. spawnTaskExecutor is the sole place that
   * overwrites these on the way to RUNNING.
   */
  async createPending(input: {
    /** Optional stable identity used by idempotent internal producers. */
    task_id?: TaskID;
    session_id: SessionID;
    full_prompt: string;
    created_by: string;
    status: TaskPendingDispatchStatus;
    metadata?: TaskMetadata;
  }): Promise<Task> {
    const taskBase: Partial<Task> = {
      task_id: input.task_id,
      session_id: input.session_id,
      full_prompt: input.full_prompt,
      created_by: input.created_by,
      status: input.status,
      metadata: input.metadata,
      // Sentinels — overwritten by spawnTaskExecutor at the status → RUNNING
      // transition. While `start_index === -1` / `sha_at_start === ''`, the
      // task is intentionally unpinned.
      message_range: {
        start_index: -1,
        end_index: -1,
        start_timestamp: new Date().toISOString(),
      },
      git_state: {
        ref_at_start: '',
        sha_at_start: '',
      },
      tool_use_count: 0,
    };

    if (input.status === TaskStatus.CREATED && !input.task_id) {
      return this.create(taskBase);
    }

    if (input.status === TaskStatus.CREATED) {
      const insertData = this.taskToInsert(taskBase);
      await insert(this.db, tasks).values(insertData).onConflictDoNothing().run();
      const row = await select(this.db).from(tasks).where(eq(tasks.task_id, input.task_id!)).one();
      if (!row) throw new RepositoryError('Failed to retrieve idempotent pending task');
      const existing = this.rowToTask(row);
      if (
        existing.session_id !== input.session_id ||
        existing.created_by !== input.created_by ||
        existing.full_prompt !== input.full_prompt
      ) {
        throw new RepositoryError(`Task identity ${input.task_id} is already in use`);
      }
      return existing;
    }

    // QUEUED: lock the durable Session row before max+1. This is required on
    // PostgreSQL: two ordinary READ COMMITTED transactions can otherwise read
    // the same max concurrently and merely turn the unique index into a loser
    // error rather than making one ordered admission decision.
    return this.runTaskMutation(() =>
      runDatabaseTransaction(
        this.db,
        async (txDb) => {
          await lockRowForUpdate(
            txDb,
            this.db,
            sessions,
            eq(sessions.session_id, input.session_id)
          );
          const sessionRow = await select(txDb)
            .from(sessions)
            .where(eq(sessions.session_id, input.session_id))
            .one();
          if (!sessionRow) throw new EntityNotFoundError('Session', input.session_id);
          if (
            input.task_id &&
            sessionRow.scheduler_init_failure_code &&
            !sessionRow.scheduler_init_retry_at
          ) {
            throw new RepositoryError('Scheduled occurrence initialization is permanently settled');
          }

          let existingCreated: Task | undefined;
          if (input.task_id) {
            await lockRowForUpdate(txDb, this.db, tasks, eq(tasks.task_id, input.task_id));
            const existingRow = await select(txDb)
              .from(tasks)
              .where(eq(tasks.task_id, input.task_id))
              .one();
            if (existingRow) {
              const existing = this.rowToTask(existingRow);
              if (
                existing.session_id !== input.session_id ||
                existing.created_by !== input.created_by ||
                existing.full_prompt !== input.full_prompt
              ) {
                throw new RepositoryError(`Task identity ${input.task_id} is already in use`);
              }
              if (existing.status !== TaskStatus.CREATED) return existing;

              // A stable internal producer may recover a standalone SQLite
              // crash that committed CREATED before launch admission. Move
              // that same Task into the durable queue rather than letting it
              // jump an already-admitted prompt or remain undiscoverable.
              existingCreated = existing;
            }
          }

          const positionRow = await select(txDb, {
            maxPos: sql<number | null>`max(${tasks.queue_position})`,
          })
            .from(tasks)
            .where(sql`${tasks.session_id} = ${input.session_id} AND ${tasks.status} = 'queued'`)
            .one();

          const nextPosition = (positionRow?.maxPos ?? 0) + 1;
          if (existingCreated) {
            await update(txDb, tasks)
              .set({ status: TaskStatus.QUEUED, queue_position: nextPosition })
              .where(eq(tasks.task_id, existingCreated.task_id))
              .run();
            return {
              ...existingCreated,
              status: TaskStatus.QUEUED,
              queue_position: nextPosition,
            };
          }

          const insertData = this.taskToInsert({
            ...taskBase,
            queue_position: nextPosition,
          });
          await insert(txDb, tasks).values(insertData).run();

          const row = await select(txDb)
            .from(tasks)
            .where(eq(tasks.task_id, insertData.task_id))
            .one();
          if (!row) throw new RepositoryError('Failed to retrieve created queued task');
          return this.rowToTask(row);
        },
        { sqliteImmediate: true }
      )
    );
  }

  /**
   * Atomically claim the CREATED/QUEUED -> DISPATCHING transition.
   *
   * The Session row lock, queue-head check, and Task expected-state check are
   * the fence. A Task-only fence prevents duplicate launch of one Task but is
   * insufficient when two daemons claim different Tasks for the same Session.
   * A loser may do preparatory reads, but it cannot write launch intent,
   * transcript/session state, or spawn an executor.
   */
  async claimDispatchAndProjectSession(
    id: string,
    expectedStatus: TaskPendingDispatchStatus,
    updates: Partial<Task>
  ): Promise<TaskDispatchClaimResult> {
    return this.mutateLockedSessionTask(id, async (txDb, currentRow, sessionRow, fullId) => {
      const current = this.rowToTask(currentRow);
      if (current.status !== expectedStatus) {
        return {
          outcome:
            current.status === TaskStatus.DISPATCHING || current.status === TaskStatus.RUNNING
              ? 'already_claimed'
              : 'condition_changed',
          task: current,
        };
      }
      if (updates.status !== TaskStatus.DISPATCHING) {
        throw new RepositoryError('Dispatch claim must transition to dispatching');
      }

      // A queue claimant may only take the durable head. An explicit CREATED
      // task may not jump an existing prompt queue. Both checks run under the
      // same Session lock that serializes enqueue position assignment.
      const queuedHead = await select(txDb, { task_id: tasks.task_id })
        .from(tasks)
        .where(and(eq(tasks.session_id, current.session_id), eq(tasks.status, TaskStatus.QUEUED)))
        .orderBy(asc(tasks.queue_position), asc(tasks.created_at), asc(tasks.task_id))
        .limit(1)
        .one();
      if (
        (expectedStatus === TaskStatus.QUEUED && queuedHead?.task_id !== fullId) ||
        (expectedStatus === TaskStatus.CREATED && queuedHead != null)
      ) {
        return { outcome: 'condition_changed', task: current };
      }

      const actor = await select(txDb, { user_id: users.user_id })
        .from(users)
        .where(eq(users.user_id, current.created_by))
        .one();
      if (!actor) {
        return {
          outcome: 'actor_missing',
          task: await this.terminalizeMissingDispatchActor(txDb, current, fullId),
        };
      }

      const competingExecution = await select(txDb, { task_id: tasks.task_id })
        .from(tasks)
        .where(
          and(
            eq(tasks.session_id, current.session_id),
            ne(tasks.task_id, fullId),
            inArray(tasks.status, [...EXECUTING_TASK_STATUSES])
          )
        )
        .limit(1)
        .one();
      if (
        competingExecution ||
        !sessionCanStartTask(sessionRow.status, sessionRow.ready_for_prompt)
      ) {
        return { outcome: 'condition_changed', task: current };
      }

      const requestedStartedAt = updates.started_at ? new Date(updates.started_at) : undefined;
      const dispatchAt = await this.mutationNow(
        txDb,
        fullId,
        // Standalone SQLite retains injected/process time for deterministic
        // compatibility. PostgreSQL launch deadlines use the database clock.
        isSQLiteDatabase(this.db) ? requestedStartedAt : undefined
      );

      const merged: Task = {
        ...deepMerge(current, { ...updates, started_at: dispatchAt.toISOString() }),
        task_id: current.task_id,
        session_id: current.session_id,
        created_by: current.created_by,
        created_at: current.created_at,
        // Queue ownership ends at the durable launch-intent transition.
        queue_position: undefined,
      };
      const insertData = this.taskToInsert(merged);
      await update(txDb, tasks)
        .set({
          status: insertData.status,
          queue_position: insertData.queue_position,
          started_at: insertData.started_at,
          executor_connected_at: insertData.executor_connected_at,
          completed_at: insertData.completed_at,
          last_executor_heartbeat_at: insertData.last_executor_heartbeat_at,
          data: insertData.data,
        })
        .where(eq(tasks.task_id, fullId))
        .run();

      // The launch-intent transition and its Session projection are one
      // durable state change. Keeping this write inside the task-claim
      // transaction (independent of any request-scope policy) closes the kill
      // point where a Task could be DISPATCHING while its Session remained
      // IDLE and omitted the task from data.tasks. The Session row is already
      // locked by mutateLockedSessionTask.
      const sessionTasks = sessionRow.data.tasks.includes(current.task_id)
        ? sessionRow.data.tasks
        : [...sessionRow.data.tasks, current.task_id];
      await update(txDb, sessions)
        .set({
          status: SessionStatus.RUNNING,
          ready_for_prompt: false,
          updated_at: dispatchAt,
          data: { ...sessionRow.data, tasks: sessionTasks },
        })
        .where(eq(sessions.session_id, current.session_id))
        .run();
      return { outcome: 'claimed', task: merged };
    });
  }

  /**
   * Fail a queued head only if its immutable creator is absent at the locked
   * Session→Task boundary. A concurrent dispatcher that wins first changes the
   * status and this command becomes a no-op instead of overwriting DISPATCHING.
   */
  async failQueuedTaskIfCreatorMissing(id: string): Promise<QueuedTaskActorCheckResult> {
    return this.mutateLockedSessionTask(id, async (txDb, currentRow, _sessionRow, fullId) => {
      const current = this.rowToTask(currentRow);
      if (current.status !== TaskStatus.QUEUED) {
        return { outcome: 'condition_changed', task: current };
      }
      const queuedHead = await select(txDb, { task_id: tasks.task_id })
        .from(tasks)
        .where(and(eq(tasks.session_id, current.session_id), eq(tasks.status, TaskStatus.QUEUED)))
        .orderBy(asc(tasks.queue_position), asc(tasks.created_at), asc(tasks.task_id))
        .limit(1)
        .one();
      if (queuedHead?.task_id !== fullId) {
        return { outcome: 'condition_changed', task: current };
      }
      const actor = await select(txDb, { user_id: users.user_id })
        .from(users)
        .where(eq(users.user_id, current.created_by))
        .one();
      if (actor) return { outcome: 'actor_available', task: current };
      return {
        outcome: 'actor_missing',
        task: await this.terminalizeMissingDispatchActor(txDb, current, fullId),
      };
    });
  }

  private async terminalizeMissingDispatchActor(
    txDb: Database,
    current: Task,
    fullId: string
  ): Promise<Task> {
    const completedAt = await this.mutationNow(txDb, fullId);
    const failed: Task = {
      ...current,
      status: TaskStatus.FAILED,
      queue_position: undefined,
      completed_at: completedAt.toISOString(),
      error_message: MISSING_TASK_ACTOR_ERROR,
    };
    const insertData = this.taskToInsert(failed);
    await update(txDb, tasks)
      .set({
        status: insertData.status,
        queue_position: null,
        completed_at: insertData.completed_at,
        data: insertData.data,
      })
      .where(and(eq(tasks.task_id, fullId), eq(tasks.status, current.status)))
      .run();
    return failed;
  }

  /**
   * Find all QUEUED tasks for a session, ordered by queue_position ascending.
   */
  async findQueued(sessionId: string): Promise<Task[]> {
    try {
      const rows = await select(this.db)
        .from(tasks)
        .where(sql`${tasks.session_id} = ${sessionId} AND ${tasks.status} = 'queued'`)
        .orderBy(asc(tasks.queue_position), asc(tasks.created_at), asc(tasks.task_id))
        .all();

      return rows.map((row: TaskRow) => this.rowToTask(row));
    } catch (error) {
      throw new RepositoryError(
        `Failed to find queued tasks: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Return the next QUEUED task to drain (lowest queue_position) for a session,
   * or null if none.
   */
  async getNextQueued(sessionId: string): Promise<Task | null> {
    try {
      const row = await select(this.db)
        .from(tasks)
        .where(sql`${tasks.session_id} = ${sessionId} AND ${tasks.status} = 'queued'`)
        .orderBy(asc(tasks.queue_position), asc(tasks.created_at), asc(tasks.task_id))
        .limit(1)
        .one();

      return row ? this.rowToTask(row) : null;
    } catch (error) {
      throw new RepositoryError(
        `Failed to get next queued task: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Bounded routing-only discovery for all-daemon queue recovery.
   *
   * The cursor is fairness state only. QUEUED rows remain the durable
   * authority, and callers wrap after an empty page. PostgreSQL system scope
   * exposes only queued rows through the dedicated RLS capability; each
   * returned Session must be reloaded and mutated in its trusted tenant scope.
   */
  async findQueuedSessionRefs(
    limit = 25,
    after?: QueuedSessionCursor
  ): Promise<QueuedSessionRef[]> {
    if (!Number.isInteger(limit) || limit <= 0 || limit > 1_000) {
      throw new RepositoryError('Queued Session discovery limit must be between 1 and 1000');
    }

    const tenantColumn = (tasks as unknown as { tenant_id?: typeof tasks.session_id }).tenant_id;
    const postgresTenantColumn = isPostgresDatabase(this.db) ? tenantColumn : undefined;
    const afterCondition = postgresTenantColumn
      ? after?.tenant_id
        ? or(
            gt(postgresTenantColumn, after.tenant_id),
            and(eq(postgresTenantColumn, after.tenant_id), gt(tasks.session_id, after.session_id))
          )
        : undefined
      : after
        ? gt(tasks.session_id, after.session_id)
        : undefined;
    const columns = {
      session_id: tasks.session_id,
      first_queued_at: sql<Date | number>`min(${tasks.created_at})`,
      ...(postgresTenantColumn ? { tenant_id: postgresTenantColumn } : {}),
    };
    const grouped = select(this.db, columns)
      .from(tasks)
      .where(and(eq(tasks.status, TaskStatus.QUEUED), afterCondition))
      .groupBy(
        ...(postgresTenantColumn ? [postgresTenantColumn, tasks.session_id] : [tasks.session_id])
      );
    const rows = postgresTenantColumn
      ? await grouped.orderBy(asc(postgresTenantColumn), asc(tasks.session_id)).limit(limit).all()
      : await grouped.orderBy(asc(tasks.session_id)).limit(limit).all();

    return (rows as Array<Record<string, unknown>>).map((row) => ({
      session_id: row.session_id as SessionID,
      first_queued_at:
        row.first_queued_at instanceof Date
          ? row.first_queued_at.getTime()
          : new Date(row.first_queued_at as string | number).getTime(),
      ...(typeof row.tenant_id === 'string' ? { tenant_id: row.tenant_id } : {}),
    }));
  }

  /**
   * Count tasks for a session
   */
  async countBySession(sessionId: string): Promise<number> {
    try {
      const result = await select(this.db, { count: sql<number>`count(*)` })
        .from(tasks)
        .where(eq(tasks.session_id, sessionId))
        .one();

      return result?.count ?? 0;
    } catch (error) {
      throw new RepositoryError(
        `Failed to count tasks: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }
}
