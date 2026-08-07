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
import { getCurrentTenantId } from '@agor/core/db';
import {
  attachEnvFileCleanup,
  buildSpawnArgs,
  escapeShellArg,
  isSecretEnvKey,
  isValidUnixUsername,
  prepareImpersonationEnv,
} from '@agor/core/unix';
import { getCurrentLogLevel } from '@agor/core/utils/logger';
import type { SignOptions } from 'jsonwebtoken';
import { issueRuntimeToken } from '../auth/runtime-tokens.js';
import {
  containExecutorProcess,
  markExecutorProcessExited,
  retainExecutorContainmentFence,
  trackExecutorProcess,
  untrackExecutorProcess,
} from '../executor-tracking.js';
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
let requireExecutorTenantContext = false;

/** Set default executor template + impersonation user from config. Call once at daemon startup. */
export function configureExecutor(
  config?: ExecutorConfig | null,
  options: { requireTenantContext?: boolean } = {}
): void {
  configuredExecutorDefaults = {
    executorCommandTemplate: config?.executor_command_template || undefined,
    asUser: config?.executor_unix_user || undefined,
  };
  requireExecutorTenantContext = options.requireTenantContext === true;

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
  /**
   * Trusted runtime tenant identity. This is populated from the ambient tenant
   * context, shell-escaped during substitution, and is not caller-overridable
   * through `SpawnExecutorOptions.templateVariables`.
   */
  tenant_id?: string;
}

export type ExecutorSpawnMode = 'local' | 'templated';

export interface ExecutorSpawnContext {
  mode: ExecutorSpawnMode;
}

export interface SpawnExecutorOptions {
  cwd?: string;
  env?: Record<string, string>;
  logPrefix?: string;
  /** When set, spawns via `sudo -n -u $asUser`. Secrets go through a 0600 env-file. */
  asUser?: string | null;
  /** When set, uses template substitution instead of local subprocess. */
  executorCommandTemplate?: string | null;
  /**
   * Caller-provided domain/runtime overrides. Tenant identity is deliberately
   * excluded: it must come from the ambient tenant context.
   */
  templateVariables?: Omit<ExecutorTemplateVariables, 'tenant_id'>;
  onExit?: (code: number | null, context: ExecutorSpawnContext) => void;
  /** Fired after spawn, before stdin is written. Works for both local and templated paths. */
  onSpawn?: (child: ChildProcess, context: ExecutorSpawnContext) => void | Promise<void>;
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
  /** Suppress child stdout/stderr logging because the JSON result may contain credentials. */
  sensitiveOutput?: boolean;
}

export interface InteractiveExecutorHandle {
  result: Promise<ExecutorCommandResult>;
  cancel(): Promise<ExecutorCommandResult>;
  deliver(value: unknown, end?: boolean): Promise<boolean>;
  endInput(): boolean;
  verifyAbsence(): Promise<boolean>;
  retainContainmentFence(key: string): Promise<void>;
}

export interface ContainedExecutorCommandHandle {
  result: Promise<ExecutorCommandResult>;
  verifyAbsence(): Promise<boolean>;
  retainContainmentFence(key: string): Promise<void>;
}

export interface InteractiveExecutorFailures {
  localProcessRequired: ExecutorCommandResult;
  spawn: ExecutorCommandResult;
  stdin: ExecutorCommandResult;
  timeout: ExecutorCommandResult;
  cancelled: ExecutorCommandResult;
  cleanupUnverified: ExecutorCommandResult;
  missingResult(stderrSeen: boolean): ExecutorCommandResult;
}

export interface StartInteractiveExecutorOptions extends RunExecutorCommandOptions {
  failures: InteractiveExecutorFailures;
  /** Close stdin after the initial payload when no later control frame is expected. */
  closeInputAfterPayload?: boolean;
  onEvent?: (
    event: unknown,
    input: Pick<InteractiveExecutorHandle, 'deliver' | 'endInput'>
  ) => void;
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
  if (template.includes('{tenant_id}') && !variables.tenant_id) {
    throw new Error(
      'executor_command_template requires {tenant_id}, but no active tenant context is available'
    );
  }

