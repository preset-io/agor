/**
 * SQLite Schema Definition
 *
 * Uses type factory helpers for the 3 differing types (timestamp, boolean, json).
 * All other types (text, index, foreign keys) are identical to PostgreSQL schema.
 */

import type {
  AgorGrants,
  AgorRuntimeConfig,
  BranchEnvironmentInstance,
  CodexApprovalPolicy,
  CodexSandboxMode,
  EffortLevel,
  Message,
  PermissionMode,
  SandpackConfig,
  Session,
  Task,
  UserExternalIdentity,
} from '@agor/core/types';
import { BRANCH_PERMISSION_LEVELS } from '@agor/core/types';
import { relations, sql } from 'drizzle-orm';
import {
  type AnySQLiteColumn,
  blob,
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

// SQLite-specific type helpers (inline to avoid factory pattern type issues)
const t = {
  timestamp: (name: string) => integer(name, { mode: 'timestamp_ms' }),
  bool: (name: string) => integer(name, { mode: 'boolean' }),
  json: <T>(name: string) => text(name, { mode: 'json' }).$type<T>(),
} as const;

/**
 * Sessions table - Core primitive for all agentic tool interactions
 *
 * Hybrid schema strategy:
 * - Materialize columns we filter/join by (status, genealogy, agentic_tool, board)
 * - JSON blob for nested/rarely-queried data (git_state, repo config, etc.)
 */
export const sessions = sqliteTable(
  'sessions',
  {
    // Primary identity
    session_id: text('session_id', { length: 36 }).primaryKey(),
    created_at: t.timestamp('created_at').notNull(),
    updated_at: t.timestamp('updated_at'),

    // User attribution
    created_by: text('created_by', { length: 36 }).notNull(),

    // Immutable execution-home key (legacy column name)
    // Set from creator's unix_username at session creation time
    // NEVER changes, even if user's unix_username changes later
    // This ensures SDK session data remains accessible in the original home directory
    unix_username: text('unix_username'),

    // Immutable SDK-state boundary. Existing sessions keep using their
    // historical execution home; only newly admitted sessions may use the
    // branch-owned SDK home.
    sdk_home_scope: text('sdk_home_scope', {
      enum: ['execution_home', 'branch'],
    })
      .notNull()
      .default('execution_home'),

    // Materialized for filtering/joins (cross-DB compatible)
    status: text('status', {
      enum: [
        'idle',
        'running',
        'stopping',
        'awaiting_permission',
        'awaiting_input',
        'timed_out',
        'completed',
        'failed',
      ],
    }).notNull(),
    agentic_tool: text('agentic_tool', {
      // Retain the removed identifier so historical rows remain readable.
      // Runtime creation and execution validate against AgenticToolName.
      enum: ['claude-code', 'claude-code-cli', 'codex', 'gemini', 'opencode', 'copilot', 'cursor'],
    }).notNull(),
    agentic_tool_preset_id: text('agentic_tool_preset_id', { length: 36 }).references(
      (): AnySQLiteColumn => agenticToolPresets.preset_id,
      { onDelete: 'restrict' }
    ),
    board_id: text('board_id', { length: 36 }), // NULL = no board

    // Genealogy (materialized for tree queries)
    parent_session_id: text('parent_session_id', { length: 36 }),
    forked_from_session_id: text('forked_from_session_id', { length: 36 }),

    // Branch reference (REQUIRED: all sessions must have a branch)
    branch_id: text('branch_id', { length: 36 })
      .notNull()
      .references(() => branches.branch_id, {
        onDelete: 'cascade', // Cascade delete sessions when branch is deleted
      }),

    // Scheduler tracking (materialized for deduplication and retention cleanup)
    scheduled_run_at: integer('scheduled_run_at'), // Unix timestamp (ms) - authoritative run ID
    scheduled_from_branch: t.bool('scheduled_from_branch').notNull().default(false),
    // FK to schedules.schedule_id, ON DELETE SET NULL. Defined here (not
    // just in the migration) so drizzle-kit / db introspection sees the
    // constraint and so future schema diffs don't lose it.
    schedule_id: text('schedule_id', { length: 36 }).references(
      (): import('drizzle-orm/sqlite-core').AnySQLiteColumn => schedules.schedule_id,
      { onDelete: 'set null' }
    ),
    // Internal scheduler recovery marker. Existing rows are backfilled by the
    // migration; new occurrences remain NULL until initialization, retention,
    // and schedule metadata are durable.
    scheduler_init_completed_at: t.timestamp('scheduler_init_completed_at'),
    // Durable diagnosis/retry state for an admitted occurrence that could not
    // finish initialization. A failure code with no retry timestamp is a
    // deliberate permanent terminal diagnosis; retryable failures carry the
    // next database-visible attempt time.
    scheduler_init_failure_code: text('scheduler_init_failure_code'),
    scheduler_init_failure_stage: text('scheduler_init_failure_stage'),
    scheduler_init_attempt_count: integer('scheduler_init_attempt_count').notNull().default(0),
    scheduler_init_retry_at: t.timestamp('scheduler_init_retry_at'),

    // UI state (materialized for efficient highlighting queries)
    ready_for_prompt: t.bool('ready_for_prompt').notNull().default(false),

    // Archive state (cascaded from branch archive)
    archived: t.bool('archived').notNull().default(false),
    archived_reason: text('archived_reason', {
      enum: ['branch_archived', 'manual', 'parent_archived', 'btw_completed'],
    }),

    // JSON blob for everything else (cross-DB via json() type)
    data: t
      .json<unknown>('data')
      .$type<{
        agentic_tool_version?: string;
        sdk_session_id?: string; // SDK session ID for conversation continuity (Claude Agent SDK, Codex SDK, etc.)
        mcp_token?: string; // MCP authentication token for Agor self-access
        title?: string; // Session title (user-provided or auto-generated)
        description?: string; // Legacy field, may contain first prompt

        // Genealogy details (children array, fork/spawn points)
        genealogy: {
          fork_point_task_id?: string;
          fork_point_message_index?: number;
          spawn_point_task_id?: string;
          spawn_point_message_index?: number;
          children: string[];
        };

        // Context
        contextFiles: string[];
        tasks: string[];

        // Note: message_count was removed — computed dynamically via COUNT(*) where needed

        // Permission config (session-level permission settings)
        permission_config?: {
          mode?: PermissionMode; // For Claude/Gemini (SDK handles tool-level permissions)
          codex?: {
            sandboxMode: CodexSandboxMode;
            approvalPolicy: CodexApprovalPolicy;
          };
        } | null;

        // Model config (session-level model selection)
        model_config?: Session['model_config'];

        // Callback config (child/remote session completion notifications)
        callback_config?: Session['callback_config'];

        // Fork origin tracking (set to 'btw' for ephemeral btw forks)
        fork_origin?: 'btw';

        // Context window tracking (cumulative usage from latest task)
        current_context_usage?: number; // Tokens currently in context
        context_window_limit?: number; // Model's max context (e.g., 200K)
        last_context_update_at?: string; // ISO 8601 timestamp

        // Custom context for Handlebars templates
        // Keep scheduler/gateway/user context owned by the canonical Session type.
        custom_context?: Session['custom_context'];

        // Read-only metadata retained for historical sessions created by the
        // removed experimental Claude CLI integration. No runtime consumes it.
        cli_state?: {
          watcher_offset?: number;
          last_event_ts?: string;
          last_event_uuid?: string;
          slug?: string;
          jsonl_path?: string;
          zellij_pane_id?: string;
          zellij_tab_name?: string;
          active_turn?: {
            task_id: string;
            user_message_index: number;
            started_at_ms: number;
          } | null;
        };

        // Read-only billing metadata retained with historical sessions.
        billing_mode?: 'subscription' | 'api-key' | 'unknown';
      }>()
      .notNull(),
  },
  (table) => ({
    statusIdx: index('sessions_status_idx').on(table.status),
    statusReadyIdx: index('sessions_status_ready_idx').on(table.status, table.ready_for_prompt),
    agenticToolIdx: index('sessions_agentic_tool_idx').on(table.agentic_tool),
    agenticToolPresetIdx: index('sessions_agentic_tool_preset_idx').on(
      table.agentic_tool_preset_id
    ),
    boardIdx: index('sessions_board_idx').on(table.board_id),
    branchIdx: index('sessions_branch_idx').on(table.branch_id),
    createdIdx: index('sessions_created_idx').on(table.created_at),
    archivedUpdatedIdx: index('sessions_archived_updated_idx').on(table.archived, table.updated_at),
    parentIdx: index('sessions_parent_idx').on(table.parent_session_id),
    forkedIdx: index('sessions_forked_idx').on(table.forked_from_session_id),
    // Scheduler indexes — including the partial unique index below.
    scheduledFromBranchIdx: index('sessions_scheduled_flag_idx').on(table.scheduled_from_branch),
    // Partial unique index — covering for the scheduler's dedup lookup
    // AND serves as the DB-level guard against check-then-create races
    // in spawnScheduledSession (cron tick vs manual run-now, or two
    // tick async paths). Partial because schedule_id is nullable: ad-hoc
    // sessions all have schedule_id NULL and must coexist.
    scheduleRunUnique: uniqueIndex('sessions_schedule_run_unique')
      .on(table.schedule_id, table.scheduled_run_at)
      // Both columns must be non-null: the logical dedup key is
      // (schedule_id, scheduled_run_at) and is only meaningful when
      // both are set. Non-scheduled sessions (schedule_id NULL) must
      // coexist freely.
      .where(sql`${table.schedule_id} IS NOT NULL AND ${table.scheduled_run_at} IS NOT NULL`),
    schedulerInitPendingIdx: index('sessions_scheduler_init_pending_idx')
      .on(table.created_at, table.session_id)
      .where(
        sql`${table.scheduled_from_branch} = true AND ${table.scheduled_run_at} IS NOT NULL AND ${table.scheduler_init_completed_at} IS NULL AND (${table.scheduler_init_failure_code} IS NULL OR ${table.scheduler_init_retry_at} IS NOT NULL)`
      ),
  })
);

/**
 * Session Relationships table
 *
 * Durable cross-session links that are not necessarily canonical genealogy.
 * Used for cross-branch remote-create provenance while keeping
 * sessions.genealogy.parent_session_id branch-local.
 */
export const sessionRelationships = sqliteTable(
  'session_relationships',
  {
    relationship_id: text('relationship_id', { length: 36 }).primaryKey(),
    source_session_id: text('source_session_id', { length: 36 })
      .notNull()
      .references(() => sessions.session_id, { onDelete: 'cascade' }),
    target_session_id: text('target_session_id', { length: 36 })
      .notNull()
      .references(() => sessions.session_id, { onDelete: 'cascade' }),
    relationship_type: text('relationship_type', { enum: ['remote_create'] }).notNull(),
    created_by: text('created_by', { length: 36 }).notNull(),
    created_at: t.timestamp('created_at').notNull(),
    updated_at: t.timestamp('updated_at'),
    callback_enabled: t.bool('callback_enabled').notNull().default(false),
    callback_session_id: text('callback_session_id', { length: 36 }).references(
      () => sessions.session_id,
      {
        onDelete: 'set null',
      }
    ),
    data: t.json<Record<string, unknown>>('data'),
  },
  (table) => ({
    sourceIdx: index('session_relationships_source_idx').on(table.source_session_id),
    targetIdx: index('session_relationships_target_idx').on(table.target_session_id),
    callbackIdx: index('session_relationships_callback_idx').on(table.callback_session_id),
    // Note: no tenant_source/tenant_target composite indexes here — SQLite schema
    // has no tenant column on this table (RLS is Postgres-only). The standalone
    // source/target indexes above are sufficient for SQLite.
    sourceTargetTypeUnique: uniqueIndex('session_relationships_source_target_type_unique').on(
      table.source_session_id,
      table.target_session_id,
      table.relationship_type
    ),
  })
);

/**
 * Tasks table - Granular work units within sessions
 */
export const tasks = sqliteTable(
  'tasks',
  {
    task_id: text('task_id', { length: 36 }).primaryKey(),
    session_id: text('session_id', { length: 36 })
      .notNull()
      .references(() => sessions.session_id, { onDelete: 'cascade' }),
    created_at: t.timestamp('created_at').notNull(),
    started_at: t.timestamp('started_at'),
    executor_connected_at: t.timestamp('executor_connected_at'),
    completed_at: t.timestamp('completed_at'),
    last_executor_heartbeat_at: t.timestamp('last_executor_heartbeat_at'),
    dispatch_timeout_observed_at: t.timestamp('dispatch_timeout_observed_at'),
    termination_coordination_token: text('termination_coordination_token'),
    termination_coordination_claimed_at: t.timestamp('termination_coordination_claimed_at'),
    termination_coordination_expires_at: t.timestamp('termination_coordination_expires_at'),
    termination_coordination_instance_id: text('termination_coordination_instance_id'),
    termination_coordination_boot_id: text('termination_coordination_boot_id'),
    termination_unverified_at: t.timestamp('termination_unverified_at'),
    status: text('status', {
      enum: [
        'queued',
        'created',
        'dispatching',
        'running',
        'stopping',
        'awaiting_permission',
        'awaiting_input',
        'timed_out',
        'completed',
        'failed',
        'stopped',
      ],
    }).notNull(),

    // Queue position (lower drains first); only populated for status='queued'
    queue_position: integer('queue_position'),

    // User attribution
    created_by: text('created_by', { length: 36 }).notNull(),

    data: t
      .json<unknown>('data')
      .$type<{
        full_prompt: string;

        message_range: Task['message_range'];
        git_state: Task['git_state'];

        /** Filled by the executor after the turn. */
        model?: string;
        tool_use_count: number;

        duration_ms?: number;
        agent_session_id?: string;

        // Populated when a task transitions to `failed` so the cause is
        // preserved instead of the session silently sitting idle.
        error_message?: string;

        // Raw SDK response - single source of truth for token accounting
        raw_sdk_response?: Task['raw_sdk_response'];

        // Normalized SDK response - computed from raw_sdk_response by executor
        // Stored so UI doesn't need SDK-specific normalization logic
        normalized_sdk_response?: Task['normalized_sdk_response'];

        // Computed context window (cumulative tokens)
        computed_context_window?: Task['computed_context_window'];

        report?: Task['report'];
        permission_request?: Task['permission_request'];

        // Generic metadata (e.g., is_agor_callback, source, child_session_id)
        metadata?: Task['metadata'];
        executor_mode?: Task['executor_mode'];
        latest_executor_pulse?: Task['latest_executor_pulse'];
        sdk_failure?: Task['sdk_failure'];
        termination_request?: Task['termination_request'];
        sdk_watchdog_mode?: Task['sdk_watchdog_mode'];
        /**
         * Immutable filesystem authority projected when this executor was
         * launched. Internal repository fact; deliberately omitted from the
         * public Task DTO and never accepted from executor writes.
         */
        executor_launch_fs_access_floor?: import('@agor/core/types').CapabilityPolicyFsAccess;
      }>()
      .notNull(),
  },
  (table) => ({
    sessionIdx: index('tasks_session_idx').on(table.session_id),
    sessionTaskIdIdx: index('tasks_session_task_id_idx').on(table.session_id, table.task_id),
    statusIdx: index('tasks_status_idx').on(table.status),
    createdIdx: index('tasks_created_idx').on(table.created_at),
    queueIdx: index('tasks_queue_idx').on(table.session_id, table.status, table.queue_position),
    runtimeDispatchIdx: index('tasks_runtime_dispatch_idx')
      .on(table.started_at, table.task_id)
      .where(
        sql`${table.status} = 'dispatching' AND ${table.executor_connected_at} IS NULL AND ${table.started_at} IS NOT NULL AND ${table.dispatch_timeout_observed_at} IS NULL`
      ),
    runtimeHeartbeatIdx: index('tasks_runtime_heartbeat_idx')
      .on(table.last_executor_heartbeat_at, table.task_id)
      .where(
        sql`${table.status} IN ('running', 'awaiting_permission', 'awaiting_input') AND ${table.last_executor_heartbeat_at} IS NOT NULL`
      ),
    runtimeTerminationIdx: index('tasks_runtime_termination_idx')
      .on(table.termination_coordination_expires_at, table.task_id)
      .where(sql`${table.status} = 'stopping' AND ${table.termination_unverified_at} IS NULL`),
    // Partial unique index — defense-in-depth for `tasks.createPending` race
    // serialization. Only QUEUED rows are constrained; CREATED/RUNNING/done
    // rows have NULL queue_position and are unaffected.
    queuedPositionUnique: uniqueIndex('tasks_queued_position_unique')
      .on(table.session_id, table.queue_position)
      .where(sql`${table.status} = 'queued'`),
    // Standalone recovery uses the same bounded Session scan without tenant
    // routing metadata.
    queueScanIdx: index('tasks_queue_scan_idx')
      .on(table.session_id, table.created_at)
      .where(sql`${table.status} = 'queued'`),
  })
);

/**
 * Schema mirror for PostgreSQL executor-session token authority.
 *
 * Standalone SQLite intentionally continues to use SessionTokenService's
 * process-local token Map; this table exists only to keep the dual schemas and
 * migration history compatible if a database changes dialect later.
 */
export const executorSessionTokenAuthorities = sqliteTable(
  'executor_session_token_authorities',
  {
    token_fingerprint: text('token_fingerprint', { length: 64 }).primaryKey(),
    token_type: text('token_type').notNull(),
    purpose: text('purpose').notNull(),
    session_id: text('session_id').notNull(),
    task_id: text('task_id'),
    branch_id: text('branch_id'),
    user_id: text('user_id').notNull(),
    created_at: t.timestamp('created_at').notNull(),
    expires_at: t.timestamp('expires_at').notNull(),
    max_uses: integer('max_uses').notNull(),
    use_count: integer('use_count').notNull().default(0),
    last_used_at: t.timestamp('last_used_at'),
    revoked_at: t.timestamp('revoked_at'),
  },
  (table) => ({
    sessionIdx: index('executor_session_token_authorities_session_idx').on(table.session_id),
    expiresIdx: index('executor_session_token_authorities_expires_idx').on(table.expires_at),
    revokedIdx: index('executor_session_token_authorities_revoked_idx')
      .on(table.revoked_at)
      .where(sql`${table.revoked_at} IS NOT NULL`),
  })
);

/**
 * Schema mirror for PostgreSQL GitHub installation setup state.
 *
 * Standalone SQLite intentionally keeps the short-lived hash authority in the
 * daemon process. This unused table preserves dual-dialect migration history
 * without changing standalone behavior.
 */
export const githubInstallStates = sqliteTable(
  'github_install_states',
  {
    state_hash: text('state_hash', { length: 64 }).primaryKey(),
    user_id: text('user_id', { length: 36 }).notNull(),
    intent: text('intent').notNull(),
    created_at: t.timestamp('created_at').notNull(),
    expires_at: t.timestamp('expires_at').notNull(),
  },
  (table) => ({
    expiresIdx: index('github_install_states_expires_idx').on(table.expires_at),
  })
);

/**
 * Messages table - Conversation messages within sessions
 *
 * Stores individual messages (user, assistant, system) for full conversation replay.
 * Messages are indexed by session_id, task_id, and position (index) for efficient queries.
 */
export const messages = sqliteTable(
  'messages',
  {
    // Primary identity
    message_id: text('message_id', { length: 36 }).primaryKey(),
    created_at: t.timestamp('created_at').notNull(),

    // Foreign keys (materialized for indexes)
    session_id: text('session_id', { length: 36 })
      .notNull()
      .references(() => sessions.session_id, { onDelete: 'cascade' }),
    task_id: text('task_id', { length: 36 }).references(() => tasks.task_id, {
      onDelete: 'set null',
    }),

    // Materialized for queries
    type: text('type', {
      enum: [
        'user',
        'assistant',
        'system',
        'file-history-snapshot',
        'permission_request',
        'input_request',
        'daemon_restart',
        'daemon_crash',
        'widget_request',
      ],
    }).notNull(),
    role: text('role', {
      enum: ['user', 'assistant', 'system'],
    }).notNull(),
    index: integer('index').notNull(), // Position in conversation (0-based)
    timestamp: t.timestamp('timestamp').notNull(),
    content_preview: text('content_preview'), // First 200 chars for list views

    // Parent tool use ID (for nested tool calls - e.g., Task tool spawning Read/Grep)
    parent_tool_use_id: text('parent_tool_use_id'),

    // NOTE: queueing moved off `messages` and onto `tasks.status='queued'` as
    // of migration sqlite/0040 (postgres/0030). The legacy `status` and
    // `queue_position` columns are gone — see `tasks.queue_position` instead.

    // Full data (JSON blob)
    data: t
      .json<unknown>('data')
      .$type<{
        content: Message['content'];
        tool_uses?: Message['tool_uses'];
        metadata?: Message['metadata'];
      }>()
      .notNull(),
  },
  (table) => ({
    // Indexes for efficient lookups
    sessionIdx: index('messages_session_id_idx').on(table.session_id),
    taskIdx: index('messages_task_id_idx').on(table.task_id),
    sessionMessageIdIdx: index('messages_session_message_id_idx').on(
      table.session_id,
      table.message_id
    ),
    taskMessageIdIdx: index('messages_task_message_id_idx').on(table.task_id, table.message_id),
    sessionIndexIdx: index('messages_session_index_idx').on(table.session_id, table.index),
    timestampIdx: index('messages_timestamp_idx').on(table.timestamp),
    sessionTimestampIdx: index('messages_session_timestamp_idx').on(
      table.session_id,
      table.timestamp
    ),
  })
);

/**
 * Boards table - Organizational primitive for grouping sessions
 */
export const boards = sqliteTable(
  'boards',
  {
    board_id: text('board_id', { length: 36 }).primaryKey(),
    created_at: t.timestamp('created_at').notNull(),
    updated_at: t.timestamp('updated_at'),

    // User attribution
    created_by: text('created_by', { length: 36 }).notNull(),
    // User deletion guards are a separate lifecycle flow; this immutable
    // logical owner pointer intentionally does not cascade or transfer.
    primary_owner_user_id: text('primary_owner_user_id', { length: 36 }).notNull(),

    // Materialized for lookups
    name: text('name').notNull(),
    slug: text('slug').unique(),
    primary_teammate_id: text('primary_teammate_id', { length: 36 }).references(
      (): AnySQLiteColumn => branches.branch_id,
      {
        onDelete: 'set null',
      }
    ),
    // Deprecated SQLite compatibility column. Kept so upgraded local DBs can
    // retain the legacy value without a destructive table rebuild; all new
    // writes use primary_teammate_id.
    primary_assistant_id: text('primary_assistant_id', { length: 36 }).references(
      (): AnySQLiteColumn => branches.branch_id,
      {
        onDelete: 'set null',
      }
    ),

    // JSON blob for the rest
    data: t
      .json<unknown>('data')
      .$type<{
        description?: string;
        access_mode?: 'private' | 'shared';
        default_others_can?: import('@agor/core/types').BranchPermissionLevel;
        default_others_fs_access?: 'none' | 'read' | 'write';
        color?: string;
        icon?: string;
        background_color?: string; // Background color for the board canvas
        custom_css?: string; // Custom CSS for animations, keyframes, etc. (rendered in scoped <style> tag)
        objects?: Record<string, import('@agor/core/types').BoardObject>; // Board objects (text, zone)
        custom_context?: Record<string, unknown>; // Custom context for Handlebars templates
      }>()
      .notNull(),

    // Archive state (for soft deletes)
    archived: t.bool('archived').notNull().default(false),
    archived_at: t.timestamp('archived_at'),
    archived_by: text('archived_by', { length: 36 }),
  },
  (table) => ({
    nameIdx: index('boards_name_idx').on(table.name),
    slugIdx: index('boards_slug_idx').on(table.slug),
  })
);

/**
 * Repos table - Git repositories managed by Agor
 *
 * All repos are cloned to ~/.agor/repos/{slug}
 */
export const repos = sqliteTable(
  'repos',
  {
    repo_id: text('repo_id', { length: 36 }).primaryKey(),
    created_at: t.timestamp('created_at').notNull(),
    updated_at: t.timestamp('updated_at'),

    // Materialized for querying
    slug: text('slug').notNull().unique(),
    repo_type: text('repo_type', { enum: ['remote', 'local'] })
      .notNull()
      .default('remote'),

    // Retired nullable compatibility stamp retained for rollback/audit only.
    unix_group: text('unix_group'), // retired nullable compatibility stamp; runtime ignores it

    data: t
      .json<unknown>('data')
      .$type<{
        name: string;
        remote_url?: string;
        local_path: string; // Absolute path to base repository
        default_branch?: string;
        // Async clone lifecycle: 'cloning' → 'ready' | 'failed'. Undefined for
        // legacy rows and for local-type repos. See packages/core/src/types/repo.ts.
        clone_status?: 'cloning' | 'ready' | 'failed';
        clone_error?: {
          exit_code: number;
          category: 'auth_failed' | 'not_found' | 'network' | 'git_unavailable' | 'unknown';
          message: string;
        };
        // v2 environment config — source of truth. Named variants + optional
        // deployment-local template_overrides. See RepoEnvironment in
        // packages/core/src/types/branch.ts.
        environment?: {
          version: 2;
          default: string;
          variants: Record<
            string,
            {
              description?: string;
              extends?: string;
              // start/stop are optional on the raw variant (may be inherited
              // via `extends`); the parser validates that the resolved
              // variant has both.
              start?: string;
              stop?: string;
              nuke?: string;
              logs?: string;
              health?: string;
              app?: string;
            }
          >;
          template_overrides?: Record<string, unknown>;
        };
        // Legacy v1 view kept in sync for UI back-compat.
        // Derived from environment.variants[default] on write.
        environment_config?: {
          up_command: string;
          down_command: string;
          nuke_command?: string;
          health_check?: {
            type: 'http' | 'tcp' | 'process';
            url_template?: string;
          };
          app_url_template?: string;
          logs_command?: string;
        };
      }>()
      .notNull(),
  },
  (table) => ({
    slugIdx: index('repos_slug_idx').on(table.slug),
  })
);

/**
 * Branches table - Git branches for isolated development contexts
 *
 * First-class entities for managing work contexts across sessions.
 * Each branch is an isolated git working directory with its own branch,
 * environment configuration, and persistent work state.
 */
export const branches = sqliteTable(
  'branches',
  {
    // Primary identity
    branch_id: text('branch_id', { length: 36 }).primaryKey(),
    repo_id: text('repo_id', { length: 36 })
      .notNull()
      .references(() => repos.repo_id, { onDelete: 'cascade' }),
    created_at: t.timestamp('created_at').notNull(),
    updated_at: t.timestamp('updated_at'),

    // User attribution
    created_by: text('created_by', { length: 36 }).notNull(),
    primary_owner_user_id: text('primary_owner_user_id', { length: 36 }).notNull(),

    // Materialized for queries
    name: text('name').notNull(), // "feat-auth", "main"
    ref: text('ref').notNull(), // Current branch/tag/commit
    ref_type: text('ref_type', { enum: ['branch', 'tag'] }), // Type of ref (branch or tag)
    branch_unique_id: integer('branch_unique_id').notNull(), // Auto-assigned sequential ID for templates

    // Environment configuration (static, initialized from templates, then user-editable)
    start_command: text('start_command'), // Start command (initialized from repo's up_command template)
    stop_command: text('stop_command'), // Stop command (initialized from repo's down_command template)
    nuke_command: text('nuke_command'), // Nuke command (initialized from repo's nuke_command template)
    health_check_url: text('health_check_url'), // Health check URL (initialized from repo's health_check.url_template)
    app_url: text('app_url'), // Application URL (initialized from repo's app_url_template)
    logs_command: text('logs_command'), // Logs command (initialized from repo's logs_command template)
    // Name of the environment variant currently rendered into the command fields above.
    // References a key under repo.environment.variants. Null for pre-v2 branches.
    environment_variant: text('environment_variant'),

    // Durable health-observation coordination. Standalone does not use these
    // fields, but the mirror keeps branch persistence dialect-consistent.
    environment_generation: integer('environment_generation').notNull().default(0),
    environment_health_claim_token: text('environment_health_claim_token'),
    environment_health_claimed_at: t.timestamp('environment_health_claimed_at'),
    environment_health_claim_expires_at: t.timestamp('environment_health_claim_expires_at'),
    environment_health_next_observation_at: t.timestamp('environment_health_next_observation_at'),
    environment_health_claim_instance_id: text('environment_health_claim_instance_id'),
    environment_health_claim_boot_id: text('environment_health_claim_boot_id'),
    environment_health_claim_generation: integer('environment_health_claim_generation')
      .notNull()
      .default(0),

    // Board relationship (nullable - branches can exist without boards)
    board_id: text('board_id', { length: 36 }).references((): AnySQLiteColumn => boards.board_id, {
      onDelete: 'set null', // If board is deleted, branch remains but loses board association
    }),

    // UI state (materialized for efficient highlighting queries)
    needs_attention: t.bool('needs_attention').notNull().default(true), // Default true for new branches

    // Archive state (for soft deletes)
    archived: t.bool('archived').notNull().default(false),
    archived_at: t.timestamp('archived_at'),
    archived_by: text('archived_by', { length: 36 }),
    filesystem_status: text('filesystem_status', {
      enum: ['creating', 'ready', 'failed', 'preserved', 'cleaned', 'deleted'],
    }),

    // RBAC: App-layer permissions (rbac.md)
    permission_binding: text('permission_binding', { enum: ['inherit', 'override'] })
      .$type<'inherit' | 'override'>()
      .notNull()
      .default('override'),
    permission_source: text('permission_source', { enum: ['board', 'override'] })
      .$type<'board' | 'override'>()
      .notNull()
      .default('override'),
    others_can: text('others_can', {
      enum: [...BRANCH_PERMISSION_LEVELS],
    }).default('view'),

    // RBAC: OS-layer permissions (unix-user-modes.md)
    unix_group: text('unix_group'), // retired nullable compatibility stamp; runtime ignores it
    others_fs_access: text('others_fs_access', {
      enum: ['none', 'read', 'write'],
    })
      .$type<'none' | 'read' | 'write'>()
      .default('read'),

    // Branch storage model — see context/explorations/clone-redesign.md.
    // 'worktree' = native `git worktree add` (shared base .git/config — legacy default).
    // 'clone'    = self-standing `git clone` (own .git/ — closes cross-branch leak vectors).
    //
    // Enum is validated at the Drizzle/TS/Zod/service layer (no DB-side
    // CHECK) per context/guides/creating-database-migrations.md so adding a
    // value later doesn't force a table-recreation migration on SQLite.
    storage_mode: text('storage_mode', { enum: ['worktree', 'clone'] })
      .notNull()
      .default('worktree'),
    // Only meaningful when storage_mode='clone'. NULL = full clone, positive
    // integer = `git clone --depth N` (shallow). The service layer rejects
    // a non-null clone_depth on worktree-mode rows.
    clone_depth: integer('clone_depth'),

    // Per-branch SDK home intent (design §9.2). NULL = inherit today's behavior
    // (no branch SDK home). 'per_branch' = this branch has its own relocated SDK
    // home under `branch-homes/<branchId>`. Stored as an intent enum, NOT a path
    // — the path is derived from branch_id by a single resolver (getBranchHomePath)
    // so it cannot drift or be injected. Sticky once set: the value here — not
    // the live `execution.sandbox.sdk_home_mode` flag — governs whether an
    // existing branch keeps its home (design §8B.3). No CHECK constraint (SQLite
    // enum extension would force a table rebuild); validated at the app layer.
    sdk_home: text('sdk_home', { enum: ['per_branch'] }).$type<'per_branch'>(),

    // JSON blob for everything else
    data: t
      .json<unknown>('data')
      .$type<{
        // File system
        path: string; // Absolute path to branch directory

        // Git state (current)
        base_ref?: string; // Branch this diverged from (e.g., "main")
        base_remote_url?: string; // Optional remote that owns base_ref
        base_sha?: string; // SHA at branch creation
        last_commit_sha?: string; // Latest commit
        tracking_branch?: string; // Remote tracking branch
        new_branch: boolean; // Created by Agor?

        // Work context (persistent across sessions)
        issue_url?: string; // GitHub/GitLab issue
        pull_request_url?: string; // PR link
        notes?: string; // Freeform user notes
        error_message?: string; // Error details when filesystem_status is 'failed'

        // Snapshotted environment startup policy.
        startup_timeout_ms?: number;

        // Snapshotted stop/nuke/sync command budget.
        lifecycle_timeout_ms?: number;

        // Environment instance (runtime state only, no variables)
        environment_instance?: {
          status: 'stopped' | 'starting' | 'running' | 'stopping' | 'error';
          process?: {
            pid?: number;
            started_at?: string;
            uptime?: string;
          };
          startup_deadline_at?: string;
          last_health_check?: {
            timestamp: string;
            status: 'healthy' | 'unhealthy' | 'unknown';
            message?: string;
            consecutive?: number;
          };
          access_urls?: Array<{
            name: string;
            url: string;
          }>;
          source_sync?: BranchEnvironmentInstance['source_sync'];
          logs?: string[];
        };

        last_used: string; // ISO timestamp

        // Custom context for templates (accessible as {{custom.*}})
        custom_context?: Record<string, unknown>;

        // Default MCP servers for new sessions in this branch
        mcp_server_ids?: string[];

        // DANGEROUS: opt-in to legacy session-spawn identity borrowing.
      }>()
      .notNull(),
  },
  (table) => ({
    repoIdx: index('branches_repo_idx').on(table.repo_id),
    nameIdx: index('branches_name_idx').on(table.name),
    refIdx: index('branches_ref_idx').on(table.ref),
    boardIdx: index('branches_board_idx').on(table.board_id),
    createdIdx: index('branches_created_idx').on(table.created_at),
    updatedIdx: index('branches_updated_idx').on(table.updated_at),
    environmentHealthLeaseIdx: index('branches_environment_health_lease_idx').on(
      table.archived,
      table.environment_health_claim_expires_at,
      table.branch_id
    ),
    // Composite unique constraint (repo + name)
    uniqueRepoName: index('branches_repo_name_unique').on(table.repo_id, table.name),
    permissionBindingCheck: check(
      'branches_permission_binding_check',
      sql`${table.permission_binding} IN ('inherit','override')`
    ),
  })
);

/**
 * Branch Owners - RBAC junction table
 *
 * Many-to-many relationship between users and branches.
 * Owners have implicit 'all' permission regardless of others_can setting.
 */
export const branchOwners = sqliteTable(
  'branch_owners',
  {
    branch_id: text('branch_id', { length: 36 })
      .notNull()
      .references(() => branches.branch_id, { onDelete: 'cascade' }),
    user_id: text('user_id', { length: 36 })
      .notNull()
      .references(() => users.user_id, { onDelete: 'cascade' }),
    created_at: t.timestamp('created_at'),
  },
  (table) => ({
    // Composite primary key matching migration 0016
    pk: primaryKey({ columns: [table.branch_id, table.user_id] }),
  })
);

/**
 * Board Owners - RBAC junction table.
 *
 * Board owners can manage board-level defaults and are treated as inherited
 * branch owners for board-aligned branches.
 */
export const boardOwners = sqliteTable(
  'board_owners',
  {
    board_id: text('board_id', { length: 36 })
      .notNull()
      .references(() => boards.board_id, { onDelete: 'cascade' }),
    user_id: text('user_id', { length: 36 })
      .notNull()
      .references(() => users.user_id, { onDelete: 'cascade' }),
    created_at: t.timestamp('created_at'),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.board_id, table.user_id] }),
    userIdx: index('board_owners_user_idx').on(table.user_id),
  })
);

