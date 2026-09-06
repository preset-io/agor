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
   * Maximum number of log lines to store per branch
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
  LOGS_TIMEOUT_MS: 30_000, // 30 seconds

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

/** Shared Socket.IO packet ceiling used by the daemon transport. */
export const SOCKET_IO_MAX_BUFFER_SIZE_BYTES = 1_000_000;

/** Executor Feathers RPC acknowledgement deadline. */
export const EXECUTOR_FEATHERS_ACK_TIMEOUT_MS = 60_000;

/** Extra time for bounded transport cleanup after the executor RPC deadline. */
export const EXECUTOR_REVOCATION_TRANSPORT_CLEANUP_MARGIN_MS = 5_000;

/**
 * Default lifetime of a taskless executor command credential.
 *
 * These credentials delegate the initiating user's normal tenant authority but
 * have no task lifecycle that can reliably revoke them when a remote launcher
 * exits, so the expiry is the only bound. A caller that owns a stricter
 * server-side command deadline may request that exact narrower window; the
 * configured `execution.session_token_expiration_ms` maximum stays
 * authoritative.
 *
 * Lives here rather than beside the issuer because the default environment
 * lifecycle command budget is derived from it. A second local copy could drift
 * and silently size a command deadline past the authority issued for it.
 */
export const EXECUTOR_COMMAND_TOKEN_EXPIRATION_MS = 15 * 60 * 1000;

export const EXECUTOR_REVOCATION_TRANSPORT_CLEANUP_TIMEOUT_MS =
  EXECUTOR_FEATHERS_ACK_TIMEOUT_MS + EXECUTOR_REVOCATION_TRANSPORT_CLEANUP_MARGIN_MS;

/** Desired lease for one asynchronous branch filesystem materialization. */
export const BRANCH_FILESYSTEM_MATERIALIZATION_TIMEOUT_MS = 10 * 60_000;

/** Smallest useful materialization lease after reserving callback settlement time. */
export const BRANCH_FILESYSTEM_MATERIALIZATION_MIN_TIMEOUT_MS = 1_000;

export interface BranchFilesystemMaterializationBudget {
  attemptTimeoutMs: number;
  credentialLifetimeMs: number;
}

/**
 * Fit the durable filesystem attempt and its callback credential to one
 * shared budget. A hardened session-token ceiling shortens the attempt rather
 * than leaving a lease whose only settlement credential expires first.
 */
export function resolveBranchFilesystemMaterializationBudget(
  credentialCeilingMs?: number
): BranchFilesystemMaterializationBudget {
  const ceilingMs = Math.min(
    credentialCeilingMs ?? EXECUTOR_COMMAND_TOKEN_EXPIRATION_MS,
    EXECUTOR_COMMAND_TOKEN_EXPIRATION_MS
  );
  const attemptTimeoutMs = Math.min(
    BRANCH_FILESYSTEM_MATERIALIZATION_TIMEOUT_MS,
    ceilingMs - EXECUTOR_REVOCATION_TRANSPORT_CLEANUP_TIMEOUT_MS
  );
  if (attemptTimeoutMs < BRANCH_FILESYSTEM_MATERIALIZATION_MIN_TIMEOUT_MS) {
    throw new Error(
      'execution.session_token_expiration_ms is too short for branch filesystem materialization: ' +
        `at least ${BRANCH_FILESYSTEM_MATERIALIZATION_MIN_TIMEOUT_MS + EXECUTOR_REVOCATION_TRANSPORT_CLEANUP_TIMEOUT_MS}ms is required`
    );
  }
  return {
    attemptTimeoutMs,
    credentialLifetimeMs: attemptTimeoutMs + EXECUTOR_REVOCATION_TRANSPORT_CLEANUP_TIMEOUT_MS,
  };
}

/**
 * Pagination Constants
 *
 * High limits to avoid silent truncation of results.
 * FeathersJS pagination defaults were causing data loss when collections grew.
 */
export const PAGINATION = {
  /**
   * Default limit for services/UI - high enough to fetch "all" in practice
   */
  DEFAULT_LIMIT: 10_000,

  /**
   * Maximum allowed limit - prevents accidental DoS from unbounded queries
   */
  MAX_LIMIT: 10_000,

  /**
   * Default limit for CLI list commands - reasonable for terminal display
   */
  CLI_DEFAULT_LIMIT: 50,
} as const;

/**
 * Messages carry transcript/tool payloads and are materially heavier than most
 * list resources. Keep each transport page small; callers that intentionally
 * need a complete Task transcript use the client's paginated `findAll()` loop.
 */
export const MESSAGE_PAGINATION = {
  DEFAULT_LIMIT: 100,
  MAX_LIMIT: 1_000,
} as const;

/**
 * Git Constants
 */
export const GIT = {
  /**
   * Default branch base path (relative to ~/.agor)
   */
  BRANCH_BASE_PATH: 'branches',

  /**
   * Default repo clone path (relative to ~/.agor)
   */
  REPO_BASE_PATH: 'repos',
} as const;

/**
 * MCP Token Constants
 */
export const MCP_TOKEN = {
  /**
   * Default lifetime for internal MCP session tokens in milliseconds.
   * Keep short to bound the blast radius of a leaked token — there is no
   * revocation mechanism; `exp` is the only backstop.
   */
  DEFAULT_EXPIRATION_MS: 24 * 60 * 60 * 1000, // 24 hours
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
