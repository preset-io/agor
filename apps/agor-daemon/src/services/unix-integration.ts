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

import type { Database } from '@agor/core/db';
import {
  UnixIntegrationService as CoreUnixIntegrationService,
  SudoCliExecutor,
  SudoDirectExecutor,
  type UnixIntegrationConfig,
} from '@agor/core/unix';

// Re-export types
export type { UnixIntegrationConfig };

/**
 * Daemon-specific configuration for Unix integration
 */
export interface DaemonUnixIntegrationConfig extends UnixIntegrationConfig {
  /** Executor mode: 'direct' runs sudo commands directly, 'cli' uses agor admin proxy */
  executorMode?: 'direct' | 'cli';

  /** Path to agor CLI binary (only used when executorMode='cli', default: 'agor') */
  cliPath?: string;

  /** Use sudo for admin commands (default: true) */
  useSudo?: boolean;
}

/**
 * Create Unix Integration Service for daemon use
 *
 * @param db - Database instance
 * @param config - Configuration options
 * @returns UnixIntegrationService instance
 */
export function createUnixIntegrationService(
  db: Database,
  config: DaemonUnixIntegrationConfig = { enabled: false }
): CoreUnixIntegrationService {
  // Default to 'direct' mode - runs sudo commands directly
  // This works in Docker where agor user has passwordless sudo
  const mode = config.executorMode || 'direct';

  const executor =
    mode === 'cli'
      ? new SudoCliExecutor({
          cliPath: config.cliPath || 'agor',
          useSudo: config.useSudo ?? true,
        })
      : new SudoDirectExecutor();

  return new CoreUnixIntegrationService(db, executor, config);
}

// Re-export the service class for type compatibility
export { CoreUnixIntegrationService as UnixIntegrationService };