/**
 * Schedules table - First-class scheduled prompts per branch.
 *
 * Multiple schedules per branch (e.g. hourly heartbeat + daily summary).
 * Replaces the four `branches.schedule_*` columns and `branches.data.schedule`
 * blob; sessions backlink via `sessions.schedule_id`.
 *
 * Enums (`timezone_mode`) are validated at the app layer (no DB CHECK
 * constraint) per context/guides/creating-database-migrations.md.
 */
export const schedules = sqliteTable(
  'schedules',
  {
    schedule_id: text('schedule_id', { length: 36 }).primaryKey(),
    branch_id: text('branch_id', { length: 36 })
      .notNull()
      .references(() => branches.branch_id, { onDelete: 'cascade' }),

    name: text('name').notNull(),
    description: text('description'),
    cron_expression: text('cron_expression').notNull(),
    timezone_mode: text('timezone_mode', { enum: ['local', 'utc'] })
      .notNull()
      .default('local'),
    timezone: text('timezone'), // IANA, required when timezone_mode='local'

    prompt: text('prompt').notNull(), // Handlebars template

    // jsonb on PG; mirrors BranchScheduleConfig minus promoted fields.
    agentic_tool_config: t.json<unknown>('agentic_tool_config').notNull(),
    agentic_tool_preset_id: text('agentic_tool_preset_id', { length: 36 }).references(
      (): AnySQLiteColumn => agenticToolPresets.preset_id,
      { onDelete: 'restrict' }
    ),
    mcp_server_ids: t.json<string[]>('mcp_server_ids'),

    enabled: t.bool('enabled').notNull().default(true),
    allow_concurrent_runs: t.bool('allow_concurrent_runs').notNull().default(false),
    retention: integer('retention').notNull().default(5), // 0 = keep all

    last_run_at: integer('last_run_at'), // Unix timestamp (ms)
    last_run_session_id: text('last_run_session_id', { length: 36 }).references(
      () => sessions.session_id,
      { onDelete: 'set null' }
    ),
    next_run_at: integer('next_run_at'), // Unix timestamp (ms), denormalized for scheduler

    created_at: t.timestamp('created_at').notNull(),
    updated_at: t.timestamp('updated_at').notNull(),
    created_by: text('created_by', { length: 36 })
      .notNull()
      .references(() => users.user_id),
  },
  (table) => ({
    // Scheduler hot path: WHERE enabled = true AND next_run_at <= ?
    enabledNextRunIdx: index('schedules_enabled_next_run_idx').on(table.enabled, table.next_run_at),
    agenticToolPresetIdx: index('schedules_agentic_tool_preset_idx').on(
      table.agentic_tool_preset_id
    ),
    branchIdx: index('schedules_branch_idx').on(table.branch_id),
    createdByIdx: index('schedules_created_by_idx').on(table.created_by),
  })
);

