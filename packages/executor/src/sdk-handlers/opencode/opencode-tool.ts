/**
 * OpenCode Tool Implementation
 *
 * Owns one authenticated, task-scoped OpenCode server and its SDK turn.
 * The handler calls only runTurn; protocol translation and reconciliation stay
 * behind this single runtime owner.
 */

import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shortId } from '@agor/core';
import { mergeMCPRemoteHeaders } from '@agor/core/tools/mcp/http-headers';
import { resolveMCPAuthHeaders } from '@agor/core/tools/mcp/jwt-auth';
import type {
  ContentBlock,
  MessageID,
  PermissionMode,
  SessionID,
  TaskID,
  ToolUse,
} from '@agor/core/types';
import { createOpencodeClient } from '@opencode-ai/sdk';
import { getDaemonUrl } from '../../config.js';
import type {
  MCPOAuthAuthHeadersRepository,
  MCPServerRepository,
  MessagesRepository,
  SessionMCPServerRepository,
} from '../../db/feathers-repositories.js';
import type { PermissionService } from '../../permissions/permission-service.js';
import { enrichContentBlocks } from '../base/diff-enrichment.js';
import type {
  CreateSessionConfig,
  MessagesService,
  SessionHandle,
  SessionsPatchClient,
  StreamingCallbacks,
  TasksService,
} from '../base/index.js';
import { getMcpServersForSession } from '../base/mcp-scoping.js';
import { createCanUseToolCallback } from '../claude/permissions/permission-hooks.js';
import {
  createOpenCodeEventTranslator,
  type OpenCodeEventEffect,
  reconcileOpenCodeMessages,
} from './event-translator.js';

const OPENCODE_VERSION = '1.14.33';
const DEFAULT_READINESS_TIMEOUT_MS = 10_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 2_000;
const DEFAULT_EVENT_DRAIN_MS = 10;
const MAX_STARTUP_OUTPUT = 4_096;
const AGOR_PERMISSION_INTERCEPTION = {
  '*': 'ask',
  read: 'ask',
  edit: 'ask',
  glob: 'ask',
  grep: 'ask',
  list: 'ask',
  bash: 'ask',
  task: 'ask',
  external_directory: 'ask',
  todowrite: 'ask',
  question: 'ask',
  webfetch: 'ask',
  websearch: 'ask',
  lsp: 'ask',
  doom_loop: 'ask',
  skill: 'ask',
} as const;
const AGOR_MANAGED_AGENT = 'agor-managed';

type OpenCodeClient = ReturnType<typeof createOpencodeClient>;

export class OpenCodePermissionRejectedError extends Error {}

type ManagedChild = {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  exitCode: number | null;
  kill(signal: NodeJS.Signals): boolean;
  once(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void
  ): unknown;
  once(
    event: 'close',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void
  ): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
  removeListener(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void
  ): unknown;
  removeListener(event: 'error', listener: (error: Error) => void): unknown;
};

export type RunOpenCodeTurnInput = {
  agorSessionId: SessionID;
  taskId: TaskID;
  prompt: string;
  agorAssistantMessageId: MessageID;
  existingOpenCodeSessionId?: string;
  title: string;
  directory: string;
  provider?: string;
  model?: string;
  mcpToken?: string;
  permissionMode?: PermissionMode;
  signal: AbortSignal;
  persistOpenCodeSessionId: (sessionId: string) => Promise<void>;
};

export type OpenCodeTurnResult = {
  openCodeSessionId: string;
  sessionWasCreated: boolean;
  finalMessage: {
    content: string;
    contentBlocks: ContentBlock[];
    toolUses: ToolUse[];
    metadata: Record<string, unknown>;
  };
};

type InvocationConfig = {
  mcp: Record<string, unknown>;
  permission?: Record<string, 'ask' | 'allow' | 'deny'>;
  [key: string]: unknown;
};

export type OpenCodeToolDependencies = {
  sessionMCPRepo?: SessionMCPServerRepository;
  mcpServerRepo?: MCPServerRepository;
  mcpOAuthAuthHeadersRepo?: MCPOAuthAuthHeadersRepository;
  permissionService?: PermissionService;
  messagesRepo?: MessagesRepository;
  messagesService?: MessagesService;
  tasksService?: TasksService;
  sessionsService?: SessionsPatchClient;
  resolveBinary?: () => Promise<string>;
  spawn?: (executable: string, args: readonly string[], options: SpawnOptions) => ManagedChild;
  createClient?: typeof createOpencodeClient;
  resolveInvocationConfig?: (input: RunOpenCodeTurnInput) => Promise<InvocationConfig>;
  randomBytes?: typeof nodeRandomBytes;
  readinessTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  eventDrainMs?: number;
};

