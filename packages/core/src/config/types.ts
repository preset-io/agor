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
 * Supported credential keys (enum for type safety)
 */
export enum CredentialKey {
  ANTHROPIC_API_KEY = 'ANTHROPIC_API_KEY',
  OPENAI_API_KEY = 'OPENAI_API_KEY',
  GEMINI_API_KEY = 'GEMINI_API_KEY',
  CURSOR_API_KEY = 'CURSOR_API_KEY',
}

/**
 * Tool credentials (API keys, tokens, etc.)
 */
export interface AgorCredentials {
  /** Anthropic API key for Claude Code */
  ANTHROPIC_API_KEY?: string;

  /** Cursor API key (if needed) */
  CURSOR_API_KEY?: string;

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
  | `credentials.${keyof AgorCredentials}`;
