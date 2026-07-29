/**
 * OpenCode Tool Implementation
 *
 * Owns one authenticated, task-scoped OpenCode server and its SDK turn.
 * The handler calls only runTurn; protocol translation and reconciliation stay
 * behind this single runtime owner.
 */

import type { SpawnOptions } from 'node:child_process';
import type { randomBytes as nodeRandomBytes } from 'node:crypto';
import { shortId } from '@agor/core';
import { OPENCODE_MODEL_CONFIG_PAIR_ERROR } from '@agor/core/models';
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
  MessagesService,
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
import {
  createOpenCodeSanitizer,
  type ManagedChild,
  type ManagedOpenCodeServer,
  type OpenCodeSanitizer,
  resolvePackagedOpenCodeBinary,
  startManagedOpenCodeServer,
} from './managed-server.js';

export { resolvePackagedOpenCodeBinary };

const DEFAULT_READINESS_TIMEOUT_MS = 10_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 2_000;
const DEFAULT_EVENT_DRAIN_MS = 10;
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
  dataHome?: string;
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
  fetch?: typeof globalThis.fetch;
  readinessTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  eventDrainMs?: number;
};

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

/**
 * Session context for an Agor session mapped to OpenCode
 */
interface TurnContext {
  opencodeSessionId: string;
  model: string;
  provider: string;
  /** Branch directory path for project-scoped operations. */
  branchPath: string;
}

