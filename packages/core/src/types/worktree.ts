// src/types/worktree.ts
import type { BoardID, UUID, WorktreeID } from './id';
import type { WorktreeName } from './repo';

/**
 * Git worktree - First-class entity for isolated development contexts
 *
 * Worktrees are persistent work contexts that outlive individual sessions.
 * Each worktree has:
 * - Isolated git working directory and branch
 * - Environment configuration and runtime state
 * - Work metadata (issue, PR, notes)
 * - Session history
 *
 * Relationship to sessions:
 * - Sessions = ephemeral conversations with AI agents
 * - Worktrees = persistent work contexts (git + environment + metadata)
 * - Multiple sessions can work on the same worktree over time
 */
export interface Worktree {
  // ===== Identity =====

  /** Unique worktree identifier (UUIDv7) */
  worktree_id: WorktreeID;

  /** Repository this worktree belongs to */
  repo_id: UUID;

  /**
   * Unique numeric ID for this worktree (auto-assigned, sequential)
   *
   * Used in environment templates for port allocation:
   * Example: {{add 9000 WORKTREE_UNIQUE_ID}} → 9001, 9002, 9003, ...
   *
   * Auto-incremented when worktree is created (1, 2, 3, ...)
   */
  worktree_unique_id: number;

  /** Start command - initialized from repo template, then user-editable (e.g., "pnpm dev") */
  start_command?: string;

  /** Stop command - initialized from repo template, then user-editable (e.g., "pkill -f 'pnpm dev'") */
  stop_command?: string;

  /** Nuke command - initialized from repo template, then user-editable (e.g., "docker compose down -v") */
  nuke_command?: string;

  /** Health check URL - initialized from repo template, then user-editable (e.g., "http://localhost:5173/health") */
  health_check_url?: string;

  /** App URL - initialized from repo template, then user-editable (e.g., "http://localhost:5173") */
  app_url?: string;

  /** Logs command - initialized from repo template, then user-editable (e.g., "docker logs agor-daemon") */
  logs_command?: string;

  /** Timestamps */
  created_at: string;
  updated_at: string;

  /** User who created this worktree */
  created_by: UUID;

  // ===== Materialized (for indexes/queries) =====

  /**
   * Worktree name (slug format)
   *
   * Used for:
   * - Directory name: ~/.agor/worktrees/{repo-slug}/{name}
   * - Default branch name (if creating new branch)
   * - CLI references
   *
   * Examples: "main", "feat-auth", "exp-rewrite"
   */
  name: WorktreeName;

  /**
   * Git ref (branch/tag/commit) currently checked out
   *
   * Examples: "feat-auth", "main", "v1.2.3", "a1b2c3d"
   */
  ref: string;

  /**
   * Type of ref (branch or tag)
   *
   * - 'branch': ref is a branch name (default)
   * - 'tag': ref is a tag name
   */
  ref_type?: 'branch' | 'tag';

  // ===== File System =====

  /**
   * Absolute path to worktree directory
   *
   * Example: "/Users/max/.agor/worktrees/myapp/feat-auth"
   */
  path: string;

  // ===== Git State (Current) =====

  /**
   * Branch this worktree diverged from
   *
   * Example: "main" (if this is a feature branch)
   */
  base_ref?: string;

  /**
   * SHA at worktree creation (base commit)
   *
   * Tracks where this branch started.
   */
  base_sha?: string;

  /**
   * Latest commit SHA in this worktree
   *
   * Updated when sessions make commits.
   */
  last_commit_sha?: string;

  /**
   * Remote tracking branch (if any)
   *
   * Examples: "origin/feat-auth", "upstream/main"
   */
  tracking_branch?: string;

  /**
   * Whether this ref is a new branch created by Agor
   *
   * true:  Branch was created during worktree creation
   * false: Branch existed before (tracked from remote or local)
   */
  new_branch: boolean;

  // ===== Work Context (Persistent Across Sessions) =====

  /**
   * Board this worktree belongs to (if any)
   *
   * Worktrees can live on ONE board (not many).
   * Sessions within the worktree are accessed through the worktree card.
   */
  board_id?: BoardID;

  /**
   * Associated GitHub/GitLab issue
   *
   * Links worktree to issue it addresses.
   * Worktree-level (not session) because work persists across sessions.
   *
   * Example: "https://github.com/org/repo/issues/123"
   */
  issue_url?: string;

  /**
   * Associated pull request
   *
   * Links worktree to PR containing changes.
   * Auto-populated when user creates PR.
   *
   * Example: "https://github.com/org/repo/pull/42"
   */
  pull_request_url?: string;

  /**
   * Freeform notes about this worktree
   *
   * User can document:
   * - What they're working on
   * - Blockers or issues
   * - Design decisions
   * - Next steps
   *
   * Supports markdown.
   */
  notes?: string;

  // ===== Environment =====

  /**
   * Environment instance (if repo has environment config)
   *
   * Tracks runtime state, process info, variable values.
   * Each worktree gets its own environment instance with unique ports.
   */
  environment_instance?: WorktreeEnvironmentInstance;

  // ===== Sessions =====

