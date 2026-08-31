/**
 * Executor Spawning Utility
 *
 * Provides a single function to spawn the executor process for all commands.
 * Used by daemon services (repos, branches, terminals, tasks) to delegate
 * operations to the executor for proper Unix isolation.
 *
 * DESIGN PHILOSOPHY:
 * - Lifecycle work remains fire-and-forget and reports through the Agor client.
 * - Short request-mode commands return one bounded result through the
 *   authenticated executor response channel; stdout/stderr are logs only.
 * - Executor process isolation and delegated launch behavior remain shared.
 *
 * EXECUTION MODES:
 * 1. Local subprocess (default): Spawns executor as a child process
 * 2. Templated/remote: Uses executor_command_template for k8s/docker/remote execution
 *
 * Local executors always run as the daemon user. External launchers receive
 * trusted tenant/user identity through template variables and enforce their
 * own execution boundary.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureCredentialAuthorityLayoutSync } from '@agor/core/codex/credential-file';
import {
  type AgorExecutionSettings,
  buildAllowlistedEnv,
  type ResolvedExecutorResponseConfig,
  resolveExecutorResponseConfig,
  resolveExecutorResponseTimeoutMs,
} from '@agor/core/config';
import { getCurrentTenantId } from '@agor/core/db';
import {
  EXECUTOR_RESPONSE_PROTOCOL,
  type ExecutorCommandResult,
} from '@agor/core/executor-protocol';
import { isValidExecutionHomeKey } from '@agor/core/unix';
import { getCurrentLogLevel } from '@agor/core/utils/logger';
import type { SignOptions } from 'jsonwebtoken';
import { issueRuntimeToken } from '../auth/runtime-tokens.js';
import {
  configureExecutorResponseChannel,
  ExecutorResponseAdmissionError,
  type ExecutorResponseReservation,
  reserveExecutorResponse,
} from '../executor-response-channel.js';
import {
  containExecutorProcess,
  markExecutorProcessExited,
  retainExecutorContainmentFence,
  trackExecutorProcess,
  untrackExecutorProcess,
} from '../executor-tracking.js';
import { withResolvedConfig } from './build-resolved-config-slice.js';
import { buildSandboxWrap, type SandboxRuntimePaths } from './sandbox-wrap.js';
import { buildTrustedLauncherEnvironment } from './trusted-launcher-environment.js';

let configuredDaemonUrl: string | null = null;

function escapeShellArg(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

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

/**
 * Environment for the local launcher process in templated/delegated mode.
 *
 * The executor's authenticated payload is sent over stdin; the intermediate
 * `sh -c <launcher>` must not inherit the daemon's database URL, JWT/master
 * secrets, provider credentials, or other ambient deployment configuration.
 * The one exception is the launcher's own `AGOR_CLOUD_*` runtime-service
 * credentials (https://github.com/preset-io/agor-cloud/issues/198);
 * daemon-internal secrets stay withheld.
 */
function resolveTemplateLauncherEnvironment(logLevel: string): Record<string, string> {
  return buildTrustedLauncherEnvironment(logLevel);
}

/** Set the daemon URL for executor payloads. Call once at daemon startup. */
export function configureDaemonUrl(url: string): void {
  configuredDaemonUrl = url;
  console.log(`[Executor] Daemon URL configured: ${url}`);
}

let configuredExecutorDefaults: ExecutorSpawnDefaults = {
  executorResponse: resolveExecutorResponseConfig(),
};
let requireExecutorTenantContext = false;

/** Set default executor template and sandbox policy from config. */
export function configureExecutor(
  config: ExecutorConfig | null | undefined,
  options: {
    /** Replica-local daemon listener origin used by locally spawned request executors. */
    localResponseOriginUrl: string;
    requireTenantContext?: boolean;
    sandboxRuntimePaths?: SandboxRuntimePaths;
  }
): void {
  configuredExecutorDefaults = {
    executorCommandTemplate: config?.executor_command_template || undefined,
    executorResponse: resolveExecutorResponseConfig(config?.executor_response),
    sandbox: config?.sandbox?.enabled ? config.sandbox : undefined,
    sandboxRuntimePaths: options.sandboxRuntimePaths,
  };
  requireExecutorTenantContext = options.requireTenantContext === true;
  const response = configuredExecutorDefaults.executorResponse;
  // Local subprocess executors are co-located with this replica, so they always
  // call back over loopback — guaranteed to reach the replica that holds the
  // reservation. The configured `origin_url` is the reachable address for
  // OFF-HOST (templated/delegated) executors only, and is applied per
  // reservation on that path. Using it for local callbacks would risk
  // misrouting through a load balancer to a replica whose `pending` map has no
  // matching request.
  configureExecutorResponseChannel({
    originUrl: options.localResponseOriginUrl,
    maxResponseBytes: response.maxResponseBytes,
    maxActiveRequests: response.maxActiveRequests,
  });

  if (configuredExecutorDefaults.executorCommandTemplate) {
    const preview =
      configuredExecutorDefaults.executorCommandTemplate.split('\n')[0]?.slice(0, 80) ?? '';
    console.log(
      `[Executor] Command template configured (first line): ${preview}${preview.length === 80 ? '…' : ''}`
    );
  }
  if (configuredExecutorDefaults.sandbox && !configuredExecutorDefaults.sandboxRuntimePaths) {
    throw new Error('Sandbox executor configuration requires resolved runtime paths');
  }
}

