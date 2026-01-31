/**
 * Agor Configuration Types
 */

/**
 * Type for user-provided JSON data where structure is unknown or dynamic
 *
 * Use this instead of `any` when dealing with user input or dynamic data structures.
 */
// biome-ignore lint/suspicious/noExplicitAny: Escape hatch for user-provided JSON data
export type UnknownJson = any;

/**
 * Global default values
 */
export interface AgorDefaults {
  /** Default board for new sessions */
  board?: string;

  /** Default agent for new sessions */
  agent?: string;
}

/**
 * Display settings
 */
export interface AgorDisplaySettings {
  /** Table style: unicode, ascii, or minimal */
  tableStyle?: 'unicode' | 'ascii' | 'minimal';

  /** Enable color output */
  colorOutput?: boolean;

  /** Short ID length (default: 8) */
  shortIdLength?: number;
}

/**
 * Daemon settings
 */
export interface AgorDaemonSettings {
  /** Daemon port (default: 3030) */
  port?: number;

  /** Daemon host (default: localhost) */
  host?: string;

  /**
   * Public URL for executors to reach the daemon.
   *
   * In local mode, defaults to `http://localhost:{port}`.
   * In containerized (k8s) mode, should be the internal service URL.
   *
   * @example
   * ```yaml
   * daemon:
   *   public_url: http://agor-daemon.agor.svc.cluster.local:3030
   * ```
   */
  public_url?: string;

  /** Allow anonymous access (default: true for local mode) */
  allowAnonymous?: boolean;

  /** Require authentication for all requests (default: false) */
  requireAuth?: boolean;

  /** JWT secret (auto-generated if not provided) */
  jwtSecret?: string;

  /** Master secret for API key encryption (auto-generated if not provided) */
  masterSecret?: string;

  /** Enable built-in MCP server (default: true) */
  mcpEnabled?: boolean;

  /** Unix user the daemon runs as. Used to ensure daemon has access to all Unix groups.
   * Required when Unix isolation is enabled (worktree_rbac or unix_user_mode).
   * In dev mode without isolation, falls back to current process user. */
  unix_user?: string;

  /** Instance label for deployment identification (e.g., "staging", "prod-us-east").
   * Displayed as a Tag in the UI navbar when set. */
  instanceLabel?: string;

  /** Instance description (markdown supported).
   * Displayed as a popover around the instance label Tag. */
  instanceDescription?: string;
}

/**
 * UI settings
 */
export interface AgorUISettings {
  /** UI dev server port (default: 5173) */
  port?: number;

  /** UI host (default: localhost) */
  host?: string;
}

/**
 * OpenCode.ai integration settings
 */
export interface AgorOpenCodeSettings {
  /** Enable OpenCode integration (default: false) */
  enabled?: boolean;

  /** URL where OpenCode server is running (default: http://localhost:4096) */
  serverUrl?: string;
}

/**
 * Database configuration settings
 */
export interface AgorDatabaseSettings {
  /** Database dialect (default: 'sqlite') */
  dialect?: 'sqlite' | 'postgresql';

  /** SQLite configuration */
  sqlite?: {
    /** Database file path (default: '~/.agor/agor.db') */
    path?: string;

    /** Enable WAL mode (default: true) */
    walMode?: boolean;

    /** Busy timeout in ms (default: 5000) */
    busyTimeout?: number;
  };

  /** PostgreSQL configuration */
  postgresql?: {
    /** Connection URL (postgresql://user:pass@host:port/db) */
    url?: string;

    /** Individual connection parameters (alternative to URL) */
    host?: string;
    port?: number;
    database?: string;
    user?: string;
    password?: string;

    /** Connection pool settings */
    pool?: {
      min?: number; // Default: 2
      max?: number; // Default: 10
      idleTimeout?: number; // Default: 30000ms
    };

    /** SSL/TLS configuration */
    ssl?:
      | boolean
      | {
          rejectUnauthorized?: boolean;
          ca?: string;
          cert?: string;
          key?: string;
        };

    /** Schema name (default: 'public') */
    schema?: string;
  };
}

/**
 * Codex-specific configuration
 */
export interface AgorCodexSettings {
  /** Codex home directory (default: ~/.agor/codex) */
  home?: string;
}

/**
 * Execution settings
 */
export interface AgorExecutionSettings {
  /** Unix user to run executors as (default: undefined = run as daemon user). When set, uses sudo impersonation. */
  executor_unix_user?: string;

  /** Unix user mode: simple (no isolation), insulated (worktree groups), strict (enforce process impersonation) */
  unix_user_mode?: 'simple' | 'insulated' | 'strict';

  /** Enable worktree RBAC and ownership system (default: false). When enabled, enforces permission checks and Unix group isolation. */
  worktree_rbac?: boolean;

  /** Session token expiration in ms (default: 86400000 = 24 hours) */
  session_token_expiration_ms?: number;