  // `{unix_user}` is rendered into a `sh -c` command AND is typically used by
  // launchers as a path segment (per-user home mounts), so a malformed value
  // is both a shell-injection and a path-traversal vector. The Unix username
  // charset excludes shell metacharacters, `/` and `.`, so format validation
  // is the control here (stronger than escaping, which would not stop `../`).
  if (variables.unix_user !== undefined && !isValidUnixUsername(variables.unix_user)) {
    throw new Error(
      'executor_command_template {unix_user} value is not a valid Unix username; refusing to execute'
    );
  }

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
    tenant_id: variables.tenant_id,
  };

  for (const [key, value] of Object.entries(substitutions)) {
    if (value !== undefined) {
      const placeholder = new RegExp(`\\{${key}\\}`, 'g');
      // executor_command_template is executed via `sh -c`. Tenant IDs may
      // originate in external auth claims, so render this security-sensitive
      // value as one opaque shell argument. Templates should use
      // `{tenant_id}` unquoted, e.g. `launcher --tenant-id {tenant_id}`.
      const renderedValue = key === 'tenant_id' ? escapeShellArg(String(value)) : String(value);
      result = result.replace(placeholder, renderedValue);
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

/**
 * Resolve executor tenant identity from the operation-wide AsyncLocalStorage
 * context established by Feathers/MCP orchestration boundaries.
 *
 * Hosted required-from-auth mode refuses every unscoped executor launch, not
 * only templates that happen to reference `{tenant_id}`. An unscoped local
 * executor would also receive an unusable tenant-less runtime credential.
 */
function resolveExecutorTenantId(): string | undefined {
  const tenantId = getCurrentTenantId();
  if (!tenantId && requireExecutorTenantContext) {
    throw new Error('Missing active tenant context for executor launch');
  }
  return tenantId ? String(tenantId) : undefined;
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
  const tenantId = resolveExecutorTenantId();

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
        tenant_id: tenantId,
      },
      logPrefix,
    });
  } else {
    spawnExecutorLocal(payloadWithConfig, { ...options, asUser });
  }
}

function sendExecutorPayload(
  executorProcess: ChildProcess,
  payload: Record<string, unknown>,
  spawnReady: void | Promise<void>,
  logPrefix: string,
  reportExit: (code: number | null) => void
): void {
  const writePayload = () => {
    executorProcess.stdin?.write(JSON.stringify(payload));
    executorProcess.stdin?.end();
  };
  if (!spawnReady) {
    writePayload();
    return;
  }
  void spawnReady.then(writePayload).catch((error) => {
    console.error(`${logPrefix} Spawn readiness failed:`, error);
    try {
      executorProcess.kill();
    } finally {
      reportExit(127);
    }
  });
}

/**
 * Spawn executor as a local subprocess.
 * stdout/stderr are inherited so logs appear in daemon output.
 */