/**
 * Users table - Authentication and authorization.
 *
 * Always present. Authentication is required for every endpoint; on first
 * daemon start with an empty users table, a default admin is auto-created
 * (see `bootstrapFirstRunAdmin`).
 */
export const users = sqliteTable(
  'users',
  {
    // Primary identity
    user_id: text('user_id', { length: 36 }).primaryKey(),
    created_at: t.timestamp('created_at').notNull(),
    updated_at: t.timestamp('updated_at'),

    // Materialized for auth lookups
    email: text('email').unique().notNull(),
    password: text('password').notNull(), // bcrypt hashed

    // Basic profile (materialized for display)
    name: text('name'),
    emoji: text('emoji'),
    role: text('role', {
      enum: ['superadmin', 'admin', 'member', 'viewer'], // 'owner' is deprecated alias for 'superadmin'
    })
      .notNull()
      .default('member'),

    // Opaque execution-home key (optional, database-enforced uniqueness)
    unix_username: text('unix_username'),

    // Absolute host home dir used as the per-user sandbox overlay SOURCE under
    // unix_user_mode: sandbox (home_mode: per_user). Null → canonical store
    // <data_home>/tenants/<tenant>/homes/<user_id>. See types/user.ts.
    filesystem_home: text('filesystem_home'),

    // Onboarding state
    onboarding_completed: t.bool('onboarding_completed').notNull().default(false),

    // Force password change flag (admin-settable, auto-cleared on password change)
    must_change_password: t.bool('must_change_password').notNull().default(false),

    // Monotonic local-credential generation copied into interactive JWTs.
    credential_generation: integer('credential_generation').notNull().default(0),

    // Auth invalidation marker. Password changes set this timestamp so any
    // previously issued browser access or refresh token is rejected.
    tokens_valid_after: t.timestamp('tokens_valid_after'),

    // JSON blob for profile/preferences
    data: t
      .json<unknown>('data')
      .$type<{
        avatar?: string;
        avatar_url?: string;
        avatar_source?: string;
        avatar_source_id?: string;
        avatar_synced_at?: string;
        preferences?: Record<string, unknown>;
        // Stable external-auth identity mappings used by generic launch-code auth.
        external_identities?: UserExternalIdentity[];
        // Per-tool credentials and auth-adjacent config.
        //
        // Each entry is keyed by AgenticToolName and holds env-var-named fields
        // (e.g. `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`). All values are
        // encrypted at rest (AES-256-GCM, hex-encoded) for shape uniformity —
        // the runtime decrypts on read; the UI controls plain-vs-password
        // rendering based on per-field config.
        //
        // Field name = env var name. The session executor exports these as
        // env vars to the SDK CLI, scoped to the session's agentic_tool
        // (i.e. claude-code's keys never reach codex sessions).
        //
        // See `context/concepts/agentic-tool-config.md` (TODO).
        agentic_tools?: {
          'claude-code'?: {
            ANTHROPIC_API_KEY?: string;
            CLAUDE_CODE_OAUTH_TOKEN?: string;
            ANTHROPIC_AUTH_TOKEN?: string;
            ANTHROPIC_BASE_URL?: string;
          };
          codex?: {
            OPENAI_API_KEY?: string;
            OPENAI_BASE_URL?: string;
          };
          gemini?: {
            GEMINI_API_KEY?: string;
          };
          copilot?: {
            COPILOT_GITHUB_TOKEN?: string;
          };
          opencode?: Record<string, never>;
        };
        agentic_auth_methods?: import('../types/user').AgenticAuthMethods;
        agentic_credential_sources?: import('../types/user').AgenticCredentialSources;
        // Encrypted environment variables with scope metadata.
        //
        // Two stored value shapes are tolerated on read:
        //   - Legacy: `"GITHUB_TOKEN": "enc:..."` (plain encrypted string → scope='global')
        //   - v0.5+:  `"GITHUB_TOKEN": { value_encrypted: "enc:...", scope: 'global'|'session', ... }`
        //
        // Writes always produce the object form. Keep scope validation in the app
        // layer (no SQL CHECK constraint) so adding future scope values ('repo',
        // 'mcp_server', ...) doesn't require a SQLite table rebuild.
        //
        // See `context/explorations/env-var-access.md`.
        env_vars?: Record<
          string,
          | string // legacy
          | {
              value_encrypted: string;
              scope: string; // validated in app layer: 'global' | 'session' (+ reserved values)
              resource_id?: string | null;
              extra_config?: Record<string, unknown> | null;
            }
        >;
        // Default agentic tool configuration (prepopulates session creation forms)
        default_agentic_config?: {
          'claude-code'?: {
            modelConfig?: {
              mode?: 'alias' | 'exact';
              model?: string;
              effort?: EffortLevel;
              advisorModel?: string;
            };
            permissionMode?: string;
          };
          codex?: {
            modelConfig?: {
              mode?: 'alias' | 'exact';
              model?: string;
              effort?: EffortLevel;
            };
            permissionMode?: string;
            codexSandboxMode?: string;
            codexApprovalPolicy?: string;
            codexNetworkAccess?: boolean;
          };
          gemini?: {
            modelConfig?: {
              mode?: 'alias' | 'exact';
              model?: string;
              effort?: EffortLevel;
            };
            permissionMode?: string;
          };
          opencode?: {
            modelConfig?: {
              mode?: 'alias' | 'exact';
              model?: string;
            };
            permissionMode?: string;
            serverUrl?: string;
          };
          copilot?: {
            modelConfig?: {
              mode?: 'alias' | 'exact';
              model?: string;
              effort?: EffortLevel;
            };
            permissionMode?: string;
          };
        };
        primary_agentic_tool?: import('../types/agentic-tool').AgenticToolName;
        primary_teammate_id?: import('../types/id').BranchID;
        default_mcp_server_ids?: string[];
        default_agentic_selection?: import('../types/user').UserAgenticDefaultSelections;
      }>()
      .notNull(),
  },
  (table) => ({
    emailIdx: index('users_email_idx').on(table.email),
    executionHomeUnique: uniqueIndex('users_unix_username_unique').on(table.unix_username),
  })
);

/**
 * Database-enforced binding between one trusted external subject and its local
 * user projection. SQLite is single-tenant, so identity_key is globally unique.
 */
export const userExternalIdentities = sqliteTable(
  'user_external_identities',
  {
    identity_key: text('identity_key', { length: 64 }).primaryKey(),
    user_id: text('user_id', { length: 36 })
      .notNull()
      .references(() => users.user_id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    issuer: text('issuer').notNull(),
    subject: text('subject').notNull(),
    email: text('email'),
    name: text('name'),
    last_login_at: t.timestamp('last_login_at').notNull(),
    created_at: t.timestamp('created_at').notNull(),
    updated_at: t.timestamp('updated_at').notNull(),
  },
  (table) => ({
    providerSubjectUnique: uniqueIndex('user_external_identities_provider_subject_unique').on(
      table.provider,
      table.issuer,
      table.subject
    ),
    userIdx: index('user_external_identities_user_idx').on(table.user_id),
  })
);

/**
 * Groups - admin-managed user collections for sharing and branch RBAC.
 */
export const groups = sqliteTable(
  'groups',
  {
    group_id: text('group_id', { length: 36 }).primaryKey(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    description: text('description'),
    archived: t.bool('archived').notNull().default(false),
    created_by: text('created_by', { length: 36 }).references(() => users.user_id, {
      onDelete: 'set null',
    }),
    created_at: t.timestamp('created_at').notNull(),
    updated_at: t.timestamp('updated_at'),
  },
  (table) => ({
    slugIdx: uniqueIndex('groups_slug_idx').on(table.slug),
    archivedIdx: index('groups_archived_idx').on(table.archived),
  })
);

/**
 * Group Memberships - many-to-many users ↔ groups.
 */
export const groupMemberships = sqliteTable(
  'group_memberships',
  {
    group_id: text('group_id', { length: 36 })
      .notNull()
      .references(() => groups.group_id, { onDelete: 'cascade' }),
    user_id: text('user_id', { length: 36 })
      .notNull()
      .references(() => users.user_id, { onDelete: 'cascade' }),
    added_by: text('added_by', { length: 36 }).references(() => users.user_id, {
      onDelete: 'set null',
    }),
    created_at: t.timestamp('created_at').notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.group_id, table.user_id] }),
    userIdx: index('group_memberships_user_idx').on(table.user_id),
  })
);

