/**
 * Executor Spawning Utility
 *
 * Provides a single function to spawn the executor process for all commands.
 * Used by daemon services (repos, branches, terminals, tasks) to delegate
 * operations to the executor for proper Unix isolation.
 *
 * DESIGN PHILOSOPHY:
 * - All spawns are fire-and-forget (daemon doesn't wait for results)
 * - Executor handles its own logging, status updates, and notifications via Feathers
 * - Executor connects back to daemon via WebSocket for real-time communication
 *
 * EXECUTION MODES:
 * 1. Local subprocess (default): Spawns executor as a child process
 * 2. Templated/remote: Uses executor_command_template for k8s/docker/remote execution
 *
 * IMPERSONATION: When asUser is provided, the executor is spawned via
 * `sudo -n -u $asUser bash -c '...'` to run as the target Unix user with
 * fresh group memberships. Secret-looking env vars are routed through a
 * 0600 env-file owned by the target user so their values never appear in
 * argv / /proc/<pid>/cmdline.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgorExecutionSettings } from '@agor/core/config';
import type { AuthenticatedParams } from '@agor/core/types';
import {
  attachEnvFileCleanup,
  buildSpawnArgs,
  isSecretEnvKey,
  prepareImpersonationEnv,
} from '@agor/core/unix';
import { getCurrentLogLevel } from '@agor/core/utils/logger';
import type { SignOptions } from 'jsonwebtoken';
import { issueRuntimeToken } from '../auth/runtime-tokens.js';
import { withResolvedConfig } from './build-resolved-config-slice.js';

let configuredDaemonUrl: string | null = null;

function resolveExecutorLogLevel(env: Record<string, string>): string {
  return env.LOG_LEVEL || getCurrentLogLevel();
}

function withDaemonExecutorEnv(
  env: Record<string, string>,
  daemonUrl: string
): Record<string, string> {
  return {
    ...env,
    DAEMON_URL: daemonUrl,
    LOG_LEVEL: resolveExecutorLogLevel(env),
  };
}

/** Set the daemon URL for executor payloads. Call once at daemon startup. */
export function configureDaemonUrl(url: string): void {
  configuredDaemonUrl = url;
  console.log(`[Executor] Daemon URL configured: ${url}`);
}

let configuredExecutorDefaults: ExecutorSpawnDefaults = {};

/** Set default executor template + impersonation user from config. Call once at daemon startup. */
export function configureExecutor(config?: ExecutorConfig | null): void {
  configuredExecutorDefaults = {
    executorCommandTemplate: config?.executor_command_template || undefined,
    asUser: config?.executor_unix_user || undefined,
  };

  if (configuredExecutorDefaults.executorCommandTemplate) {
    const preview =
      configuredExecutorDefaults.executorCommandTemplate.split('\n')[0]?.slice(0, 80) ?? '';
    console.log(
      `[Executor] Command template configured (first line): ${preview}${preview.length === 80 ? '…' : ''}`
    );
  }
  if (configuredExecutorDefaults.asUser) {
    console.log(`[Executor] Default impersonation user: ${configuredExecutorDefaults.asUser}`);
  }
}

export interface ExecutorTemplateVariables {
  task_id?: string;
  command?: string;
  unix_user?: string;
  unix_user_uid?: number;
  unix_user_gid?: number;
  session_id?: string;
  branch_id?: string;
  log_level?: string;
}

export interface SpawnExecutorOptions {
  cwd?: string;
  env?: Record<string, string>;
  logPrefix?: string;
  /** When set, spawns via `sudo -n -u $asUser`. Secrets go through a 0600 env-file. */
  asUser?: string | null;
  /** When set, uses template substitution instead of local subprocess. */
  executorCommandTemplate?: string | null;
  templateVariables?: ExecutorTemplateVariables;
  onExit?: (code: number | null) => void;
  /** Fired after spawn, before stdin is written. Works for both local and templated paths. */
  onSpawn?: (child: ChildProcess) => void;
  /** Caller-assembled env; bypasses internal curation. Ignored by templated path. */
  preparedEnv?: Record<string, string>;
  /** Pre-written 0600 env file; bypasses prepareImpersonationEnv(). Only with asUser. */
  preparedEnvFilePath?: string;
}

