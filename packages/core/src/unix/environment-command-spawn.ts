/**
 * Environment Command Spawn Utilities
 *
 * Wraps environment commands (start/stop/nuke/logs/health) with Unix impersonation.
 * Reuses existing impersonation logic from run-as-user and user-manager.
 */

import { type ChildProcess, type SpawnOptions, spawn } from 'node:child_process';
import { createUserProcessEnvironment } from '../config/index.js';
import type { Database } from '../db/index.js';
import { UsersRepository } from '../db/repositories/index.js';
import type { Worktree } from '../types/index.js';
import { buildSpawnArgs } from './run-as-user.js';
import { resolveUnixUserForImpersonation, validateResolvedUnixUser } from './user-manager.js';

/**
 * Environment command types for logging
 */
export type EnvironmentCommandType = 'start' | 'stop' | 'nuke' | 'logs' | 'health';

export interface SpawnEnvironmentCommandOptions {
  /** The shell command to execute */
  command: string;
  /** The worktree this command is running for */
  worktree: Worktree;
  /** Database instance (for user lookup and config) */
  db: Database;
  /** Command type for logging */
  commandType: EnvironmentCommandType;
  /** stdio configuration (default: 'inherit') */
  stdio?: SpawnOptions['stdio'];
}

/**
 * Spawn an environment command with conditional Unix impersonation
 *
 * Automatically handles:
 * - Loading Unix user mode config
 * - Looking up user's unix_username
 * - Creating clean user process environment
 * - Resolving impersonation based on mode
 *
 * Behavior based on unix_user_mode:
 * - simple: No impersonation, run as daemon user
 * - insulated: Run as executor_unix_user (if configured)
 * - strict: Run as user's unix_username
 *
 * @param options - Spawn configuration
 * @returns Child process
 */
export async function spawnEnvironmentCommand(
  options: SpawnEnvironmentCommandOptions
): Promise<ChildProcess> {
  const { command, worktree, db, commandType, stdio = 'inherit' } = options;

  const logPrefix = `[Environment.${commandType} ${worktree.name}]`;

  // Load config for Unix impersonation settings
  const { loadConfig } = await import('../config/config-manager.js');
  const config = await loadConfig();
  const unixUserMode = config.execution?.unix_user_mode ?? 'simple';

  // Resolve impersonation user first to determine if we need impersonation-safe env
  let asUser: string | undefined;

  if (unixUserMode !== 'simple') {
    // Look up user's unix_username
    const usersRepo = new UsersRepository(db);
    const user = await usersRepo.findById(worktree.created_by);

    const impersonationResult = resolveUnixUserForImpersonation({
      mode: unixUserMode,
      userUnixUsername: user?.unix_username,
      executorUnixUser: config.execution?.executor_unix_user,
    });

    asUser = impersonationResult.unixUser ?? undefined;

    if (asUser) {
      validateResolvedUnixUser(unixUserMode, asUser);
      console.log(
        `${logPrefix} Running as user: ${asUser} (reason: ${impersonationResult.reason})`
      );
    } else {
      console.log(`${logPrefix} Running as daemon user (reason: ${impersonationResult.reason})`);
    }
  } else {
    console.log(`${logPrefix} Running as daemon user (mode: ${unixUserMode})`);
  }

  // Create clean environment for user process
  // If impersonating, strip HOME/USER/LOGNAME/SHELL so sudo -u can set them properly
  const env = await createUserProcessEnvironment(worktree.created_by, db, undefined, !!asUser);

  // Build spawn args with impersonation
  const { cmd, args } = buildSpawnArgs(command, [], {
    asUser,
    env: asUser ? env : undefined, // Only pass env via sudo wrapper if impersonating
  });

  // Spawn the command
  // When not impersonating (simple mode), buildSpawnArgs returns the raw command string,
  // so we need shell: true to handle multi-word commands like "docker compose up -d"
  return spawn(cmd, args, {
    cwd: worktree.path,
    env: asUser ? undefined : env, // Use process env if not impersonating
    stdio,
    shell: !asUser, // Use shell for simple mode, buildSpawnArgs wraps sudo in bash -c
  });
}