/** Board visibility/management policy. Branch defaults are stored separately. */
export const boardAccessPolicies = sqliteTable(
  'board_access_policies',
  {
    board_id: text('board_id', { length: 36 })
      .primaryKey()
      .references(() => boards.board_id, { onDelete: 'cascade' }),
    schema_version: integer('schema_version').notNull().default(1),
    sharing_mode: text('sharing_mode', { enum: ['private', 'shared'] }).notNull(),
    others_role: text('others_role', { enum: ['none', 'viewer', 'editor', 'manager'] })
      .notNull()
      .default('none'),
    revision: integer('revision').notNull().default(1),
    updated_by: text('updated_by', { length: 36 }).references(() => users.user_id, {
      onDelete: 'set null',
    }),
    created_at: t.timestamp('created_at').notNull(),
    updated_at: t.timestamp('updated_at').notNull(),
  },
  (table) => ({
    updatedIdx: index('board_access_policies_updated_idx').on(table.updated_at),
    sharingModeCheck: check(
      'board_access_policies_sharing_mode_check',
      sql`${table.sharing_mode} IN ('private','shared')`
    ),
    othersRoleCheck: check(
      'board_access_policies_others_role_check',
      sql`${table.others_role} IN ('none','viewer','editor','manager')`
    ),
  })
);

/** One normalized user or group entry in a board policy. */
export const boardAccessEntries = sqliteTable(
  'board_access_entries',
  {
    entry_id: text('entry_id', { length: 36 }).primaryKey(),
    board_id: text('board_id', { length: 36 })
      .notNull()
      .references(() => boardAccessPolicies.board_id, { onDelete: 'cascade' }),
    user_id: text('user_id', { length: 36 }).references(() => users.user_id, {
      onDelete: 'cascade',
    }),
    group_id: text('group_id', { length: 36 }).references(() => groups.group_id, {
      onDelete: 'cascade',
    }),
    role: text('role', { enum: ['none', 'viewer', 'editor', 'manager'] }).notNull(),
    created_at: t.timestamp('created_at').notNull(),
    updated_at: t.timestamp('updated_at').notNull(),
  },
  (table) => ({
    boardIdx: index('board_access_entries_board_idx').on(table.board_id),
    userIdx: index('board_access_entries_user_idx').on(table.user_id, table.board_id),
    groupIdx: index('board_access_entries_group_idx').on(table.group_id, table.board_id),
    boardUserUnique: uniqueIndex('board_access_entries_board_user_unique').on(
      table.board_id,
      table.user_id
    ),
    boardGroupUnique: uniqueIndex('board_access_entries_board_group_unique').on(
      table.board_id,
      table.group_id
    ),
    roleCheck: check(
      'board_access_entries_role_check',
      sql`${table.role} IN ('none','viewer','editor','manager')`
    ),
    principalCheck: check(
      'board_access_entries_principal_check',
      sql`(${table.user_id} IS NOT NULL) <> (${table.group_id} IS NOT NULL)`
    ),
  })
);

/** Complete board branch-template or branch-override permission package. */
export const branchPermissionConfigs = sqliteTable(
  'branch_permission_configs',
  {
    config_id: text('config_id', { length: 36 }).primaryKey(),
    board_id: text('board_id', { length: 36 }).references(() => boards.board_id, {
      onDelete: 'cascade',
    }),
    branch_id: text('branch_id', { length: 36 }).references(() => branches.branch_id, {
      onDelete: 'cascade',
    }),
    schema_version: integer('schema_version').notNull().default(1),
    sharing_mode: text('sharing_mode', { enum: ['private', 'shared'] }).notNull(),
    others_role: text('others_role', {
      enum: ['none', 'viewer', 'collaborator', 'manager'],
    })
      .notNull()
      .default('none'),
    others_fs_access: text('others_fs_access', { enum: ['none', 'read', 'write'] })
      .notNull()
      .default('none'),
    allow_shared_session_prompts: t.bool('allow_shared_session_prompts').notNull().default(false),
    revision: integer('revision').notNull().default(1),
    updated_by: text('updated_by', { length: 36 }).references(() => users.user_id, {
      onDelete: 'set null',
    }),
    created_at: t.timestamp('created_at').notNull(),
    updated_at: t.timestamp('updated_at').notNull(),
  },
  (table) => ({
    boardUnique: uniqueIndex('branch_permission_configs_board_unique').on(table.board_id),
    branchUnique: uniqueIndex('branch_permission_configs_branch_unique').on(table.branch_id),
    updatedIdx: index('branch_permission_configs_updated_idx').on(table.updated_at),
    sharingModeCheck: check(
      'branch_permission_configs_sharing_mode_check',
      sql`${table.sharing_mode} IN ('private','shared')`
    ),
    othersFsAccessCheck: check(
      'branch_permission_configs_others_fs_access_check',
      sql`${table.others_fs_access} IN ('none','read','write')`
    ),
    othersRoleCheck: check(
      'branch_permission_configs_others_role_check',
      sql`${table.others_role} IN ('none','viewer','collaborator','manager')`
    ),
    targetCheck: check(
      'branch_permission_configs_target_check',
      sql`(${table.board_id} IS NOT NULL) <> (${table.branch_id} IS NOT NULL)`
    ),
  })
);

/** One normalized user or group entry in a branch permission package. */
export const branchPermissionEntries = sqliteTable(
  'branch_permission_entries',
  {
    entry_id: text('entry_id', { length: 36 }).primaryKey(),
    config_id: text('config_id', { length: 36 })
      .notNull()
      .references(() => branchPermissionConfigs.config_id, { onDelete: 'cascade' }),
    user_id: text('user_id', { length: 36 }).references(() => users.user_id, {
      onDelete: 'cascade',
    }),
    group_id: text('group_id', { length: 36 }).references(() => groups.group_id, {
      onDelete: 'cascade',
    }),
    role: text('role', { enum: ['none', 'viewer', 'collaborator', 'manager'] }).notNull(),
    fs_access: text('fs_access', { enum: ['none', 'read', 'write'] })
      .notNull()
      .default('none'),
    created_at: t.timestamp('created_at').notNull(),
    updated_at: t.timestamp('updated_at').notNull(),
  },
  (table) => ({
    configIdx: index('branch_permission_entries_config_idx').on(table.config_id),
    userIdx: index('branch_permission_entries_user_idx').on(table.user_id, table.config_id),
    groupIdx: index('branch_permission_entries_group_idx').on(table.group_id, table.config_id),
    configUserUnique: uniqueIndex('branch_permission_entries_config_user_unique').on(
      table.config_id,
      table.user_id
    ),
    configGroupUnique: uniqueIndex('branch_permission_entries_config_group_unique').on(
      table.config_id,
      table.group_id
    ),
    fsAccessCheck: check(
      'branch_permission_entries_fs_access_check',
      sql`${table.fs_access} IN ('none','read','write')`
    ),
    roleCheck: check(
      'branch_permission_entries_role_check',
      sql`${table.role} IN ('none','viewer','collaborator','manager')`
    ),
    principalCheck: check(
      'branch_permission_entries_principal_check',
      sql`(${table.user_id} IS NOT NULL) <> (${table.group_id} IS NOT NULL)`
    ),
  })
);

/**
 * Branch Group Grants - group-aware Branch RBAC grants.
 *
 * Owners remain direct users in branch_owners. Groups receive explicit grants
 * that participate in the same permission lattice as others_can.
 */
export const branchGroupGrants = sqliteTable(
  'branch_group_grants',
  {
    branch_id: text('branch_id', { length: 36 })
      .notNull()
      .references(() => branches.branch_id, { onDelete: 'cascade' }),
    group_id: text('group_id', { length: 36 })
      .notNull()
      .references(() => groups.group_id, { onDelete: 'cascade' }),
    can: text('can', { enum: [...BRANCH_PERMISSION_LEVELS] })
      .notNull()
      .default('view'),
    fs_access: text('fs_access', { enum: ['none', 'read', 'write'] }).$type<
      'none' | 'read' | 'write'
    >(),
    created_by: text('created_by', { length: 36 }).references(() => users.user_id, {
      onDelete: 'set null',
    }),
    created_at: t.timestamp('created_at').notNull(),
    updated_at: t.timestamp('updated_at'),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.branch_id, table.group_id] }),
    groupIdx: index('branch_group_grants_group_idx').on(table.group_id),
  })
);

/**
 * Board Group Grants - group-aware board visibility/default grants.
 */
export const boardGroupGrants = sqliteTable(
  'board_group_grants',
  {
    board_id: text('board_id', { length: 36 })
      .notNull()
      .references(() => boards.board_id, { onDelete: 'cascade' }),
    group_id: text('group_id', { length: 36 })
      .notNull()
      .references(() => groups.group_id, { onDelete: 'cascade' }),
    can: text('can', { enum: [...BRANCH_PERMISSION_LEVELS] })
      .notNull()
      .default('view'),
    fs_access: text('fs_access', { enum: ['none', 'read', 'write'] }).$type<
      'none' | 'read' | 'write'
    >(),
    created_by: text('created_by', { length: 36 }).references(() => users.user_id, {
      onDelete: 'set null',
    }),
    created_at: t.timestamp('created_at').notNull(),
    updated_at: t.timestamp('updated_at'),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.board_id, table.group_id] }),
    groupIdx: index('board_group_grants_group_idx').on(table.group_id),
  })
);

/**
 * App Variables - daemon-owned application settings and secrets.
 *
 * Values can be plaintext (`value_text`) for non-secret JSON/string settings or
 * encrypted (`value_encrypted`) with AGOR_MASTER_SECRET for daemon service
 * credentials such as Knowledge embedding provider API keys.
 */
export const appVariables = sqliteTable(
  'app_variables',
  {
    variable_id: text('variable_id', { length: 36 }).primaryKey(),
    namespace: text('namespace').notNull(),
    key: text('key').notNull(),
    value_text: text('value_text'),
    value_encrypted: text('value_encrypted'),
    is_encrypted: t.bool('is_encrypted').notNull().default(false),
    content_type: text('content_type').notNull().default('text/plain'),
    metadata: t.json<Record<string, unknown>>('metadata'),
    updated_by: text('updated_by', { length: 36 }).references(() => users.user_id, {
      onDelete: 'set null',
    }),
    created_at: t.timestamp('created_at').notNull(),
    updated_at: t.timestamp('updated_at').notNull(),
  },
  (table) => ({
    namespaceKeyIdx: uniqueIndex('app_variables_namespace_key_idx').on(table.namespace, table.key),
    namespaceIdx: index('app_variables_namespace_idx').on(table.namespace),
  })
);

/** Tenant-owned, live agentic-tool runtime configuration presets. */
export const agenticToolPresets = sqliteTable(
  'agentic_tool_presets',
  {
    preset_id: text('preset_id').primaryKey(),
    tool: text('tool', {
      enum: ['claude-code', 'codex', 'gemini', 'copilot', 'cursor', 'opencode'],
    }).notNull(),
    name: text('name').notNull(),
    description: text('description'),
    is_default: t.bool('is_default').notNull().default(false),
    configuration: t.json<unknown>('configuration').notNull(),
    created_by: text('created_by').notNull(),
    updated_by: text('updated_by').notNull(),
    created_at: t.timestamp('created_at').notNull(),
    updated_at: t.timestamp('updated_at').notNull(),
  },
  (table) => ({
    toolNameUnique: uniqueIndex('agentic_tool_presets_tool_name_unique').on(table.tool, table.name),
    tenantToolDefaultUnique: uniqueIndex('agentic_tool_presets_tenant_tool_default_unique')
      .on(table.tool)
      .where(sql`${table.is_default} = 1`),
  })
);

/**
 * User API Keys table - Personal API keys for programmatic access
 *
 * Stores bcrypt-hashed API keys with a prefix for identification.
 * The raw key is shown once at creation time and never stored.
 */
