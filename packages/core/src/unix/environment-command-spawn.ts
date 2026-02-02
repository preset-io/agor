/**
 * Environment Command Spawn Utilities
 *
 * Wraps environment commands (start/stop/nuke/logs/health) with Unix impersonation.
 * Reuses existing impersonation logic from run-as-user and user-manager.
 */

import { type ChildProcess, type SpawnOptions, spawn } from 'node:child_process';
import { buildSpawnArgs } from './run-as-user.js';
import {
  resolveUnixUserForImpersonation,
  type UnixUserMode,
  validateResolvedUnixUser,
} from './user-manager.js';

export interface SpawnEnvironmentCommandOptions {
  /** The shell command to execute */
  command: string;
  /** Working directory for the command */
  cwd: string;
  /** Environment variables to pass to the command */
  env: Record<string, string>;
  /** Unix user mode (simple/insulated/strict) */
  unixUserMode?: UnixUserMode;
  /** User's unix_username (for resolving impersonation in strict mode) */
  userUnixUsername?: string | null;
  /** Executor unix username (for insulated mode) */
  executorUnixUser?: string | null;
  /** stdio configuration (default: 'inherit') */
  stdio?: SpawnOptions['stdio'];
  /** Log prefix for console output (default: '[Environment]') */
  logPrefix?: string;
}

/**
 * Spawn an environment command with conditional Unix impersonation
 *
 * Behavior based on unix_user_mode:
 * - simple: No impersonation, run as daemon user
 * - insulated: Run as executor_unix_user (if configured)
 * - strict: Run as user's unix_username (requires userUnixUsername to be provided)
 *
 * @param options - Spawn configuration
 * @returns Child process
 */
export function spawnEnvironmentCommand(options: SpawnEnvironmentCommandOptions): ChildProcess {
  const {
    command,
    cwd,
    env,
    unixUserMode = 'simple',
    userUnixUsername,
    executorUnixUser,
    stdio = 'inherit',
    logPrefix = '[Environment]',
  } = options;

  // Resolve impersonation user
  let asUser: string | undefined;

  if (unixUserMode !== 'simple') {
    const impersonationResult = resolveUnixUserForImpersonation({
      mode: unixUserMode,
      userUnixUsername: userUnixUsername ?? undefined,
      executorUnixUser: executorUnixUser ?? undefined,
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

  // Build spawn args with impersonation
  const { cmd, args } = buildSpawnArgs(command, [], {
    asUser,
    env: asUser ? env : undefined, // Only pass env via sudo wrapper if impersonating
  });

  // Spawn the command
  return spawn(cmd, args, {
    cwd,
    env: asUser ? undefined : env, // Use process env if not impersonating
    stdio,
    shell: false, // buildSpawnArgs already wraps in bash -c
  });
}