function spawnExecutorLocal(payload: Record<string, unknown>, options: SpawnExecutorOptions): void {
  const location = resolveLocalExecutorLocation(options);
  const cwdFailure = resolveLocalExecutorCwdFailure(location);
  const logPrefix = options.logPrefix ?? '[Executor]';
  if (cwdFailure) {
    console.error(
      `${logPrefix} ${cwdFailure.error?.message}. ` +
        `This usually means the branch or repo directory was deleted out-of-band. ` +
        `Verify that the volume backing the working directory persists across restarts.`
    );
    options.onExit?.(127, { mode: 'local' });
    return;
  }

  const { executorPath, cwd, asUser, envWithDaemonUrl, envFilePath, inlineEnv, cmd, args } =
    prepareLocalExecutorSpawn(options, '--stdin', location);

  if (asUser) {
    // Safe summary only — never log secret values or their key names.
    const safeEnvKeys = Object.keys(inlineEnv ?? {}).filter((key) => !isSecretEnvKey(key));
    console.log(
      `${logPrefix} Spawning executor as user=${asUser} tool=${payload.command ?? '?'} envKeys=[${safeEnvKeys.join(',')}]${envFilePath ? ' (secrets in env-file)' : ''}`
    );
  }
  console.log(`${logPrefix} Spawning executor at: ${executorPath}`);
  console.log(`${logPrefix} Command: ${payload.command}`);

  let reportedExit = false;
  const reportExit = (code: number | null): void => {
    if (reportedExit) return;
    reportedExit = true;
    options.onExit?.(code, { mode: 'local' });
  };

  const executorProcess = spawn(cmd, args, {
    cwd,
    env: asUser ? undefined : { ...envWithDaemonUrl }, // When impersonating, env is in the command; otherwise pass to spawn
    stdio: ['pipe', 'inherit', 'inherit'], // stdin: pipe, stdout/stderr: inherit (show in daemon logs)
    detached: process.platform !== 'win32',
  });

  // Best-effort safety-net cleanup: the inner bash script `rm -f`s the env
  // file before exec, but if sudo/bash failed to launch — or `set -eu`
  // aborted the source step — the file may remain. attachEnvFileCleanup
  // uses `sudo -u <asUser> rm -f` so it works under sticky /tmp.
  attachEnvFileCleanup(executorProcess, { envFilePath, asUser });

  const spawnReady = options.onSpawn?.(executorProcess, { mode: 'local' });

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

  sendExecutorPayload(executorProcess, payload, spawnReady, logPrefix, reportExit);
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
    options.onExit?.(code, { mode: 'templated' });
  };

  const executorProcess = spawn('sh', ['-c', command], {
    env: { ...process.env, LOG_LEVEL: logLevel },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const spawnReady = options.onSpawn?.(executorProcess, { mode: 'templated' });

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

  sendExecutorPayload(executorProcess, payload, spawnReady, logPrefix, reportExit);
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

const INTERACTIVE_EXECUTOR_EVENT_PREFIX = 'AGOR_EXECUTOR_INTERACTIVE_EVENT ';

function resolveLocalExecutorLocation(options: Pick<SpawnExecutorOptions, 'cwd'> = {}) {
  const executorPath = findExecutorPath();
  return {
    executorPath,
    // Default to the executor package directory for proper module resolution.
    // ESM imports resolve relative to the file location, and pnpm's node_modules
    // structure requires running from the package directory.
    cwd: options.cwd ?? path.dirname(path.dirname(executorPath)),
  };
}

function resolveLocalExecutorCwdFailure(
  location: ReturnType<typeof resolveLocalExecutorLocation>
): ExecutorCommandResult | undefined {
  if (!location.cwd || existsSync(location.cwd)) return undefined;
  return {
    success: false,
    error: {
      code: 'EXECUTOR_CWD_MISSING',
      message: `Refusing to spawn: cwd does not exist on disk: ${location.cwd}`,
    },
  };
}

function definedEnvironment(values: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
}

function executorEnvironmentForImpersonation(env: Record<string, string>): Record<string, string> {
  return definedEnvironment({
    PATH: env.PATH || '/usr/local/bin:/usr/bin:/bin',
    NODE_ENV: env.NODE_ENV,
    LOG_LEVEL: env.LOG_LEVEL,
    // Version-aligned agentic tool packages are system runtime metadata, not
    // tenant credentials. Preserve their absolute read-only location when an
    // executor crosses a Unix identity boundary.
    AGOR_VERSION: env.AGOR_VERSION,
    AGOR_AGENTIC_TOOLS_DIR: env.AGOR_AGENTIC_TOOLS_DIR,
    AGOR_MANAGED_AGENTIC_TOOLS: env.AGOR_MANAGED_AGENTIC_TOOLS,
    ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
    ANTHROPIC_AUTH_TOKEN: env.ANTHROPIC_AUTH_TOKEN,
    ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL,
    CLAUDE_CODE_OAUTH_TOKEN: env.CLAUDE_CODE_OAUTH_TOKEN,
    OPENAI_API_KEY: env.OPENAI_API_KEY,
    OPENAI_BASE_URL: env.OPENAI_BASE_URL,
    GEMINI_API_KEY: env.GEMINI_API_KEY,
    GOOGLE_API_KEY: env.GOOGLE_API_KEY,
    GIT_CONFIG_PARAMETERS: env.GIT_CONFIG_PARAMETERS,
  });
}

function resolveLocalExecutorEnvironment(
  options: Pick<SpawnExecutorOptions, 'env' | 'preparedEnv'>,
  asUser: string | undefined
): Record<string, string> {
  const env = options.env ?? (process.env as Record<string, string>);
  const source = options.preparedEnv ?? (asUser ? executorEnvironmentForImpersonation(env) : env);
  return withDaemonExecutorEnv(source, getDaemonUrl());
}

function prepareLocalExecutorImpersonation(
  asUser: string | undefined,
  env: Record<string, string>,
  preparedEnvFilePath: string | undefined
): { inlineEnv?: Record<string, string>; envFilePath?: string } {
  if (!asUser) return {};
  if (!preparedEnvFilePath) return prepareImpersonationEnv({ asUser, env });
  return {
    inlineEnv: Object.fromEntries(Object.entries(env).filter(([key]) => !isSecretEnvKey(key))),
    envFilePath: preparedEnvFilePath,
  };
}

function prepareLocalExecutorSpawn(
  options: SpawnExecutorOptions,
  mode: '--stdin' | '--interactive-command',
  location = resolveLocalExecutorLocation(options)
) {
  const { executorPath, cwd } = location;
  const asUser = options.asUser || undefined;
  const envWithDaemonUrl = resolveLocalExecutorEnvironment(options, asUser);
  const prepared = prepareLocalExecutorImpersonation(
    asUser,
    envWithDaemonUrl,
    options.preparedEnvFilePath
  );
  const command = buildSpawnArgs('node', [executorPath, mode], {
    asUser,
    env: asUser ? prepared.inlineEnv : undefined,
    envFilePath: prepared.envFilePath,
  });
  return {
    ...command,
    executorPath,
    cwd,
    asUser,
    envWithDaemonUrl,
    inlineEnv: prepared.inlineEnv,
    envFilePath: prepared.envFilePath,
  };
}

function parseInteractiveExecutorEvent(line: string): unknown | undefined {
  if (!line.startsWith(INTERACTIVE_EXECUTOR_EVENT_PREFIX)) return undefined;
  try {
    return JSON.parse(line.slice(INTERACTIVE_EXECUTOR_EVENT_PREFIX.length)) as unknown;
  } catch {
    // Invalid protocol output is ignored and becomes a missing-result failure.
  }
  return undefined;
}

function failedInteractiveExecutorHandle(
  failure: ExecutorCommandResult
): InteractiveExecutorHandle {
  return {
    result: Promise.resolve(failure),
    cancel: async () => failure,
    deliver: async () => false,
    endInput: () => false,
    verifyAbsence: async () => true,
    retainContainmentFence: async () => {
      throw new Error('Cannot retain a containment fence for an executor that did not start');
    },
  };
}

interface JsonLineInput {
  deliver(value: unknown, end?: boolean): Promise<boolean>;
  end(): boolean;
  failPending(transportFailure: boolean): void;
}

function createJsonLineInput(
  child: ChildProcess,
  isFinalized: () => boolean,
  onTransportFailure: () => void
): JsonLineInput {
  let pendingFailure: ((transportFailure: boolean) => void) | undefined;

  const failPending = (transportFailure: boolean) => {
    pendingFailure?.(transportFailure);
  };
  const end = (): boolean => {
    const stream = child.stdin;
    if (!stream || stream.destroyed) {
      onTransportFailure();
      return false;
    }
    if (stream.writableEnded || stream.writableFinished) return true;
    try {
      stream.end();
      return true;
    } catch {
      failPending(true);
      onTransportFailure();
      return false;
    }
  };
  const deliver = (value: unknown, shouldEnd = false): Promise<boolean> => {
    const stream = child.stdin;
    if (
      !stream?.writable ||
      stream.destroyed ||
      stream.writableEnded ||
      stream.writableFinished ||
      isFinalized()
    ) {
      onTransportFailure();
      return Promise.resolve(false);
    }

    return new Promise<boolean>((resolve) => {
      let settled = false;
      const succeed = () => {
        if (settled) return;
        settled = true;
        if (pendingFailure === fail) pendingFailure = undefined;
        resolve(true);
      };
      const fail = (transportFailure: boolean) => {
        if (settled) return;
        settled = true;
        if (pendingFailure === fail) pendingFailure = undefined;
        if (transportFailure) onTransportFailure();
        resolve(false);
      };
      pendingFailure = fail;

      try {
        stream.write(`${JSON.stringify(value)}\n`, (error?: Error | null) => {
          if (error) return fail(true);
          if (settled) return;
          if (!shouldEnd) return succeed();
          try {
            stream.end((endError?: Error | null) => {
              if (endError) return fail(true);
              succeed();
            });
          } catch {
            fail(true);
          }
        });
      } catch {
        fail(true);
      }
    });
  };

  return { deliver, end, failPending };
}

/**
 * Starts one bounded local executor using JSON-lines input and event framing.
 *
 * This host transport owns process spawning, containment, and framing only.
 * Callers own command-specific payloads, event interpretation, and failures.
 */
export function startInteractiveExecutor(
  payload: Record<string, unknown>,
  options: StartInteractiveExecutorOptions
): InteractiveExecutorHandle {
  const { failures, onEvent } = options;
  const executorCommandTemplate =
    options.executorCommandTemplate !== undefined
      ? options.executorCommandTemplate || undefined
      : configuredExecutorDefaults.executorCommandTemplate;
  if (executorCommandTemplate) {
    return failedInteractiveExecutorHandle(failures.localProcessRequired);
  }

  const { timeoutMs = 10 * 60_000 } = options;
  const rawAsUser = options.asUser;
  const asUser =
    rawAsUser !== undefined
      ? rawAsUser || undefined
      : configuredExecutorDefaults.asUser || undefined;
  const attemptId = crypto.randomUUID();
  const taskId = generateTaskId();
  const location = resolveLocalExecutorLocation(options);
  const cwdFailure = resolveLocalExecutorCwdFailure(location);
  if (cwdFailure) return failedInteractiveExecutorHandle(cwdFailure);
  const prepared = prepareLocalExecutorSpawn(
    { ...options, asUser },
    '--interactive-command',
    location
  );
  const { cmd, args, cwd, envWithDaemonUrl, envFilePath } = prepared;
  const child = spawn(cmd, args, {
    cwd,
    env: asUser ? undefined : { ...envWithDaemonUrl },
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  });
  attachEnvFileCleanup(child, { envFilePath, asUser });

  let resolveResult!: (result: ExecutorCommandResult) => void;
  const result = new Promise<ExecutorCommandResult>((resolve) => {
    resolveResult = resolve;
  });
  let stdout = '';
  let lineBuffer = '';
  let stderrSeen = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let finalization: Promise<ExecutorCommandResult> | undefined;
  let resolveClose!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClose = resolve;
  });
  let input!: JsonLineInput;

  const finalize = (
    fallback?: ExecutorCommandResult,
    leaderExited = false
  ): Promise<ExecutorCommandResult> => {
    finalization ??= (async () => {
      input.failPending(false);
      if (timer) clearTimeout(timer);
      if (leaderExited) markExecutorProcessExited(attemptId, child.pid);
      const containment = await containExecutorProcess(attemptId, taskId);
      if (containment.status !== 'verified_absent') {
        return failures.cleanupUnverified;
      }
      await closed;
      untrackExecutorProcess(attemptId, taskId);
      return (
        fallback ?? parseExecutorResultFromStdout(stdout) ?? failures.missingResult(stderrSeen)
      );
    })();
    void finalization.then(resolveResult);
    return finalization;
  };

  const stdinFailure = failures.stdin;
  input = createJsonLineInput(
    child,
    () => Boolean(finalization),
    () => void finalize(stdinFailure)
  );

  if (!child.pid) {
    const spawnFailure = failures.spawn;
    resolveResult(spawnFailure);
    return failedInteractiveExecutorHandle(spawnFailure);
  }
  trackExecutorProcess({ sessionId: attemptId, taskId, pid: child.pid, asUser });

  const controls = {
    deliver: input.deliver,
    endInput: input.end,
  };

  child.stdout?.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    stdout += text;
    lineBuffer += text;
    const lines = lineBuffer.split(/\r?\n/);
    lineBuffer = lines.pop() ?? '';
    for (const rawLine of lines) {
      const event = parseInteractiveExecutorEvent(rawLine.trim());
      if (event !== undefined) onEvent?.(event, controls);
    }
  });
  child.stderr?.on('data', () => {
    stderrSeen = true;
  });
  child.stdin?.on('error', () => {
    input.failPending(true);
    void finalize(stdinFailure);
  });
  child.on('error', () => {
    void finalize(failures.spawn);
  });
  child.on('exit', () => {
    input.failPending(false);
    void finalize(undefined, true);
  });
  child.on('close', () => {
    input.failPending(false);
    markExecutorProcessExited(attemptId, child.pid);
    resolveClose();
    void finalize(undefined, true);
  });

  timer = setTimeout(() => {
    void finalize(failures.timeout);
  }, timeoutMs);
  void input.deliver(withResolvedConfig(payload), options.closeInputAfterPayload);

  return {
    result,
    cancel: () => finalize(failures.cancelled),
    deliver: input.deliver,
    endInput: input.end,
    verifyAbsence: async () => {
      const containment = await containExecutorProcess(attemptId, taskId);
      if (containment.status !== 'verified_absent') return false;
      untrackExecutorProcess(attemptId, taskId);
      return true;
    },
    retainContainmentFence: (key) => retainExecutorContainmentFence(key, attemptId, taskId),
  };
}