export const userApiKeys = sqliteTable(
  'user_api_keys',
  {
    id: text('id', { length: 36 }).primaryKey(),
    user_id: text('user_id', { length: 36 })
      .notNull()
      .references(() => users.user_id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    prefix: text('prefix').notNull(), // first 12 chars: 'agor_sk_XXXX' for identification
    key_hash: text('key_hash').notNull(), // bcrypt hash of full key
    created_at: t.timestamp('created_at').notNull(),
    last_used_at: t.timestamp('last_used_at'),
  },
  (table) => ({
    userIdx: index('user_api_keys_user_idx').on(table.user_id),
    prefixIdx: index('user_api_keys_prefix_idx').on(table.prefix),
  })
);

/**
 * MCP Servers table - MCP server configurations
 *
 * Stores MCP (Model Context Protocol) server configurations that can be attached to sessions.
 * Supports stdio, HTTP, and SSE transports with scoped access control.
 */
export const mcpServers = sqliteTable(
  'mcp_servers',
  {
    // Primary identity
    mcp_server_id: text('mcp_server_id', { length: 36 }).primaryKey(),
    created_at: t.timestamp('created_at').notNull(),
    updated_at: t.timestamp('updated_at'),

    // Materialized for filtering
    name: text('name').notNull(), // e.g., "filesystem", "sentry"
    transport: text('transport', {
      enum: ['stdio', 'http', 'sse'],
    }).notNull(),
    scope: text('scope', {
      enum: ['global', 'session'],
    }).notNull(),
    enabled: t.bool('enabled').notNull().default(true),

    // Owner of a private server, NULL for a shared one. Applies to both
    // scopes: a private server is only ever resolved into, and attachable to,
    // sessions its owner created.
    owner_user_id: text('owner_user_id', { length: 36 }),

    // Source tracking (materialized for queries)
    source: text('source', {
      enum: ['user', 'imported', 'agor', 'catalog'],
    }).notNull(),
    catalog_entry_name: text('catalog_entry_name'),

    // JSON blob for configuration and capabilities
    data: t
      .json<unknown>('data')
      .$type<{
        display_name?: string;
        description?: string;
        import_path?: string;
        // Catalog entry this server was installed from, by the registry name
        // that outlives the entry row.
        catalog_entry_name?: string;

        // Daemon-owned optimistic-concurrency revision for public edits.
        config_version?: number;

        // Transport config
        command?: string;
        args?: string[];
        url?: string;
        headers?: Record<string, string>;
        env?: Record<string, string>;

        // Authentication config (for HTTP/SSE transports)
        auth?: {
          type: 'none' | 'bearer' | 'jwt' | 'oauth';
          // Bearer token
          token?: string;
          // JWT config
          api_url?: string;
          api_token?: string;
          api_secret?: string;
          // OAuth 2.0 config
          oauth_token_url?: string;
          oauth_client_id?: string;
          oauth_client_secret?: string;
          oauth_scope?: string;
          oauth_grant_type?: string;
          // OAuth 2.1 runtime tokens (obtained via browser flow)
          oauth_access_token?: string;
          oauth_token_expires_at?: number; // Unix timestamp in milliseconds
          oauth_refresh_token?: string;
          // OAuth mode: 'per_user' stores tokens per-user, 'shared' uses single token for all users
          oauth_mode?: 'per_user' | 'shared';
          // Common
          insecure?: boolean;
        };

        // Discovered capabilities
        tools?: Array<{
          name: string;
          description?: string;
          input_schema?: Record<string, unknown>; // Optional - not all MCP servers provide schemas
        }>;
        resources?: Array<{
          uri: string;
          name: string;
          description?: string;
          mimeType?: string;
        }>;
        prompts?: Array<{
          name: string;
          description?: string;
          arguments?: Array<{
            name: string;
            description?: string;
            required?: boolean;
          }>;
        }>;

        // Tool permissions configuration
        tool_permissions?: Record<string, 'ask' | 'allow' | 'deny'>;
      }>()
      .notNull(),
  },
  (table) => ({
    nameIdx: index('mcp_servers_name_idx').on(table.name),
    scopeIdx: index('mcp_servers_scope_idx').on(table.scope),
    ownerIdx: index('mcp_servers_owner_idx').on(table.owner_user_id),
    enabledIdx: index('mcp_servers_enabled_idx').on(table.enabled),
    catalogOwnerUq: uniqueIndex('mcp_servers_catalog_owner_uq')
      .on(sql`coalesce(${table.owner_user_id}, '')`, table.catalog_entry_name)
      .where(sql`${table.source} = 'catalog' AND ${table.catalog_entry_name} IS NOT NULL`),
  })
);

/**
 * Card Types table - Global card type definitions
 *
 * CardTypes are org-level templates that define a category of cards
 * with default emoji, color, and optional JSON Schema for data validation.
 */
export const cardTypes = sqliteTable(
  'card_types',
  {
    card_type_id: text('card_type_id', { length: 36 }).primaryKey(),
    name: text('name').notNull(),
    emoji: text('emoji'),
    color: text('color'),
    json_schema: text('json_schema'), // JSON string of JSON Schema
    created_by: text('created_by', { length: 36 }),
    created_at: t.timestamp('created_at').notNull(),
    updated_at: t.timestamp('updated_at').notNull(),
  },
  (table) => ({
    nameIdx: index('card_types_name_idx').on(table.name),
  })
);

/**
 * Cards table - Generic entities on boards
 *
 * Cards are visual work items managed by agents via MCP tools.
 * They live on boards alongside branches and can be placed in zones.
 */
export const cards = sqliteTable(
  'cards',
  {
    card_id: text('card_id', { length: 36 }).primaryKey(),
    board_id: text('board_id', { length: 36 })
      .notNull()
      .references(() => boards.board_id, { onDelete: 'cascade' }),
    card_type_id: text('card_type_id', { length: 36 }).references(() => cardTypes.card_type_id, {
      onDelete: 'set null',
    }),
    title: text('title').notNull(),
    url: text('url'),
    description: text('description'),
    note: text('note'),
    data: text('data'), // JSON blob validated against CardType.json_schema if present
    color_override: text('color_override'),
    emoji_override: text('emoji_override'),
    created_by: text('created_by', { length: 36 }),
    created_at: t.timestamp('created_at').notNull(),
    updated_at: t.timestamp('updated_at').notNull(),
    archived: t.bool('archived').notNull().default(false),
    archived_at: t.timestamp('archived_at'),
  },
  (table) => ({
    boardIdx: index('cards_board_idx').on(table.board_id),
    cardTypeIdx: index('cards_card_type_idx').on(table.card_type_id),
    titleIdx: index('cards_title_idx').on(table.title),
    archivedIdx: index('cards_archived_idx').on(table.archived),
    createdIdx: index('cards_created_idx').on(table.created_at),
  })
);

/**
 * Artifacts table - Live web applications rendered via Sandpack
 *
 * Artifacts are board-scoped, DB-backed objects. The filesystem folder is a
 * transient staging area that agents write to; on publish, the daemon serializes
 * folder contents into the `files` JSONB column. Serving reads from DB only.
 */
export const artifacts = sqliteTable(
  'artifacts',
  {
    artifact_id: text('artifact_id', { length: 36 }).primaryKey(),
    branch_id: text('branch_id', { length: 36 }).references(() => branches.branch_id, {
      onDelete: 'set null',
    }),
    source_session_id: text('source_session_id', { length: 36 }).references(
      () => sessions.session_id,
      {
        onDelete: 'set null',
      }
    ),
    board_id: text('board_id', { length: 36 })
      .notNull()
      .references(() => boards.board_id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    path: text('path'), // provenance only — where files were read from
    template: text('template').notNull().default('react'),
    build_status: text('build_status').notNull().default('unknown'),
    build_errors: t.json<string[]>('build_errors'),
    content_hash: text('content_hash'),
    files: t.json<Record<string, string>>('files'),
    dependencies: t.json<Record<string, string>>('dependencies'),
    entry: text('entry'), // denormalized cache of the Sandpack entry file
    sandpack_config: t.json<SandpackConfig>('sandpack_config'),
    required_env_vars: t.json<string[]>('required_env_vars'),
    agor_grants: t.json<AgorGrants>('agor_grants'),
    agor_runtime: t.json<AgorRuntimeConfig>('agor_runtime'),
    public: t.bool('public').notNull().default(true),
    created_by: text('created_by', { length: 36 }),
    created_at: t.timestamp('created_at').notNull(),
    updated_at: t.timestamp('updated_at').notNull(),
    archived: t.bool('archived').notNull().default(false),
    archived_at: t.timestamp('archived_at'),
  },
  (table) => ({
    branchIdx: index('artifacts_branch_idx').on(table.branch_id),
    sourceSessionIdx: index('artifacts_source_session_idx').on(table.source_session_id),
    boardIdx: index('artifacts_board_idx').on(table.board_id),
    archivedIdx: index('artifacts_archived_idx').on(table.archived),
    publicIdx: index('artifacts_public_idx').on(table.public),
  })
);

export type ArtifactRow = typeof artifacts.$inferSelect;
export type ArtifactInsert = typeof artifacts.$inferInsert;

/**
 * Per-viewer trust grants for artifact secret/grant injection. The viewer
 * (`user_id`) consented to inject the listed `env_vars_set` and
 * `agor_grants_set` into one or more artifacts matching `scope_type` +
 * `scope_value`. Soft-deleted via `revoked_at` for audit history.
 */
export const artifactTrustGrants = sqliteTable(
  'artifact_trust_grants',
  {
    grant_id: text('grant_id', { length: 36 }).primaryKey(),
    user_id: text('user_id', { length: 36 }).notNull(),
    // CHECK constraint omitted — service-layer enforcement only, so adding new
    // scope_types in the future doesn't require a SQLite table-recreate.
    scope_type: text('scope_type').notNull(),
    scope_value: text('scope_value'),
    env_vars_set: t.json<string[]>('env_vars_set').notNull(),
    agor_grants_set: t.json<AgorGrants>('agor_grants_set').notNull(),
    granted_at: t.timestamp('granted_at').notNull(),
    revoked_at: t.timestamp('revoked_at'),
  },
  (table) => ({
    userIdx: index('artifact_trust_grants_user_idx').on(table.user_id),
    scopeIdx: index('artifact_trust_grants_scope_idx').on(table.scope_type, table.scope_value),
  })
);

export type ArtifactTrustGrantRow = typeof artifactTrustGrants.$inferSelect;
export type ArtifactTrustGrantInsert = typeof artifactTrustGrants.$inferInsert;

/**
 * Board Objects table - Positioned entities (branches and cards) on boards
 *
 * Polymorphic placement: exactly one of branch_id or card_id must be set.
 * Enforced in application layer.
 */
export const boardObjects = sqliteTable(
  'board_objects',
  {
    // Primary identity
    object_id: text('object_id', { length: 36 }).primaryKey(),
    board_id: text('board_id', { length: 36 })
      .notNull()
      .references(() => boards.board_id, { onDelete: 'cascade' }),
    created_at: t.timestamp('created_at').notNull(),

    // Polymorphic entity reference (exactly one must be set)
    branch_id: text('branch_id', { length: 36 }).references(() => branches.branch_id, {
      onDelete: 'cascade',
    }),
    card_id: text('card_id', { length: 36 }).references(() => cards.card_id, {
      onDelete: 'cascade',
    }),

    // Position data (JSON)
    data: t
      .json<unknown>('data')
      .$type<{
        position: { x: number; y: number };
        zone_id?: string; // Optional zone pinning
      }>()
      .notNull(),
  },
  (table) => ({
    boardIdx: index('board_objects_board_idx').on(table.board_id),
    branchIdx: index('board_objects_branch_idx').on(table.branch_id),
    cardIdx: index('board_objects_card_idx').on(table.card_id),
  })
);

/**
 * Session-MCP Servers relationship table
 *
 * Many-to-many relationship between sessions and MCP servers.
 * Tracks which MCP servers are enabled for each session.
 */
export const sessionMcpServers = sqliteTable(
  'session_mcp_servers',
  {
    session_id: text('session_id', { length: 36 })
      .notNull()
      .references(() => sessions.session_id, { onDelete: 'cascade' }),
    mcp_server_id: text('mcp_server_id', { length: 36 })
      .notNull()
      .references(() => mcpServers.mcp_server_id, { onDelete: 'cascade' }),
    enabled: t.bool('enabled').notNull().default(true),
    added_at: t.timestamp('added_at').notNull(),
  },
  (table) => ({
    // Idempotency guard for recovery and concurrent attachment.
    pk: uniqueIndex('session_mcp_servers_pk').on(table.session_id, table.mcp_server_id),
    // Indexes for queries
    sessionIdx: index('session_mcp_servers_session_idx').on(table.session_id),
    serverIdx: index('session_mcp_servers_server_idx').on(table.mcp_server_id),
    enabledIdx: index('session_mcp_servers_enabled_idx').on(table.session_id, table.enabled),
  })
);

/**
 * MCP OAuth Tokens table - OAuth 2.1 tokens for MCP servers
 *
 * Holds BOTH per-user and shared-mode tokens:
 *   - `user_id` set  → per-user token (oauth_mode: 'per_user')
 *   - `user_id` NULL → shared token for this MCP server (oauth_mode: 'shared')
 *
 * `oauth_client_id`/`oauth_client_secret` are co-located because the
 * refresh_token is bound to the client credentials that were used when
 * it was issued (often via RFC 7591 Dynamic Client Registration, which
 * generates fresh per-grant credentials on each daemon restart). Storing
 * them alongside the refresh_token keeps the refresh path correct even
 * if the server-level DCR cache is rebuilt.
 */
export const userMcpOauthTokens = sqliteTable(
  'user_mcp_oauth_tokens',
  {
    // NULL = shared-mode token (one per mcp_server_id)
    user_id: text('user_id', { length: 36 }).references(() => users.user_id, {
      onDelete: 'cascade',
    }),
    mcp_server_id: text('mcp_server_id', { length: 36 })
      .notNull()
      .references(() => mcpServers.mcp_server_id, { onDelete: 'cascade' }),
    oauth_access_token: text('oauth_access_token').notNull(),
    oauth_token_expires_at: t.timestamp('oauth_token_expires_at'), // Unix timestamp in milliseconds
    oauth_refresh_token: text('oauth_refresh_token'),
    // DCR / registered client credentials this grant was issued under.
    // Must be preserved across refreshes.
    oauth_client_id: text('oauth_client_id'),
    oauth_client_secret: text('oauth_client_secret'),
    grant_generation: integer('grant_generation').notNull().default(0),
    grant_binding_version: integer('grant_binding_version'),
    grant_binding_fingerprint: text('grant_binding_fingerprint', { length: 64 }),
    oauth_metadata_uri: text('oauth_metadata_uri'),
    oauth_resource_uri: text('oauth_resource_uri'),
    oauth_issuer: text('oauth_issuer'),
    oauth_authorization_endpoint: text('oauth_authorization_endpoint'),
    oauth_token_endpoint: text('oauth_token_endpoint'),
    oauth_redirect_uri: text('oauth_redirect_uri'),
    refresh_status: text('refresh_status').notNull().default('idle'),
    refresh_generation: integer('refresh_generation').notNull().default(0),
    refresh_success_generation: integer('refresh_success_generation').notNull().default(0),
    refresh_claim_id: text('refresh_claim_id', { length: 36 }),
    refresh_claimed_at: t.timestamp('refresh_claimed_at'),
    created_at: t.timestamp('created_at').notNull(),
    updated_at: t.timestamp('updated_at'),
  },
  (table) => ({
    // Composite lookup indexes. Uniqueness enforced via partial unique indexes
    // created in the migration (one for per-user rows, one for the shared row).
    pk: index('user_mcp_oauth_tokens_pk').on(table.user_id, table.mcp_server_id),
    userIdx: index('user_mcp_oauth_tokens_user_idx').on(table.user_id),
    serverIdx: index('user_mcp_oauth_tokens_server_idx').on(table.mcp_server_id),
  })
);

/**
 * Schema mirror for PostgreSQL MCP OAuth pending-flow authority.
 *
 * Standalone SQLite deliberately keeps its existing process-local flow state;
 * this table is unused at runtime and exists for cross-dialect compatibility.
 */
export const mcpOauthPendingFlows = sqliteTable(
  'mcp_oauth_pending_flows',
  {
    attempt_id: text('attempt_id', { length: 36 }).primaryKey(),
    state_hash: text('state_hash', { length: 64 }).notNull(),
    user_id: text('user_id', { length: 36 })
      .notNull()
      .references(() => users.user_id, { onDelete: 'cascade' }),
    mcp_server_id: text('mcp_server_id', { length: 36 })
      .notNull()
      .references(() => mcpServers.mcp_server_id, { onDelete: 'cascade' }),
    oauth_mode: text('oauth_mode', { enum: ['per_user', 'shared'] }).notNull(),
    subject_user_id: text('subject_user_id', { length: 36 }),
    grant_generation: integer('grant_generation').notNull(),
    config_fingerprint_version: integer('config_fingerprint_version').notNull(),
    config_fingerprint: text('config_fingerprint', { length: 64 }).notNull(),
    envelope_version: integer('envelope_version').notNull(),
    is_current: integer('is_current', { mode: 'boolean' }).notNull().default(true),
    status: text('status', {
      enum: ['pending', 'exchanging', 'succeeded', 'failed', 'ambiguous', 'expired'],
    })
      .notNull()
      .default('pending'),
    sealed_material: text('sealed_material'),
    exchange_claim_id: text('exchange_claim_id', { length: 36 }),
    failure_code: text('failure_code'),
    created_at: t.timestamp('created_at').notNull(),
    updated_at: t.timestamp('updated_at').notNull(),
    expires_at: t.timestamp('expires_at').notNull(),
    exchange_started_at: t.timestamp('exchange_started_at'),
    finished_at: t.timestamp('finished_at'),
  },
  (table) => ({
    stateHashUnique: uniqueIndex('mcp_oauth_pending_flows_state_hash_unique').on(table.state_hash),
    userIdx: index('mcp_oauth_pending_flows_user_idx').on(table.user_id, table.created_at),
    serverIdx: index('mcp_oauth_pending_flows_server_idx').on(table.mcp_server_id),
    grantIdx: index('mcp_oauth_pending_flows_grant_idx').on(
      table.mcp_server_id,
      table.oauth_mode,
      table.subject_user_id,
      table.grant_generation
    ),
    maintenanceIdx: index('mcp_oauth_pending_flows_maintenance_idx').on(
      table.status,
      table.expires_at,
      table.exchange_started_at,
      table.finished_at
    ),
  })
);

/**
 * Schema mirror for PostgreSQL Claude subscription OAuth attempt authority.
 *
 * Standalone SQLite deliberately keeps its existing process-local sign-in state;
 * this table is unused at runtime and exists for cross-dialect compatibility.
 */
export const claudeOauthAttempts = sqliteTable(
  'claude_oauth_attempts',
  {
    attempt_id: text('attempt_id', { length: 36 }).primaryKey(),
    state_hash: text('state_hash', { length: 64 }).notNull(),
    user_id: text('user_id', { length: 36 })
      .notNull()
      .references(() => users.user_id, { onDelete: 'cascade' }),
    attempt_generation: integer('attempt_generation').notNull(),
    envelope_version: integer('envelope_version').notNull(),
    is_current: integer('is_current', { mode: 'boolean' }).notNull().default(true),
    status: text('status', {
      enum: ['pending', 'exchanging', 'persisting', 'succeeded', 'failed', 'ambiguous', 'expired'],
    })
      .notNull()
      .default('pending'),
    sealed_material: text('sealed_material'),
    exchange_claim_id: text('exchange_claim_id', { length: 36 }),
    failure_code: text('failure_code'),
    subscription_type: text('subscription_type'),
    created_at: t.timestamp('created_at').notNull(),
    updated_at: t.timestamp('updated_at').notNull(),
    expires_at: t.timestamp('expires_at').notNull(),
    exchange_started_at: t.timestamp('exchange_started_at'),
    finished_at: t.timestamp('finished_at'),
  },
  (table) => ({
    stateHashUnique: uniqueIndex('claude_oauth_attempts_state_hash_unique').on(table.state_hash),
    userIdx: index('claude_oauth_attempts_user_idx').on(table.user_id, table.created_at),
    currentUserUnique: uniqueIndex('claude_oauth_attempts_current_user_uq')
      .on(table.user_id)
      .where(sql`${table.is_current} = 1`),
    maintenanceIdx: index('claude_oauth_attempts_maintenance_idx').on(
      table.status,
      table.expires_at,
      table.exchange_started_at,
      table.finished_at
    ),
  })
);

/**
 * Cross-dialect schema mirror. Standalone SQLite continues to use the simple
 * process-local Codex device flow; durable polling authority is HA/PostgreSQL-only.
 */
export const codexDeviceAuthAttempts = sqliteTable(
  'codex_device_auth_attempts',
  {
    attempt_id: text('attempt_id', { length: 36 }).primaryKey(),
    user_id: text('user_id', { length: 36 })
      .notNull()
      .references(() => users.user_id, { onDelete: 'cascade' }),
    attempt_generation: integer('attempt_generation').notNull(),
    envelope_version: integer('envelope_version').notNull(),
    is_current: integer('is_current', { mode: 'boolean' }).notNull().default(true),
    status: text('status', {
      enum: [
        'starting',
        'pending',
        'exchanging',
        'persisting',
        'succeeded',
        'unavailable',
        'denied',
        'failed',
        'ambiguous',
        'expired',
        'superseded',
        'cancelled',
      ],
    })
      .notNull()
      .default('starting'),
    sealed_material: text('sealed_material'),
    poll_interval_ms: integer('poll_interval_ms'),
    poll_next_at: t.timestamp('poll_next_at'),
    poll_claim_id: text('poll_claim_id', { length: 36 }),
    poll_claim_generation: integer('poll_claim_generation').notNull().default(0),
    poll_lease_expires_at: t.timestamp('poll_lease_expires_at'),
    exchange_claim_id: text('exchange_claim_id', { length: 36 }),
    failure_code: text('failure_code'),
    plan_type: text('plan_type'),
    created_at: t.timestamp('created_at').notNull(),
    updated_at: t.timestamp('updated_at').notNull(),
    expires_at: t.timestamp('expires_at').notNull(),
    exchange_started_at: t.timestamp('exchange_started_at'),
    finished_at: t.timestamp('finished_at'),
  },
  (table) => ({
    currentUserUnique: uniqueIndex('codex_device_auth_attempts_current_user_uq')
      .on(table.user_id)
      .where(sql`${table.is_current} = 1`),
    userIdx: index('codex_device_auth_attempts_user_idx').on(table.user_id, table.created_at),
    pollIdx: index('codex_device_auth_attempts_poll_idx').on(
      table.status,
      table.poll_next_at,
      table.poll_lease_expires_at
    ),
    maintenanceIdx: index('codex_device_auth_attempts_maintenance_idx').on(
      table.status,
      table.expires_at,
      table.exchange_started_at,
      table.finished_at
    ),
  })
);

/**
 * Board Comments table - Human-to-human conversations and collaboration
 *
 * Flexible attachment strategy:
 * - Board-level: General conversations (no attachment foreign keys)
 * - Object-level: Attached to sessions, tasks, messages, or branches
 * - Spatial: Positioned on canvas (absolute or relative to objects)
 *
 * Supports threading, mentions, and resolve/unresolve workflows.
 */
export const boardComments = sqliteTable(
  'board_comments',
  {
    // Primary identity
    comment_id: text('comment_id', { length: 36 }).primaryKey(),
    created_at: t.timestamp('created_at').notNull(),
    updated_at: t.timestamp('updated_at'),

    // Scoping & authorship
    board_id: text('board_id', { length: 36 })
      .notNull()
      .references(() => boards.board_id, { onDelete: 'cascade' }),
    created_by: text('created_by', { length: 36 }).notNull(),

    // FLEXIBLE ATTACHMENTS (all optional)
    // Phase 1: board-level only (all NULL)
    // Phase 2: object attachments (session, task, message, branch)
    // Phase 3: spatial positioning
    session_id: text('session_id', { length: 36 }).references(() => sessions.session_id, {
      onDelete: 'set null',
    }),
    task_id: text('task_id', { length: 36 }).references(() => tasks.task_id, {
      onDelete: 'set null',
    }),
    message_id: text('message_id', { length: 36 }).references(() => messages.message_id, {
      onDelete: 'set null',
    }),
    branch_id: text('branch_id', { length: 36 }).references(() => branches.branch_id, {
      onDelete: 'cascade',
    }),

    // Content (materialized for display)
    content: text('content').notNull(), // Markdown-supported text
    content_preview: text('content_preview').notNull(), // First 200 chars

    // Thread support (optional)
    parent_comment_id: text('parent_comment_id', { length: 36 }),

    // Metadata (materialized for filtering)
    resolved: t.bool('resolved').notNull().default(false),
    edited: t.bool('edited').notNull().default(false),

    // Reactions (for BOTH thread roots and replies)
    // Stored as JSON array: [{ user_id: "abc", emoji: "👍" }, ...]
    // Display grouped by emoji: { "👍": ["alice", "bob"], "🎉": ["charlie"] }
    reactions: t
      .json<unknown>('reactions')
      .$type<Array<{ user_id: string; emoji: string }>>()
      .notNull()
      .default(sql`'[]'`),

    // JSON blob for advanced features
    data: t
      .json<unknown>('data')
      .$type<{
        // Spatial positioning (Phase 3)
        position?: {
          // Absolute board coordinates (React Flow coordinates)
          absolute?: { x: number; y: number };
          // OR relative to session/zone/branch (follows parent when it moves)
          relative?: {
            parent_id: string; // Can be session_id, zone object ID, or branch_id
            parent_type: 'session' | 'zone' | 'branch';
            offset_x: number;
            offset_y: number;
          };
        };
        // Mentions (Phase 4)
        mentions?: string[]; // Array of user IDs
      }>()
      .notNull(),
  },
  (table) => ({
    boardIdx: index('board_comments_board_idx').on(table.board_id),
    sessionIdx: index('board_comments_session_idx').on(table.session_id),
    taskIdx: index('board_comments_task_idx').on(table.task_id),
    messageIdx: index('board_comments_message_idx').on(table.message_id),
    branchIdx: index('board_comments_branch_idx').on(table.branch_id),
    createdByIdx: index('board_comments_created_by_idx').on(table.created_by),
    parentIdx: index('board_comments_parent_idx').on(table.parent_comment_id),
    createdIdx: index('board_comments_created_idx').on(table.created_at),
    resolvedIdx: index('board_comments_resolved_idx').on(table.resolved),
  })
);

/**
 * Upload metadata control plane. Bytes live in the configured storage adapter.
 * Session/branch identifiers intentionally have no restrictive FK so upload
 * cleanup and historical attachment snapshots remain independent.
 */
export const uploads = sqliteTable(
  'uploads',
  {
    upload_ref: text('upload_ref').primaryKey(),
    created_by: text('created_by', { length: 36 }).notNull(),
    session_id: text('session_id', { length: 36 }).notNull(),
    branch_id: text('branch_id', { length: 36 }).notNull(),
    storage_key: text('storage_key').notNull(),
    original_name: text('original_name').notNull(),
    display_name: text('display_name').notNull(),
    content_type: text('content_type').notNull(),
    size_bytes: integer('size_bytes').notNull(),
    checksum: text('checksum'),
    status: text('status', { enum: ['pending', 'active', 'deleting'] })
      .notNull()
      .default('active'),
    provenance: text('provenance', {
      enum: ['browser', 'gateway-slack', 'mcp-slack'],
    }).notNull(),
    created_at: t.timestamp('created_at').notNull(),
    expires_at: t.timestamp('expires_at'),
  },
  (table) => ({
    ownerIdx: index('uploads_owner_idx').on(table.created_by),
    sessionIdx: index('uploads_session_idx').on(table.session_id),
    expiryIdx: index('uploads_expiry_idx').on(table.expires_at),
  })
);

/**
 * Gateway Channels table - Registered messaging platform integrations
 *
 * Users create channels to connect messaging platforms (Slack, Discord, etc.)
 * to Agor. Each channel targets a specific branch and routes messages
 * to/from sessions within that branch.
 */
export const gatewayChannels = sqliteTable(
  'gateway_channels',
  {
    // Primary identity
    id: text('id', { length: 36 }).primaryKey(),
    created_at: t.timestamp('created_at').notNull(),
    updated_at: t.timestamp('updated_at').notNull(),

    // User attribution
    created_by: text('created_by', { length: 36 }).notNull(),

    // Materialized for queries
    name: text('name').notNull(),
    channel_type: text('channel_type', {
      enum: ['slack', 'discord', 'whatsapp', 'telegram', 'github', 'teams', 'shortcut'],
    }).notNull(),
    target_branch_id: text('target_branch_id', { length: 36 })
      .notNull()
      .references(() => branches.branch_id, { onDelete: 'cascade' }),
    agor_user_id: text('agor_user_id', { length: 36 }),
    provider_installation_id: text('provider_installation_id'),
    provider_config_generation: integer('provider_config_generation').notNull().default(1),
    channel_key: text('channel_key').notNull().unique(),
    enabled: t.bool('enabled').notNull().default(true),
    last_message_at: t.timestamp('last_message_at'),

    // JSON blob for platform credentials (encrypted at rest)
    config: t.json<Record<string, unknown>>('config').notNull(),

    // JSON blob for agentic tool configuration (agent, model, permission mode, etc.)
    agentic_config: t.json<Record<string, unknown> | null>('agentic_config'),
    agentic_tool_preset_id: text('agentic_tool_preset_id', { length: 36 }).references(
      () => agenticToolPresets.preset_id,
      { onDelete: 'restrict' }
    ),
    mcp_server_ids: t.json<string[]>('mcp_server_ids'),

    // Present for schema parity and portability of standalone databases. The
    // SQLite listener lifecycle remains process-local and does not use leases.
    listener_claim_token: text('listener_claim_token'),
    listener_claimed_at: t.timestamp('listener_claimed_at'),
    listener_lease_expires_at: t.timestamp('listener_lease_expires_at'),
    listener_instance_id: text('listener_instance_id'),
    listener_boot_id: text('listener_boot_id'),
    listener_generation: integer('listener_generation').notNull().default(0),
    listener_checkpoint: t.json<Record<string, unknown> | null>('listener_checkpoint'),
    listener_checkpoint_updated_at: t.timestamp('listener_checkpoint_updated_at'),
  },
  (table) => ({
    channelKeyIdx: index('idx_gateway_channel_key').on(table.channel_key),
    agenticToolPresetIdx: index('gateway_channels_agentic_tool_preset_idx').on(
      table.agentic_tool_preset_id
    ),
    enabledTypeIdx: index('idx_gateway_enabled_type').on(table.enabled, table.channel_type),
    discordInstallationUnique: uniqueIndex('gateway_channels_discord_installation_unique')
      .on(table.channel_type, table.provider_installation_id)
      .where(
        sql`${table.channel_type} = 'discord' AND ${table.enabled} = 1 AND ${table.provider_installation_id} IS NOT NULL`
      ),
    listenerLeaseIdx: index('gateway_channels_listener_lease_idx').on(
      table.enabled,
      table.listener_lease_expires_at,
      table.id
    ),
  })
);

/** Standalone parity for provider-event idempotency records. */
export const gatewayInboundEvents = sqliteTable(
  'gateway_inbound_events',
  {
    id: text('id', { length: 36 }).primaryKey(),
    gateway_channel_id: text('gateway_channel_id', { length: 36 })
      .notNull()
      .references(() => gatewayChannels.id, { onDelete: 'cascade' }),
    provider_event_id: text('provider_event_id').notNull(),
    thread_id: text('thread_id').notNull(),
    delivery_metadata: t.json<Record<string, unknown> | null>('delivery_metadata'),
    status: text('status', { enum: ['processing', 'completed'] }).notNull(),
    processing_token: text('processing_token').notNull(),
    processing_expires_at: t.timestamp('processing_expires_at').notNull(),
    session_id: text('session_id', { length: 36 }).references(() => sessions.session_id, {
      onDelete: 'set null',
    }),
    task_id: text('task_id', { length: 36 }).references(() => tasks.task_id, {
      onDelete: 'set null',
    }),
    received_at: t.timestamp('received_at').notNull(),
    completed_at: t.timestamp('completed_at'),
  },
  (table) => ({
    providerEventUnique: uniqueIndex('gateway_inbound_events_provider_unique').on(
      table.gateway_channel_id,
      table.provider_event_id
    ),
    recoveryIdx: index('gateway_inbound_events_recovery_idx').on(
      table.status,
      table.processing_expires_at,
      table.id
    ),
  })
);

/**
 * Thread-Session Map table - Links platform threads to Agor sessions
 *
 * Each thread in a messaging platform maps 1:1 to an Agor session.
 * The gateway service manages these mappings for routing.
 */
export const threadSessionMap = sqliteTable(
  'thread_session_map',
  {
    // Primary identity
    id: text('id', { length: 36 }).primaryKey(),
    created_at: t.timestamp('created_at').notNull(),
    last_message_at: t.timestamp('last_message_at').notNull(),

    // Foreign keys
    channel_id: text('channel_id', { length: 36 })
      .notNull()
      .references(() => gatewayChannels.id, { onDelete: 'cascade' }),
    thread_id: text('thread_id').notNull(),
    session_id: text('session_id', { length: 36 })
      .notNull()
      .references(() => sessions.session_id, { onDelete: 'cascade' }),
    branch_id: text('branch_id', { length: 36 })
      .notNull()
      .references(() => branches.branch_id),

    // Materialized for queries
    status: text('status', {
      enum: ['active', 'archived', 'paused'],
    })
      .notNull()
      .default('active'),

    // JSON blob for extra metadata
    metadata: t.json<Record<string, unknown>>('metadata'),

    // Durable Discord catch-up cursor. Provider history itself is never stored.
    discord_last_admitted_message_id: text('discord_last_admitted_message_id'),
  },
  (table) => ({
    uniqueChannelThread: uniqueIndex('uniq_thread_map_channel_thread').on(
      table.channel_id,
      table.thread_id
    ),
    sessionIdx: index('idx_thread_map_session_id').on(table.session_id),
    threadIdx: index('idx_thread_map_thread_id').on(table.thread_id),
    channelStatusIdx: index('idx_thread_map_channel_status').on(table.channel_id, table.status),
  })
);

/** Standalone SQLite mirror of the narrow Discord final-delivery intent. */
export const discordMessageDeliveries = sqliteTable(
  'discord_message_deliveries',
  {
    delivery_id: text('delivery_id', { length: 36 }).primaryKey(),
    created_at: t.timestamp('created_at').notNull(),
    updated_at: t.timestamp('updated_at').notNull(),
    message_id: text('message_id', { length: 36 })
      .notNull()
      .references(() => messages.message_id, { onDelete: 'cascade' }),
    gateway_channel_id: text('gateway_channel_id', { length: 36 })
      .notNull()
      .references(() => gatewayChannels.id, { onDelete: 'cascade' }),
    thread_session_map_id: text('thread_session_map_id', { length: 36 })
      .notNull()
      .references(() => threadSessionMap.id, { onDelete: 'cascade' }),
    provider_installation_id: text('provider_installation_id').notNull(),
    provider_config_generation: integer('provider_config_generation').notNull(),
    status: text('status', {
      enum: ['pending', 'processing', 'completed', 'canceled', 'dead_letter'],
    })
      .notNull()
      .default('pending'),
    attempt_count: integer('attempt_count').notNull().default(0),
    next_attempt_at: t.timestamp('next_attempt_at').notNull(),
    claim_token: text('claim_token'),
    claim_expires_at: t.timestamp('claim_expires_at'),
    claim_generation: integer('claim_generation').notNull().default(0),
    ambiguous_chunk_index: integer('ambiguous_chunk_index'),
    effect_started_at: t.timestamp('effect_started_at'),
    effect_recovery_grace_until: t.timestamp('effect_recovery_grace_until'),
    chunk_receipts: t
      .json<import('../types/gateway').DiscordMessageDeliveryChunkReceipt[]>('chunk_receipts')
      .notNull(),
    reply_aliases: t.json<string[]>('reply_aliases').notNull(),
    last_error_code: text('last_error_code'),
    completed_at: t.timestamp('completed_at'),
    canceled_at: t.timestamp('canceled_at'),
    dead_lettered_at: t.timestamp('dead_lettered_at'),
  },
  (table) => ({
    messageUnique: uniqueIndex('discord_message_deliveries_message_unique').on(table.message_id),
    dueIdx: index('discord_message_deliveries_due_idx').on(
      table.status,
      table.next_attempt_at,
      table.delivery_id
    ),
    claimIdx: index('discord_message_deliveries_claim_idx').on(
      table.status,
      table.claim_expires_at,
      table.delivery_id
    ),
  })
);

/**
 * Gateway Outbound Messages table - Durable audit/seed rows for proactive outbound messages.
 *
 * Proactive emits seed external platform threads. They intentionally do NOT create
 * thread_session_map rows until a human replies, preserving the invariant that one
 * external conversation maps to one Agor session.
 */
export const gatewayOutboundMessages = sqliteTable(
  'gateway_outbound_messages',
  {
    id: text('id', { length: 36 }).primaryKey(),
    created_at: t.timestamp('created_at').notNull(),
    updated_at: t.timestamp('updated_at').notNull(),

    gateway_channel_id: text('gateway_channel_id', { length: 36 })
      .notNull()
      .references(() => gatewayChannels.id, { onDelete: 'cascade' }),
    channel_type: text('channel_type', {
      enum: ['slack', 'discord', 'whatsapp', 'telegram', 'github', 'teams', 'shortcut'],
    }).notNull(),

    platform_channel_id: text('platform_channel_id').notNull(),
    platform_message_id: text('platform_message_id').notNull(),
    platform_thread_id: text('platform_thread_id').notNull(),
    platform_permalink: text('platform_permalink'),

    target_branch_id: text('target_branch_id', { length: 36 })
      .notNull()
      .references(() => branches.branch_id),
    emitted_by_user_id: text('emitted_by_user_id', { length: 36 })
      .notNull()
      .references(() => users.user_id),
    emitted_by_session_id: text('emitted_by_session_id', { length: 36 }).references(
      () => sessions.session_id,
      {
        onDelete: 'set null',
      }
    ),
    emitted_by_task_id: text('emitted_by_task_id', { length: 36 }).references(() => tasks.task_id, {
      onDelete: 'set null',
    }),
    emitted_by_schedule_id: text('emitted_by_schedule_id', { length: 36 }).references(
      () => schedules.schedule_id,
      {
        onDelete: 'set null',
      }
    ),

    message_text: text('message_text').notNull(),
    message_preview: text('message_preview').notNull(),
    metadata: t.json<Record<string, unknown> | null>('metadata'),
    consumed_by_session_id: text('consumed_by_session_id', { length: 36 }).references(
      () => sessions.session_id,
      {
        onDelete: 'set null',
      }
    ),
    consumed_at: t.timestamp('consumed_at'),
  },
  (table) => ({
    uniqueChannelThread: uniqueIndex('uniq_gateway_outbound_channel_thread').on(
      table.gateway_channel_id,
      table.platform_thread_id
    ),
    emittedSessionIdx: index('idx_gateway_outbound_emitted_session').on(
      table.emitted_by_session_id
    ),
    emittedScheduleIdx: index('idx_gateway_outbound_emitted_schedule').on(
      table.emitted_by_schedule_id
    ),
    targetBranchCreatedIdx: index('idx_gateway_outbound_branch_created').on(
      table.target_branch_id,
      table.created_at
    ),
    consumedIdx: index('idx_gateway_outbound_consumed').on(table.consumed_at),
  })
);

/**
 * Session Env Selections - Many-to-many between sessions and session-scope env vars.
 *
 * Records which of a user's scope='session' env vars are exposed to a given session
 * at spawn time. Global-scope vars are always included; session-scope vars only
 * appear in the session's effective env when a row in this table says so.
 *
 * v0.5: env vars are keyed by name inside `users.data.env_vars` (no env_vars.id yet).
 * Rows scope implicitly to `session.created_by`.
 *
 * See `context/explorations/env-var-access.md`.
 */
export const sessionEnvSelections = sqliteTable(
  'session_env_selections',
  {
    session_id: text('session_id', { length: 36 })
      .notNull()
      .references(() => sessions.session_id, { onDelete: 'cascade' }),
    env_var_name: text('env_var_name').notNull(),
    created_at: t.timestamp('created_at').notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.session_id, table.env_var_name] }),
    sessionIdx: index('session_env_selections_session_idx').on(table.session_id),
  })
);

