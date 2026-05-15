/**
 * Executor Spawning Utility
 *
 * Provides a single function to spawn the executor process for all commands.
 * Used by daemon services (repos, worktrees, terminals, tasks) to delegate
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

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  attachEnvFileCleanup,
  buildSpawnArgs,
  isSecretEnvKey,
  prepareImpersonationEnv,
} from '@agor/core/unix';
import jwt from 'jsonwebtoken';

/**
 * Module-level daemon URL configuration.
 * Set once at daemon startup via configureDaemonUrl().
 * Used by getDaemonUrl() for all executor payloads.
 */
let configuredDaemonUrl: string | null = null;

/**
 * Configure the daemon URL for executor payloads.
 * Call this once at daemon startup.
 *
 * @param url - The URL executors should use to reach the daemon
 *              (e.g., "http://agor-daemon.agor.svc.cluster.local:3030" for k8s)
 */
export function configureDaemonUrl(url: string): void {
  configuredDaemonUrl = url;
  console.log(`[Executor] Daemon URL configured: ${url}`);
}

/**
 * Template variables for executor command template substitution.
 * These are substituted into the executor_command_template at spawn time.
 */
export interface ExecutorTemplateVariables {
  /** Unique task identifier (for pod/container naming) */
  task_id?: string;

  /** Executor command (prompt, git.clone, etc.) */
  command?: string;

  /** Target Unix username */
  unix_user?: string;

  /** Target Unix UID (for runAsUser in k8s) */
  unix_user_uid?: number;

  /** Target Unix GID (for fsGroup in k8s) */
  unix_user_gid?: number;

  /** Session ID (if available) */
  session_id?: string;

  /** Worktree ID (if available) */
  worktree_id?: string;
}

/**
 * Options for spawning executor
 */
export interface SpawnExecutorOptions {
  /** Working directory for executor process */
  cwd?: string;

  /** Environment variables for executor process */
  env?: Record<string, string>;

  /** Log prefix for console output */
  logPrefix?: string;

  /**
   * Unix user to run executor as (impersonation)
   * When set, spawns via `sudo -n -u $asUser bash -c '...'` so the executor
   * gets fresh group memberships for the target user. Secret env vars are
   * routed through a 0600 env-file owned by `asUser` so their values stay
   * out of argv / /proc/<pid>/cmdline.
   */
  asUser?: string;

  /**
   * Executor command template for remote/containerized execution.
   * When provided, uses template substitution instead of local subprocess.
   * Takes precedence over local spawning.
   */
  executorCommandTemplate?: string;

  /**
   * Template variables for substitution in executor_command_template.
   * Used when executorCommandTemplate is provided.
   */
  templateVariables?: ExecutorTemplateVariables;

  /**
   * Callback when executor process exits.
   * Used to clean up resources when executor terminates.
   */
  onExit?: (code: number | null) => void;
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

  // Substitute each known variable
  const substitutions: Record<string, string | number | undefined> = {
    task_id: variables.task_id,
    command: variables.command,
    unix_user: variables.unix_user,
    unix_user_uid: variables.unix_user_uid,
    unix_user_gid: variables.unix_user_gid,
    session_id: variables.session_id,
    worktree_id: variables.worktree_id,
  };

  for (const [key, value] of Object.entries(substitutions)) {
    if (value !== undefined) {
      // Replace all occurrences of {key} with the value
      const placeholder = new RegExp(`\\{${key}\\}`, 'g');
      result = result.replace(placeholder, String(value));
    }
  }

  return result;
}

/**
 * Generate a unique task ID for executor pod/container naming.
 * Uses a short random string that's safe for k8s resource names.
 */