export interface ExecutorTemplateVariables {
  task_id?: string;
  command?: string;
  unix_user?: string;
  session_id?: string;
  branch_id?: string;
  /** Trusted Agor user UUID used by external launchers for identity-scoped storage. */
  user_id?: string;
  /** RBAC-resolved branch filesystem projection for the current actor. */
  branch_fs_access?: 'none' | 'read' | 'write';
  log_level?: string;
  executor_type?: string;
  /**
   * Absolute path of the per-branch SDK home for a branch-scoped Session, or
   * empty for an execution-home Session (design §7.4). In `delegated` mode
   * Agor mounts nothing, so the external launcher owns enforcement: it must
   * relocate the tool's SDK home and provide any safe caller-scoped credential
   * overlay. Shell-escaped during substitution like {tenant_id}; always
   * rendered (empty string when unused) so the placeholder never survives into
   * the command.
   */
  branch_sdk_home?: string;
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
  /** Opaque legacy home key forwarded only to an external delegated launcher. */
  delegatedHomeKey?: string | null;
  /** When set, uses template substitution instead of local subprocess. */
  executorCommandTemplate?: string | null;
  /**
   * Caller-provided domain/runtime overrides. Tenant identity is deliberately
   * excluded: it must come from the ambient tenant context.
   */
  templateVariables?: Omit<ExecutorTemplateVariables, 'tenant_id'>;
  onExit?: (code: number | null, context: ExecutorSpawnContext) => void | Promise<void>;
  /** Fired after spawn, before stdin is written. Works for both local and templated paths. */
  onSpawn?: (child: ChildProcess, context: ExecutorSpawnContext) => void | Promise<void>;
  /** Caller-assembled env; bypasses internal curation. Ignored by templated path. */
  preparedEnv?: Record<string, string>;
  /**
   * Parent-process descriptors for race-safe local sandbox file mounts. The
   * caller keeps each descriptor open through this synchronous spawn call and
   * closes its copy afterwards. Never forwarded to delegated launchers or the
   * executor payload.
   */
  localSandboxFileBinds?: Array<{ sourceFd: number; destination: string }>;
}

export type { ExecutorCommandResult } from '@agor/core/executor-protocol';

/**
 * Invoke a fire-and-forget lifecycle callback while observing both synchronous
 * throws and asynchronous rejections. The spawn API deliberately remains void,
 * but callback failures must never become process-level unhandled rejections.
 * Error objects are not logged because database failures can carry bound token
 * fingerprints or other sensitive parameters.
 */
function observeExitCallback(
  callback: SpawnExecutorOptions['onExit'],
  code: number | null,
  context: ExecutorSpawnContext,
  logPrefix: string
): void {
  if (!callback) return;
  try {
    void Promise.resolve(callback(code, context)).catch(() => {
      console.error(`${logPrefix} Executor exit callback failed`);
    });
  } catch {
    console.error(`${logPrefix} Executor exit callback failed`);
  }
}