/**
 * Knowledge namespaces - first-class scopes for DB-backed knowledge documents.
 * URI shape: agor://kb/<namespace.slug>/<document.path>
 */
export const kbNamespaces = sqliteTable(
  'kb_namespaces',
  {
    namespace_id: text('namespace_id', { length: 36 }).primaryKey(),
    slug: text('slug').notNull(),
    display_name: text('display_name').notNull(),
    description: text('description'),
    kind: text('kind', { enum: ['system', 'global', 'user', 'repo', 'branch', 'team'] })
      .notNull()
      .default('global'),
    owner_user_id: text('owner_user_id', { length: 36 }).references(() => users.user_id, {
      onDelete: 'set null',
    }),
    repo_id: text('repo_id', { length: 36 }).references(() => repos.repo_id, {
      onDelete: 'set null',
    }),
    branch_id: text('branch_id', { length: 36 }).references(() => branches.branch_id, {
      onDelete: 'set null',
    }),
    visibility_default: text('visibility_default', { enum: ['public', 'private'] })
      .notNull()
      .default('public'),
    others_can: text('others_can', { enum: ['none', 'read', 'write'] })
      .notNull()
      .default('write'),
    metadata: t.json<Record<string, unknown>>('metadata'),
    created_by: text('created_by', { length: 36 }).references(() => users.user_id, {
      onDelete: 'set null',
    }),
    created_at: t.timestamp('created_at').notNull(),
    updated_at: t.timestamp('updated_at'),
    archived: t.bool('archived').notNull().default(false),
    archived_at: t.timestamp('archived_at'),
  },
  (table) => ({
    slugIdx: uniqueIndex('kb_namespaces_slug_idx')
      .on(table.slug)
      .where(sql`${table.archived} = false`),
    kindIdx: index('kb_namespaces_kind_idx').on(table.kind),
    ownerIdx: index('kb_namespaces_owner_idx').on(table.owner_user_id),
    repoIdx: index('kb_namespaces_repo_idx').on(table.repo_id),
    branchIdx: index('kb_namespaces_branch_idx').on(table.branch_id),
    archivedIdx: index('kb_namespaces_archived_idx').on(table.archived),
  })
);

