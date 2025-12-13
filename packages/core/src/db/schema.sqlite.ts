/**
 * SQLite Schema Definition
 *
 * Uses type factory helpers for the 3 differing types (timestamp, boolean, json).
 * All other types (text, index, foreign keys) are identical to PostgreSQL schema.
 */

import type {
  CodexApprovalPolicy,
  CodexSandboxMode,
  Message,
  PermissionMode,
  Session,
  Task,
} from '@agor/core/types';
import { sql } from 'drizzle-orm';
import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

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
    created_by: text('created_by', { length: 36 }).notNull().default('anonymous'),

    // Unix username for SDK impersonation (immutable once set)
    // Set from creator's unix_username at session creation time
    // NEVER changes, even if user's unix_username changes later
    // This ensures SDK session data remains accessible in the original home directory
    unix_username: text('unix_username'),

    // Materialized for filtering/joins (cross-DB compatible)
    status: text('status', {
      enum: ['idle', 'running', 'stopping', 'awaiting_permission', 'completed', 'failed'],
    }).notNull(),
    agentic_tool: text('agentic_tool', {
      enum: ['claude-code', 'codex', 'gemini', 'opencode'],
    }).notNull(),
    board_id: text('board_id', { length: 36 }), // NULL = no board

    // Genealogy (materialized for tree queries)
    parent_session_id: text('parent_session_id', { length: 36 }),
    forked_from_session_id: text('forked_from_session_id', { length: 36 }),

    // Worktree reference (REQUIRED: all sessions must have a worktree)
    worktree_id: text('worktree_id', { length: 36 })
      .notNull()
      .references(() => worktrees.worktree_id, {
        onDelete: 'cascade', // Cascade delete sessions when worktree is deleted
      }),

    // Scheduler tracking (materialized for deduplication and retention cleanup)
    scheduled_run_at: integer('scheduled_run_at'), // Unix timestamp (ms) - authoritative run ID
    scheduled_from_worktree: t.bool('scheduled_from_worktree').notNull().default(false),

    // UI state (materialized for efficient highlighting queries)
    ready_for_prompt: t.bool('ready_for_prompt').notNull().default(false),

    // Archive state (cascaded from worktree archive)
    archived: t.bool('archived').notNull().default(false),
    archived_reason: text('archived_reason', {
      enum: ['worktree_archived', 'manual'],
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

        // Aggregates
        message_count: number;

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
      }>()
      .notNull(),
  },
  (table) => ({
    statusIdx: index('sessions_status_idx').on(table.status),
    agenticToolIdx: index('sessions_agentic_tool_idx').on(table.agentic_tool),
    boardIdx: index('sessions_board_idx').on(table.board_id),
    worktreeIdx: index('sessions_worktree_idx').on(table.worktree_id),
    createdIdx: index('sessions_created_idx').on(table.created_at),
    parentIdx: index('sessions_parent_idx').on(table.parent_session_id),
    forkedIdx: index('sessions_forked_idx').on(table.forked_from_session_id),
    // Scheduler indexes (note: partial indexes defined in migration, not here)
    scheduledFromWorktreeIdx: index('sessions_scheduled_flag_idx').on(
      table.scheduled_from_worktree
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
    completed_at: t.timestamp('completed_at'),
    status: text('status', {
      enum: [
        'created',
        'running',
        'stopping',
        'awaiting_permission',
        'completed',
        'failed',
        'stopped',
      ],
    }).notNull(),

    // User attribution
    created_by: text('created_by', { length: 36 }).notNull().default('anonymous'),

    data: t
      .json<unknown>('data')
      .$type<{
        description: string;
        full_prompt: string;

        message_range: Task['message_range'];
        git_state: Task['git_state'];

        model: string;
        tool_use_count: number;

        duration_ms?: number;
        agent_session_id?: string;

        // Raw SDK response - single source of truth for token accounting
        raw_sdk_response?: Task['raw_sdk_response'];

        // Normalized SDK response - computed from raw_sdk_response by executor
        // Stored so UI doesn't need SDK-specific normalization logic
        normalized_sdk_response?: Task['normalized_sdk_response'];

        // Computed context window (cumulative tokens)
        computed_context_window?: Task['computed_context_window'];

        report?: Task['report'];
        permission_request?: Task['permission_request'];
      }>()
      .notNull(),
  },
  (table) => ({
    sessionIdx: index('tasks_session_idx').on(table.session_id),
    statusIdx: index('tasks_status_idx').on(table.status),
    createdIdx: index('tasks_created_idx').on(table.created_at),
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
      enum: ['user', 'assistant', 'system', 'file-history-snapshot', 'permission_request'],
    }).notNull(),
    role: text('role', {
      enum: ['user', 'assistant', 'system'],
    }).notNull(),
    index: integer('index').notNull(), // Position in conversation (0-based)
    timestamp: t.timestamp('timestamp').notNull(),
    content_preview: text('content_preview'), // First 200 chars for list views

    // Parent tool use ID (for nested tool calls - e.g., Task tool spawning Read/Grep)
    parent_tool_use_id: text('parent_tool_use_id'),

    // Message queueing fields
    status: text('status', { enum: ['queued'] }), // 'queued' or null (normal message)
    queue_position: integer('queue_position'), // Position in queue (1, 2, 3, ...)

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
    queueIdx: index('messages_queue_idx').on(table.session_id, table.status, table.queue_position),
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
    created_by: text('created_by', { length: 36 }).notNull().default('anonymous'),

    // Materialized for lookups
    name: text('name').notNull(),
    slug: text('slug').unique(),

    // JSON blob for the rest
    data: t
      .json<unknown>('data')
      .$type<{
        description?: string;
        color?: string;
        icon?: string;
        background_color?: string; // Background color for the board canvas
        objects?: Record<string, import('@agor/core/types').BoardObject>; // Board objects (text, zone)
        custom_context?: Record<string, unknown>; // Custom context for Handlebars templates
      }>()
      .notNull(),
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

    // Unix group for .git/ directory access (agor_rp_<short-id>)
    // Users who have access to ANY worktree in this repo get added to this group
    // Enables git operations (commit, push, etc) by granting .git/ access
    unix_group: text('unix_group'),

    data: t
      .json<unknown>('data')
      .$type<{
        name: string;
        remote_url?: string;
        local_path: string; // Absolute path to base repository
        default_branch?: string;
        environment_config?: {
          up_command: string; // Handlebars template
          down_command: string; // Handlebars template
          health_check?: {
            type: 'http' | 'tcp' | 'process';
            url_template?: string; // Handlebars template
          };
        };
      }>()
      .notNull(),
  },
  (table) => ({
    slugIdx: index('repos_slug_idx').on(table.slug),
  })
);

