/**
 * Executor Spawning Utility
 *
 * Provides a reusable function to spawn the executor process for various commands.
 * Used by daemon services (repos, worktrees, terminals) to delegate operations
 * to the executor for proper Unix isolation.
 *
 * IMPERSONATION: When asUser is provided, the executor is spawned via `sudo su -`
 * to run as the target Unix user with fresh group memberships. This is the single
 * point where user impersonation happens - the executor itself runs as the target user.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSpawnArgs } from '@agor/core/unix';
import jwt from 'jsonwebtoken';

/**
 * Result from executor spawning
 */
export interface SpawnExecutorResult {
  success: boolean;
  data?: Record<string, unknown>;
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

/**
 * Options for spawning executor
 */
export interface SpawnExecutorOptions {
  /** Working directory for executor process */
  cwd?: string;

  /** Environment variables for executor process */
  env?: Record<string, string>;

  /** Timeout in milliseconds (default: 5 minutes) */
  timeout?: number;

  /** Log prefix for console output */
  logPrefix?: string;

  /**
   * Unix user to run executor as (impersonation)
   * When set, spawns via `sudo su - $asUser -c 'node executor --stdin'`
   * This gives the executor fresh group memberships for the target user.
   */
  asUser?: string;
}

/**
 * Find the executor binary path
 *
 * Searches multiple possible locations for development and production:
 * - Bundled in agor-live package
 * - Development bin script
 * - Built dist directory
 */
export function findExecutorPath(): string {
  const dirname =
    typeof __dirname !== 'undefined' ? __dirname : path.dirname(fileURLToPath(import.meta.url));

  const possiblePaths = [
    path.join(dirname, '../executor/cli.js'), // Bundled in agor-live
    path.join(dirname, '../../executor/cli.js'), // Bundled one level up
    path.join(dirname, '../../../packages/executor/bin/agor-executor'), // Development - bin script
    path.join(dirname, '../../../packages/executor/dist/cli.js'), // Development - built dist
    path.join(dirname, '../../../../packages/executor/bin/agor-executor'), // Development from deeper nesting
    path.join(dirname, '../../../../packages/executor/dist/cli.js'), // Development from deeper nesting
  ];

  const executorPath = possiblePaths.find((p) => existsSync(p));
  if (!executorPath) {
    throw new Error(
      `Executor binary not found. Tried:\n${possiblePaths.map((p) => `  - ${p}`).join('\n')}`
    );
  }

  return executorPath;
}

/**
 * Spawn executor process with JSON payload via stdin
 *
 * This is a general-purpose executor spawner for synchronous operations
 * (git clone, git worktree add/remove, etc.) where we wait for completion.
 *
 * When asUser is provided, the executor is spawned via `sudo su -` to run
 * as the target Unix user with fresh group memberships.
 *
 * @param payload - JSON payload matching ExecutorPayload schema
 * @param options - Spawn options
 * @returns Promise resolving to executor result
 */
export async function spawnExecutor(
  payload: Record<string, unknown>,
  options: SpawnExecutorOptions = {}
): Promise<SpawnExecutorResult> {
  const executorPath = findExecutorPath();

  // Default cwd to executor package directory for proper module resolution
  // ESM imports resolve relative to the file location, and pnpm's node_modules
  // structure requires running from the package directory
  const executorDir = path.dirname(path.dirname(executorPath)); // Go up from bin/agor-executor or dist/cli.js

  const {
    cwd = executorDir,
    env = process.env as Record<string, string>,
    timeout = 5 * 60 * 1000, // 5 minutes default
    logPrefix = '[Executor]',
    asUser,
  } = options;

  // Build spawn command - handles impersonation via sudo su - when asUser is set
  const { cmd, args } = buildSpawnArgs('node', [executorPath, '--stdin'], {
    asUser,
    env: asUser ? env : undefined, // Only inject env when impersonating (sudo su - ignores spawn env)
  });

  if (asUser) {
    console.log(`${logPrefix} Spawning executor as user: ${asUser}`);
  }
  console.log(`${logPrefix} Spawning executor at: ${executorPath}`);
  console.log(`${logPrefix} Command: ${payload.command}`);

  return new Promise((resolve) => {
    const executorProcess = spawn(cmd, args, {
      cwd,
      env: asUser ? undefined : { ...env }, // When impersonating, env is in the command; otherwise pass to spawn
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Collect stdout and stderr
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    executorProcess.stdout?.on('data', (data) => {
      stdoutChunks.push(data);
      // Also log in real-time
      console.log(`${logPrefix} ${data.toString().trim()}`);
    });

    executorProcess.stderr?.on('data', (data) => {
      stderrChunks.push(data);
      console.error(`${logPrefix} ${data.toString().trim()}`);
    });

    // Set up timeout
    const timeoutId = setTimeout(() => {
      console.error(`${logPrefix} Timeout after ${timeout}ms, killing process`);
      executorProcess.kill('SIGTERM');
      resolve({
        success: false,
        error: {
          code: 'EXECUTOR_TIMEOUT',
          message: `Executor timed out after ${timeout}ms`,
          details: { command: payload.command },
        },
      });
    }, timeout);

    executorProcess.on('error', (error) => {
      clearTimeout(timeoutId);
      console.error(`${logPrefix} Spawn error:`, error.message);
      resolve({
        success: false,
        error: {
          code: 'EXECUTOR_SPAWN_FAILED',
          message: error.message,
        },
      });
    });

    executorProcess.on('exit', (code) => {
      clearTimeout(timeoutId);

      const stdout = Buffer.concat(stdoutChunks).toString('utf-8').trim();
      const stderr = Buffer.concat(stderrChunks).toString('utf-8').trim();

      console.log(`${logPrefix} Exited with code ${code}`);

      if (code === 0) {
        // Try to parse JSON result from stdout
        // The executor outputs the result as the last line of JSON
        const lines = stdout.split('\n');
        const lastLine = lines[lines.length - 1];

        try {
          const result = JSON.parse(lastLine);
          resolve(result);
        } catch {
          // Not JSON, return raw output
          resolve({
            success: true,
            data: { stdout, exitCode: code },
          });
        }
      } else {
        resolve({
          success: false,
          error: {
            code: 'EXECUTOR_FAILED',
            message: `Executor exited with code ${code}`,
            details: { stdout, stderr, exitCode: code },
          },
        });
      }
    });

    // Write JSON payload to stdin
    executorProcess.stdin?.write(JSON.stringify(payload));
    executorProcess.stdin?.end();
  });
}

/**
 * Get daemon URL from environment or config
 */
export function getDaemonUrl(port?: number): string {
  const effectivePort = port || process.env.PORT || '3030';
  return `http://localhost:${effectivePort}`;
}

/**
 * Create a short-lived service token for executor authentication
 *
 * This token is used by the executor to authenticate with the daemon
 * when making Feathers API calls. It's a special "service" token that
 * allows the executor to perform privileged operations.
 *
 * @param jwtSecret - The daemon's JWT secret
 * @param expiresIn - Token expiration (default: 5 minutes)
 * @returns JWT access token
 */
export function createServiceToken(jwtSecret: string, expiresIn?: string): string {
  // Cast options to satisfy TypeScript - the signature is correct
  const options = {
    expiresIn: expiresIn || '5m',
    issuer: 'agor',
    audience: 'https://agor.dev',
  } as jwt.SignOptions;

  return jwt.sign(
    {
      sub: 'executor-service',
      type: 'service',
      // Service tokens can perform privileged operations
      role: 'service',
    },
    jwtSecret,
    options
  );
}

/**
 * Generate a session token from the Feathers app
 *
 * Convenience function that extracts the JWT secret from the app
 * and creates a service token.
 *
 * @param app - FeathersJS application with sessionTokenService
 * @returns JWT access token
 */
export function generateSessionToken(app: {
  settings: { authentication?: { secret?: string } };
}): string {
  const jwtSecret = app.settings.authentication?.secret;
  if (!jwtSecret) {
    throw new Error('JWT secret not configured in app settings');
  }
  return createServiceToken(jwtSecret);
}

/**
 * Options for fire-and-forget executor spawning
 */
export interface FireAndForgetOptions {
  /** Working directory for executor process */
  cwd?: string;

  /** Environment variables for executor process */
  env?: Record<string, string>;

  /** Log prefix for console output */
  logPrefix?: string;

  /**
   * Unix user to run executor as (impersonation)
   * When set, spawns via `sudo su - $asUser -c 'node executor --stdin'`
   * This gives the executor fresh group memberships for the target user.
   */
  asUser?: string;
}

/**
 * Spawn executor process and return immediately (fire-and-forget)
 *
 * Unlike spawnExecutor(), this function:
 * - Does NOT wait for the process to complete
 * - Does NOT parse stdout for results
 * - Returns immediately after spawning
 *
 * The executor is responsible for:
 * - Completing all operations (git, DB updates, Unix groups)
 * - Communicating with daemon via Feathers WebSocket client
 * - Handling its own errors and logging
 *
 * When asUser is provided, the executor is spawned via `sudo su -` to run
 * as the target Unix user with fresh group memberships.
 *
 * @param payload - JSON payload matching ExecutorPayload schema
 * @param options - Spawn options
 */
export function spawnExecutorFireAndForget(
  payload: Record<string, unknown>,
  options: FireAndForgetOptions = {}
): void {
  const executorPath = findExecutorPath();

  // Default cwd to executor package directory for proper module resolution
  // ESM imports resolve relative to the file location, and pnpm's node_modules
  // structure requires running from the package directory
  const executorDir = path.dirname(path.dirname(executorPath)); // Go up from bin/agor-executor or dist/cli.js

  const {
    cwd = executorDir,
    env = process.env as Record<string, string>,
    logPrefix = '[Executor]',
    asUser,
  } = options;

  // Build spawn command - handles impersonation via sudo su - when asUser is set
  const { cmd, args } = buildSpawnArgs('node', [executorPath, '--stdin'], {
    asUser,
    env: asUser ? env : undefined, // Only inject env when impersonating (sudo su - ignores spawn env)
  });

  if (asUser) {
    console.log(`${logPrefix} 🔥 Fire-and-forget: Spawning executor as user: ${asUser}`);
  }
  console.log(`${logPrefix} 🔥 Fire-and-forget: Spawning executor at: ${executorPath}`);
  console.log(`${logPrefix} Command: ${payload.command}`);

  const executorProcess = spawn(cmd, args, {
    cwd,
    env: asUser ? undefined : { ...env }, // When impersonating, env is in the command; otherwise pass to spawn
    stdio: ['pipe', 'inherit', 'inherit'], // stdin: pipe, stdout/stderr: inherit (show in daemon logs)
    detached: false, // Don't detach - let daemon manage lifecycle
  });

  // Log if process fails to spawn
  executorProcess.on('error', (error) => {
    console.error(`${logPrefix} ❌ Spawn error:`, error.message);
  });

  // Log when process exits (for debugging)
  executorProcess.on('exit', (code) => {
    if (code === 0) {
      console.log(`${logPrefix} ✅ Executor completed successfully`);
    } else {
      console.error(`${logPrefix} ❌ Executor exited with code ${code}`);
    }
  });

  // Write JSON payload to stdin and close it
  executorProcess.stdin?.write(JSON.stringify(payload));
  executorProcess.stdin?.end();

  // Return immediately - don't wait for process to complete
}