type PackageLocation = { packageJsonPath: string; version: string };

function collectConfigSecrets(value: unknown): string[] {
  if (typeof value === 'string') {
    const credential = /^(?:Bearer|Basic)\s+(.+)$/i.exec(value)?.[1];
    return credential ? [value, credential] : [value];
  }
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap((item) => collectConfigSecrets(item));
  return Object.values(value).flatMap((item) => collectConfigSecrets(item));
}

function collectEnvironmentSecrets(environment: NodeJS.ProcessEnv): string[] {
  const declared = new Set(
    (environment.AGOR_USER_ENV_KEYS ?? '')
      .split(',')
      .map((key) => key.trim())
      .filter(Boolean)
  );
  return Object.entries(environment).flatMap(([key, value]) =>
    value && (declared.has(key) || /(?:KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL)$/i.test(key))
      ? [value]
      : []
  );
}

type TurnSanitizer = {
  text(value: string): string;
  error(value: unknown): Error;
};

function createTurnSanitizer(secrets: readonly string[]): TurnSanitizer {
  const uniqueSecrets = [...new Set(secrets.filter(Boolean))].sort((a, b) => b.length - a.length);
  const text = (value: string) =>
    uniqueSecrets.reduce((safe, secret) => safe.replaceAll(secret, '[REDACTED]'), value);
  const error = (value: unknown): Error => {
    const failure = value instanceof Error ? value : new Error(String(value));
    const seen = new WeakSet<Error>();
    const normalize = (unsafe: Error): Error => {
      if (seen.has(unsafe)) return new Error('[Circular error cause]');
      seen.add(unsafe);

      const safe = new Error(text(unsafe.message));
      Object.defineProperty(safe, 'name', {
        value: text(unsafe.name || 'Error'),
        configurable: true,
        writable: true,
      });
      if (unsafe.stack) safe.stack = text(unsafe.stack);
      if (unsafe.cause !== undefined) {
        const safeCause =
          unsafe.cause instanceof Error
            ? normalize(unsafe.cause)
            : new Error(text(String(unsafe.cause)));
        Object.defineProperty(safe, 'cause', {
          value: safeCause,
          configurable: true,
          writable: true,
        });
      }
      return safe;
    };
    return normalize(failure);
  };
  return { text, error };
}

function automaticallyAllowsOpenCodePermission(
  permissionMode: PermissionMode | undefined,
  permission: string
): boolean {
  if (
    permissionMode === 'bypassPermissions' ||
    permissionMode === 'allow-all' ||
    permissionMode === 'yolo'
  ) {
    return true;
  }
  if (
    permissionMode === 'acceptEdits' ||
    permissionMode === 'auto' ||
    permissionMode === 'autoEdit'
  ) {
    return permission === 'edit' || permission === 'write';
  }
  return false;
}

function asUnknownAsyncIterable(value: unknown): AsyncIterable<unknown> {
  if (value && typeof value === 'object') {
    if (Symbol.asyncIterator in value) return value as AsyncIterable<unknown>;
    if (Symbol.iterator in value) {
      const iterable = value as Iterable<unknown>;
      return {
        async *[Symbol.asyncIterator]() {
          yield* iterable;
        },
      };
    }
  }
  throw new Error('OpenCode event subscription returned no iterable stream');
}