export interface ExecutorCommandResult {
  success: boolean;
  data?: unknown;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface RunExecutorCommandOptions
  extends Omit<SpawnExecutorOptions, 'onExit' | 'onSpawn'> {
  /** Optional timeout for short-lived command execution. */
  timeoutMs?: number;
}

/**
 * Substitute template variables in the executor command template.
 *
 * Replaces placeholders like {task_id}, {unix_user}, etc. with actual values.
 * Unknown placeholders are left as-is (for safety).
 *
 * @param template - The command template with {variable} placeholders
 * @param variables - The values to substitute
 * @returns The template with variables substituted
 */
export function substituteTemplateVariables(
  template: string,
  variables: ExecutorTemplateVariables
): string {
  let result = template;

  const substitutions: Record<string, string | number | undefined> = {
    task_id: variables.task_id,
    command: variables.command,
    unix_user: variables.unix_user,
    unix_user_uid: variables.unix_user_uid,
    unix_user_gid: variables.unix_user_gid,
    session_id: variables.session_id,
    branch_id: variables.branch_id,
    log_level: variables.log_level,
  };

  for (const [key, value] of Object.entries(substitutions)) {
    if (value !== undefined) {
      const placeholder = new RegExp(`\\{${key}\\}`, 'g');
      result = result.replace(placeholder, String(value));
    }
  }

  return result;
}

export function generateTaskId(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function findExecutorPath(): string {
  const configuredPath = process.env.AGOR_EXECUTOR_PATH;
  if (configuredPath) {
    if (!existsSync(configuredPath)) {
      throw new Error(`Configured AGOR_EXECUTOR_PATH does not exist: ${configuredPath}`);
    }
    return configuredPath;
  }

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
 * Spawn executor process with JSON payload via stdin (fire-and-forget)
 *
 * This is the SINGLE entry point for all executor spawning. It:
 * - Returns immediately after spawning (does NOT wait for completion)
 * - Supports both local subprocess and templated (k8s/docker) execution
 * - Logs stdout/stderr to daemon logs
 *
 * The executor is responsible for:
 * - Completing all operations (git, DB updates, Unix groups)
 * - Communicating with daemon via Feathers WebSocket client
 * - Handling its own errors, logging, and status updates
 * - Emitting events that the UI can display as toasts
 *
 * @param payload - JSON payload matching ExecutorPayload schema
 * @param options - Spawn options
 */
export function spawnExecutor(
  payload: Record<string, unknown>,
  options: SpawnExecutorOptions = {}
): void {
  const { templateVariables, logPrefix = '[Executor]' } = options;

  const executorCommandTemplate =
    options.executorCommandTemplate !== undefined
      ? options.executorCommandTemplate || undefined
      : configuredExecutorDefaults.executorCommandTemplate;
  const asUser =
    options.asUser !== undefined ? options.asUser || undefined : configuredExecutorDefaults.asUser;

  const payloadWithConfig = withResolvedConfig(payload);

  if (executorCommandTemplate) {
    spawnExecutorWithTemplate(payloadWithConfig, {
      ...options,
      asUser,
      executorCommandTemplate,
      templateVariables: {
        command: payloadWithConfig.command as string,
        task_id: generateTaskId(),
        unix_user: asUser,
        log_level: resolveExecutorLogLevel(options.env ?? (process.env as Record<string, string>)),
        ...templateVariables,
      },
      logPrefix,
    });
  } else {
    spawnExecutorLocal(payloadWithConfig, { ...options, asUser });
  }
}

/**
 * Spawn executor as a local subprocess.
 * stdout/stderr are inherited so logs appear in daemon output.
 */
function spawnExecutorLocal(payload: Record<string, unknown>, options: SpawnExecutorOptions): void {
  const executorPath = findExecutorPath();

  // Default cwd to executor package directory for proper module resolution
  // ESM imports resolve relative to the file location, and pnpm's node_modules
  // structure requires running from the package directory
  const executorDir = path.dirname(path.dirname(executorPath)); // Go up from bin/agor-executor or dist/cli.js

  const {
    cwd = executorDir,
    env = process.env as Record<string, string>,
    logPrefix = '[Executor]',
    asUser: rawAsUser,
    onSpawn,
    preparedEnv,
    preparedEnvFilePath,
  } = options;
  const asUser = rawAsUser || undefined;

  const daemonUrl = getDaemonUrl();

  const envWithDaemonUrl: Record<string, string> = preparedEnv
    ? withDaemonExecutorEnv(preparedEnv, daemonUrl)
    : asUser
      ? withDaemonExecutorEnv(
          Object.fromEntries(
            Object.entries({
              PATH: env.PATH || '/usr/local/bin:/usr/bin:/bin',
              NODE_ENV: env.NODE_ENV,
              LOG_LEVEL: env.LOG_LEVEL,
              // HOME: not set - sudo will set it to the target user's home directory
              ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
              ANTHROPIC_AUTH_TOKEN: env.ANTHROPIC_AUTH_TOKEN,
              ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL,
              CLAUDE_CODE_OAUTH_TOKEN: env.CLAUDE_CODE_OAUTH_TOKEN,
              OPENAI_API_KEY: env.OPENAI_API_KEY,
              OPENAI_BASE_URL: env.OPENAI_BASE_URL,
              GEMINI_API_KEY: env.GEMINI_API_KEY,
              GOOGLE_API_KEY: env.GOOGLE_API_KEY,
              // Forward git hardening pairs across the sudo boundary (sudoers
              // env_keep is the belt; this is the suspenders for this path).
              GIT_CONFIG_PARAMETERS: env.GIT_CONFIG_PARAMETERS,
            }).filter(([_, v]) => v !== undefined)
          ),
          daemonUrl
        )
      : withDaemonExecutorEnv(env as Record<string, string>, daemonUrl);

  const prepared = asUser
    ? preparedEnvFilePath
      ? {
          inlineEnv: Object.fromEntries(
            Object.entries(envWithDaemonUrl).filter(([k]) => !isSecretEnvKey(k))
          ),
          envFilePath: preparedEnvFilePath,
        }
      : prepareImpersonationEnv({ asUser, env: envWithDaemonUrl })
    : { inlineEnv: undefined, envFilePath: undefined };

  const { cmd, args } = buildSpawnArgs('node', [executorPath, '--stdin'], {
    asUser,
    env: asUser ? prepared.inlineEnv : undefined, // Non-secret env only; secrets are sourced from envFilePath
    envFilePath: prepared.envFilePath,
  });

  if (asUser) {
    // Safe summary only — never log secret values or their key names.
    const safeEnvKeys = Object.keys(prepared.inlineEnv ?? {}).filter((k) => !isSecretEnvKey(k));
    console.log(
      `${logPrefix} Spawning executor as user=${asUser} tool=${payload.command ?? '?'} envKeys=[${safeEnvKeys.join(',')}]${prepared.envFilePath ? ' (secrets in env-file)' : ''}`
    );
  }
  console.log(`${logPrefix} Spawning executor at: ${executorPath}`);
  console.log(`${logPrefix} Command: ${payload.command}`);

  // Detect missing-cwd up front (issue #1109). Without this, node's
  // child_process surfaces `spawn /usr/local/bin/node ENOENT` — reported
  // against the executable path, not the cwd that's actually gone — and
  // operators end up debugging the wrong layer. The most common cause is
  // running with a persistent database while `$HOME` is on an ephemeral
  // volume (e.g. Kubernetes emptyDir): on pod redeploy the DB still
  // references branch/repo paths that no longer exist on disk. We
  // surface that clearly here; recovery is left to the operator
  // (restore the volume, or use the branch/repo lifecycle commands to
  // remove the orphan rows).
  if (cwd && !existsSync(cwd)) {
    console.error(
      `${logPrefix} Refusing to spawn: cwd does not exist on disk: ${cwd}. ` +
        `This usually means the branch or repo directory was deleted ` +
        `out-of-band — for example a Kubernetes pod redeploy with an ` +
        `ephemeral $HOME but a persistent database. Verify that the volume ` +
        `backing $HOME persists across restarts. See issue #1109.`
    );
    // Surface failure through the normal exit-code path so onExit handlers
    // (e.g. the clone-safety-net in repos.ts) run as expected. 127 is the
    // conventional "command not found" exit code; close enough semantically
    // for "the cwd is gone" without inventing a new one.
    options.onExit?.(127);
    return;
  }

  let reportedExit = false;
  const reportExit = (code: number | null): void => {
    if (reportedExit) return;
    reportedExit = true;
    options.onExit?.(code);
  };

  const executorProcess = spawn(cmd, args, {
    cwd,
    env: asUser ? undefined : { ...envWithDaemonUrl }, // When impersonating, env is in the command; otherwise pass to spawn
    stdio: ['pipe', 'inherit', 'inherit'], // stdin: pipe, stdout/stderr: inherit (show in daemon logs)
    detached: false, // Don't detach - let daemon manage lifecycle
  });

  // Best-effort safety-net cleanup: the inner bash script `rm -f`s the env
  // file before exec, but if sudo/bash failed to launch — or `set -eu`
  // aborted the source step — the file may remain. attachEnvFileCleanup
  // uses `sudo -u <asUser> rm -f` so it works under sticky /tmp.
  attachEnvFileCleanup(executorProcess, { envFilePath: prepared.envFilePath, asUser });

  onSpawn?.(executorProcess);

  executorProcess.on('error', (error) => {
    console.error(`${logPrefix} Spawn error:`, error.message);
    // child_process may emit `error` without a following `exit` when the
    // executable itself cannot be spawned (for example, missing sudo in a dev
    // image). Surface that through the normal onExit safety net so callers do
    // not leave persistent rows stuck in in-progress states.
    reportExit(127);
  });

  executorProcess.on('exit', (code) => {
    if (code === 0) {
      console.log(`${logPrefix} Executor completed successfully`);
    } else {
      console.error(`${logPrefix} Executor exited with code ${code}`);
    }
    reportExit(code);
  });

  executorProcess.stdin?.write(JSON.stringify(payload));
  executorProcess.stdin?.end();
}

function spawnExecutorWithTemplate(
  payload: Record<string, unknown>,
  options: SpawnExecutorOptions & {
    executorCommandTemplate: string;
    templateVariables: ExecutorTemplateVariables;
  }
): void {
  const { executorCommandTemplate, templateVariables, logPrefix = '[Executor]' } = options;
  const logLevel = templateVariables.log_level ?? getCurrentLogLevel();

  const command = substituteTemplateVariables(executorCommandTemplate, templateVariables);

  console.log(`${logPrefix} Templated execution mode`);
  console.log(`${logPrefix} Task ID: ${templateVariables.task_id}`);
  console.log(`${logPrefix} Command: ${payload.command}`);
  console.log(`${logPrefix} Template command (first 200 chars): ${command.slice(0, 200)}...`);

  let reportedExit = false;
  const reportExit = (code: number | null): void => {
    if (reportedExit) return;
    reportedExit = true;
    options.onExit?.(code);
  };

  const executorProcess = spawn('sh', ['-c', command], {
    env: { ...process.env, LOG_LEVEL: logLevel },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  options.onSpawn?.(executorProcess);

  executorProcess.stdout?.on('data', (data) => {
    console.log(`${logPrefix} ${data.toString().trim()}`);
  });

  executorProcess.stderr?.on('data', (data) => {
    console.error(`${logPrefix} ${data.toString().trim()}`);
  });

  executorProcess.on('error', (error) => {
    console.error(`${logPrefix} Spawn error:`, error.message);
    reportExit(127);
  });

  executorProcess.on('exit', (code) => {
    if (code === 0) {
      console.log(
        `${logPrefix} Executor completed successfully (task: ${templateVariables.task_id})`
      );
    } else {
      console.error(
        `${logPrefix} Executor exited with code ${code} (task: ${templateVariables.task_id})`
      );
    }
    reportExit(code);
  });

  executorProcess.stdin?.write(JSON.stringify(payload));
  executorProcess.stdin?.end();
}

const EXECUTOR_RESULT_PREFIX = 'AGOR_EXECUTOR_RESULT ';

function parseExecutorResultFromStdout(stdout: string): ExecutorCommandResult | null {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const resultJson = line.startsWith(EXECUTOR_RESULT_PREFIX)
      ? line.slice(EXECUTOR_RESULT_PREFIX.length)
      : line.startsWith('{') && line.endsWith('}')
        ? line
        : null;
    if (!resultJson) continue;
    try {
      const parsed = JSON.parse(resultJson) as unknown;
      if (parsed && typeof parsed === 'object' && 'success' in parsed) {
        return parsed as ExecutorCommandResult;
      }
    } catch {
      // Not the executor result line; keep scanning.
    }
  }

  return null;
}

function logChunkedOutput(prefix: string, stream: 'stdout' | 'stderr', chunk: Buffer): void {
  const text = chunk.toString();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (line.trim().startsWith(EXECUTOR_RESULT_PREFIX)) continue;
    if (stream === 'stdout') {
      if (process.env.AGOR_EXECUTOR_DEBUG_STDOUT === '1') {
        console.log(`${prefix} ${line}`);
      }
    } else {
      console.error(`${prefix} ${line}`);
    }
  }
}

/**
 * Run a short-lived executor command and wait for its JSON result.
 *
 * Use this for daemon call sites that need an immediate answer (for example
 * autocomplete and git-state probes). Long-running commands and lifecycle
 * tasks should keep using spawnExecutorFireAndForget().
 */
export async function runExecutorCommand(
  payload: Record<string, unknown>,
  options: RunExecutorCommandOptions = {}
): Promise<ExecutorCommandResult> {
  const { templateVariables, logPrefix = '[Executor]', timeoutMs = 60_000 } = options;

  const executorCommandTemplate =
    options.executorCommandTemplate !== undefined
      ? options.executorCommandTemplate || undefined
      : configuredExecutorDefaults.executorCommandTemplate;
  const asUser =
    options.asUser !== undefined ? options.asUser || undefined : configuredExecutorDefaults.asUser;

  const payloadWithConfig = withResolvedConfig(payload);

  if (executorCommandTemplate) {
    return runExecutorCommandWithTemplate(payloadWithConfig, {
      ...options,
      timeoutMs,
      asUser,
      executorCommandTemplate,
      templateVariables: {
        command: payloadWithConfig.command as string,
        task_id: generateTaskId(),
        unix_user: asUser,
        log_level: resolveExecutorLogLevel(options.env ?? (process.env as Record<string, string>)),
        ...templateVariables,
      },
      logPrefix,
    });
  }

  return runExecutorCommandLocal(payloadWithConfig, { ...options, timeoutMs, asUser, logPrefix });
}

function runExecutorCommandLocal(
  payload: Record<string, unknown>,
  options: RunExecutorCommandOptions
): Promise<ExecutorCommandResult> {
  const executorPath = findExecutorPath();
  const executorDir = path.dirname(path.dirname(executorPath));

  const {
    cwd = executorDir,
    env = process.env as Record<string, string>,
    logPrefix = '[Executor]',
    asUser: rawAsUser,
    preparedEnv,
    preparedEnvFilePath,
    timeoutMs = 60_000,
  } = options;
  const asUser = rawAsUser || undefined;

  if (cwd && !existsSync(cwd)) {
    return Promise.resolve({
      success: false,
      error: {
        code: 'EXECUTOR_CWD_MISSING',
        message: `Refusing to spawn: cwd does not exist on disk: ${cwd}`,
      },
    });
  }

  const daemonUrl = getDaemonUrl();
  const envWithDaemonUrl: Record<string, string> = preparedEnv
    ? withDaemonExecutorEnv(preparedEnv, daemonUrl)
    : asUser
      ? withDaemonExecutorEnv(
          Object.fromEntries(
            Object.entries({
              PATH: env.PATH || '/usr/local/bin:/usr/bin:/bin',
              NODE_ENV: env.NODE_ENV,
              LOG_LEVEL: env.LOG_LEVEL,
              ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
              ANTHROPIC_AUTH_TOKEN: env.ANTHROPIC_AUTH_TOKEN,
              ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL,
              CLAUDE_CODE_OAUTH_TOKEN: env.CLAUDE_CODE_OAUTH_TOKEN,
              OPENAI_API_KEY: env.OPENAI_API_KEY,
              OPENAI_BASE_URL: env.OPENAI_BASE_URL,
              GEMINI_API_KEY: env.GEMINI_API_KEY,
              GOOGLE_API_KEY: env.GOOGLE_API_KEY,
              GIT_CONFIG_PARAMETERS: env.GIT_CONFIG_PARAMETERS,
            }).filter(([_, v]) => v !== undefined)
          ),
          daemonUrl
        )
      : withDaemonExecutorEnv(env as Record<string, string>, daemonUrl);

  const prepared = asUser
    ? preparedEnvFilePath
      ? {
          inlineEnv: Object.fromEntries(
            Object.entries(envWithDaemonUrl).filter(([k]) => !isSecretEnvKey(k))
          ),
          envFilePath: preparedEnvFilePath,
        }
      : prepareImpersonationEnv({ asUser, env: envWithDaemonUrl })
    : { inlineEnv: undefined, envFilePath: undefined };

  const { cmd, args } = buildSpawnArgs('node', [executorPath, '--stdin'], {
    asUser,
    env: asUser ? prepared.inlineEnv : undefined,
    envFilePath: prepared.envFilePath,
  });

  console.log(`${logPrefix} Running executor command: ${payload.command ?? '?'}`);

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    const child = spawn(cmd, args, {
      cwd,
      env: asUser ? undefined : { ...envWithDaemonUrl },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false,
    });

    attachEnvFileCleanup(child, { envFilePath: prepared.envFilePath, asUser });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      resolve({
        success: false,
        error: {
          code: 'EXECUTOR_TIMEOUT',
          message: `Executor command timed out after ${timeoutMs}ms`,
          details: { command: payload.command },
        },
      });
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      logChunkedOutput(logPrefix, 'stdout', chunk);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      logChunkedOutput(logPrefix, 'stderr', chunk);
    });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        success: false,
        error: {
          code: 'EXECUTOR_SPAWN_ERROR',
          message: error.message,
          details: { command: payload.command },
        },
      });
    });

    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      const result = parseExecutorResultFromStdout(stdout);
      if (result) {
        resolve(result);
        return;
      }

      resolve({
        success: false,
        error: {
          code: 'EXECUTOR_RESULT_MISSING',
          message: `Executor exited with code ${code} but did not emit a JSON result`,
          details: {
            command: payload.command,
            exitCode: code,
            stderr: stderr ? '[redacted; enable executor debug logs]' : '',
          },
        },
      });
    });

    child.stdin?.write(JSON.stringify(payload));
    child.stdin?.end();
  });
}

