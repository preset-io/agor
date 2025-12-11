/**
 * Unix Integration Service (Daemon Re-export)
 *
 * Re-exports the UnixIntegrationService from @agor/core for daemon use.
 *
 * Executor modes:
 * - DirectExecutor: Runs commands via `sudo <command>` directly (default for Docker/dev)
 * - SudoCliExecutor: Runs commands via `sudo agor admin <command>` (for production with CLI proxy)
 *
 * @see context/guides/rbac-and-unix-isolation.md
 */

import { getAgorDaemonUser } from '@agor/core/config';
import type { Database } from '@agor/core/db';
import {
  UnixIntegrationService as CoreUnixIntegrationService,
  SudoDirectExecutor,
  type UnixIntegrationConfig,
} from '@agor/core/unix';

// Re-export types and helpers
export type { UnixIntegrationConfig };
export { getAgorDaemonUser };

/**
 * Daemon-specific configuration for Unix integration
 *
 * Note: CLI executor mode (via `sudo agor admin`) is not yet implemented.
 * Currently only 'direct' mode is supported (sudo commands directly).
 */
export interface DaemonUnixIntegrationConfig extends UnixIntegrationConfig {
  // Future: executorMode for CLI proxy support
  // Currently always uses SudoDirectExecutor
}

/**
 * Create Unix Integration Service for daemon use
 *
 * Uses SudoDirectExecutor which runs privileged commands via `sudo <command>`.
 * This requires passwordless sudo for the daemon user (typical in Docker/dev).
 *
 * @param db - Database instance
 * @param config - Configuration options
 * @returns UnixIntegrationService instance
 */
export function createUnixIntegrationService(
  db: Database,
  config: DaemonUnixIntegrationConfig = { enabled: false }
): CoreUnixIntegrationService {
  // Always use SudoDirectExecutor - runs sudo commands directly
  // This works in Docker where agor user has passwordless sudo
  const executor = new SudoDirectExecutor();

  return new CoreUnixIntegrationService(db, executor, config);
}

// Re-export the service class for type compatibility
export { CoreUnixIntegrationService as UnixIntegrationService };