async function findPackageLocation(
  entryPath: string,
  packageName: string
): Promise<PackageLocation> {
  let current = dirname(entryPath);
  for (;;) {
    const packageJsonPath = join(current, 'package.json');
    try {
      const parsed = JSON.parse(await readFile(packageJsonPath, 'utf8')) as {
        name?: string;
        version?: string;
      };
      if (parsed.name === packageName && parsed.version) {
        return { packageJsonPath, version: parsed.version };
      }
    } catch {
      // Keep walking toward the package root.
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`OpenCode package ${packageName} is not installed correctly`);
}

export async function resolvePackagedOpenCodeBinary(): Promise<string> {
  const require = createRequire(import.meta.url);
  let cli: PackageLocation;
  let sdk: PackageLocation;
  try {
    cli = await findPackageLocation(require.resolve('opencode-ai/package.json'), 'opencode-ai');
    sdk = await findPackageLocation(
      fileURLToPath(import.meta.resolve('@opencode-ai/sdk')),
      '@opencode-ai/sdk'
    );
  } catch (error) {
    throw new Error(
      `OpenCode ${OPENCODE_VERSION} is not fully installed; reinstall Agor with optional dependencies enabled`,
      { cause: error }
    );
  }

  if (cli.version !== OPENCODE_VERSION || sdk.version !== OPENCODE_VERSION) {
    throw new Error(
      `OpenCode SDK/CLI mismatch: expected ${OPENCODE_VERSION}, found SDK ${sdk.version} and CLI ${cli.version}`
    );
  }

  const packageRoot = dirname(cli.packageJsonPath);
  const binary =
    process.platform === 'win32'
      ? join(packageRoot, 'bin', 'opencode.exe')
      : join(packageRoot, 'bin', '.opencode');
  try {
    await access(binary, process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
  } catch (error) {
    throw new Error(
      `Packaged OpenCode ${OPENCODE_VERSION} native binary is missing or not executable; reinstall Agor with optional dependencies enabled`,
      { cause: error }
    );
  }
  return binary;
}

/**
 * Session context for an Agor session mapped to OpenCode
 */
interface SessionContext {
  opencodeSessionId: string;
  model?: string;
  provider?: string;
  /** Branch directory path for project-scoped operations */
  branchPath?: string;
}

export class OpenCodeTool {
  private client: OpenCodeClient | null = null;
  private readonly dependencies: Required<
    Pick<
      OpenCodeToolDependencies,
      | 'resolveBinary'
      | 'spawn'
      | 'createClient'
      | 'resolveInvocationConfig'
      | 'randomBytes'
      | 'readinessTimeoutMs'
      | 'shutdownTimeoutMs'
      | 'eventDrainMs'
    >
  >;
  private sessionContexts: Map<string, SessionContext> = new Map(); // Agor session ID → session context
  /** MCP repository dependencies for resolving user-defined MCP servers */
  private sessionMCPRepo?: SessionMCPServerRepository;
  private mcpServerRepo?: MCPServerRepository;
  private mcpOAuthAuthHeadersRepo?: MCPOAuthAuthHeadersRepository;
  private readonly permissionService?: PermissionService;
  private readonly messagesRepo?: MessagesRepository;
  private readonly messagesService?: MessagesService;
  private readonly tasksService?: TasksService;
  private readonly sessionsService?: SessionsPatchClient;
  private readonly permissionLocks = new Map<SessionID, Promise<void>>();

  constructor(dependencies: OpenCodeToolDependencies) {
    this.sessionMCPRepo = dependencies.sessionMCPRepo;
    this.mcpServerRepo = dependencies.mcpServerRepo;
    this.mcpOAuthAuthHeadersRepo = dependencies.mcpOAuthAuthHeadersRepo;
    this.permissionService = dependencies.permissionService;
    this.messagesRepo = dependencies.messagesRepo;
    this.messagesService = dependencies.messagesService;
    this.tasksService = dependencies.tasksService;
    this.sessionsService = dependencies.sessionsService;
    this.dependencies = {
      resolveBinary: dependencies.resolveBinary ?? resolvePackagedOpenCodeBinary,
      spawn:
        dependencies.spawn ??
        ((executable, args, options) => nodeSpawn(executable, [...args], options)),
      createClient: dependencies.createClient ?? createOpencodeClient,
      resolveInvocationConfig:
        dependencies.resolveInvocationConfig ??
        ((input) =>
          this.buildInvocationConfig(input.agorSessionId, input.mcpToken, input.directory)),
      randomBytes: dependencies.randomBytes ?? nodeRandomBytes,
      readinessTimeoutMs: dependencies.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS,
      shutdownTimeoutMs: dependencies.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
      eventDrainMs: dependencies.eventDrainMs ?? DEFAULT_EVENT_DRAIN_MS,
    };
  }

  async runTurn(
    input: RunOpenCodeTurnInput,
    streamingCallbacks?: StreamingCallbacks
  ): Promise<OpenCodeTurnResult> {
    const environmentSecrets = collectEnvironmentSecrets(process.env);
    const preliminarySanitizer = createTurnSanitizer([input.mcpToken ?? '', ...environmentSecrets]);
    let resolvedInvocationConfig: InvocationConfig;
    try {
      resolvedInvocationConfig = await this.dependencies.resolveInvocationConfig(input);
    } catch (error) {
      throw preliminarySanitizer.error(error);
    }
    // OPENCODE_CONFIG_CONTENT is the highest-precedence, invocation-scoped
    // configuration. Force every interceptable permission through Agor even if
    // the repository's opencode.json contains permissive rules.
    const invocationConfig: InvocationConfig = {
      ...resolvedInvocationConfig,
      permission: AGOR_PERMISSION_INTERCEPTION,
      agent: {
        ...(typeof resolvedInvocationConfig.agent === 'object' &&
        resolvedInvocationConfig.agent !== null
          ? resolvedInvocationConfig.agent
          : {}),
        [AGOR_MANAGED_AGENT]: {
          mode: 'primary',
          permission: AGOR_PERMISSION_INTERCEPTION,
        },
      },
    };
    const configContent = JSON.stringify(invocationConfig);
    const password = this.dependencies.randomBytes(32).toString('base64url');
    const username = 'agor';
    const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
    const turnSecrets = [
      password,
      authorization,
      input.mcpToken ?? '',
      configContent,
      ...collectConfigSecrets(invocationConfig),
      ...environmentSecrets,
    ];
    const sanitizer = createTurnSanitizer(turnSecrets);
    let child: ManagedChild;
    try {
      const executable = await this.dependencies.resolveBinary();
      child = this.dependencies.spawn(executable, ['serve', '--hostname=127.0.0.1', '--port=0'], {
        cwd: input.directory,
        detached: false,
        env: {
          ...process.env,
          OPENCODE_CONFIG_CONTENT: configContent,
          // OpenCode resolves this dedicated runtime override when creating
          // session permission rules. Keep it alongside the config content so
          // permissive project/agent rules cannot bypass Agor interception.
          OPENCODE_PERMISSION: JSON.stringify(AGOR_PERMISSION_INTERCEPTION),
          OPENCODE_SERVER_USERNAME: username,
          OPENCODE_SERVER_PASSWORD: password,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      throw sanitizer.error(error);
    }
    const close = this.createBoundedClose(child);
    let stopEventCollector = async () => {};
    let turnCompleted = false;
    let cleanupPromise: Promise<void> | undefined;
    const cleanup = () => {
      cleanupPromise ??= (async () => {
        if (!turnCompleted) {
          await this.settlesWithin(
            this.abortActiveSession(input),
            this.dependencies.shutdownTimeoutMs
          );
        }
        const collectorStop = this.settleWithinOrThrow(
          stopEventCollector(),
          this.dependencies.shutdownTimeoutMs,
          'OpenCode event collector did not settle within the shutdown timeout'
        );
        this.permissionService?.cancelPendingRequests(input.agorSessionId);
        // Child containment must start even if iterator.return() or the
        // collector itself ignores cancellation forever.
        const [collectorResult, closeResult] = await Promise.allSettled([collectorStop, close()]);
        const failures = [collectorResult, closeResult].flatMap((result) =>
          result.status === 'rejected' ? [result.reason] : []
        );
        if (failures.length > 1) {
          throw new AggregateError(
            failures,
            'OpenCode event collector and child cleanup both failed'
          );
        }
        if (failures.length === 1) throw failures[0];
      })();
      return cleanupPromise;
    };
    const abortHandler = () => {
      void cleanup().catch(() => undefined);
    };
    input.signal.addEventListener('abort', abortHandler, { once: true });

    let outcome: OpenCodeTurnResult | undefined;
    let turnFailure: Error | undefined;
    try {
      const baseUrl = await this.waitForReadiness(child, turnSecrets);
      this.client = this.dependencies.createClient({
        baseUrl,
        directory: input.directory,
        headers: { Authorization: authorization },
      });

      let openCodeSessionId = input.existingOpenCodeSessionId;
      let sessionWasCreated = false;
      if (openCodeSessionId) {
        const response = await this.client.session.get({
          path: { id: openCodeSessionId },
          query: { directory: input.directory },
        });
        if (response.error || !response.data || response.data.id !== openCodeSessionId) {
          throw new Error(
            `Unable to resume stored OpenCode session ${openCodeSessionId}; verify that its state is available under the executor identity`
          );
        }
      } else {
        const created = await this.createSession({
          title: input.title,
          projectName: 'agor',
          model: input.model,
          provider: input.provider,
          workingDirectory: input.directory,
        });
        openCodeSessionId = created.sessionId;
        sessionWasCreated = true;
        await input.persistOpenCodeSessionId(openCodeSessionId);
      }

      this.setSessionContext(
        input.agorSessionId,
        openCodeSessionId,
        input.model,
        input.provider,
        input.directory
      );
      if (input.signal.aborted)
        throw new Error('OpenCode turn was aborted before prompt submission');
      const finalMessage = await this.executeTask(
        input,
        {
          opencodeSessionId: openCodeSessionId,
          model: input.model,
          provider: input.provider,
          branchPath: input.directory,
        },
        streamingCallbacks,
        (stop) => {
          stopEventCollector = stop;
        },
        sanitizer
      );
      turnCompleted = true;
      outcome = { openCodeSessionId, sessionWasCreated, finalMessage };
    } catch (error) {
      turnFailure = sanitizer.error(error);
    }

    input.signal.removeEventListener('abort', abortHandler);
    try {
      await cleanup();
    } catch (error) {
      turnFailure = sanitizer.error(error);
    }
    this.sessionContexts.delete(input.agorSessionId);
    this.client = null;

    if (turnFailure) throw turnFailure;
    if (!outcome) throw new Error('OpenCode turn ended without a result');
    return outcome;
  }

  private async abortActiveSession(input: RunOpenCodeTurnInput): Promise<void> {
    const context = this.getSessionContext(input.agorSessionId);
    if (!context || !this.client) return;
    try {
      await this.client.session.abort({
        path: { id: context.opencodeSessionId },
        query: { directory: input.directory },
      });
    } catch {
      // Local child cleanup remains authoritative.
    }
  }

  private waitForReadiness(child: ManagedChild, secrets: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      let output = '';
      let settled = false;
      const redact = (value: string) =>
        secrets.reduce(
          (safe, secret) => (secret ? safe.replaceAll(secret, '[REDACTED]') : safe),
          value
        );
      const diagnostic = () => {
        const tail = redact(output.slice(-MAX_STARTUP_OUTPUT)).trim();
        return tail ? `: ${tail}` : '';
      };
      const cleanup = () => {
        clearTimeout(timer);
        child.stdout?.off('data', onData);
        child.stderr?.off('data', onData);
        child.removeListener('exit', onExit);
        child.removeListener('error', onError);
      };
      const fail = (message: string) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(`${message}${diagnostic()}`));
      };
      const onData = (chunk: Buffer | string) => {
        output = `${output}${chunk.toString()}`.slice(-MAX_STARTUP_OUTPUT);
        const matches = [
          ...output.matchAll(/(?:^|\n)opencode server listening on (https?:\/\/[^\s]+)/g),
        ];
        const raw = matches.at(-1)?.[1]?.replace(/[),.;]+$/, '');
        if (!raw) return;
        try {
          const url = new URL(raw);
          if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port) {
            fail('OpenCode reported a non-loopback readiness URL');
            return;
          }
          if (settled) return;
          settled = true;
          cleanup();
          resolve(url.origin);
        } catch {
          fail('OpenCode reported malformed readiness output');
        }
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
        fail(
          `OpenCode server exited before readiness (code ${code ?? 'null'}, signal ${signal ?? 'none'})`
        );
      const onError = (error: Error) => fail(`OpenCode server failed to start: ${error.message}`);
      const timer = setTimeout(
        () =>
          fail(
            `OpenCode server readiness timed out after ${this.dependencies.readinessTimeoutMs}ms`
          ),
        this.dependencies.readinessTimeoutMs
      );
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      child.once('exit', onExit);
      child.once('error', onError);
    });
  }

  private createBoundedClose(child: ManagedChild): () => Promise<void> {
    let exitObserved = child.exitCode !== null;
    const exited = exitObserved
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          const observe = () => {
            exitObserved = true;
            resolve();
          };
          child.once('exit', observe);
          child.once('close', observe);
        });
    let closePromise: Promise<void> | undefined;
    return () => {
      closePromise ??= (async () => {
        if (exitObserved || child.exitCode !== null) return;
        child.kill('SIGTERM');
        if (await this.settlesWithin(exited, this.dependencies.shutdownTimeoutMs)) return;
        child.kill('SIGKILL');
        if (!(await this.settlesWithin(exited, this.dependencies.shutdownTimeoutMs))) {
          throw new Error('OpenCode server did not exit after bounded SIGTERM/SIGKILL cleanup');
        }
      })();
      return closePromise;
    };
  }

  private async settlesWithin(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise.then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async settleWithinOrThrow(
    promise: Promise<void>,
    timeoutMs: number,
    timeoutMessage: string
  ): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Set session context (OpenCode session ID, model, provider, branch path, and MCP token) for an Agor session
   * Must be called before executeTask
   *
   * @param agorSessionId - Agor session ID
   * @param opencodeSessionId - OpenCode session ID
   * @param model - Model identifier (e.g., 'gpt-4o', 'claude-sonnet-4-6')
   * @param provider - Provider ID (e.g., 'openai', 'opencode'). If omitted, uses legacy mapping.
   * @param branchPath - Branch directory path for project-scoped operations
   */
  private setSessionContext(
    agorSessionId: string,
    opencodeSessionId: string,
    model?: string,
    provider?: string,
    branchPath?: string
  ): void {
    this.sessionContexts.set(agorSessionId, {
      opencodeSessionId,
      model,
      provider,
      branchPath,
    });
  }

  /**
   * Get session context for an Agor session
   */
  private getSessionContext(agorSessionId: string): SessionContext | undefined {
    return this.sessionContexts.get(agorSessionId);
  }

  /** Return the invocation-scoped authenticated client. */
  private getClientForDirectory(_directory: string | undefined): OpenCodeClient {
    if (!this.client) throw new Error('OpenCode managed server is not running');
    return this.client;
  }

  private async buildInvocationConfig(
    sessionId: string,
    mcpToken?: string,
    _branchPath?: string
  ): Promise<InvocationConfig> {
    if (!mcpToken) {
      throw new Error('OpenCode requires the built-in Agor MCP token');
    }
    if (!this.sessionMCPRepo || !this.mcpServerRepo) {
      throw new Error('OpenCode requires MCP repository dependencies');
    }
    const mcp: Record<string, unknown> = {};
    mcp[`agor_${shortId(sessionId)}`] = {
      type: 'remote',
      url: `${await getDaemonUrl()}/mcp`,
      enabled: true,
      headers: { Authorization: `Bearer ${mcpToken}` },
    };

    const servers = await getMcpServersForSession(sessionId as SessionID, {
      mode: 'strict',
      sessionMCPRepo: this.sessionMCPRepo,
      mcpServerRepo: this.mcpServerRepo,
      mcpOAuthAuthHeadersRepo: this.mcpOAuthAuthHeadersRepo,
    });

    for (const { server } of servers) {
      const sanitizedName = server.name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
      const name = `agor_${shortId(sessionId)}_${shortId(server.mcp_server_id)}_${sanitizedName}`;
      if (server.transport === 'stdio') {
        if (!server.command) {
          throw new Error(`Attached MCP server ${server.name} is missing its command`);
        }
        mcp[name] = {
          type: 'local',
          command: [server.command, ...(server.args || [])],
          environment: (server.env as Record<string, string>) ?? {},
          enabled: true,
        };
      } else if (server.transport === 'http' || server.transport === 'sse') {
        if (!server.url) {
          throw new Error(`Attached MCP server ${server.name} is missing its URL`);
        }
        let authHeaders: Record<string, string> | undefined;
        try {
          authHeaders = await resolveMCPAuthHeaders(server.auth, server.url);
        } catch {
          throw new Error(`Attached MCP server ${server.name} authentication failed`);
        }
        const authorization = Object.entries(authHeaders ?? {}).find(
          ([name]) => name.toLowerCase() === 'authorization'
        )?.[1];
        if (
          server.auth &&
          server.auth.type !== 'none' &&
          !/^Bearer\s+\S+$/i.test(authorization?.trim() ?? '')
        ) {
          throw new Error(
            `Attached MCP server ${server.name} did not resolve a usable Authorization header`
          );
        }
        const headers = mergeMCPRemoteHeaders({ custom: server.headers, auth: authHeaders });
        mcp[name] = {
          type: 'remote',
          url: server.url,
          enabled: true,
          headers,
        };
      } else {
        throw new Error(
          `Attached MCP server ${server.name} uses unsupported transport ${server.transport}`
        );
      }
    }
    return { mcp, permission: AGOR_PERMISSION_INTERCEPTION };
  }

  /** Create a new OpenCode session on the managed runtime. */
  private async createSession(config: CreateSessionConfig): Promise<SessionHandle> {
    const client = this.getClientForDirectory(config.workingDirectory);
    const response = await client.session.create({
      body: { title: String(config.title || 'Agor Session') },
      query: config.workingDirectory ? { directory: config.workingDirectory } : undefined,
    });
    if (response.error) throw new Error('OpenCode failed to create a session');
    if (!response.data) throw new Error('OpenCode returned no session data');
    return { sessionId: response.data.id, toolType: 'opencode' };
  }

  private async executeTask(
    input: RunOpenCodeTurnInput,
    context: SessionContext,
    streamingCallbacks: StreamingCallbacks | undefined,
    registerStopEventCollector: (stop: () => Promise<void>) => void,
    sanitizer: TurnSanitizer
  ): Promise<OpenCodeTurnResult['finalMessage']> {
    const client = this.getClientForDirectory(context.branchPath);
    const request = {
      path: { id: context.opencodeSessionId },
      signal: input.signal,
      body: {
        agent: AGOR_MANAGED_AGENT,
        parts: [{ type: 'text' as const, text: input.prompt }],
        ...(context.model && context.provider
          ? { model: { providerID: context.provider, modelID: context.model } }
          : {}),
      },
      query: context.branchPath ? { directory: context.branchPath } : undefined,
    };
    const transcriptRequest = {
      path: { id: context.opencodeSessionId },
      query: context.branchPath ? { directory: context.branchPath } : undefined,
    };

    const collectorController = new AbortController();
    let subscription: Awaited<ReturnType<OpenCodeClient['event']['subscribe']>> | undefined;
    let collector: Promise<void> | undefined;
    let collectorStopPromise: Promise<void> | undefined;
    const stopEventCollector = () => {
      collectorStopPromise ??= (async () => {
        collectorController.abort(input.signal.reason);
        if (subscription) await subscription.stream.return?.(undefined);
        if (collector) await collector;
      })();
      return collectorStopPromise;
    };
    registerStopEventCollector(stopEventCollector);

    const baselineResponse = await client.session.messages(transcriptRequest);
    if (baselineResponse.error || !Array.isArray(baselineResponse.data)) {
      throw new Error('OpenCode failed to capture the pre-turn message baseline');
    }
    const baselineMessageIds = new Set(
      baselineResponse.data.flatMap((entry) =>
        entry?.info && typeof entry.info.id === 'string' ? [entry.info.id] : []
      )
    );

    if (input.signal.aborted) throw new Error('OpenCode turn was aborted before event collection');
    let protocolError: Error | undefined;
    let terminalSettled = false;
    let settleTerminal!: (result: { error?: Error }) => void;
    const terminal = new Promise<{ error?: Error }>((resolve) => {
      settleTerminal = resolve;
    });
    let textStarted = false;
    let thinkingStarted = false;
    let sequence = 0;
    const canUseTool =
      this.permissionService &&
      this.messagesRepo &&
      this.messagesService &&
      this.tasksService &&
      this.sessionsService &&
      this.sessionMCPRepo &&
      this.mcpServerRepo
        ? createCanUseToolCallback(input.agorSessionId, input.taskId, {
            permissionService: this.permissionService,
            tasksService: this.tasksService,
            messagesRepo: this.messagesRepo,
            messagesService: this.messagesService,
            sessionsService: this.sessionsService,
            permissionLocks: this.permissionLocks,
            mcpServerRepo: this.mcpServerRepo,
            sessionMCPRepo: this.sessionMCPRepo,
            deferDeniedTerminalState: true,
          })
        : undefined;

    const settle = (error?: Error) => {
      if (terminalSettled) return;
      terminalSettled = true;
      settleTerminal({ error });
    };
    const settleAbort = () => settle(new Error('OpenCode turn was aborted'));
    input.signal.addEventListener('abort', settleAbort, { once: true });
    if (input.signal.aborted) settleAbort();

    const applyEffects = async (effects: OpenCodeEventEffect[]) => {
      for (const effect of effects) {
        switch (effect.type) {
          case 'text-delta':
            if (!streamingCallbacks) break;
            if (!textStarted) {
              textStarted = true;
              await streamingCallbacks.onStreamStart(input.agorAssistantMessageId, {
                session_id: input.agorSessionId,
                task_id: input.taskId,
                role: 'assistant',
                timestamp: new Date().toISOString(),
              });
            }
            await streamingCallbacks.onStreamChunk(
              input.agorAssistantMessageId,
              effect.delta,
              sequence++
            );
            break;
          case 'reasoning-delta':
            if (!streamingCallbacks?.onThinkingChunk) break;
            if (!thinkingStarted) {
              thinkingStarted = true;
              await streamingCallbacks.onThinkingStart?.(input.agorAssistantMessageId, {});
            }
            await streamingCallbacks.onThinkingChunk(input.agorAssistantMessageId, effect.delta);
            break;
          case 'tool-activity':
            streamingCallbacks?.onPulse?.('progress', `opencode_tool_${effect.status}`);
            break;
          case 'permission':
            streamingCallbacks?.onPulse?.('waiting', 'permission.request');
            {
              let response: 'once' | 'always' | 'reject' = 'reject';
              let handledByAgor = false;
              if (canUseTool) {
                if (
                  automaticallyAllowsOpenCodePermission(
                    input.permissionMode,
                    effect.request.permission
                  )
                ) {
                  response = 'once';
                } else {
                  handledByAgor = true;
                  const decision = await canUseTool(
                    effect.request.permission,
                    { ...effect.request.metadata, patterns: effect.request.patterns },
                    { signal: input.signal }
                  );
                  if (decision.behavior === 'allow') {
                    const remembered = decision.updatedPermissions?.some(
                      (update) => update.destination !== 'session'
                    );
                    response = remembered && effect.request.patterns.length > 0 ? 'always' : 'once';
                  }
                }
              }
              const reply = await client.postSessionIdPermissionsPermissionId({
                path: {
                  id: context.opencodeSessionId,
                  permissionID: effect.request.id,
                },
                query: context.branchPath ? { directory: context.branchPath } : undefined,
                body: { response },
              });
              if (reply.error) throw new Error('OpenCode failed to apply the permission decision');
              if (response === 'reject') {
                throw handledByAgor
                  ? new OpenCodePermissionRejectedError('OpenCode permission was rejected')
                  : new Error('OpenCode permission was rejected');
              }
            }
            break;
          case 'idle':
            settle();
            break;
          case 'error':
            protocolError = new Error(`OpenCode session failed: ${sanitizer.text(effect.message)}`);
            settle(protocolError);
            break;
        }
      }
    };

    try {
      subscription = await client.event.subscribe({
        query: context.branchPath ? { directory: context.branchPath } : undefined,
        signal: collectorController.signal,
      });
      const translator = createOpenCodeEventTranslator({
        sessionId: context.opencodeSessionId,
        baselineMessageIds,
      });
      const iterator = asUnknownAsyncIterable(subscription.stream)[Symbol.asyncIterator]();
      collector = (async () => {
        try {
          for (;;) {
            const next = await iterator.next();
            if (next.done) {
              if (!terminalSettled && !collectorController.signal.aborted) {
                settle(
                  new Error('OpenCode event stream closed before the active turn became idle')
                );
              }
              return;
            }
            await applyEffects(translator.translate(next.value));
          }
        } catch (error) {
          if (!collectorController.signal.aborted) {
            protocolError = error instanceof Error ? error : new Error(String(error));
            settle(protocolError);
          }
        }
      })();

      const promptResponse = await client.session.prompt(request);
      if (promptResponse.error) throw new Error('OpenCode prompt failed');

      const terminalResult = await terminal;
      if (terminalResult.error) throw terminalResult.error;

      await new Promise((resolve) => setTimeout(resolve, this.dependencies.eventDrainMs));
      await this.settleWithinOrThrow(
        stopEventCollector(),
        this.dependencies.shutdownTimeoutMs,
        'OpenCode event collector did not settle within the shutdown timeout'
      );
      if (protocolError) throw protocolError;

      const finalResponse = await client.session.messages(transcriptRequest);
      if (finalResponse.error || !Array.isArray(finalResponse.data)) {
        throw new Error('OpenCode failed to fetch the authoritative completed transcript');
      }
      const finalMessage = reconcileOpenCodeMessages(finalResponse.data, {
        sessionId: context.opencodeSessionId,
        baselineMessageIds,
      });
      enrichContentBlocks(finalMessage.contentBlocks);

      if (thinkingStarted) {
        await streamingCallbacks?.onThinkingEnd?.(input.agorAssistantMessageId);
      }
      if (textStarted) await streamingCallbacks?.onStreamEnd(input.agorAssistantMessageId);
      return finalMessage;
    } catch (error) {
      const failure = sanitizer.error(error);
      if (textStarted) {
        await streamingCallbacks?.onStreamError(input.agorAssistantMessageId, failure);
      }
      throw failure;
    } finally {
      input.signal.removeEventListener('abort', settleAbort);
      // The runTurn cleanup route owns collector, permission, session, and child shutdown.
    }
  }
}