/**
 * Knowledge namespace ACL entries - explicit user/group grants for namespace RBAC.
 */
export const kbNamespaceAcl = sqliteTable(
  'kb_namespace_acl',
  {
    namespace_acl_id: text('namespace_acl_id', { length: 36 }).primaryKey(),
    namespace_id: text('namespace_id', { length: 36 })
      .notNull()
      .references(() => kbNamespaces.namespace_id, { onDelete: 'cascade' }),
    subject_type: text('subject_type', { enum: ['user', 'group'] }).notNull(),
    subject_id: text('subject_id', { length: 36 }).notNull(),
    permission: text('permission', { enum: ['read', 'write', 'own'] }).notNull(),
    created_by: text('created_by', { length: 36 }).references(() => users.user_id, {
      onDelete: 'set null',
    }),
    created_at: t.timestamp('created_at').notNull(),
    updated_at: t.timestamp('updated_at'),
  },
  (table) => ({
    namespaceIdx: index('kb_namespace_acl_namespace_idx').on(table.namespace_id),
    subjectIdx: index('kb_namespace_acl_subject_idx').on(table.subject_type, table.subject_id),
    namespaceSubjectIdx: uniqueIndex('kb_namespace_acl_namespace_subject_idx').on(
      table.namespace_id,
      table.subject_type,
      table.subject_id
    ),
  })
);

/**
 * Knowledge documents - stable namespace/path identity and current-version state.
 */
export const kbDocuments = sqliteTable(
  'kb_documents',
  {
    document_id: text('document_id', { length: 36 }).primaryKey(),
    namespace_id: text('namespace_id', { length: 36 })
      .notNull()
      .references(() => kbNamespaces.namespace_id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    uri: text('uri').notNull(),
    title: text('title').notNull(),
    icon_emoji: text('icon_emoji'),
    kind: text('kind', {
      enum: ['doc', 'memory', 'skill', 'prompt', 'guide', 'decision', 'bundle', 'external'],
    })
      .notNull()
      .default('doc'),
    visibility: text('visibility', { enum: ['public', 'private'] })
      .notNull()
      .default('public'),
    status: text('status', { enum: ['draft', 'published'] })
      .notNull()
      .default('published'),
    edit_policy: text('edit_policy', { enum: ['owner', 'public', 'admins'] })
      .notNull()
      .default('owner'),
    // Application-maintained pointer. Avoids a circular FK with versions.
    current_version_id: text('current_version_id', { length: 36 }),
    metadata: t.json<Record<string, unknown>>('metadata'),
    created_by: text('created_by', { length: 36 }).references(() => users.user_id, {
      onDelete: 'set null',
    }),
    created_at: t.timestamp('created_at').notNull(),
    updated_by: text('updated_by', { length: 36 }).references(() => users.user_id, {
      onDelete: 'set null',
    }),
    updated_by_session_id: text('updated_by_session_id', { length: 36 }),
    updated_by_agentic_tool: text('updated_by_agentic_tool'),
    updated_by_teammate_name: text('updated_by_teammate_name'),
    updated_at: t.timestamp('updated_at'),
    archived: t.bool('archived').notNull().default(false),
    archived_at: t.timestamp('archived_at'),
  },
  (table) => ({
    namespacePathIdx: uniqueIndex('kb_documents_namespace_path_idx')
      .on(table.namespace_id, table.path)
      .where(sql`${table.archived} = false`),
    uriIdx: uniqueIndex('kb_documents_uri_idx').on(table.uri).where(sql`${table.archived} = false`),
    namespaceIdx: index('kb_documents_namespace_idx').on(table.namespace_id),
    kindIdx: index('kb_documents_kind_idx').on(table.kind),
    visibilityIdx: index('kb_documents_visibility_idx').on(table.visibility),
    statusIdx: index('kb_documents_status_idx').on(table.status),
    createdByIdx: index('kb_documents_created_by_idx').on(table.created_by),
    updatedAtIdx: index('kb_documents_updated_at_idx').on(table.updated_at),
    archivedIdx: index('kb_documents_archived_idx').on(table.archived),
  })
);

/**
 * Immutable document content snapshots.
 */
export const kbDocumentVersions = sqliteTable(
  'kb_document_versions',
  {
    version_id: text('version_id', { length: 36 }).primaryKey(),
    document_id: text('document_id', { length: 36 })
      .notNull()
      .references(() => kbDocuments.document_id, { onDelete: 'cascade' }),
    version_number: integer('version_number').notNull(),
    content_text: text('content_text'),
    content_blob: blob('content_blob'),
    mime_type: text('mime_type').notNull().default('text/markdown'),
    content_md5: text('content_md5'),
    content_sha256: text('content_sha256'),
    byte_length: integer('byte_length'),
    char_length: integer('char_length'),
    frontmatter: t.json<Record<string, unknown>>('frontmatter'),
    metadata: t.json<Record<string, unknown>>('metadata'),
    change_summary: text('change_summary'),
    created_by: text('created_by', { length: 36 }).references(() => users.user_id, {
      onDelete: 'set null',
    }),
    created_by_session_id: text('created_by_session_id', { length: 36 }),
    created_by_agentic_tool: text('created_by_agentic_tool'),
    created_by_teammate_name: text('created_by_teammate_name'),
    created_at: t.timestamp('created_at').notNull(),
  },
  (table) => ({
    documentVersionIdx: uniqueIndex('kb_document_versions_document_version_idx').on(
      table.document_id,
      table.version_number
    ),
    documentIdx: index('kb_document_versions_document_idx').on(table.document_id),
    createdIdx: index('kb_document_versions_created_idx').on(table.created_at),
    md5Idx: index('kb_document_versions_md5_idx').on(table.content_md5),
  })
);

/**
 * Internal search units. V1 can create one unit per document version; later
 * versions may create heading/file units without exposing arbitrary chunks.
 */
export const kbDocumentUnits = sqliteTable(
  'kb_document_units',
  {
    unit_id: text('unit_id', { length: 36 }).primaryKey(),
    document_id: text('document_id', { length: 36 })
      .notNull()
      .references(() => kbDocuments.document_id, { onDelete: 'cascade' }),
    version_id: text('version_id', { length: 36 })
      .notNull()
      .references(() => kbDocumentVersions.version_id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['document', 'section', 'file', 'auto_split'] })
      .notNull()
      .default('document'),
    ordinal: integer('ordinal').notNull().default(0),
    path_anchor: text('path_anchor'),
    heading_path: text('heading_path'),
    source_path: text('source_path'),
    content_text: text('content_text'),
    content_md5: text('content_md5'),
    start_offset: integer('start_offset'),
    end_offset: integer('end_offset'),
    embedding_status: text('embedding_status', {
      enum: ['not_configured', 'pending', 'ready', 'stale', 'error'],
    })
      .notNull()
      .default('not_configured'),
    embedding_model: text('embedding_model'),
    embedding_dimensions: integer('embedding_dimensions'),
    embedding_hash: text('embedding_hash'),
    embedding_error: text('embedding_error'),
    // Kept in schema parity with PostgreSQL. SQLite semantic vector indexing
    // remains disabled, so these fields stay at their standalone defaults.
    embedding_claim_token: text('embedding_claim_token'),
    embedding_claim_generation: integer('embedding_claim_generation').notNull().default(0),
    embedding_claimed_at: t.timestamp('embedding_claimed_at'),
    embedding_claim_expires_at: t.timestamp('embedding_claim_expires_at'),
    embedding_claim_instance_id: text('embedding_claim_instance_id'),
    embedding_claim_boot_id: text('embedding_claim_boot_id'),
    embedding_failure_count: integer('embedding_failure_count').notNull().default(0),
    embedding_retry_at: t.timestamp('embedding_retry_at'),
    metadata: t.json<Record<string, unknown>>('metadata'),
    created_at: t.timestamp('created_at').notNull(),
    updated_at: t.timestamp('updated_at'),
  },
  (table) => ({
    documentIdx: index('kb_document_units_document_idx').on(table.document_id),
    versionIdx: index('kb_document_units_version_idx').on(table.version_id),
    versionOrdinalIdx: index('kb_document_units_version_ordinal_idx').on(
      table.version_id,
      table.ordinal
    ),
    contentHashIdx: index('kb_document_units_content_hash_idx').on(table.content_md5),
    embeddingStatusIdx: index('kb_document_units_embedding_status_idx').on(table.embedding_status),
    embeddingWorkScanIdx: index('kb_document_units_embedding_work_scan_idx')
      .on(table.created_at, table.unit_id)
      .where(
        sql`${table.content_text} IS NOT NULL AND ${table.embedding_status} IN ('pending', 'stale', 'error')`
      ),
  })
);

