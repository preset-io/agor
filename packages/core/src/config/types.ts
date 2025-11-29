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

  /** Unix user mode: simple (no isolation), insulated (worktree groups), opportunistic (insulated + process impersonation if possible), strict (enforce process impersonation) */
  unix_user_mode?: 'simple' | 'insulated' | 'opportunistic' | 'strict';

  /** Enable worktree RBAC and ownership system (default: false). When enabled, enforces permission checks and Unix group isolation. */
  worktree_rbac?: boolean;

  /** Session token expiration in ms (default: 86400000 = 24 hours) */
  session_token_expiration_ms?: number;

  /** Maximum session token uses (default: 1 = single-use, -1 = unlimited) */
  session_token_max_uses?: number;
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
  | `credentials.${keyof AgorCredentials}`;