export interface RunExecutorCommandOptions
  extends Omit<SpawnExecutorOptions, 'localSandboxFileBinds' | 'onExit' | 'onSpawn'> {
  /** Built-in call-specific timeout; config `timeout_ms.by_command` may override it. */
  timeoutMs?: number;
  /** Suppress child stdout/stderr logs for credential-sensitive operations. */
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
  // is both a shell-injection and a path-traversal vector. The home-key
  // charset excludes shell metacharacters, `/` and `.`, so format validation
  // is the control here (stronger than escaping, which would not stop `../`).
  if (variables.unix_user !== undefined && !isValidExecutionHomeKey(variables.unix_user)) {
    throw new Error(
      'executor_command_template {unix_user} value is not a valid execution home key; refusing to execute'
    );
  }
  if (
    variables.user_id !== undefined &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(variables.user_id)
  ) {
    throw new Error(
      'executor_command_template {user_id} value is not a valid Agor user UUID; refusing to execute'
    );
  }

  let result = template;

  const substitutions: Record<string, string | number | undefined> = {
    task_id: variables.task_id,
    command: variables.command,
    unix_user: variables.unix_user,
    session_id: variables.session_id,
    branch_id: variables.branch_id,
    user_id: variables.user_id,
    branch_fs_access: variables.branch_fs_access,
    log_level: variables.log_level,
    executor_type: variables.executor_type,
    // Always render (empty string when unused) so `{branch_sdk_home}` never
    // survives literally into the command line (design §7.4).
    branch_sdk_home: variables.branch_sdk_home ?? '',
    tenant_id: variables.tenant_id,
  };

  // Security-sensitive values rendered as one opaque shell argument. tenant_id
  // may originate in external auth claims; branch_sdk_home is a filesystem path
  // that must not word-split or glob. Templates should use them unquoted, e.g.
  // `launcher --tenant-id {tenant_id} --sdk-home {branch_sdk_home}`.
  const shellEscapedKeys = new Set(['tenant_id', 'branch_sdk_home']);
  for (const [key, value] of Object.entries(substitutions)) {
    if (value !== undefined) {
      const placeholder = new RegExp(`\\{${key}\\}`, 'g');
      const renderedValue = shellEscapedKeys.has(key)
        ? escapeShellArg(String(value))
        : String(value);
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
 * This is the canonical entry point for autonomous executor spawning. It:
 * - Returns immediately after spawning (does NOT wait for completion)
 * - Supports both local subprocess and templated (k8s/docker) execution
 * - Logs stdout/stderr to daemon logs
 *
 * The executor is responsible for:
 * - Completing filesystem and database lifecycle operations
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
  const payloadWithConfig = {
    ...withResolvedConfig(payload),
    executorMode: 'autonomous' as const,
  };

  if (executorCommandTemplate) {
    if (options.localSandboxFileBinds?.length) {
      throw new Error('Local sandbox file binds cannot be forwarded to a delegated launcher');
    }
    spawnExecutorWithTemplate(payloadWithConfig, {
      ...options,
      executorCommandTemplate,
      templateVariables: {
        command: payload.command as string,
        task_id: generateTaskId(),
        unix_user: options.delegatedHomeKey || undefined,
        log_level: resolveExecutorLogLevel(options.env ?? (process.env as Record<string, string>)),
        executor_type: 'executor',
        ...templateVariables,
        tenant_id: tenantId,
      },
      logPrefix,
    });
  } else {
    spawnExecutorLocal(payloadWithConfig, options);
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
function sandboxLocalExecutorCommand(
  payload: Record<string, unknown>,
  command: { cmd: string; args: string[]; env: Record<string, string | undefined> },
  logPrefix: string,
  localSandboxFileBinds: SpawnExecutorOptions['localSandboxFileBinds']
): {
  cmd: string;
  args: string[];
  env: Record<string, string | undefined>;
  inheritedFds?: number[];
} {
  // Sandbox around the WORK directory, never the executor package cwd. The
  // daemon supplies this path and the caller's normalized filesystem access;
  // the executor must not rediscover either from client-controlled data.
  const params = payload.params as
    | {
        cwd?: unknown;
        sandboxBaseRepoPath?: unknown;
        sandboxHomeStore?: unknown;
        sandboxWorktreesRoot?: unknown;
        principalBranchAccess?: unknown;
        sandboxBranchSdkHome?: unknown;
      }
    | undefined;
  const workdir =
    typeof payload.cwd === 'string' && payload.cwd.length > 0
      ? payload.cwd
      : typeof params?.cwd === 'string' && params.cwd.length > 0
        ? params.cwd
        : undefined;
  if (!workdir) {
    if (localSandboxFileBinds?.length) {
      throw new Error('Sandbox file binds require an authoritative branch working directory');
    }
    return command;
  }

  const inheritedFds = localSandboxFileBinds?.map((bind) => bind.sourceFd) ?? [];
  const childCredentialBinds = localSandboxFileBinds?.map((bind, index) => ({
    // Node maps extra stdio entries to child descriptors starting at 3.
    fd: 3 + index,
    destination: bind.destination,
  }));

  const branchAccess =
    params?.principalBranchAccess === 'read' || params?.principalBranchAccess === 'none'
      ? params.principalBranchAccess
      : 'write';
  const wrap = buildSandboxWrap({
    sandbox: configuredExecutorDefaults.sandbox,
    branchPath: workdir,
    cmd: command.cmd,
    args: command.args,
    baseRepoPath:
      typeof params?.sandboxBaseRepoPath === 'string' ? params.sandboxBaseRepoPath : undefined,
    ownerHomeStore:
      typeof params?.sandboxHomeStore === 'string' ? params.sandboxHomeStore : undefined,
    worktreesRoot:
      typeof params?.sandboxWorktreesRoot === 'string' ? params.sandboxWorktreesRoot : undefined,
    branchAccess,
    branchSdkHomeDir:
      typeof params?.sandboxBranchSdkHome === 'string' ? params.sandboxBranchSdkHome : undefined,
    branchSdkCredentialBinds: childCredentialBinds,
    runtimePaths: configuredExecutorDefaults.sandboxRuntimePaths as SandboxRuntimePaths,
  });
  if (!wrap) {
    if (inheritedFds.length > 0) {
      throw new Error('Credential file binds require the fail-closed filesystem sandbox');
    }
    return command;
  }
  console.log(`${logPrefix} Sandbox: wrapping executor via bwrap (filesystem-only)`);
  return {
    cmd: wrap.cmd,
    args: wrap.args,
    env: { ...command.env, ...wrap.extraEnv },
    ...(inheritedFds.length > 0 ? { inheritedFds } : {}),
  };
}

function spawnExecutorLocal(payload: Record<string, unknown>, options: SpawnExecutorOptions): void {
  const params = payload.params as { cwd?: unknown; sandboxHomeStore?: unknown } | undefined;
  const sandboxWorkdir =
    typeof payload.cwd === 'string' && payload.cwd.length > 0
      ? payload.cwd
      : typeof params?.cwd === 'string' && params.cwd.length > 0
        ? params.cwd
        : undefined;
  const sandboxHomeStore =
    typeof params?.sandboxHomeStore === 'string' ? params.sandboxHomeStore : undefined;
  const sandbox = configuredExecutorDefaults.sandbox;

  if (
    process.platform === 'linux' &&
    sandboxWorkdir &&
    sandboxHomeStore &&
    sandbox?.enabled === true &&
    sandbox.home_mode === 'per_user'
  ) {
    // Materialize the immutable-parent mount source and all authority leaves
    // immediately before argument construction. The shared credential-file
    // primitive walks directories without following symlinks and preserves
    // existing bytes/inodes, so a malformed owner store fails before bwrap can
    // create an empty mountpoint or follow a task-controlled `.claude` symlink.
    try {
      ensureCredentialAuthorityLayoutSync(
        path.join(sandboxHomeStore, '.claude', '.credentials.json')
      );
    } catch (error) {
      const logPrefix = options.logPrefix ?? '[Executor]';
      console.error(
        `${logPrefix} Sandbox credential authority preparation failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      observeExitCallback(options.onExit, 126, { mode: 'local' }, logPrefix);
      return;
    }
    spawnExecutorLocalPrepared(payload, options);
    return;
  }

  spawnExecutorLocalPrepared(payload, options);
}

function spawnExecutorLocalPrepared(
  payload: Record<string, unknown>,
  options: SpawnExecutorOptions
): void {
  const location = resolveLocalExecutorLocation(options);
  const cwdFailure = resolveLocalExecutorCwdFailure(location);
  const logPrefix = options.logPrefix ?? '[Executor]';
  if (cwdFailure) {
    console.error(
      `${logPrefix} ${cwdFailure.error?.message}. ` +
        `This usually means the branch or repo directory was deleted out-of-band. ` +
        `Verify that the volume backing the working directory persists across restarts.`
    );
    observeExitCallback(options.onExit, 127, { mode: 'local' }, logPrefix);
    return;
  }

  const { executorPath, cwd, envWithDaemonUrl, cmd, args } = prepareLocalExecutorSpawn(
    options,
    '--stdin',
    location
  );

  // OS-level sandbox wrap (SRT) — covers fire-and-forget prompt processes and
  // the request/response branch-file commands through one helper.
  let spawnCommand: ReturnType<typeof sandboxLocalExecutorCommand>;
  try {
    spawnCommand = sandboxLocalExecutorCommand(
      payload,
      { cmd, args, env: envWithDaemonUrl },
      logPrefix,
      options.localSandboxFileBinds
    );
  } catch (err) {
    console.error(
      `${logPrefix} Sandbox wrap failed: ${err instanceof Error ? err.message : String(err)}`
    );
    observeExitCallback(options.onExit, 126, { mode: 'local' }, logPrefix);
    return;
  }
  console.log(`${logPrefix} Spawning executor at: ${executorPath}`);
  console.log(`${logPrefix} Command: ${payload.command}`);

  let reportedExit = false;
  const reportExit = (code: number | null): void => {
    if (reportedExit) return;
    reportedExit = true;
    observeExitCallback(options.onExit, code, { mode: 'local' }, logPrefix);
  };

  const executorProcess = spawn(spawnCommand.cmd, spawnCommand.args, {
    cwd,
    env: { ...spawnCommand.env },
    stdio: ['pipe', 'inherit', 'inherit', ...(spawnCommand.inheritedFds ?? [])], // stdin: pipe, stdout/stderr: inherit; extra entries are pinned credential fds
    detached: process.platform !== 'win32',
  });

  const spawnReady = options.onSpawn?.(executorProcess, { mode: 'local' });

  executorProcess.on('error', (error) => {
    console.error(`${logPrefix} Spawn error:`, error.message);
    // child_process may emit `error` without a following `exit` when the
    // executable itself cannot be spawned. Surface that through the normal onExit safety net so callers do
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
    observeExitCallback(options.onExit, code, { mode: 'templated' }, logPrefix);
  };

  const executorProcess = spawn('sh', ['-c', command], {
    env: resolveTemplateLauncherEnvironment(logLevel),
    // Trusted launchers receive the reserved AGOR_CLOUD_* credential namespace.
    // Their output is therefore not a daemon logging channel: discard it at the
    // process boundary and retain only the closed spawn/exit metadata below.
    stdio: ['pipe', 'ignore', 'ignore'],
  });

  const spawnReady = options.onSpawn?.(executorProcess, { mode: 'templated' });

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

function logChunkedOutput(prefix: string, stream: 'stdout' | 'stderr', chunk: Buffer): void {
  const text = chunk.toString();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (stream === 'stdout') {
      console.log(`${prefix} ${line}`);
    } else {
      console.error(`${prefix} ${line}`);
    }
  }
}

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

function resolveLocalExecutorEnvironment(
  options: Pick<SpawnExecutorOptions, 'env' | 'preparedEnv'>
): Record<string, string> {
  // Safe default for every fixed executor command. Task/lifecycle callers pass
  // an already resolved `preparedEnv`; other commands need only the curated
  // host runtime, never the daemon's entire credential-bearing process.env.
  const env = options.env ?? buildAllowlistedEnv();
  const source = options.preparedEnv ?? env;
  return withDaemonExecutorEnv(source, getDaemonUrl());
}

function prepareLocalExecutorSpawn(
  options: SpawnExecutorOptions,
  mode: '--stdin' | '--interactive-command',
  location = resolveLocalExecutorLocation(options)
) {
  const { executorPath, cwd } = location;
  const envWithDaemonUrl = resolveLocalExecutorEnvironment(options);
  return {
    cmd: 'node',
    args: [executorPath, mode],
    executorPath,
    cwd,
    envWithDaemonUrl,
  };
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

  const tenantId = resolveExecutorTenantId();
  const command = String(payload.command ?? '?');
  const timeoutMs = resolveExecutorResponseTimeoutMs(
    configuredExecutorDefaults.executorResponse,
    command,
    options.timeoutMs
  );
  const attemptId = crypto.randomUUID();
  const taskId = generateTaskId();
  const location = resolveLocalExecutorLocation(options);
  const cwdFailure = resolveLocalExecutorCwdFailure(location);
  if (cwdFailure) return failedInteractiveExecutorHandle(cwdFailure);
  const prepared = prepareLocalExecutorSpawn(options, '--interactive-command', location);
  const { cmd, args, cwd, envWithDaemonUrl } = prepared;
  let deliverEvent: (event: unknown) => void = () => undefined;
  let response: ExecutorResponseReservation;
  try {
    const params = payload.params as { branchId?: unknown; sessionId?: unknown } | undefined;
    response = reserveExecutorResponse({
      tenantId,
      ...(typeof options.templateVariables?.user_id === 'string'
        ? { userId: options.templateVariables.user_id }
        : {}),
      command,
      ...(typeof params?.branchId === 'string' ? { branchId: params.branchId } : {}),
      ...(typeof params?.sessionId === 'string' ? { sessionId: params.sessionId } : {}),
      timeoutMs,
      timeoutResult: failures.timeout,
      profile: 'events',
      onEvent: (event) => deliverEvent(event),
    });
  } catch (error) {
    if (error instanceof ExecutorResponseAdmissionError) {
      return failedInteractiveExecutorHandle(error.result);
    }
    throw error;
  }
  const requestPayload = {
    ...withResolvedConfig(payload),
    executorMode: 'request' as const,
    executorResponse: response.descriptor,
  };
  let child: ChildProcess;
  try {
    child = spawn(cmd, args, {
      cwd,
      env: { ...envWithDaemonUrl },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
  } catch {
    response.fail(failures.spawn);
    return failedInteractiveExecutorHandle(failures.spawn);
  }
  let resolveResult!: (result: ExecutorCommandResult) => void;
  const result = new Promise<ExecutorCommandResult>((resolve) => {
    resolveResult = resolve;
  });
  let stderrSeen = false;
  let terminalResult: ExecutorCommandResult | undefined;
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
      if (leaderExited) markExecutorProcessExited(attemptId, child.pid);
      const containment = await containExecutorProcess(attemptId, taskId);
      if (containment.status !== 'verified_absent') {
        return failures.cleanupUnverified;
      }
      await closed;
      untrackExecutorProcess(attemptId, taskId);
      return fallback ?? terminalResult ?? failures.missingResult(stderrSeen);
    })();
    void finalization.then(resolveResult);
    return finalization;
  };

  const stdinFailure = failures.stdin;
  input = createJsonLineInput(
    child,
    () => Boolean(finalization),
    () => {
      response.fail(stdinFailure);
    }
  );

  if (!child.pid) {
    const spawnFailure = failures.spawn;
    response.fail(spawnFailure);
    resolveResult(spawnFailure);
    return failedInteractiveExecutorHandle(spawnFailure);
  }
  trackExecutorProcess({ sessionId: attemptId, taskId, pid: child.pid });

  const controls = {
    deliver: input.deliver,
    endInput: input.end,
  };
  deliverEvent = (event) => onEvent?.(event, controls);

  child.stdout?.on('data', (chunk: Buffer) => {
    if (!options.sensitiveOutput) {
      logChunkedOutput(options.logPrefix ?? '[Executor]', 'stdout', chunk);
    }
  });
  child.stderr?.on('data', () => {
    stderrSeen = true;
  });
  child.stdin?.on('error', () => {
    input.failPending(true);
    response.fail(stdinFailure);
  });
  child.on('error', () => {
    response.fail(failures.spawn);
  });
  child.on('exit', () => {
    input.failPending(false);
    markExecutorProcessExited(attemptId, child.pid);
    response.fail(failures.missingResult(stderrSeen));
    void finalize(terminalResult, true);
  });
  child.on('close', () => {
    input.failPending(false);
    markExecutorProcessExited(attemptId, child.pid);
    resolveClose();
    void finalize(undefined, true);
  });

  response.setFailureCleanup((terminal) => {
    terminalResult = terminal;
    void finalize(terminal);
  });
  void response.result.then((terminal) => {
    terminalResult = terminal;
    return finalize(terminal);
  });
  void input.deliver(requestPayload, options.closeInputAfterPayload);

  return {
    result,
    cancel: () => {
      response.fail(failures.cancelled);
      return finalize(failures.cancelled);
    },
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
  const command = String(payload.command ?? '?');
  const timeoutMs = resolveExecutorResponseTimeoutMs(
    configuredExecutorDefaults.executorResponse,
    command,
    options.timeoutMs
  );
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
          message: 'Executor exited without a final response',
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
 * Run a short-lived executor command and wait for its authenticated response.
 *
 * Use this for daemon call sites that need an immediate answer (for example
 * autocomplete, branch inspection, and other bounded lifecycle probes).
 * Prompt Git-state snapshots are captured inside the prompt executor; they do
 * not use this request/response path. Long-running commands and lifecycle
 * tasks should keep using spawnExecutorFireAndForget().
 */
export async function requestExecutor(
  payload: Record<string, unknown>,
  options: RunExecutorCommandOptions = {}
): Promise<ExecutorCommandResult> {
  const { templateVariables, logPrefix = '[Executor]' } = options;
  const tenantId = resolveExecutorTenantId();
  const commandName = String(payload.command ?? '?');
  const timeoutMs = resolveExecutorResponseTimeoutMs(
    configuredExecutorDefaults.executorResponse,
    commandName,
    options.timeoutMs
  );

  const executorCommandTemplate =
    options.executorCommandTemplate !== undefined
      ? options.executorCommandTemplate || undefined
      : configuredExecutorDefaults.executorCommandTemplate;
  const responseConfig = configuredExecutorDefaults.executorResponse;
  if (
    executorCommandTemplate &&
    (responseConfig.externalProtocol !== EXECUTOR_RESPONSE_PROTOCOL || !responseConfig.originUrl)
  ) {
    return {
      success: false,
      error: {
        code: 'EXECUTOR_RESPONSE_UNSUPPORTED',
        message:
          'Templated request execution requires ' +
          `execution.executor_response.external_protocol=${EXECUTOR_RESPONSE_PROTOCOL} ` +
          'and an exact origin_url',
      },
    };
  }

  const timeoutResult: ExecutorCommandResult = {
    success: false,
    error: {
      code: 'EXECUTOR_TIMEOUT',
      message: `Executor command timed out after ${timeoutMs}ms`,
      details: { command: commandName },
    },
  };
  let response: ExecutorResponseReservation;
  try {
    const params = payload.params as { branchId?: unknown; sessionId?: unknown } | undefined;
    response = reserveExecutorResponse({
      tenantId,
      ...(typeof templateVariables?.user_id === 'string'
        ? { userId: templateVariables.user_id }
        : {}),
      command: commandName,
      ...(typeof params?.branchId === 'string' ? { branchId: params.branchId } : {}),
      ...(typeof params?.sessionId === 'string' ? { sessionId: params.sessionId } : {}),
      timeoutMs,
      timeoutResult,
      // Off-host executors call back over the configured reachable origin; local
      // subprocesses inherit the loopback origin from the channel config.
      ...(executorCommandTemplate && responseConfig.originUrl
        ? { originUrl: responseConfig.originUrl }
        : {}),
    });
  } catch (error) {
    if (error instanceof ExecutorResponseAdmissionError) return error.result;
    throw error;
  }
  const payloadWithConfig = {
    ...withResolvedConfig(payload),
    executorMode: 'request' as const,
    executorResponse: response.descriptor,
  };

  try {
    if (executorCommandTemplate) {
      requestExecutorWithTemplate(payloadWithConfig, response, {
        ...options,
        timeoutMs,
        executorCommandTemplate,
        templateVariables: {
          command: payload.command as string,
          task_id: generateTaskId(),
          unix_user: options.delegatedHomeKey || undefined,
          log_level: resolveExecutorLogLevel(
            options.env ?? (process.env as Record<string, string>)
          ),
          executor_type: 'executor',
          ...templateVariables,
          tenant_id: tenantId,
        },
        logPrefix,
      });
    } else {
      requestExecutorLocal(payloadWithConfig, response, { ...options, timeoutMs, logPrefix });
    }
  } catch {
    response.fail({
      success: false,
      error: {
        code: 'EXECUTOR_SPAWN_ERROR',
        message: 'Executor process did not start',
        details: { command: commandName },
      },
    });
  }
  return response.result;
}

function requestExecutorLocal(
  payload: Record<string, unknown>,
  response: ExecutorResponseReservation,
  options: RunExecutorCommandOptions
): void {
  const { logPrefix = '[Executor]' } = options;
  const location = resolveLocalExecutorLocation(options);
  const cwdFailure = resolveLocalExecutorCwdFailure(location);
  if (cwdFailure) {
    response.fail(cwdFailure);
    return;
  }
  const prepared = prepareLocalExecutorSpawn(options, '--stdin', location);
  const { cmd, args, cwd, envWithDaemonUrl } = prepared;

  let spawnCommand: ReturnType<typeof sandboxLocalExecutorCommand>;
  try {
    spawnCommand = sandboxLocalExecutorCommand(
      payload,
      { cmd, args, env: envWithDaemonUrl },
      logPrefix,
      undefined
    );
  } catch (error) {
    response.fail({
      success: false,
      error: {
        code: 'EXECUTOR_SPAWN_ERROR',
        message: `Executor sandbox setup failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        details: { command: payload.command },
      },
    });
    return;
  }

  console.log(`${logPrefix} Running executor command: ${payload.command ?? '?'}`);

  const child = spawn(spawnCommand.cmd, spawnCommand.args, {
    cwd,
    env: { ...spawnCommand.env },
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: false,
  });

  let stderrSeen = false;
  response.setFailureCleanup(() => child.kill('SIGTERM'));
  child.stdout?.on('data', (chunk: Buffer) => {
    if (!options.sensitiveOutput) logChunkedOutput(logPrefix, 'stdout', chunk);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrSeen = true;
    if (!options.sensitiveOutput) logChunkedOutput(logPrefix, 'stderr', chunk);
  });
  child.stdin?.on('error', () => {
    response.fail({
      success: false,
      error: { code: 'EXECUTOR_STDIN_ERROR', message: 'Executor command input failed' },
    });
  });
  child.on('error', (error) => {
    response.fail({
      success: false,
      error: {
        code: 'EXECUTOR_SPAWN_ERROR',
        message: error.message,
        details: { command: payload.command },
      },
    });
  });
  child.on('exit', (code) => {
    response.fail({
      success: false,
      error: {
        code: 'EXECUTOR_RESULT_MISSING',
        message: `Executor exited with code ${code} before delivering a final response`,
        details: {
          command: payload.command,
          exitCode: code,
          stderr: stderrSeen ? '[redacted; enable executor debug logs]' : '',
        },
      },
    });
  });

  child.stdin?.write(JSON.stringify(payload));
  child.stdin?.end();
}

function requestExecutorWithTemplate(
  payload: Record<string, unknown>,
  response: ExecutorResponseReservation,
  options: RunExecutorCommandOptions & {
    executorCommandTemplate: string;
    templateVariables: ExecutorTemplateVariables;
  }
): void {
  const { executorCommandTemplate, templateVariables, logPrefix = '[Executor]' } = options;
  const logLevel = templateVariables.log_level ?? getCurrentLogLevel();
  const command = substituteTemplateVariables(executorCommandTemplate, templateVariables);

  console.log(`${logPrefix} Running templated executor command: ${payload.command ?? '?'}`);

  const child = spawn('sh', ['-c', command], {
    env: resolveTemplateLauncherEnvironment(logLevel),
    // The authenticated response channel is the result protocol. Launcher
    // stdout/stderr are untrusted diagnostics from a secret-bearing process
    // and must never be relayed into daemon logs.
    stdio: ['pipe', 'ignore', 'ignore'],
  });

  response.setFailureCleanup(() => child.kill('SIGTERM'));
  child.stdin?.on('error', () => {
    response.fail({
      success: false,
      error: { code: 'EXECUTOR_STDIN_ERROR', message: 'Executor launcher input failed' },
    });
  });
  child.on('error', (error) => {
    response.fail({
      success: false,
      error: {
        code: 'EXECUTOR_SPAWN_ERROR',
        message: error.message,
        details: { command: payload.command, taskId: templateVariables.task_id },
      },
    });
  });
  child.on('exit', (code) => {
    // A templated launcher may exit after submitting remote work. Its exit is
    // observed for process hygiene but is not the executor's terminal result.
    if (code && code !== 0) {
      console.error(`${logPrefix} Executor launcher exited with code ${code}`);
    }
  });

  child.stdin?.write(JSON.stringify(payload));
  child.stdin?.end();
}

export function getDaemonUrl(): string {
  if (configuredDaemonUrl) return configuredDaemonUrl;
  return `http://localhost:${process.env.PORT || '3030'}`;
}

/**
 * Create a short-lived reserved service-identity token.
 *
 * Production callers reach this low-level signer only through the explicit
 * daemon-system and restricted-terminal wrappers below. User-triggered
 * executors authenticate with delegated-user credentials instead.
 *
 * @param jwtSecret - The daemon's JWT secret
 * @param expiresIn - Token expiration (default: 5 minutes)
 * @returns JWT access token
 */
function createServiceToken(
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
 * Issue one reserved service-family token from the Feathers app.
 *
 * Convenience function that extracts the JWT secret from the app
 * and creates a service token.
 *
 * @param app - FeathersJS application with sessionTokenService
 * @returns JWT access token
 */
function issueReservedServiceTokenFromApp(
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
 * Generate a full daemon service token for an explicit system job.
 *
 * User-triggered executors must use delegated-user credentials instead. This
 * intentionally accepts no caller-provided scope: extra JWT claims do not
 * restrict a service account's ordinary Feathers authority.
 */
export function generateDaemonServiceToken(
  app: {
    settings: { authentication?: { secret?: string } };
  },
  expiresIn?: SignOptions['expiresIn']
): string {
  return issueReservedServiceTokenFromApp(app, serviceTokenScopeForCurrentTenant(), expiresIn);
}

export interface TerminalExecutorTokenScope {
  terminal_user_id: string;
  terminal_id: string;
  terminal_branch_id: string;
  terminal_owner_boot_id: string;
}

/** Generate the separately restricted identity for one live PTY attachment. */
export function generateTerminalExecutorToken(
  app: {
    settings: { authentication?: { secret?: string } };
  },
  scope: TerminalExecutorTokenScope,
  expiresIn: SignOptions['expiresIn']
): string {
  return issueReservedServiceTokenFromApp(
    app,
    { ...scope, ...serviceTokenScopeForCurrentTenant() },
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
  'executor_command_template' | 'executor_response' | 'sandbox'
>;

interface ExecutorSpawnDefaults {
  /** Executor command template for containerized execution */
  executorCommandTemplate?: string;
  /** Resolved bounded response transport policy. */
  executorResponse: ResolvedExecutorResponseConfig;
  /** OS-level sandbox policy (SRT) wrapped around every local executor spawn. */
  sandbox?: AgorExecutionSettings['sandbox'];
  /** Deployment paths captured from the immutable startup configuration. */
  sandboxRuntimePaths?: SandboxRuntimePaths;
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
    });
  };
}

// `spawnExecutorFireAndForget` is the canonical name used by ~10 call sites
// across daemon/services and daemon/register-hooks. We keep it as the public
// name because that's what callers expect; `spawnExecutor` remains the
// underlying implementation.
export const spawnExecutorFireAndForget = spawnExecutor;