  /** Maximum session token uses (default: 1 = single-use, -1 = unlimited) */
  session_token_max_uses?: number;

  /** Sync web passwords to Unix user passwords (default: true). When enabled, passwords are synced on user creation/update. */
  sync_unix_passwords?: boolean;

  /**
   * Executor command template for remote/containerized execution.
   *
   * When null/undefined (default), executors are spawned as local subprocesses.
   * When set, the template is used to spawn executors in containers/pods.
   *
   * Template variables (substituted at spawn time):
   * - {task_id} - Unique task identifier (for pod naming)
   * - {command} - Executor command (prompt, git.clone, etc.)
   * - {unix_user} - Target Unix username
   * - {unix_user_uid} - Target Unix UID (for runAsUser)
   * - {unix_user_gid} - Target Unix GID (for fsGroup)
   * - {session_id} - Session ID (if available)
   * - {worktree_id} - Worktree ID (if available)
   *
   * The template command receives JSON payload via stdin and should pipe it
   * to `agor-executor --stdin`.
   *
   * @example Kubernetes execution
   * ```yaml
   * executor_command_template: |
   *   kubectl run executor-{task_id} \
   *     --image=ghcr.io/preset-io/agor-executor:latest \
   *     --rm -i --restart=Never \
   *     --overrides='{
   *       "spec": {
   *         "securityContext": {
   *           "runAsUser": {unix_user_uid},
   *           "fsGroup": {unix_user_gid}
   *         }
   *       }
   *     }' \
   *     -- agor-executor --stdin
   * ```
   *
   * @example Docker execution
   * ```yaml
   * executor_command_template: |
   *   docker run --rm -i \
   *     --user {unix_user_uid}:{unix_user_gid} \
   *     -v /data/agor:/data/agor \
   *     ghcr.io/preset-io/agor-executor:latest \
   *     agor-executor --stdin
   * ```
   */
  executor_command_template?: string;
}

/**
 * Path configuration settings
 *
 * Allows separation of daemon operating files from git data files.
 * This enables different storage backends (e.g., local SSD for daemon, EFS for worktrees).
 *
 * @see context/explorations/executor-expansion.md
 */
export interface AgorPathSettings {
  /**
   * Git data directory (repos, worktrees)
   *
   * When set, repos and worktrees are stored here instead of under agor_home.
   * Useful for k8s deployments where worktrees need to be on shared storage (EFS).
   *
   * Default: same as agor_home (~/.agor)
   *
   * Environment variable: AGOR_DATA_HOME (takes precedence over config)
   *
   * @example
   * ```yaml
   * paths:
   *   data_home: /data/agor
   * ```
   */
  data_home?: string;
}

/**
 * Supported credential keys (enum for type safety)
 */
export enum CredentialKey {
  ANTHROPIC_API_KEY = 'ANTHROPIC_API_KEY',
  OPENAI_API_KEY = 'OPENAI_API_KEY',
  GEMINI_API_KEY = 'GEMINI_API_KEY',
}

/**
 * Tool credentials (API keys, tokens, etc.)
 */
export interface AgorCredentials {
  /** Anthropic API key for Claude Code */
  ANTHROPIC_API_KEY?: string;

  /** OpenAI API key for Codex */
  OPENAI_API_KEY?: string;

  /** Google Gemini API key */
  GEMINI_API_KEY?: string;
}

/**
 * Complete Agor configuration
 */
export interface AgorConfig {
  /** Global defaults */
  defaults?: AgorDefaults;

  /** Display settings */
  display?: AgorDisplaySettings;

  /** Daemon settings */
  daemon?: AgorDaemonSettings;

  /** UI settings */
  ui?: AgorUISettings;

  /** Database configuration */
  database?: AgorDatabaseSettings;

  /** OpenCode.ai integration settings */
  opencode?: AgorOpenCodeSettings;

  /** Codex-specific configuration */
  codex?: AgorCodexSettings;

  /** Execution isolation settings */
  execution?: AgorExecutionSettings;

  /** Path configuration (data_home for repos/worktrees separation) */
  paths?: AgorPathSettings;

  /** Tool credentials (API keys, tokens) */
  credentials?: AgorCredentials;
}

/**
 * Valid config keys (includes nested keys with dot notation)
 */
export type ConfigKey =
  | `defaults.${keyof AgorDefaults}`
  | `display.${keyof AgorDisplaySettings}`
  | `daemon.${keyof AgorDaemonSettings}`
  | `ui.${keyof AgorUISettings}`
  | `database.${keyof AgorDatabaseSettings}`
  | `opencode.${keyof AgorOpenCodeSettings}`
  | `codex.${keyof AgorCodexSettings}`
  | `execution.${keyof AgorExecutionSettings}`
  | `paths.${keyof AgorPathSettings}`
  | `credentials.${keyof AgorCredentials}`;