function runExecutorCommandWithTemplate(
  payload: Record<string, unknown>,
  options: RunExecutorCommandOptions & {
    executorCommandTemplate: string;
    templateVariables: ExecutorTemplateVariables;
  }
): Promise<ExecutorCommandResult> {
  const {
    executorCommandTemplate,
    templateVariables,
    logPrefix = '[Executor]',
    timeoutMs = 60_000,
  } = options;
  const logLevel = templateVariables.log_level ?? getCurrentLogLevel();
  const command = substituteTemplateVariables(executorCommandTemplate, templateVariables);

  console.log(`${logPrefix} Running templated executor command: ${payload.command ?? '?'}`);

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    const child = spawn('sh', ['-c', command], {
      env: { ...process.env, LOG_LEVEL: logLevel },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      resolve({
        success: false,
        error: {
          code: 'EXECUTOR_TIMEOUT',
          message: `Executor command timed out after ${timeoutMs}ms`,
          details: { command: payload.command, taskId: templateVariables.task_id },
        },
      });
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      logChunkedOutput(logPrefix, 'stdout', chunk);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      logChunkedOutput(logPrefix, 'stderr', chunk);
    });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        success: false,
        error: {
          code: 'EXECUTOR_SPAWN_ERROR',
          message: error.message,
          details: { command: payload.command, taskId: templateVariables.task_id },
        },
      });
    });

    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      const result = parseExecutorResultFromStdout(stdout);
      if (result) {
        resolve(result);
        return;
      }

      resolve({
        success: false,
        error: {
          code: 'EXECUTOR_RESULT_MISSING',
          message: `Executor exited with code ${code} but did not emit a JSON result`,
          details: {
            command: payload.command,
            exitCode: code,
            stderr: stderr ? '[redacted; enable executor debug logs]' : '',
          },
        },
      });
    });

    child.stdin?.write(JSON.stringify(payload));
    child.stdin?.end();
  });
}

