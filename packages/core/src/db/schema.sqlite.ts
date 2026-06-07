/**
 * SQLite Schema Definition
 *
 * Uses type factory helpers for the 3 differing types (timestamp, boolean, json).
 * All other types (text, index, foreign keys) are identical to PostgreSQL schema.
 */

import type {
  AgorGrants,
  AgorRuntimeConfig,
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

    // Unix username for SDK impersonation (immutable once set)
    // Set from creator's unix_username at session creation time
    // NEVER changes, even if user's unix_username changes later
    // This ensures SDK session data remains accessible in the original home directory
    unix_username: text('unix_username'),

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
      enum: ['claude-code', 'claude-code-cli', 'codex', 'gemini', 'opencode', 'copilot', 'cursor'],
    }).notNull(),
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

    // UI state (materialized for efficient highlighting queries)
    ready_for_prompt: t.bool('ready_for_prompt').notNull().default(false),

    // Archive state (cascaded from branch archive)
    archived: t.bool('archived').notNull().default(false),
    archived_reason: text('archived_reason', {
      enum: ['branch_archived', 'manual', 'btw_completed'],
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

        // Git state
        git_state: Session['git_state'];

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
        };

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
        custom_context?: Record<string, unknown> & {
          // Scheduled run metadata (populated by scheduler)
          scheduled_run?: {
            rendered_prompt: string; // Template after Handlebars rendering
            run_index: number; // 1st, 2nd, 3rd run for this schedule
            schedule_config_snapshot?: {
              cron: string;
              timezone: string;
              retention: number;
            };
          };
        };

        // Claude Code CLI adapter state (only set when agentic_tool === 'claude-code-cli').
        // Persisted so the daemon can re-instantiate the JSONL watcher across
        // daemon restarts without losing offset. See
        // apps/agor-daemon/src/services/claude-cli-watcher.ts and
        // docs/internal/claude-code-cli-integration-analysis-2026-05-14.md.
        cli_state?: {
          // Bytes consumed from the JSONL — resume point on watcher restart.
          watcher_offset?: number;
          // Last processed JSONL line's `timestamp` (ISO 8601). Telemetry only.
          last_event_ts?: string;
          // Last processed JSONL line's `uuid`. Used for "did we miss anything?"
          // sanity checks against `loadSessionUsageById` on resume.
          last_event_uuid?: string;
          // The slugged JSONL directory under ~/.claude/projects/. Cached at
          // spawn time so we don't recompute the slug on every event.
          slug?: string;
          // Absolute path to the JSONL file the watcher tails.
          jsonl_path?: string;
          // Zellij pane handle so PTY injection (Zellij `action write-chars`)
          // can target this session specifically.
          zellij_pane_id?: string;
          zellij_tab_name?: string;
          // In-flight turn snapshot for daemon-restart recovery — written
          // on user_message, cleared on turn_end. See
          // Session['cli_state']['active_turn'] in types/session.ts.
          active_turn?: {
            task_id: string;
            user_message_index: number;
            started_at_ms: number;
          } | null;
        };

        // Billing model for this session.
        // - 'subscription': running against the user's Claude Pro/Max
        //   subscription's interactive limits (CLI adapter, default).
        // - 'api-key': ANTHROPIC_API_KEY was set at spawn → per-token billing.
        // - 'unknown': legacy rows or pre-flag detection.
        // Drives the cost-UI caption ("Estimated; covered by your subscription")
        // and any future 5h-billing-window banner.
        billing_mode?: 'subscription' | 'api-key' | 'unknown';
      }>()
      .notNull(),
  },
  (table) => ({
    statusIdx: index('sessions_status_idx').on(table.status),
    agenticToolIdx: index('sessions_agentic_tool_idx').on(table.agentic_tool),
    boardIdx: index('sessions_board_idx').on(table.board_id),
    branchIdx: index('sessions_branch_idx').on(table.branch_id),
    createdIdx: index('sessions_created_idx').on(table.created_at),
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
    completed_at: t.timestamp('completed_at'),
    last_executor_heartbeat_at: t.timestamp('last_executor_heartbeat_at'),
    status: text('status', {
      enum: [
        'queued',
        'created',
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

    // MD5 of SDK session file at task completion (only populated when stateless_fs_mode is enabled)
    session_md5: text('session_md5'),

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
      }>()
      .notNull(),
  },
  (table) => ({
    sessionIdx: index('tasks_session_idx').on(table.session_id),
    statusIdx: index('tasks_status_idx').on(table.status),
    createdIdx: index('tasks_created_idx').on(table.created_at),
    queueIdx: index('tasks_queue_idx').on(table.session_id, table.status, table.queue_position),
    // Partial unique index — defense-in-depth for `tasks.createPending` race
    // serialization. Only QUEUED rows are constrained; CREATED/RUNNING/done
    // rows have NULL queue_position and are unaffected.
    queuedPositionUnique: uniqueIndex('tasks_queued_position_unique')
      .on(table.session_id, table.queue_position)
      .where(sql`${table.status} = 'queued'`),
  })
);

/**
 * Serialized Sessions table - SDK session file snapshots for stateless_fs_mode
 *
 * When stateless_fs_mode is enabled, the SDK session file (JSONL transcript) is
 * serialized to this table after each turn. This allows sessions to survive pod
 * restarts/rescheduling in k8s environments without persistent volumes.
 */
export const serializedSessions = sqliteTable(
  'serialized_sessions',
  {
    id: text('id', { length: 36 }).primaryKey(),
    session_id: text('session_id', { length: 36 })
      .notNull()
      .references(() => sessions.session_id, { onDelete: 'cascade' }),
    branch_id: text('branch_id', { length: 36 })
      .notNull()
      .references(() => branches.branch_id, { onDelete: 'cascade' }),
    task_id: text('task_id', { length: 36 }).references(() => tasks.task_id, {
      onDelete: 'set null',
    }),
    turn_index: integer('turn_index').notNull().default(0),
    created_at: t.timestamp('created_at').notNull(),
    md5: text('md5').notNull(),
    status: text('status').notNull(), // 'processing' | 'done' — validated at app layer
    payload: blob('payload', { mode: 'buffer' }), // gzipped; NULL while status='processing'
  },
  (table) => ({
    sessionTurnIdx: index('serialized_sessions_session_turn_idx').on(
      table.session_id,
      table.turn_index
    ),
    branchIdx: index('serialized_sessions_branch_idx').on(table.branch_id),
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
    sessionIndexIdx: index('messages_session_index_idx').on(table.session_id, table.index),
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

    // Materialized for lookups
    name: text('name').notNull(),
    slug: text('slug').unique(),
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

    // Unix group for repo-level git access (agor_rp_<short-id>)
    // Users who have access to ANY branch in this repo get added to this group.
    // Applied to repo Unix-group-managed paths:
    // - repo root (non-recursive) for traversal into .git/worktrees/<name>
    // - .git (recursive) for shared git objects/refs and git operations
    unix_group: text('unix_group'),

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
          category: 'auth_failed' | 'not_found' | 'network' | 'unknown';
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
    others_can: text('others_can', {
      enum: [...BRANCH_PERMISSION_LEVELS],
    }).default('view'),

    // RBAC: OS-layer permissions (unix-user-modes.md)
    unix_group: text('unix_group'), // e.g., 'agor_wt_abc123'
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

    // JSON blob for everything else
    data: t
      .json<unknown>('data')
      .$type<{
        // File system
        path: string; // Absolute path to branch directory

        // Git state (current)
        base_ref?: string; // Branch this diverged from (e.g., "main")
        base_sha?: string; // SHA at branch creation
        last_commit_sha?: string; // Latest commit
        tracking_branch?: string; // Remote tracking branch
        new_branch: boolean; // Created by Agor?

        // Work context (persistent across sessions)
        issue_url?: string; // GitHub/GitLab issue
        pull_request_url?: string; // PR link
        notes?: string; // Freeform user notes
        error_message?: string; // Error details when filesystem_status is 'failed'

        // Environment instance (runtime state only, no variables)
        environment_instance?: {
          status: 'stopped' | 'starting' | 'running' | 'stopping' | 'error';
          process?: {
            pid?: number;
            started_at?: string;
            uptime?: string;
          };
          last_health_check?: {
            timestamp: string;
            status: 'healthy' | 'unhealthy' | 'unknown';
            message?: string;
          };
          access_urls?: Array<{
            name: string;
            url: string;
          }>;
          logs?: string[];
        };

        last_used: string; // ISO timestamp

        // Custom context for templates (accessible as {{custom.*}})
        custom_context?: Record<string, unknown>;

        // Default MCP servers for new sessions in this branch
        mcp_server_ids?: string[];

        // DANGEROUS: opt-in to legacy session-spawn identity borrowing.
        // When true, agor_sessions_spawn / agor_sessions_prompt(mode:"fork"|"subsession")
        // attribute the new child session to the parent owner instead of the
        // MCP-authenticated caller. See packages/core/src/types/branch.ts.
        dangerously_allow_session_sharing?: boolean;

        // Unix integration
        // Note: unix_gid was previously stored here but is now resolved dynamically
        // via getGidFromGroupName(unix_group) at execution time. See id-lookups.ts.
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
    // Composite unique constraint (repo + name)
    uniqueRepoName: index('branches_repo_name_unique').on(table.repo_id, table.name),
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

    // Unix username for process impersonation (optional, app-enforced uniqueness)
    unix_username: text('unix_username'),

    // Onboarding state
    onboarding_completed: t.bool('onboarding_completed').notNull().default(false),

    // Force password change flag (admin-settable, auto-cleared on password change)
    must_change_password: t.bool('must_change_password').notNull().default(false),

    // JSON blob for profile/preferences
    data: t
      .json<unknown>('data')
      .$type<{
        avatar?: string;
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
          'claude-code-cli'?: {
            // Mirrors 'claude-code' — the CLI accepts the same Anthropic env
            // vars on the api-key path. Subscription auth reads
            // ~/.claude/.credentials.json (managed by `claude auth login`),
            // not these env vars.
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
            };
            permissionMode?: string;
            mcpServerIds?: string[];
          };
          'claude-code-cli'?: {
            modelConfig?: {
              mode?: 'alias' | 'exact';
              model?: string;
              effort?: EffortLevel;
            };
            permissionMode?: string;
            mcpServerIds?: string[];
          };
          codex?: {
            modelConfig?: {
              mode?: 'alias' | 'exact';
              model?: string;
              effort?: EffortLevel;
            };
            permissionMode?: string;
            mcpServerIds?: string[];
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
            mcpServerIds?: string[];
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
            mcpServerIds?: string[];
          };
        };
      }>()
      .notNull(),
  },
  (table) => ({
    emailIdx: index('users_email_idx').on(table.email),
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

    // Scope foreign key
    // For 'global' scope: which user owns this server
    // For 'session' scope: use session_mcp_servers junction table (many-to-many)
    owner_user_id: text('owner_user_id', { length: 36 }),

    // Source tracking (materialized for queries)
    source: text('source', {
      enum: ['user', 'imported', 'agor'],
    }).notNull(),

    // JSON blob for configuration and capabilities
    data: t
      .json<unknown>('data')
      .$type<{
        display_name?: string;
        description?: string;
        import_path?: string;

        // Transport config
        command?: string;
        args?: string[];
        url?: string;
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
          description: string;
          input_schema?: Record<string, unknown>; // Optional - not all MCP servers provide schemas
        }>;
        resources?: Array<{
          uri: string;
          name: string;
          mimeType?: string;
        }>;
        prompts?: Array<{
          name: string;
          description: string;
          arguments?: Array<{
            name: string;
            description: string;
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
    // Composite primary key
    pk: index('session_mcp_servers_pk').on(table.session_id, table.mcp_server_id),
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
      enum: ['slack', 'discord', 'whatsapp', 'telegram', 'github'],
    }).notNull(),
    target_branch_id: text('target_branch_id', { length: 36 })
      .notNull()
      .references(() => branches.branch_id, { onDelete: 'cascade' }),
    agor_user_id: text('agor_user_id', { length: 36 }).notNull(),
    channel_key: text('channel_key').notNull().unique(),
    enabled: t.bool('enabled').notNull().default(true),
    last_message_at: t.timestamp('last_message_at'),

    // JSON blob for platform credentials (encrypted at rest)
    config: t.json<Record<string, unknown>>('config').notNull(),

    // JSON blob for agentic tool configuration (agent, model, permission mode, etc.)
    agentic_config: t.json<Record<string, unknown> | null>('agentic_config'),
  },
  (table) => ({
    channelKeyIdx: index('idx_gateway_channel_key').on(table.channel_key),
    enabledTypeIdx: index('idx_gateway_enabled_type').on(table.enabled, table.channel_type),
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
export type TaskRow = typeof tasks.$inferSelect;
export type TaskInsert = typeof tasks.$inferInsert;
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
export type AppVariableRow = typeof appVariables.$inferSelect;
export type AppVariableInsert = typeof appVariables.$inferInsert;
export type GroupRow = typeof groups.$inferSelect;
export type GroupInsert = typeof groups.$inferInsert;
export type GroupMembershipRow = typeof groupMemberships.$inferSelect;
export type GroupMembershipInsert = typeof groupMemberships.$inferInsert;
export type BranchGroupGrantRow = typeof branchGroupGrants.$inferSelect;
export type BranchGroupGrantInsert = typeof branchGroupGrants.$inferInsert;
export type MCPServerRow = typeof mcpServers.$inferSelect;
export type MCPServerInsert = typeof mcpServers.$inferInsert;
export type SessionMCPServerRow = typeof sessionMcpServers.$inferSelect;
export type SessionMCPServerInsert = typeof sessionMcpServers.$inferInsert;
export type SessionEnvSelectionRow = typeof sessionEnvSelections.$inferSelect;
export type SessionEnvSelectionInsert = typeof sessionEnvSelections.$inferInsert;
export type UserMCPOAuthTokenRow = typeof userMcpOauthTokens.$inferSelect;
export type UserMCPOAuthTokenInsert = typeof userMcpOauthTokens.$inferInsert;
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
export type SerializedSessionRow = typeof serializedSessions.$inferSelect;
export type SerializedSessionInsert = typeof serializedSessions.$inferInsert;
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

export const sessionsRelations = relations(sessions, ({ one }) => ({
  branch: one(branches, {
    fields: [sessions.branch_id],
    references: [branches.branch_id],
  }),
  schedule: one(schedules, {
    fields: [sessions.schedule_id],
    references: [schedules.schedule_id],
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