  /**
   * Last time this worktree was used
   *
   * Updated when sessions start/complete.
   */
  last_used: string;

  // ===== Custom Context =====

  /**
   * Custom context for Handlebars templates
   *
   * User-defined variables for zone triggers, reports, etc.
   */
  custom_context?: Record<string, unknown>;

  // ===== UI State =====

  /**
   * Whether this worktree needs attention (highlighted state)
   *
   * Set to true when:
   * - Worktree is newly created
   * - Any session in the worktree has ready_for_prompt=true
   *
   * Cleared when user interacts with the worktree card.
   * Used to draw attention to new or ready worktrees on the board.
   */
  needs_attention: boolean;

  // ===== Scheduler Configuration =====

  /**
   * Whether this worktree has an active schedule
   *
   * Materialized for efficient scheduler queries.
   * Only enabled schedules are evaluated during scheduler ticks.
   */
  schedule_enabled: boolean;

  /**
   * Cron expression for schedule (if scheduled)
   *
   * Standard cron format (minute hour day month weekday).
   * All times in UTC.
   *
   * Examples:
   * - "0 9 * * 1-5" - 9am weekdays
   * - "0 *\/4 * * *" - Every 4 hours
   * - "0 2 * * 1" - 2am every Monday
   */
  schedule_cron?: string;

  /**
   * Last time this schedule was triggered (Unix timestamp in ms)
   *
   * Used for deduplication and recovery.
   * Stores the exact scheduled time (rounded to minute), not execution time.
   */
  schedule_last_triggered_at?: number;

  /**
   * Next scheduled run time (Unix timestamp in ms)
   *
   * Computed from cron expression.
   * Materialized for UI display ("Next run in 2h 15m").
   */
  schedule_next_run_at?: number;

  /**
   * Full schedule configuration (JSON blob)
   *
   * Contains template, agent config, retention policy.
   * Only present if schedule_enabled = true.
   */
  schedule?: WorktreeScheduleConfig;

  // ===== Archive State =====

  /**
   * Whether this worktree is archived (soft deleted)
   *
   * Archived worktrees:
   * - Hidden from board display
   * - Metadata preserved in database
   * - Can be unarchived later
   */
  archived: boolean;

  /**
   * When this worktree was archived (if archived)
   */
  archived_at?: string;

  /**
   * User who archived this worktree
   */
  archived_by?: UUID;

  /**
   * Filesystem state after archiving
   *
   * - 'preserved': Filesystem left untouched
   * - 'cleaned': git clean -fdx run (removes node_modules, build artifacts)
   * - 'deleted': Entire worktree directory deleted from disk
   */
  filesystem_status?: 'preserved' | 'cleaned' | 'deleted';

  // ===== RBAC: App-layer permissions (rbac.md) =====

  /**
   * Permission level for non-owners
   *
   * - 'none': No access (worktree is completely private to owners)
   * - 'view': Can read worktrees/sessions/tasks/messages
   * - 'prompt': View + can create tasks/messages (run agents)
   * - 'all': Full control (create/patch/delete sessions)
   *
   * Note: Owners always have 'all' permission regardless of this setting.
   */
  others_can?: 'none' | 'view' | 'prompt' | 'all';

  // ===== RBAC: OS-layer permissions (unix-user-modes.md) =====

  /**
   * Unix group for this worktree (if Unix modes enabled)
   *
   * Format: 'agor_wt_<short-id>'
   * Owners are added to this group for filesystem access.
   */
  unix_group?: string;

  /**
   * Filesystem access level for non-owners
   *
   * - 'none': No filesystem access (permission denied)
   * - 'read': Can read files (chmod 2755)
   * - 'write': Can read and write files (chmod 2777)
   *
   * This controls OS-level permissions independent of app-layer 'others_can'.
   */
  others_fs_access?: 'none' | 'read' | 'write';
}

/**
 * Permission level type (for app-layer RBAC)
 */
export type WorktreePermissionLevel = 'none' | 'view' | 'prompt' | 'all';

/**
 * Worktree schedule configuration
 *
 * Defines how and when to automatically spawn sessions.
 * Schedules are evaluated in UTC and use Handlebars templates for prompts.
 */
export interface WorktreeScheduleConfig {
  /**
   * IANA timezone for cron evaluation
   *
   * Default: 'UTC'
   * All schedules run in UTC regardless of this setting.
   * This field is for future timezone support.
   */
  timezone: string;

  /**
   * Handlebars template for prompt
   *
   * Available variables:
   * - {{worktree.name}}, {{worktree.ref}}
   * - {{worktree.issue_url}}, {{worktree.pull_request_url}}
   * - {{worktree.notes}}, {{worktree.custom_context.*}}
   * - {{board.name}}, {{board.custom_context.*}}
   * - {{schedule.cron}}, {{schedule.scheduled_time}}
   *
   * Example: "Check PR {{worktree.pull_request_url}} for new comments"
   */
  prompt_template: string;

  /**
   * Agent to use for scheduled sessions
   */
  agentic_tool: 'claude-code' | 'codex' | 'gemini' | 'opencode';