/**
 * Worktrees table - Git worktrees for isolated development contexts
 *
 * First-class entities for managing work contexts across sessions.
 * Each worktree is an isolated git working directory with its own branch,
 * environment configuration, and persistent work state.
 */
export const worktrees = sqliteTable(
  'worktrees',
  {
    // Primary identity
    worktree_id: text('worktree_id', { length: 36 }).primaryKey(),
    repo_id: text('repo_id', { length: 36 })
      .notNull()
      .references(() => repos.repo_id, { onDelete: 'cascade' }),
    created_at: t.timestamp('created_at').notNull(),
    updated_at: t.timestamp('updated_at'),

    // User attribution
    created_by: text('created_by', { length: 36 }).notNull().default('anonymous'),

    // Materialized for queries
    name: text('name').notNull(), // "feat-auth", "main"
    ref: text('ref').notNull(), // Current branch/tag/commit
    ref_type: text('ref_type', { enum: ['branch', 'tag'] }), // Type of ref (branch or tag)
    worktree_unique_id: integer('worktree_unique_id').notNull(), // Auto-assigned sequential ID for templates

    // Environment configuration (static, initialized from templates, then user-editable)
    start_command: text('start_command'), // Start command (initialized from repo's up_command template)
    stop_command: text('stop_command'), // Stop command (initialized from repo's down_command template)
    nuke_command: text('nuke_command'), // Nuke command (initialized from repo's nuke_command template)
    health_check_url: text('health_check_url'), // Health check URL (initialized from repo's health_check.url_template)
    app_url: text('app_url'), // Application URL (initialized from repo's app_url_template)
    logs_command: text('logs_command'), // Logs command (initialized from repo's logs_command template)

    // Board relationship (nullable - worktrees can exist without boards)
    board_id: text('board_id', { length: 36 }).references(() => boards.board_id, {
      onDelete: 'set null', // If board is deleted, worktree remains but loses board association
    }),

    // Scheduler config (materialized for efficient queries)
    schedule_enabled: t.bool('schedule_enabled').notNull().default(false),
    schedule_cron: text('schedule_cron'), // Cron expression (e.g., "0 9 * * 1-5")
    schedule_last_triggered_at: integer('schedule_last_triggered_at'), // Unix timestamp (ms)
    schedule_next_run_at: integer('schedule_next_run_at'), // Unix timestamp (ms)

    // UI state (materialized for efficient highlighting queries)
    needs_attention: t.bool('needs_attention').notNull().default(true), // Default true for new worktrees

    // Archive state (for soft deletes)
    archived: t.bool('archived').notNull().default(false),
    archived_at: t.timestamp('archived_at'),
    archived_by: text('archived_by', { length: 36 }),
    filesystem_status: text('filesystem_status', {
      enum: ['preserved', 'cleaned', 'deleted'],
    }),

    // RBAC: App-layer permissions (rbac.md)
    others_can: text('others_can', {
      enum: ['none', 'view', 'prompt', 'all'],
    })
      .$type<'none' | 'view' | 'prompt' | 'all'>()
      .default('view'),

    // RBAC: OS-layer permissions (unix-user-modes.md)
    unix_group: text('unix_group'), // e.g., 'agor_wt_abc123'
    others_fs_access: text('others_fs_access', {
      enum: ['none', 'read', 'write'],
    })
      .$type<'none' | 'read' | 'write'>()
      .default('read'),

    // JSON blob for everything else
    data: t
      .json<unknown>('data')
      .$type<{
        // File system
        path: string; // Absolute path to worktree directory

        // Git state (current)
        base_ref?: string; // Branch this diverged from (e.g., "main")
        base_sha?: string; // SHA at worktree creation
        last_commit_sha?: string; // Latest commit
        tracking_branch?: string; // Remote tracking branch
        new_branch: boolean; // Created by Agor?

        // Work context (persistent across sessions)
        issue_url?: string; // GitHub/GitLab issue
        pull_request_url?: string; // PR link
        notes?: string; // Freeform user notes

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

        // Schedule configuration (full config in JSON blob)
        schedule?: {
          timezone: string; // IANA timezone (default: 'UTC')
          prompt_template: string; // Handlebars template
          agentic_tool: 'claude-code' | 'codex' | 'gemini' | 'opencode';
          retention: number; // How many sessions to keep (0 = keep forever)
          permission_mode?: string; // Permission mode for spawned sessions
          model_config?: {
            mode: 'default' | 'custom';
            model?: string;
          };
          mcp_server_ids?: string[]; // MCP servers to attach (default: ['agor'])
          context_files?: string[]; // Additional context files
          created_at: number; // When schedule was created
          created_by: string; // User ID who created
        };
      }>()
      .notNull(),
  },
  (table) => ({
    repoIdx: index('worktrees_repo_idx').on(table.repo_id),
    nameIdx: index('worktrees_name_idx').on(table.name),
    refIdx: index('worktrees_ref_idx').on(table.ref),
    boardIdx: index('worktrees_board_idx').on(table.board_id),
    createdIdx: index('worktrees_created_idx').on(table.created_at),
    updatedIdx: index('worktrees_updated_idx').on(table.updated_at),
    // Composite unique constraint (repo + name)
    uniqueRepoName: index('worktrees_repo_name_unique').on(table.repo_id, table.name),
    // Scheduler indexes (note: partial indexes with WHERE clauses defined in migration)
    scheduleEnabledIdx: index('worktrees_schedule_enabled_idx').on(table.schedule_enabled),
    boardScheduleIdx: index('worktrees_board_schedule_idx').on(
      table.board_id,
      table.schedule_enabled
    ),
  })
);