export function generateTaskId(): string {
  // Generate 8 character hex string (32 bits of entropy)
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
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
  const { executorCommandTemplate, templateVariables, logPrefix = '[Executor]' } = options;

  // Decide execution mode: templated or local
  if (executorCommandTemplate) {
    spawnExecutorWithTemplate(payload, {
      ...options,
      executorCommandTemplate,
      templateVariables: {
        command: payload.command as string,
        task_id: generateTaskId(),
        ...templateVariables,
      },
      logPrefix,
    });
  } else {
    spawnExecutorLocal(payload, options);
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
    asUser,
  } = options;

  // Add DAEMON_URL to env so executor doesn't try to read config.yaml
  // When impersonated, executor can't access /home/agorpg/.agor/config.yaml
  const daemonUrl = getDaemonUrl();

  // When impersonating, pass minimal env vars and let sudo set HOME correctly
  const essentialEnv: Record<string, string> = asUser
    ? Object.fromEntries(
        Object.entries({
          DAEMON_URL: daemonUrl,
          PATH: env.PATH || '/usr/local/bin:/usr/bin:/bin',
          NODE_ENV: env.NODE_ENV,
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
      )
    : { ...env, DAEMON_URL: daemonUrl };

  const envWithDaemonUrl = essentialEnv;

  // Route secret-looking env vars through an on-disk env file owned by the
  // target user (mode 0600). This keeps API keys/tokens out of argv and out
  // of /proc/<pid>/cmdline. Non-secret vars (PATH, DAEMON_URL, NODE_ENV)
  // are still inlined for simplicity.
  const prepared = asUser
    ? prepareImpersonationEnv({ asUser, env: envWithDaemonUrl })
    : { inlineEnv: undefined, envFilePath: undefined };

  // Build spawn command - handles impersonation via sudo -u when asUser is set
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
  // references worktree/repo paths that no longer exist on disk. We
  // surface that clearly here; recovery is left to the operator
  // (restore the volume, or use the worktree/repo lifecycle commands to
  // remove the orphan rows).
  if (cwd && !existsSync(cwd)) {
    console.error(
      `${logPrefix} Refusing to spawn: cwd does not exist on disk: ${cwd}. ` +
        `This usually means the worktree or repo directory was deleted ` +
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

  // Log if process fails to spawn
  executorProcess.on('error', (error) => {
    console.error(`${logPrefix} Spawn error:`, error.message);
  });

  // Log when process exits (for debugging) and call onExit callback
  executorProcess.on('exit', (code) => {
    if (code === 0) {
      console.log(`${logPrefix} Executor completed successfully`);
    } else {
      console.error(`${logPrefix} Executor exited with code ${code}`);
    }
    // Call onExit callback if provided (for cleanup)
    options.onExit?.(code);
  });

  // Write JSON payload to stdin and close it
  executorProcess.stdin?.write(JSON.stringify(payload));
  executorProcess.stdin?.end();
}

/**
 * Spawn executor using a command template (for k8s, docker, etc.).
 *
 * The template is executed via `sh -c` with the JSON payload piped to stdin.
 * stdout/stderr are captured and logged (since kubectl needs to pipe them back).
 *
 * @example kubectl template
 * ```
 * kubectl run executor-{task_id} \
 *   --image=ghcr.io/preset-io/agor-executor:latest \
 *   --rm -i --restart=Never \
 *   -- agor-executor --stdin
 * ```
 */
function spawnExecutorWithTemplate(
  payload: Record<string, unknown>,
  options: SpawnExecutorOptions & {
    executorCommandTemplate: string;
    templateVariables: ExecutorTemplateVariables;
  }
): void {
  const { executorCommandTemplate, templateVariables, logPrefix = '[Executor]' } = options;

  // Substitute template variables
  const command = substituteTemplateVariables(executorCommandTemplate, templateVariables);

  console.log(`${logPrefix} Templated execution mode`);
  console.log(`${logPrefix} Task ID: ${templateVariables.task_id}`);
  console.log(`${logPrefix} Command: ${payload.command}`);
  console.log(`${logPrefix} Template command (first 200 chars): ${command.slice(0, 200)}...`);

  // Execute the template command via sh -c
  // Use pipe for stdout/stderr so we can capture kubectl output and log it
  const executorProcess = spawn('sh', ['-c', command], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Log stdout in real-time
  executorProcess.stdout?.on('data', (data) => {
    console.log(`${logPrefix} ${data.toString().trim()}`);
  });

  // Log stderr in real-time
  executorProcess.stderr?.on('data', (data) => {
    console.error(`${logPrefix} ${data.toString().trim()}`);
  });

  // Log if process fails to spawn
  executorProcess.on('error', (error) => {
    console.error(`${logPrefix} Spawn error:`, error.message);
  });

  // Log when process exits
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
  });

  // Write JSON payload to stdin and close it
  executorProcess.stdin?.write(JSON.stringify(payload));
  executorProcess.stdin?.end();
}

/**
 * Get daemon URL for executor communication.
 *
 * Priority:
 * 1. Module-level configured URL (set via configureDaemonUrl at startup)
 * 2. Environment variable PORT with localhost
 * 3. Default localhost:3030
 *
 * In containerized (k8s) mode, configureDaemonUrl() should be called at startup
 * with the internal service URL (e.g., http://agor-daemon.agor.svc.cluster.local:3030)
 */
export function getDaemonUrl(): string {
  // Use configured URL if set (for k8s/containerized mode)
  if (configuredDaemonUrl) {
    return configuredDaemonUrl;
  }

  // Otherwise, use localhost with port from env or default
  const effectivePort = process.env.PORT || '3030';
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

// ============================================================================
// Config-aware executor spawning
// ============================================================================

/**
 * Configuration for executor spawning.
 * Loaded from ~/.agor/config.yaml execution section.
 */
export interface ExecutorConfig {
  /** Executor command template for containerized execution */
  executor_command_template?: string;
  /** Unix user to run executors as */
  executor_unix_user?: string;
}

/**
 * Create a configured spawn function with execution settings baked in.
 *
 * This factory creates a spawn function that automatically includes
 * the executor_command_template from config. Use this when you have
 * access to config at initialization time.
 *
 * @example
 * ```typescript
 * const config = await loadConfig();
 * const spawn = createConfiguredSpawner(config.execution);
 *
 * // Now spawn automatically uses template if configured
 * spawn({ command: 'prompt', ... }, { logPrefix: '[Task]' });
 * ```
 */
export function createConfiguredSpawner(executionConfig?: ExecutorConfig) {
  return function configuredSpawnExecutor(
    payload: Record<string, unknown>,
    options: Omit<SpawnExecutorOptions, 'executorCommandTemplate'> = {}
  ): void {
    spawnExecutor(payload, {
      ...options,
      executorCommandTemplate: executionConfig?.executor_command_template,
      asUser: options.asUser ?? executionConfig?.executor_unix_user,
    });
  };
}

// `spawnExecutorFireAndForget` is the canonical name used by ~10 call sites
// across daemon/services and daemon/register-hooks. We keep it as the public
// name because that's what callers expect; `spawnExecutor` remains the
// underlying implementation.
export const spawnExecutorFireAndForget = spawnExecutor;