  /**
   * How many scheduled sessions to keep
   *
   * - retention > 0: Keep last N sessions, delete older ones
   * - retention = 0: Keep forever (infinite retention)
   *
   * Retention cleanup runs async after session creation.
   */
  retention: number;

  /**
   * Permission mode for spawned sessions
   *
   * Controls tool approval behavior.
   * Examples: 'auto', 'ask', 'default'
   */
  permission_mode?: string;

  /**
   * Model configuration for spawned sessions
   */
  model_config?: {
    mode: 'default' | 'custom';
    model?: string; // e.g., 'opus' for complex tasks
  };

  /**
   * MCP servers to attach to spawned sessions
   *
   * Default: ['agor'] (Agor's internal MCP for self-awareness)
   * Users can add additional MCP servers via UI.
   */
  mcp_server_ids?: string[];

  /**
   * Additional context files to load
   *
   * Example: ['ARCHITECTURE.md', 'API.md']
   */
  context_files?: string[];

  /**
   * When this schedule was created (Unix timestamp in ms)
   */
  created_at: number;

  /**
   * User who created this schedule
   */
  created_by: string;
}

/**
 * Worktree environment instance
 *
 * Runtime state for a worktree's environment (dev server, Docker, etc.).
 * Template variables are resolved from:
 * - Built-in: WORKTREE_UNIQUE_ID, WORKTREE_NAME, WORKTREE_PATH, REPO_SLUG
 * - Custom: worktree.custom_context (JSON object)
 */
export interface WorktreeEnvironmentInstance {
  /**
   * Current environment status
   */
  status: 'stopped' | 'starting' | 'running' | 'stopping' | 'error';

  /**
   * Process metadata (if managed by Agor)
   */
  process?: {
    /** Process ID */
    pid?: number;
    /** When process started */
    started_at?: string;
    /** Human-readable uptime */
    uptime?: string;
  };

  /**
   * Last health check result
   */
  last_health_check?: {
    timestamp: string;
    status: 'healthy' | 'unhealthy' | 'unknown';
    message?: string;
  };

  /**
   * Resolved access URLs (after template substitution)
   *
   * Example: [
   *   { name: "UI", url: "http://localhost:5173" },
   *   { name: "API", url: "http://localhost:3030" }
   * ]
   */
  access_urls?: Array<{
    name: string;
    url: string;
  }>;

  /**
   * Process logs (last N lines)
   *
   * Captured from stdout/stderr of environment process.
   */
  logs?: string[];
}

/**
 * Repository environment configuration template
 *
 * Defines how to run environments for all worktrees in a repo.
 * Uses Handlebars templating with scoped entity references.
 *
 * Template context (always available):
 * - {{worktree.unique_id}} - Auto-assigned unique number (1, 2, 3, ...)
 * - {{worktree.name}} - Worktree name (e.g., "feat-auth")
 * - {{worktree.path}} - Absolute path to worktree directory
 * - {{repo.slug}} - Repository slug (e.g., "agor")
 * - {{custom.*}} - Any custom context from worktree.custom_context
 * - {{add a b}}, {{sub a b}}, {{mul a b}} - Math helpers
 */
export interface RepoEnvironmentConfig {
  /**
   * Command to start environment (Handlebars template)
   *
   * Examples:
   * - "docker compose -p {{worktree.name}} up -d"
   * - "UI_PORT={{add 9000 worktree.unique_id}} DAEMON_PORT={{add 8000 worktree.unique_id}} pnpm dev"
   * - "PORT={{add 5000 worktree.unique_id}} npm start"
   */
  up_command: string;

  /**
   * Command to stop environment (Handlebars template)
   *
   * Examples:
   * - "docker compose -p {{worktree.name}} down"
   * - "pkill -f 'vite.*{{add 9000 worktree.unique_id}}'"
   */
  down_command: string;

  /**
   * Command to nuke environment (Handlebars template)
   *
   * Destructive operation that typically removes volumes, data, and state.
   * Requires user confirmation before execution.
   *
   * Examples:
   * - "docker compose -p {{worktree.name}} down -v"
   * - "rm -rf node_modules .next .cache && docker compose -p {{worktree.name}} down -v"
   */
  nuke_command?: string;

  /**
   * Optional health check configuration
   */
  health_check?: {
    /** Health check type */
    type: 'http' | 'tcp' | 'process';
    /**
     * URL template for HTTP checks
     *
     * Example: "http://localhost:{{add 9000 worktree.unique_id}}/health"
     */
    url_template?: string;
  };

  /**
   * App URL template (Handlebars template)
   * URL to access the running application
   *
   * Example: "http://localhost:{{add 5000 worktree.unique_id}}"
   */
  app_url_template?: string;

  /**
   * Optional logs command (Handlebars template)
   * Command to fetch recent logs from the environment (non-streaming)
   *
   * Should return quickly with tail of recent logs.
   * Output is limited to 100 lines / 100KB for safety.
   *
   * Examples:
   * - "docker compose -p {{worktree.name}} logs --tail=100"
   * - "tail -n 100 /var/log/app-{{worktree.unique_id}}.log"
   * - "kubectl logs deployment/{{worktree.name}} --tail=100"
   */
  logs_command?: string;
}