/**
 * Worktree Owners - RBAC junction table
 *
 * Many-to-many relationship between users and worktrees.
 * Owners have implicit 'all' permission regardless of others_can setting.
 */
export const worktreeOwners = sqliteTable(
  'worktree_owners',
  {
    worktree_id: text('worktree_id', { length: 36 })
      .notNull()
      .references(() => worktrees.worktree_id, { onDelete: 'cascade' }),
    user_id: text('user_id', { length: 36 })
      .notNull()
      .references(() => users.user_id, { onDelete: 'cascade' }),
    created_at: t.timestamp('created_at'),
  },
  (table) => ({
    // Composite primary key matching migration 0016
    pk: primaryKey({ columns: [table.worktree_id, table.user_id] }),
  })
);

/**
 * Users table - Authentication and authorization
 *
 * Optional table - only created when authentication is enabled via `agor auth init`.
 * In anonymous mode (default), this table doesn't exist and all operations are permitted.
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
      enum: ['owner', 'admin', 'member', 'viewer'], // owner rarely used, hidden from UI
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
        // Encrypted API keys (stored as hex-encoded encrypted strings)
        api_keys?: {
          ANTHROPIC_API_KEY?: string; // Encrypted with AES-256-GCM
          OPENAI_API_KEY?: string; // Encrypted with AES-256-GCM
          GEMINI_API_KEY?: string; // Encrypted with AES-256-GCM
        };
        // Encrypted environment variables (stored as hex-encoded encrypted strings)
        env_vars?: Record<string, string>; // { "GITHUB_TOKEN": "enc:...", "NPM_TOKEN": "enc:..." }
        // Default agentic tool configuration (prepopulates session creation forms)
        default_agentic_config?: {
          'claude-code'?: {
            modelConfig?: {
              mode?: 'alias' | 'exact';
              model?: string;
              thinkingMode?: 'auto' | 'manual' | 'off';
              manualThinkingTokens?: number;
            };
            permissionMode?: string;
            mcpServerIds?: string[];
          };
          codex?: {
            modelConfig?: {
              mode?: 'alias' | 'exact';
              model?: string;
              thinkingMode?: 'auto' | 'manual' | 'off';
              manualThinkingTokens?: number;
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
              thinkingMode?: 'auto' | 'manual' | 'off';
              manualThinkingTokens?: number;
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
        };
      }>()
      .notNull(),
  },
  (table) => ({
    emailIdx: index('users_email_idx').on(table.email),
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
          type: 'none' | 'bearer' | 'jwt';
          // Bearer token
          token?: string;
          // JWT config
          api_url?: string;
          api_token?: string;
          api_secret?: string;
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
 * Board Objects table - Positioned worktrees on boards
 *
 * Tracks which worktrees are positioned on which boards.
 * Sessions are accessed through the worktree card (session tree).
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

    // Worktree reference
    worktree_id: text('worktree_id', { length: 36 })
      .notNull()
      .references(() => worktrees.worktree_id, {
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
    worktreeIdx: index('board_objects_worktree_idx').on(table.worktree_id),
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
 * Board Comments table - Human-to-human conversations and collaboration
 *
 * Flexible attachment strategy:
 * - Board-level: General conversations (no attachment foreign keys)
 * - Object-level: Attached to sessions, tasks, messages, or worktrees
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
    created_by: text('created_by', { length: 36 }).notNull().default('anonymous'),

    // FLEXIBLE ATTACHMENTS (all optional)
    // Phase 1: board-level only (all NULL)
    // Phase 2: object attachments (session, task, message, worktree)
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
    worktree_id: text('worktree_id', { length: 36 }).references(() => worktrees.worktree_id, {
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
          // OR relative to session/zone/worktree (follows parent when it moves)
          relative?: {
            parent_id: string; // Can be session_id, zone object ID, or worktree_id
            parent_type: 'session' | 'zone' | 'worktree';
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
    worktreeIdx: index('board_comments_worktree_idx').on(table.worktree_id),
    createdByIdx: index('board_comments_created_by_idx').on(table.created_by),
    parentIdx: index('board_comments_parent_idx').on(table.parent_comment_id),
    createdIdx: index('board_comments_created_idx').on(table.created_at),
    resolvedIdx: index('board_comments_resolved_idx').on(table.resolved),
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
export type WorktreeRow = typeof worktrees.$inferSelect;
export type WorktreeInsert = typeof worktrees.$inferInsert;
export type UserRow = typeof users.$inferSelect;
export type UserInsert = typeof users.$inferInsert;
export type MCPServerRow = typeof mcpServers.$inferSelect;
export type MCPServerInsert = typeof mcpServers.$inferInsert;
export type SessionMCPServerRow = typeof sessionMcpServers.$inferSelect;
export type SessionMCPServerInsert = typeof sessionMcpServers.$inferInsert;
export type BoardObjectRow = typeof boardObjects.$inferSelect;
export type BoardObjectInsert = typeof boardObjects.$inferInsert;
export type BoardCommentRow = typeof boardComments.$inferSelect;
export type BoardCommentInsert = typeof boardComments.$inferInsert;