export class OpenCodeTool {
  private readonly dependencies: Pick<
    OpenCodeToolDependencies,
    'resolveBinary' | 'spawn' | 'randomBytes' | 'fetch'
  > & {
    createClient: typeof createOpencodeClient;
    resolveInvocationConfig: (input: RunOpenCodeTurnInput) => Promise<InvocationConfig>;
    readinessTimeoutMs: number;
    shutdownTimeoutMs: number;
    eventDrainMs: number;
  };
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
      resolveBinary: dependencies.resolveBinary,
      spawn: dependencies.spawn,
      createClient: dependencies.createClient ?? createOpencodeClient,
      resolveInvocationConfig:
        dependencies.resolveInvocationConfig ??
        ((input) =>
          this.buildInvocationConfig(input.agorSessionId, input.mcpToken, input.directory)),
      randomBytes: dependencies.randomBytes,
      fetch: dependencies.fetch,
      readinessTimeoutMs: dependencies.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS,
      shutdownTimeoutMs: dependencies.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
      eventDrainMs: dependencies.eventDrainMs ?? DEFAULT_EVENT_DRAIN_MS,
    };
  }

  async runTurn(
    input: RunOpenCodeTurnInput,
    streamingCallbacks?: StreamingCallbacks
  ): Promise<OpenCodeTurnResult> {
    const provider = input.provider;
    const model = input.model;
    if (!provider?.trim() || !model?.trim()) {
      throw new Error(OPENCODE_MODEL_CONFIG_PAIR_ERROR);
    }
    const preliminarySanitizer = createOpenCodeSanitizer([
      input.mcpToken ?? '',
      input.dataHome ?? '',
    ]);
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
    let managedServer: ManagedOpenCodeServer;
    try {
      managedServer = await startManagedOpenCodeServer(
        {
          directory: input.directory,
          dataHome: input.dataHome,
          environment: {
            OPENCODE_CONFIG_CONTENT: configContent,
            // OpenCode resolves this dedicated runtime override when creating
            // session permission rules. Keep it alongside the config content so
            // permissive project/agent rules cannot bypass Agor interception.
            OPENCODE_PERMISSION: JSON.stringify(AGOR_PERMISSION_INTERCEPTION),
          },
          secrets: [input.mcpToken ?? '', configContent, invocationConfig],
        },
        {
          resolveBinary: this.dependencies.resolveBinary,
          spawn: this.dependencies.spawn,
          randomBytes: this.dependencies.randomBytes,
          fetch: this.dependencies.fetch,
          readinessTimeoutMs: this.dependencies.readinessTimeoutMs,
          shutdownTimeoutMs: this.dependencies.shutdownTimeoutMs,
        }
      );
    } catch (error) {
      this.permissionService?.cancelPendingRequests(input.agorSessionId);
      throw preliminarySanitizer.error(error);
    }
    const { authorization, baseUrl, close, sanitizer } = managedServer;
    let client: OpenCodeClient | undefined;
    let activeOpenCodeSessionId: string | undefined;
    let stopEventCollector = async () => {};
    let turnCompleted = false;
    let cleanupPromise: Promise<void> | undefined;
    const cleanup = () => {
      cleanupPromise ??= (async () => {
        if (!turnCompleted) {
          await this.settlesWithin(
            this.abortActiveSession(client, activeOpenCodeSessionId, input.directory),
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
      client = this.dependencies.createClient({
        baseUrl,
        directory: input.directory,
        headers: { Authorization: authorization },
      });
      await this.assertExplicitModelAvailable(client, input.directory, provider, model);

      let openCodeSessionId = input.existingOpenCodeSessionId;
      let sessionWasCreated = false;
      if (openCodeSessionId) {
        const response = await client.session.get({
          path: { id: openCodeSessionId },
          query: { directory: input.directory },
        });
        if (response.error || !response.data || response.data.id !== openCodeSessionId) {
          throw new Error(
            `Unable to resume stored OpenCode session ${openCodeSessionId}; verify that its state is available under the executor identity`
          );
        }
      } else {
        openCodeSessionId = await this.createSession(client, input.title, input.directory);
        sessionWasCreated = true;
        await input.persistOpenCodeSessionId(openCodeSessionId);
      }

      activeOpenCodeSessionId = openCodeSessionId;
      if (input.signal.aborted)
        throw new Error('OpenCode turn was aborted before prompt submission');
      const finalMessage = await this.executeTask(
        client,
        input,
        {
          opencodeSessionId: openCodeSessionId,
          model,
          provider,
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

    if (turnFailure) throw turnFailure;
    if (!outcome) throw new Error('OpenCode turn ended without a result');
    return outcome;
  }

  private async abortActiveSession(
    client: OpenCodeClient | undefined,
    openCodeSessionId: string | undefined,
    directory: string
  ): Promise<void> {
    if (!client || !openCodeSessionId) return;
    try {
      await client.session.abort({
        path: { id: openCodeSessionId },
        query: { directory },
      });
    } catch {
      // Local child cleanup remains authoritative.
    }
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
   * Admit the required exact pair against the configured catalog on this
   * task's already-running server.
   */
  private async assertExplicitModelAvailable(
    client: OpenCodeClient,
    directory: string,
    providerId: string,
    modelId: string
  ): Promise<void> {
    let available = false;
    try {
      const query = { directory };
      const [catalogResponse, runtimeResponse] = await Promise.all([
        client.config.providers({ query }),
        client.provider.list({ query }),
      ]);
      const provider = catalogResponse.data?.providers.find((entry) => entry.id === providerId);
      available =
        !catalogResponse.error &&
        !runtimeResponse.error &&
        Boolean(runtimeResponse.data?.connected.includes(providerId)) &&
        Boolean(
          provider &&
            Object.entries(provider.models).some(
              ([candidateId, model]) => candidateId === modelId || model.id === modelId
            )
        );
    } catch {
      // Public failure stays independent of raw provider objects and SDK details.
    }
    if (!available) {
      throw new Error(
        'The selected OpenCode provider/model is not available for this session owner and branch configuration; refresh configured models or enter an available exact pair'
      );
    }
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

  /** Create a new OpenCode session on the invocation's managed runtime. */
  private async createSession(
    client: OpenCodeClient,
    title: string,
    directory: string
  ): Promise<string> {
    const response = await client.session.create({
      body: { title: title || 'Agor Session' },
      query: { directory },
    });
    if (response.error) throw new Error('OpenCode failed to create a session');
    if (!response.data) throw new Error('OpenCode returned no session data');
    return response.data.id;
  }

  private async executeTask(
    client: OpenCodeClient,
    input: RunOpenCodeTurnInput,
    context: TurnContext,
    streamingCallbacks: StreamingCallbacks | undefined,
    registerStopEventCollector: (stop: () => Promise<void>) => void,
    sanitizer: OpenCodeSanitizer
  ): Promise<OpenCodeTurnResult['finalMessage']> {
    const promptFailure = (): Error =>
      new Error(
        `OpenCode prompt failed for ${context.provider}/${context.model}. Reconnect ${context.provider} in OpenCode settings or choose another provider/model.`
      );
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
            protocolError = promptFailure();
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
      if (promptResponse.error) throw promptFailure();

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
