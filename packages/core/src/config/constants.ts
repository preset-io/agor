/**
 * App-level constants for Agor
 *
 * Centralized configuration values that can be easily tweaked.
 */

/**
 * Daemon Constants
 */
export const DAEMON = {
  /**
   * Default daemon port
   */
  DEFAULT_PORT: 3030,

  /**
   * Default daemon host
   */
  DEFAULT_HOST: 'localhost',
} as const;

/**
 * Environment Management Constants
 */
export const ENVIRONMENT = {
  /**
   * Health check interval in milliseconds
   * How often to poll environment health when status is 'running'
   */
  HEALTH_CHECK_INTERVAL_MS: 5000, // 5 seconds

  /**
   * Health check timeout in milliseconds
   * How long to wait for health check response before considering it failed
   */
  HEALTH_CHECK_TIMEOUT_MS: 1000, // 1 second

  /**
   * Maximum number of log lines to store per worktree
   * (Not stored in DB - reference for future log file implementation)
   */
  MAX_LOG_LINES: 100,

  /**
   * Process startup grace period in milliseconds
   * How long to wait after starting before running health checks
   */
  STARTUP_GRACE_PERIOD_MS: 3000, // 3 seconds

  /**
   * Maximum consecutive health check failures before marking as 'error'
   */
  MAX_HEALTH_CHECK_FAILURES: 3,

  /**
   * Logs command timeout in milliseconds
   * How long to wait for logs command to complete
   */
  LOGS_TIMEOUT_MS: 10_000, // 10 seconds

  /**
   * Maximum number of log lines to return from logs command
   * Prevents daemon crashes from massive log outputs
   */
  LOGS_MAX_LINES: 500,

  /**
   * Maximum bytes to read from logs command output
   * Prevents memory issues (100KB limit)
   */
  LOGS_MAX_BYTES: 100_000, // 100KB
} as const;

/**
 * WebSocket Constants
 */
export const WEBSOCKET = {
  /**
   * Cursor position broadcast throttle in milliseconds
   */
  CURSOR_THROTTLE_MS: 100,

  /**
   * Presence timeout in milliseconds (when to mark user as stale)
   */
  PRESENCE_TIMEOUT_MS: 10000, // 10 seconds
} as const;

/**
 * Database Constants
 */
export const DATABASE = {
  /**
   * Batch size for bulk message inserts
   */
  MESSAGE_BATCH_SIZE: 100,

  /**
   * Batch size for bulk task inserts
   */
  TASK_BATCH_SIZE: 100,

  /**
   * Default pagination limit
   */
  DEFAULT_PAGE_SIZE: 50,

  /**
   * Maximum pagination limit
   */
  MAX_PAGE_SIZE: 100,
} as const;

/**
 * Git Constants
 */
export const GIT = {
  /**
   * Default worktree base path (relative to ~/.agor)
   */
  WORKTREE_BASE_PATH: 'worktrees',

  /**
   * Default repo clone path (relative to ~/.agor)
   */
  REPO_BASE_PATH: 'repos',
} as const;

/**
 * Session Constants
 */
export const SESSION = {
  /**
   * Maximum number of messages to load initially
   */
  INITIAL_MESSAGE_LOAD: 100,

  /**
   * Message streaming chunk size
   */
  STREAMING_CHUNK_SIZE: 1,
} as const;