/**
 * Starts a short local executor command and releases its result only after the
 * tracked process group is absent. Native-state operations deliberately reject
 * templated launchers until remote execution has an equivalent cleanup proof.
 */
export function startContainedExecutorCommand(
  payload: Record<string, unknown>,
  options: RunExecutorCommandOptions = {}
): ContainedExecutorCommandHandle {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const command = String(payload.command ?? '?');
  const transport = startInteractiveExecutor(payload, {
    ...options,
    timeoutMs,
    closeInputAfterPayload: true,
    failures: {
      localProcessRequired: {
        success: false,
        error: {
          code: 'EXECUTOR_LOCAL_PROCESS_REQUIRED',
          message: 'This executor command requires verifiable local process containment',
        },
      },
      spawn: {
        success: false,
        error: { code: 'EXECUTOR_SPAWN_ERROR', message: 'Executor process did not start' },
      },
      stdin: {
        success: false,
        error: { code: 'EXECUTOR_STDIN_ERROR', message: 'Executor command input failed' },
      },
      timeout: {
        success: false,
        error: {
          code: 'EXECUTOR_TIMEOUT',
          message: `Executor command timed out after ${timeoutMs}ms`,
          details: { command },
        },
      },
      cancelled: {
        success: false,
        error: { code: 'EXECUTOR_CANCELLED', message: 'Executor command was cancelled' },
      },
      cleanupUnverified: {
        success: false,
        error: {
          code: 'EXECUTOR_CLEANUP_UNVERIFIED',
          message: 'Executor command cleanup could not be verified',
        },
      },
      missingResult: (stderrSeen) => ({
        success: false,
        error: {
          code: 'EXECUTOR_RESULT_MISSING',
          message: 'Executor exited without a JSON result',
          details: {
            command,
            stderr: stderrSeen ? '[redacted; enable executor debug logs]' : '',
          },
        },
      }),
    },
  });
  return {
    result: transport.result,
    verifyAbsence: transport.verifyAbsence,
    retainContainmentFence: transport.retainContainmentFence,
  };
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
  const tenantId = resolveExecutorTenantId();

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
        tenant_id: tenantId,
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
  const { logPrefix = '[Executor]', timeoutMs = 60_000 } = options;
  const rawAsUser = options.asUser;
  const asUser = rawAsUser || undefined;
  const location = resolveLocalExecutorLocation(options);
  const cwdFailure = resolveLocalExecutorCwdFailure(location);
  if (cwdFailure) return Promise.resolve(cwdFailure);
  const prepared = prepareLocalExecutorSpawn({ ...options, asUser }, '--stdin', location);
  const { cmd, args, cwd, envWithDaemonUrl, envFilePath } = prepared;

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

    attachEnvFileCleanup(child, { envFilePath, asUser });

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
      if (!options.sensitiveOutput) logChunkedOutput(logPrefix, 'stdout', chunk);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      if (!options.sensitiveOutput) logChunkedOutput(logPrefix, 'stderr', chunk);
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
      if (!options.sensitiveOutput) logChunkedOutput(logPrefix, 'stdout', chunk);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      if (!options.sensitiveOutput) logChunkedOutput(logPrefix, 'stderr', chunk);
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
  // A terminal-scoped token (carries `terminal_user_id`) is a restricted
  // identity, not a full service account. Stamp its role accordingly at MINT
  // time too — both resolvers already override `role` before use, but this
  // closes the trap where future code reads `payload.role` directly and would
  // otherwise see a full 'service' role on a terminal token.
  const isTerminalScoped =
    typeof (scope as { terminal_user_id?: unknown }).terminal_user_id === 'string';
  return issueRuntimeToken(
    {
      sub: 'executor-service',
      type: 'service',
      purpose: 'executor-service',
      ...scope,
      // Placed AFTER ...scope so it wins; service tokens can perform privileged
      // operations, terminal-scoped tokens deliberately cannot.
      role: isTerminalScoped ? 'terminal-executor' : 'service',
    },
    jwtSecret,
    expiresIn || '5m'
  );
}

/**
 * Build executor/service-token tenant claims from the same ambient identity
 * used by command-template substitution.
 */
export function serviceTokenScopeForCurrentTenant(): Record<string, unknown> {
  const tenantId = resolveExecutorTenantId();
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
  scope: Record<string, unknown> = {},
  expiresIn?: SignOptions['expiresIn']
): string {
  const jwtSecret = app.settings.authentication?.secret;
  if (!jwtSecret) {
    throw new Error('JWT secret not configured in app settings');
  }
  return createServiceToken(jwtSecret, expiresIn, scope);
}

/**
 * Generate an executor service token from the same ambient tenant context used
 * to render the command template.
 *
 * Tenant claims are applied after extra claims so callers cannot spoof or
 * override the trusted runtime tenant.
 */
export function generateScopedServiceToken(
  app: {
    settings: { authentication?: { secret?: string } };
  },
  extraScope: Record<string, unknown> = {},
  expiresIn?: SignOptions['expiresIn']
): string {
  return generateSessionToken(
    app,
    { ...extraScope, ...serviceTokenScopeForCurrentTenant() },
    expiresIn
  );
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