export function getDaemonUrl(): string {
  if (configuredDaemonUrl) return configuredDaemonUrl;
  return `http://localhost:${process.env.PORT || '3030'}`;
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
export function createServiceToken(
  jwtSecret: string,
  expiresIn?: SignOptions['expiresIn'],
  scope: Record<string, unknown> = {}
): string {
  return issueRuntimeToken(
    {
      sub: 'executor-service',
      type: 'service',
      purpose: 'executor-service',
      // Service tokens can perform privileged operations
      role: 'service',
      ...scope,
    },
    jwtSecret,
    expiresIn || '5m'
  );
}

/**
 * Build extra JWT claims for executor/service tokens from authenticated service
 * params. In Cloud required-from-auth mode, executor RPCs must carry the same
 * tenant claim as the request that spawned them; otherwise the daemon handles
 * them as the static/default tenant.
 */
export function serviceTokenScopeForParams(
  params?: Partial<AuthenticatedParams>
): Record<string, unknown> {
  const tenantId = params?.tenant?.tenant_id ?? params?.tenant_id ?? params?.user?.tenant_id;
  return tenantId ? { tenant_id: tenantId } : {};
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
export function generateSessionToken(
  app: {
    settings: { authentication?: { secret?: string } };
  },
  scope: Record<string, unknown> = {}
): string {
  const jwtSecret = app.settings.authentication?.secret;
  if (!jwtSecret) {
    throw new Error('JWT secret not configured in app settings');
  }
  return createServiceToken(jwtSecret, undefined, scope);
}

/**
 * Generate a tenant-scoped executor service token from Feathers params.
 *
 * Prefer this over manually composing `generateSessionToken(app,
 * serviceTokenScopeForParams(params))` so required-from-auth deployments do not
 * accidentally drop tenant context on new executor call paths.
 */
export function generateScopedServiceToken(
  app: {
    settings: { authentication?: { secret?: string } };
  },
  params?: Partial<AuthenticatedParams>
): string {
  return generateSessionToken(app, serviceTokenScopeForParams(params));
}

// ============================================================================
// Config-aware executor spawning
// ============================================================================

/**
 * Configuration for executor spawning.
 * Loaded from ~/.agor/config.yaml execution section.
 */
export type ExecutorConfig = Pick<
  AgorExecutionSettings,
  'executor_command_template' | 'executor_unix_user'
>;

interface ExecutorSpawnDefaults {
  /** Executor command template for containerized execution */
  executorCommandTemplate?: string;
  /** Unix user to run executors as */
  asUser?: string;
}

/** DI-based factory that bakes execution config into a spawner, independent of module-level defaults. */
export function createConfiguredSpawner(executionConfig?: ExecutorConfig) {
  return function configuredSpawnExecutor(
    payload: Record<string, unknown>,
    options: Omit<SpawnExecutorOptions, 'executorCommandTemplate'> = {}
  ): void {
    spawnExecutor(payload, {
      ...options,
      // `null` intentionally suppresses module-level defaults so this
      // factory remains an explicit dependency-injection variant rather than
      // accidentally inheriting whatever configureExecutor() last installed.
      executorCommandTemplate: executionConfig?.executor_command_template ?? null,
      asUser:
        options.asUser !== undefined
          ? options.asUser
          : (executionConfig?.executor_unix_user ?? null),
    });
  };
}

// `spawnExecutorFireAndForget` is the canonical name used by ~10 call sites
// across daemon/services and daemon/register-hooks. We keep it as the public
// name because that's what callers expect; `spawnExecutor` remains the
// underlying implementation.
export const spawnExecutorFireAndForget = spawnExecutor;
