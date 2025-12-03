/**
 * Unix Integration Service (Daemon Re-export)
 *
 * Re-exports the UnixIntegrationService from @agor/core for daemon use.
 * The daemon uses the SudoCliExecutor to run privileged commands via `sudo agor admin`.
 *
 * @see context/guides/rbac-and-unix-isolation.md
 */

import type { Database } from '@agor/core/db';
import {
  UnixIntegrationService as CoreUnixIntegrationService,
  SudoCliExecutor,
  type UnixIntegrationConfig,
} from '@agor/core/unix';

// Re-export types
export type { UnixIntegrationConfig };

/**
 * Daemon-specific configuration for Unix integration
 */
export interface DaemonUnixIntegrationConfig extends UnixIntegrationConfig {
  /** Path to agor CLI binary (default: 'agor') */
  cliPath?: string;

  /** Use sudo for admin commands (default: true) */
  useSudo?: boolean;
}

/**
 * Create Unix Integration Service for daemon use
 *
 * Uses SudoCliExecutor to run privileged commands via `sudo agor admin`.
 *
 * @param db - Database instance
 * @param config - Configuration options
 * @returns UnixIntegrationService instance
 */
export function createUnixIntegrationService(
  db: Database,
  config: DaemonUnixIntegrationConfig = { enabled: false }
): CoreUnixIntegrationService {
  const executor = new SudoCliExecutor({
    cliPath: config.cliPath || 'agor',
    useSudo: config.useSudo ?? true,
  });

  return new CoreUnixIntegrationService(db, executor, config);
}

// Re-export the service class for type compatibility
export { CoreUnixIntegrationService as UnixIntegrationService };
