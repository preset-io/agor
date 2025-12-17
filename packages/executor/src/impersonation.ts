/**
 * Impersonation Module - Handles Unix user impersonation for executor
 *
 * This module consolidates all impersonation logic inside the executor,
 * replacing the daemon's buildSpawnArgs() impersonation.
 *
 * WHY IMPERSONATION INSIDE EXECUTOR:
 * 1. Single isolation boundary - all sudo happens in one place
 * 2. Fresh group memberships - uses `sudo su -` (login shell)
 * 3. Clean architecture - daemon just spawns executor, executor handles sudo
 * 4. k8s compatible - impersonation can use pod security context instead
 *
 * HOW IT WORKS:
 * 1. Daemon spawns executor with asUser in JSON payload
 * 2. Executor checks if already running as target user
 * 3. If not, re-invokes itself via `sudo su - $USER -c 'agor-executor --stdin'`
 * 4. Inner executor has AGOR_IMPERSONATED=true, runs the actual command
 *
 * @see context/explorations/executor-expansion.md
 */

import { spawn } from 'node:child_process';
import { userInfo } from 'node:os';

import type { ExecutorPayload, ExecutorResult } from './payload-types.js';

/**
 * Environment variable marker for impersonated executor
 * Set to 'true' when executor is re-invoked as target user
 */
export const IMPERSONATED_ENV_VAR = 'AGOR_IMPERSONATED';

/**
 * Check if current process is already impersonated
 */
export function isImpersonated(): boolean {
  return process.env[IMPERSONATED_ENV_VAR] === 'true';
}

/**
 * Check if current process is running as the target user
 */
export function isRunningAsUser(targetUser: string): boolean {
  const currentUser = userInfo().username;
  return currentUser === targetUser;
}

/**
 * Escape a string for safe use in a shell command
 * Uses single-quote escaping which prevents all expansions
 */
function escapeShellArg(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * Options for withImpersonation
 */
export interface ImpersonationOptions {
  /** Path to executor binary (for re-invocation) */
  executorPath?: string;

  /** Dry-run mode - don't actually execute */
  dryRun?: boolean;
}

/**
 * Result of impersonation check
 */
export interface ImpersonationResult {
  /** Whether impersonation is needed */
  needsImpersonation: boolean;

  /** Reason for decision */
  reason: string;

  /** Target Unix user (if impersonation needed) */
  targetUser?: string;
}

/**
 * Check if impersonation is needed for a payload
 *
 * @param payload - The executor payload
 * @returns ImpersonationResult with decision
 */
export function checkImpersonation(payload: ExecutorPayload): ImpersonationResult {
  const { asUser } = payload;

  // No impersonation requested
  if (!asUser) {
    return {
      needsImpersonation: false,
      reason: 'No asUser specified in payload',
    };
  }

  // Already impersonated (inner executor)
  if (isImpersonated()) {
    return {
      needsImpersonation: false,
      reason: `Already impersonated (${IMPERSONATED_ENV_VAR}=true)`,
    };
  }

  // Already running as target user
  if (isRunningAsUser(asUser)) {
    return {
      needsImpersonation: false,
      reason: `Already running as target user: ${asUser}`,
    };
  }

  // Impersonation needed
  return {
    needsImpersonation: true,
    reason: `Need to impersonate: ${asUser}`,
    targetUser: asUser,
  };
}

/**
 * Re-invoke executor as target user via sudo su -
 *
 * Uses `sudo -n su - $USER -c '...'` to:
 * - Get fresh Unix group memberships (login shell via `su -`)
 * - Prevent password prompts (-n flag)
 * - Pass payload via stdin
 *
 * @param payload - Original payload to pass to inner executor
 * @param targetUser - Unix user to run as
 * @param options - Additional options
 * @returns Promise resolving to ExecutorResult from inner executor
 */
export async function runAsUser(
  payload: ExecutorPayload,
  targetUser: string,
  options: ImpersonationOptions = {}
): Promise<ExecutorResult> {
  const { executorPath = process.argv[1], dryRun = false } = options;

  if (dryRun) {
    return {
      success: true,
      data: {
        dryRun: true,
        impersonation: {
          targetUser,
          executorPath,
          command: payload.command,
        },
      },
    };
  }

  return new Promise((resolve) => {
    // Build inner command that will be run as target user
    // The inner executor reads from stdin, so we pass payload via pipe
    const innerCommand = `${IMPERSONATED_ENV_VAR}=true node ${escapeShellArg(executorPath)} --stdin`;

    // Build sudo su - command
    // -n: non-interactive (no password prompt)
    // su -: login shell for fresh group memberships
    const cmd = 'sudo';
    const args = ['-n', 'su', '-', targetUser, '-c', innerCommand];

    console.log(`[executor/impersonation] Re-invoking as user: ${targetUser}`);

    const proc = spawn(cmd, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Collect stdout for result
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    proc.stdout?.on('data', (data) => {
      stdoutChunks.push(data);
    });

    proc.stderr?.on('data', (data) => {
      stderrChunks.push(data);
      // Also log stderr in real-time for debugging
      process.stderr.write(`[executor/impersonated] ${data}`);
    });

    // Write payload to stdin of inner executor
    proc.stdin?.write(JSON.stringify(payload));
    proc.stdin?.end();

    proc.on('error', (error) => {
      resolve({
        success: false,
        error: {
          code: 'IMPERSONATION_SPAWN_FAILED',
          message: `Failed to spawn impersonated executor: ${error.message}`,
        },
      });
    });

    proc.on('exit', (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString('utf-8').trim();
      const stderr = Buffer.concat(stderrChunks).toString('utf-8').trim();

      // For prompt command, result comes via WebSocket, not stdout
      // Just return success/failure based on exit code
      if (payload.command === 'prompt') {
        if (code === 0) {
          resolve({
            success: true,
            data: { exitCode: code },
          });
        } else {
          resolve({
            success: false,
            error: {
              code: 'IMPERSONATED_EXECUTOR_FAILED',
              message: `Impersonated executor exited with code ${code}`,
              details: { stderr, exitCode: code },
            },
          });
        }
        return;
      }

      // For other commands, parse JSON result from stdout
      if (code === 0 && stdout) {
        try {
          const result = JSON.parse(stdout);
          resolve(result);
        } catch {
          // stdout might not be JSON (e.g., logging output)
          resolve({
            success: true,
            data: { stdout, exitCode: code },
          });
        }
      } else {
        resolve({
          success: false,
          error: {
            code: 'IMPERSONATED_EXECUTOR_FAILED',
            message: `Impersonated executor exited with code ${code}`,
            details: { stdout, stderr, exitCode: code },
          },
        });
      }
    });
  });
}

/**
 * High-level wrapper that handles impersonation if needed
 *
 * Use this at the start of command execution:
 * 1. Checks if impersonation is needed
 * 2. If yes, re-invokes executor as target user and returns result
 * 3. If no, returns null and caller should proceed with normal execution
 *
 * @param payload - The executor payload
 * @param options - Additional options
 * @returns ExecutorResult if impersonation happened, null if caller should proceed
 */
export async function handleImpersonation(
  payload: ExecutorPayload,
  options: ImpersonationOptions = {}
): Promise<ExecutorResult | null> {
  const check = checkImpersonation(payload);

  console.log(`[executor/impersonation] ${check.reason}`);

  if (!check.needsImpersonation) {
    return null;
  }

  // Re-invoke as target user
  return runAsUser(payload, check.targetUser!, options);
}