/** Embedding spaces configured for Knowledge semantic search metadata. */
export const kbEmbeddingSpaces = sqliteTable(
  'kb_embedding_spaces',
  {
    embedding_space_id: text('embedding_space_id', { length: 36 }).primaryKey(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    dimensions: integer('dimensions').notNull(),
    storage_type: text('storage_type').notNull().default('vector'),
    distance: text('distance').notNull().default('cosine'),
    active: t.bool('active').notNull().default(true),
    metadata: t.json<Record<string, unknown>>('metadata'),
    created_at: t.timestamp('created_at').notNull(),
    updated_at: t.timestamp('updated_at'),
  },
  (table) => ({
    providerModelIdx: uniqueIndex('kb_embedding_spaces_provider_model_idx').on(
      table.provider,
      table.model,
      table.dimensions,
      table.storage_type,
      table.distance
    ),
    activeIdx: index('kb_embedding_spaces_active_idx').on(table.active),
  })
);

/**
 * Graph nodes for knowledge documents, document units, core Agor objects, tags,
 * and external references.
 */
export const kbGraphNodes = sqliteTable(
  'kb_graph_nodes',
  {
    node_id: text('node_id', { length: 36 }).primaryKey(),
    node_type: text('node_type', {
      enum: [
        'namespace',
        'document',
        'document_unit',
        'branch',
        'session',
        'task',
        'message',
        'artifact',
        'repo',
        'board',
        'user',
        'tag',
        'external',
      ],
    }).notNull(),
    uri: text('uri').notNull(),
    label: text('label'),
    namespace_id: text('namespace_id', { length: 36 }).references(() => kbNamespaces.namespace_id, {
      onDelete: 'cascade',
    }),
    document_id: text('document_id', { length: 36 }).references(() => kbDocuments.document_id, {
      onDelete: 'cascade',
    }),
    unit_id: text('unit_id', { length: 36 }).references(() => kbDocumentUnits.unit_id, {
      onDelete: 'cascade',
    }),
    branch_id: text('branch_id', { length: 36 }).references(() => branches.branch_id, {
      onDelete: 'cascade',
    }),
    session_id: text('session_id', { length: 36 }).references(() => sessions.session_id, {
      onDelete: 'cascade',
    }),
    task_id: text('task_id', { length: 36 }).references(() => tasks.task_id, {
      onDelete: 'cascade',
    }),
    message_id: text('message_id', { length: 36 }).references(() => messages.message_id, {
      onDelete: 'cascade',
    }),
    artifact_id: text('artifact_id', { length: 36 }).references(() => artifacts.artifact_id, {
      onDelete: 'cascade',
    }),
    repo_id: text('repo_id', { length: 36 }).references(() => repos.repo_id, {
      onDelete: 'cascade',
    }),
    board_id: text('board_id', { length: 36 }).references(() => boards.board_id, {
      onDelete: 'cascade',
    }),
    user_id: text('user_id', { length: 36 }).references(() => users.user_id, {
      onDelete: 'cascade',
    }),
    external_uri: text('external_uri'),
    metadata: t.json<Record<string, unknown>>('metadata'),
    created_by: text('created_by', { length: 36 }).references(() => users.user_id, {
      onDelete: 'set null',
    }),
    created_at: t.timestamp('created_at').notNull(),
    updated_at: t.timestamp('updated_at'),
    archived: t.bool('archived').notNull().default(false),
    archived_at: t.timestamp('archived_at'),
  },
  (table) => ({
    uriIdx: uniqueIndex('kb_graph_nodes_uri_idx')
      .on(table.uri)
      .where(sql`${table.archived} = false`),
    typeIdx: index('kb_graph_nodes_type_idx').on(table.node_type),
    namespaceIdx: index('kb_graph_nodes_namespace_idx').on(table.namespace_id),
    documentIdx: index('kb_graph_nodes_document_idx').on(table.document_id),
    unitIdx: index('kb_graph_nodes_unit_idx').on(table.unit_id),
    branchIdx: index('kb_graph_nodes_branch_idx').on(table.branch_id),
    sessionIdx: index('kb_graph_nodes_session_idx').on(table.session_id),
    taskIdx: index('kb_graph_nodes_task_idx').on(table.task_id),
    messageIdx: index('kb_graph_nodes_message_idx').on(table.message_id),
    artifactIdx: index('kb_graph_nodes_artifact_idx').on(table.artifact_id),
    repoIdx: index('kb_graph_nodes_repo_idx').on(table.repo_id),
    boardIdx: index('kb_graph_nodes_board_idx').on(table.board_id),
    userIdx: index('kb_graph_nodes_user_idx').on(table.user_id),
    externalUriIdx: index('kb_graph_nodes_external_uri_idx').on(table.external_uri),
    archivedIdx: index('kb_graph_nodes_archived_idx').on(table.archived),
  })
);

/** Directed relationships between knowledge graph nodes. */
export const kbGraphEdges = sqliteTable(
  'kb_graph_edges',
  {
    edge_id: text('edge_id', { length: 36 }).primaryKey(),
    source_node_id: text('source_node_id', { length: 36 })
      .notNull()
      .references(() => kbGraphNodes.node_id, { onDelete: 'cascade' }),
    target_node_id: text('target_node_id', { length: 36 })
      .notNull()
      .references(() => kbGraphNodes.node_id, { onDelete: 'cascade' }),
    edge_type: text('edge_type', {
      enum: [
        'contains',
        'references',
        'mentions',
        'implements',
        'depends_on',
        'supersedes',
        'derived_from',
        'tagged_with',
        'about',
        'parent_of',
        'related_to',
      ],
    }).notNull(),
    confidence: integer('confidence'),
    properties: t.json<Record<string, unknown>>('properties'),
    created_by: text('created_by', { length: 36 }).references(() => users.user_id, {
      onDelete: 'set null',
    }),
    created_at: t.timestamp('created_at').notNull(),
    archived: t.bool('archived').notNull().default(false),
    archived_at: t.timestamp('archived_at'),
  },
  (table) => ({
    sourceIdx: index('kb_graph_edges_source_idx').on(table.source_node_id),
    targetIdx: index('kb_graph_edges_target_idx').on(table.target_node_id),
    typeIdx: index('kb_graph_edges_type_idx').on(table.edge_type),
    sourceTypeIdx: index('kb_graph_edges_source_type_idx').on(
      table.source_node_id,
      table.edge_type
    ),
    targetTypeIdx: index('kb_graph_edges_target_type_idx').on(
      table.target_node_id,
      table.edge_type
    ),
    sourceTargetTypeIdx: uniqueIndex('kb_graph_edges_source_target_type_idx')
      .on(table.source_node_id, table.target_node_id, table.edge_type)
      .where(sql`${table.archived} = false`),
    archivedIdx: index('kb_graph_edges_archived_idx').on(table.archived),
  })
);

/**
 * Type exports for use with Drizzle ORM
 */
export type SessionRow = typeof sessions.$inferSelect;
export type SessionInsert = typeof sessions.$inferInsert;
export type SessionRelationshipRow = typeof sessionRelationships.$inferSelect;
export type SessionRelationshipInsert = typeof sessionRelationships.$inferInsert;
export type TaskRow = typeof tasks.$inferSelect;
export type TaskInsert = typeof tasks.$inferInsert;
export type ExecutorSessionTokenAuthorityRow = typeof executorSessionTokenAuthorities.$inferSelect;
export type ExecutorSessionTokenAuthorityInsert =
  typeof executorSessionTokenAuthorities.$inferInsert;
export type GitHubInstallStateRow = typeof githubInstallStates.$inferSelect;
export type GitHubInstallStateInsert = typeof githubInstallStates.$inferInsert;
export type MessageRow = typeof messages.$inferSelect;
export type MessageInsert = typeof messages.$inferInsert;
export type BoardRow = typeof boards.$inferSelect;
export type BoardInsert = typeof boards.$inferInsert;
export type RepoRow = typeof repos.$inferSelect;
export type RepoInsert = typeof repos.$inferInsert;
export type BranchRow = typeof branches.$inferSelect;
export type BranchInsert = typeof branches.$inferInsert;
export type ScheduleRow = typeof schedules.$inferSelect;
export type ScheduleInsert = typeof schedules.$inferInsert;
export type UserRow = typeof users.$inferSelect;
export type UserInsert = typeof users.$inferInsert;
export type UserExternalIdentityRow = typeof userExternalIdentities.$inferSelect;
export type UserExternalIdentityInsert = typeof userExternalIdentities.$inferInsert;
export type AppVariableRow = typeof appVariables.$inferSelect;
export type AppVariableInsert = typeof appVariables.$inferInsert;
export type AgenticToolPresetRow = typeof agenticToolPresets.$inferSelect;
export type AgenticToolPresetInsert = typeof agenticToolPresets.$inferInsert;
export type GroupRow = typeof groups.$inferSelect;
export type GroupInsert = typeof groups.$inferInsert;
export type GroupMembershipRow = typeof groupMemberships.$inferSelect;
export type GroupMembershipInsert = typeof groupMemberships.$inferInsert;
export type BoardAccessPolicyRow = typeof boardAccessPolicies.$inferSelect;
export type BoardAccessEntryRow = typeof boardAccessEntries.$inferSelect;
export type BranchPermissionConfigRow = typeof branchPermissionConfigs.$inferSelect;
export type BranchPermissionEntryRow = typeof branchPermissionEntries.$inferSelect;
export type BranchGroupGrantRow = typeof branchGroupGrants.$inferSelect;
export type BoardGroupGrantRow = typeof boardGroupGrants.$inferSelect;
export type BoardOwnerRow = typeof boardOwners.$inferSelect;
export type BranchGroupGrantInsert = typeof branchGroupGrants.$inferInsert;
export type MCPServerRow = typeof mcpServers.$inferSelect;
export type MCPServerInsert = typeof mcpServers.$inferInsert;
export type SessionMCPServerRow = typeof sessionMcpServers.$inferSelect;
export type SessionMCPServerInsert = typeof sessionMcpServers.$inferInsert;
export type SessionEnvSelectionRow = typeof sessionEnvSelections.$inferSelect;
export type SessionEnvSelectionInsert = typeof sessionEnvSelections.$inferInsert;
export type UserMCPOAuthTokenRow = typeof userMcpOauthTokens.$inferSelect;
export type UserMCPOAuthTokenInsert = typeof userMcpOauthTokens.$inferInsert;
export type MCPOAuthPendingFlowRow = typeof mcpOauthPendingFlows.$inferSelect;
export type MCPOAuthPendingFlowInsert = typeof mcpOauthPendingFlows.$inferInsert;
export type ClaudeOAuthAttemptRow = typeof claudeOauthAttempts.$inferSelect;
export type ClaudeOAuthAttemptInsert = typeof claudeOauthAttempts.$inferInsert;
export type CodexDeviceAuthAttemptRow = typeof codexDeviceAuthAttempts.$inferSelect;
export type CodexDeviceAuthAttemptInsert = typeof codexDeviceAuthAttempts.$inferInsert;
export type CardTypeRow = typeof cardTypes.$inferSelect;
export type CardTypeInsert = typeof cardTypes.$inferInsert;
export type CardRow = typeof cards.$inferSelect;
export type CardInsert = typeof cards.$inferInsert;
export type BoardObjectRow = typeof boardObjects.$inferSelect;
export type BoardObjectInsert = typeof boardObjects.$inferInsert;
export type BoardCommentRow = typeof boardComments.$inferSelect;
export type BoardCommentInsert = typeof boardComments.$inferInsert;
export type GatewayChannelRow = typeof gatewayChannels.$inferSelect;
export type GatewayChannelInsert = typeof gatewayChannels.$inferInsert;
export type ThreadSessionMapRow = typeof threadSessionMap.$inferSelect;
export type ThreadSessionMapInsert = typeof threadSessionMap.$inferInsert;
export type DiscordMessageDeliveryRow = typeof discordMessageDeliveries.$inferSelect;
export type DiscordMessageDeliveryInsert = typeof discordMessageDeliveries.$inferInsert;
export type GatewayOutboundMessageRow = typeof gatewayOutboundMessages.$inferSelect;
export type GatewayOutboundMessageInsert = typeof gatewayOutboundMessages.$inferInsert;
export type GatewayInboundEventRow = typeof gatewayInboundEvents.$inferSelect;
export type GatewayInboundEventInsert = typeof gatewayInboundEvents.$inferInsert;
export type UploadRow = typeof uploads.$inferSelect;
export type UploadInsert = typeof uploads.$inferInsert;
export type KBNamespaceRow = typeof kbNamespaces.$inferSelect;
export type KBNamespaceInsert = typeof kbNamespaces.$inferInsert;
export type KBNamespaceAclRow = typeof kbNamespaceAcl.$inferSelect;
export type KBNamespaceAclInsert = typeof kbNamespaceAcl.$inferInsert;
export type KBDocumentRow = typeof kbDocuments.$inferSelect;
export type KBDocumentInsert = typeof kbDocuments.$inferInsert;
export type KBDocumentVersionRow = typeof kbDocumentVersions.$inferSelect;
export type KBDocumentVersionInsert = typeof kbDocumentVersions.$inferInsert;
export type KBDocumentUnitRow = typeof kbDocumentUnits.$inferSelect;
export type KBDocumentUnitInsert = typeof kbDocumentUnits.$inferInsert;
export type KBEmbeddingSpaceRow = typeof kbEmbeddingSpaces.$inferSelect;
export type KBEmbeddingSpaceInsert = typeof kbEmbeddingSpaces.$inferInsert;
export type KBGraphNodeRow = typeof kbGraphNodes.$inferSelect;
export type KBGraphNodeInsert = typeof kbGraphNodes.$inferInsert;
export type KBGraphEdgeRow = typeof kbGraphEdges.$inferSelect;
export type KBGraphEdgeInsert = typeof kbGraphEdges.$inferInsert;

/**
 * Drizzle Relations for Relational Queries
 *
 * These enable automatic JOINs using db.query.sessions.findFirst({ with: { branch: true } })
 */

export const sessionsRelations = relations(sessions, ({ one, many }) => ({
  branch: one(branches, {
    fields: [sessions.branch_id],
    references: [branches.branch_id],
  }),
  schedule: one(schedules, {
    fields: [sessions.schedule_id],
    references: [schedules.schedule_id],
  }),
  outboundRelationships: many(sessionRelationships, { relationName: 'relationshipSource' }),
  inboundRelationships: many(sessionRelationships, { relationName: 'relationshipTarget' }),
}));

export const sessionRelationshipsRelations = relations(sessionRelationships, ({ one }) => ({
  sourceSession: one(sessions, {
    fields: [sessionRelationships.source_session_id],
    references: [sessions.session_id],
    relationName: 'relationshipSource',
  }),
  targetSession: one(sessions, {
    fields: [sessionRelationships.target_session_id],
    references: [sessions.session_id],
    relationName: 'relationshipTarget',
  }),
  callbackSession: one(sessions, {
    fields: [sessionRelationships.callback_session_id],
    references: [sessions.session_id],
  }),
}));

export const branchesRelations = relations(branches, ({ many }) => ({
  sessions: many(sessions),
  schedules: many(schedules),
}));

export const schedulesRelations = relations(schedules, ({ one, many }) => ({
  branch: one(branches, {
    fields: [schedules.branch_id],
    references: [branches.branch_id],
  }),
  sessions: many(sessions),
}));
