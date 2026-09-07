/**
 * OpenCode Tool Implementation
 *
 * Owns one authenticated, task-scoped OpenCode server and its SDK turn.
 * The handler calls only runTurn; protocol translation and reconciliation stay
 * behind this single runtime owner.
 */

import type { SpawnOptions } from 'node:child_process';
import type { randomBytes as nodeRandomBytes } from 'node:crypto';
import { renderAgorSystemPrompt } from '@agor/core/templates/session-context';
import { mergeMCPRemoteHeaders } from '@agor/core/tools/mcp/http-headers';
import { resolveMCPAuthHeaders } from '@agor/core/tools/mcp/jwt-auth';
import {
  type ContentBlock,
  type EffortLevel,
  type ExecutorPulseKind,
  type MCPServer,
  type MessageID,
  type PermissionMode,
  type SessionID,
  shortId,
  type TaskID,
  type ToolPermission,
  type ToolUse,
} from '@agor/core/types';
import type { createOpencodeClient } from '@opencode-ai/sdk';
import { isKnownActiveOpenCodeModel, OPENCODE_MODEL_CONFIG_PAIR_ERROR } from '../shared/index.js';
import type { OpenCodeCommand } from './binary.js';
import {
  createOpenCodeEventTranslator,
  type OpenCodeEventEffect,
  reconcileOpenCodeMessages,
} from './event-translator.js';
import {
  createOpenCodeSanitizer,
  isOpenCodeCleanupUnverifiedError,
  type ManagedChild,
  type ManagedOpenCodeServer,
  OpenCodeCleanupUnverifiedError,
  type OpenCodeSanitizer,
  refreshOpenCodeModels,
  resolvePackagedOpenCodeBinary,
  startManagedOpenCodeServer,
} from './managed-server.js';
import { loadOpenCodeSdk } from './sdk-loader.js';

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
  task: 'deny',
  external_directory: 'ask',
  todowrite: 'ask',
  question: 'deny',
  webfetch: 'ask',
  websearch: 'ask',
  lsp: 'ask',
  doom_loop: 'ask',
  skill: 'ask',
} as const;
const AGOR_MANAGED_AGENT = 'agor-managed';

type OpenCodeClient = ReturnType<typeof createOpencodeClient>;

export class OpenCodePermissionRejectedError extends Error {
  override name = 'OpenCodePermissionRejectedError';
}
export class OpenCodeInteractionTimeoutError extends Error {
  override name = 'OpenCodeInteractionTimeoutError';
}

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
  effort?: EffortLevel;
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

export type OpenCodeInvocationConfig = {
  mcp: Record<string, unknown>;
  permission?: Record<string, 'ask' | 'allow' | 'deny'>;
  tools?: Record<string, boolean>;
  /**
   * Gated MCP tools, keyed by the name OpenCode will report them under. Built
   * alongside the `mcp` block above so the keys cannot disagree with it.
   */
  mcpToolPermissions?: ReadonlyMap<string, ToolPermission>;
  [key: string]: unknown;
};

export interface OpenCodeStreamingCallbacks {
  onPulse?(kind: ExecutorPulseKind, detail?: string): void;
  onStreamStart(
    messageId: MessageID,
    metadata: {
      session_id: SessionID;
      task_id?: TaskID;
      role: string;
      timestamp: string;
    }
  ): Promise<void>;
  onStreamChunk(messageId: MessageID, chunk: string, sequence?: number): Promise<void>;
  onStreamEnd(messageId: MessageID): Promise<void>;
  onStreamError(messageId: MessageID, error: Error): Promise<void>;
  onThinkingStart?(messageId: MessageID, metadata: { budget?: number }): Promise<void>;
  onThinkingChunk?(messageId: MessageID, chunk: string): Promise<void>;
  onThinkingEnd?(messageId: MessageID): Promise<void>;
}

export type OpenCodeCanUseToolCallback = (
  toolName: string,
  toolInput: Record<string, unknown>,
  options: { signal: AbortSignal; suggestions?: Array<Record<string, unknown>> }
) => Promise<{
  behavior: 'allow' | 'deny';
  updatedInput?: Record<string, unknown>;
  updatedPermissions?: Array<{
    type: 'addRules';
    rules: Array<{ toolName: string }>;
    behavior: 'allow';
    destination: 'session' | 'projectSettings' | 'userSettings' | 'localSettings';
  }>;
  message?: string;
  timedOut?: boolean;
}>;

export type OpenCodeToolDependencies = {
  resolveBinary?: () => Promise<string | OpenCodeCommand>;
  spawn?: (executable: string, args: readonly string[], options: SpawnOptions) => ManagedChild;
  createClient?: typeof createOpencodeClient;
  resolveInvocationConfig?: (input: RunOpenCodeTurnInput) => Promise<OpenCodeInvocationConfig>;
  resolveMcpServers?: (
    sessionId: SessionID
  ) => Promise<Array<{ server: MCPServer; source: 'session-assigned' | 'global' }>>;
  getDaemonUrl?: () => Promise<string>;
  createPermissionCallback?: (
    sessionId: SessionID,
    taskId: TaskID
  ) => OpenCodeCanUseToolCallback | undefined;
  cancelPendingPermissions?: (sessionId: SessionID) => void;
  enrichContentBlocks?: (blocks: ContentBlock[]) => void;
  randomBytes?: typeof nodeRandomBytes;
  fetch?: typeof globalThis.fetch;
  readinessTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  eventDrainMs?: number;
  modelRefreshTimeoutMs?: number;
  startManagedServer?: typeof startManagedOpenCodeServer;
  refreshModels?: typeof refreshOpenCodeModels;
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
  /**
   * OpenCode tool key → configured permission, for gated MCP tools only.
   * Absent when nothing is gated. See `buildOpenCodeMcpToolPermissions`.
   */
  mcpToolPermissions?: ReadonlyMap<string, ToolPermission>;
}

type ExplicitModelAvailability = 'available' | 'curated-refresh-required';

/**
 * The alphabet OpenCode rewrites a name into before using it as a tool key.
 * Matches `CP` in the shipped binary exactly; a character we leave in but it
 * rewrites would make a lookup miss, and a miss reads as "unconfigured".
 */
const sanitizeToOpenCodeToolKey = (name: string) => name.replace(/[^a-zA-Z0-9_-]/g, '_');

/**
 * The config key Agor registers an MCP server under.
 *
 * Shared with `buildOpenCodeMcpToolPermissions` on purpose: the permission
 * lookup below is only exact because Agor mints this name itself, so the two
 * must never be able to drift apart.
 */
export function openCodeMcpServerKey(sessionId: string, server: MCPServer): string {
  const sanitized = server.name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  return `agor_${shortId(sessionId)}_${shortId(server.mcp_server_id)}_${sanitized}`;
}

/**
 * Map every configured tool to the exact key OpenCode will report it under.
 *
 * OpenCode registers MCP tools as `<server key>_<tool>`, both halves put
 * through its own sanitizer, and asks permission using that same string as the
 * permission *type* — `ask({permission: <tool key>})` on the tool-execute path.
 * Because Agor chooses the server key, the composed name is fully determined
 * here: there is nothing to parse back out, and the single-underscore join is
 * unambiguous in this direction. Hence a flat exact-match map rather than the
 * namespaced index the other handlers use.
 */
export function buildOpenCodeMcpToolPermissions(
  sessionId: string,
  servers: readonly { server: MCPServer }[]
): ReadonlyMap<string, ToolPermission> {
  const keys = new Map<string, ToolPermission>();
  for (const { server } of servers) {
    const serverKey = sanitizeToOpenCodeToolKey(openCodeMcpServerKey(sessionId, server));
    for (const [toolName, permission] of Object.entries(server.tool_permissions ?? {})) {
      keys.set(`${serverKey}_${sanitizeToOpenCodeToolKey(toolName)}`, permission);
    }
  }
  return keys;
}

/**
 * Whether `tool_permissions` alone refuses this call, and on which setting.
 *
 * Split out so the decision is reachable without standing up a turn, because
 * the surrounding function is where it is easy to get wrong. It has to run
 * BEFORE `automaticallyAllowsOpenCodePermission`: that shortcut answers
 * `once` without ever calling `canUseTool`, so a gate placed after it is
 * skipped under `bypassPermissions`, `allow-all` and `yolo` — the modes where
 * nothing else is watching.
 *
 * `ask` needs somewhere to ask. Where the mode would auto-allow, or no
 * approval callback exists at all, it collapses onto `deny` rather than
 * degrading into `allow` — the same rule the headless handlers apply.
 */
export function blockedByOpenCodeToolPermissions(input: {
  configured: ToolPermission | undefined;
  modeWouldAutoAllow: boolean;
  hasApprovalChannel: boolean;
}): ToolPermission | undefined {
  const { configured, modeWouldAutoAllow, hasApprovalChannel } = input;
  if (configured === 'deny') return 'deny';
  if (configured === 'ask' && (modeWouldAutoAllow || !hasApprovalChannel)) return 'ask';
  return undefined;
}

type OpenCodePermissionEffect = Extract<OpenCodeEventEffect, { type: 'permission' }>;

async function applyPermissionEffect(input: {
  client: OpenCodeClient;
  turn: RunOpenCodeTurnInput;
  context: TurnContext;
  effect: OpenCodePermissionEffect;
  canUseTool?: OpenCodeCanUseToolCallback;
}): Promise<void> {
  const { client, turn, context, effect, canUseTool } = input;
  let response: 'once' | 'always' | 'reject' = 'reject';
  let handledByAgor = false;
  let interactionTimedOut = false;

  // `tool_permissions` is resolved before anything else can answer.
  const configuredToolPermission = context.mcpToolPermissions?.get(effect.request.permission);
  const modeWouldAutoAllow = automaticallyAllowsOpenCodePermission(
    turn.permissionMode,
    effect.request.permission
  );
  const blocking = blockedByOpenCodeToolPermissions({
    configured: configuredToolPermission,
    modeWouldAutoAllow,
    hasApprovalChannel: Boolean(canUseTool),
  });

  if (blocking) {
    console.warn(
      `🛑 [OpenCode] MCP tool "${effect.request.permission}" blocked by tool_permissions (${blocking})`
    );
    handledByAgor = true;
    response = 'reject';
  } else if (effect.request.permission === 'question' || effect.request.permission === 'task') {
    handledByAgor = true;
  } else if (canUseTool) {
    // An `ask` tool must reach the prompt rather than be waved through by the
    // session's permission mode.
    if (modeWouldAutoAllow && configuredToolPermission !== 'ask') {
      response = 'once';
    } else {
      handledByAgor = true;
      const decision = await canUseTool(
        effect.request.permission,
        { ...effect.request.metadata, patterns: effect.request.patterns },
        { signal: turn.signal }
      );
      if (decision.behavior === 'allow') {
        const remembered = decision.updatedPermissions?.some(
          (update) => update.destination !== 'session'
        );
        response = remembered && effect.request.patterns.length > 0 ? 'always' : 'once';
      }
      interactionTimedOut = decision.timedOut === true;
    }
  }

  const reply = await client.postSessionIdPermissionsPermissionId({
    path: {
      id: context.opencodeSessionId,
      permissionID: effect.request.id,
    },
    query: { directory: context.branchPath },
    body: { response },
  });
  if (reply.error) throw new Error('OpenCode failed to apply the permission decision');
  if (response === 'reject') {
    if (interactionTimedOut) {
      throw new OpenCodeInteractionTimeoutError('OpenCode permission request timed out');
    }
    throw handledByAgor
      ? new OpenCodePermissionRejectedError('OpenCode permission was rejected')
      : new Error('OpenCode permission was rejected');
  }
}

function createOpenCodeEffectConsumer(input: {
  client: OpenCodeClient;
  turn: RunOpenCodeTurnInput;
  context: TurnContext;
  streamingCallbacks?: OpenCodeStreamingCallbacks;
  canUseTool?: OpenCodeCanUseToolCallback;
  settle: (error?: Error) => void;
  promptFailure: () => Error;
}) {
  let textStarted = false;
  let thinkingStarted = false;
  let sequence = 0;

  return {
    get textStarted() {
      return textStarted;
    },
    get thinkingStarted() {
      return thinkingStarted;
    },
    async apply(effects: OpenCodeEventEffect[]): Promise<void> {
      for (const effect of effects) {
        switch (effect.type) {
          case 'text-delta':
            input.streamingCallbacks?.onPulse?.('progress', 'message.text_delta');
            if (!input.streamingCallbacks) break;
            if (!textStarted) {
              textStarted = true;
              await input.streamingCallbacks.onStreamStart(input.turn.agorAssistantMessageId, {
                session_id: input.turn.agorSessionId,
                task_id: input.turn.taskId,
                role: 'assistant',
                timestamp: new Date().toISOString(),
              });
            }
            await input.streamingCallbacks.onStreamChunk(
              input.turn.agorAssistantMessageId,
              effect.delta,
              sequence++
            );
            break;
          case 'reasoning-delta':
            input.streamingCallbacks?.onPulse?.('progress', 'message.reasoning_delta');
            if (!input.streamingCallbacks?.onThinkingChunk) break;
            if (!thinkingStarted) {
              thinkingStarted = true;
              await input.streamingCallbacks.onThinkingStart?.(
                input.turn.agorAssistantMessageId,
                {}
              );
            }
            await input.streamingCallbacks.onThinkingChunk(
              input.turn.agorAssistantMessageId,
              effect.delta
            );
            break;
          case 'tool-activity':
            input.streamingCallbacks?.onPulse?.(
              'progress',
              effect.status === 'completed' || effect.status === 'error'
                ? 'tool.complete'
                : effect.status === 'pending' || effect.status === 'running'
                  ? 'tool.start'
                  : 'tool.update'
            );
            break;
          case 'permission':
            input.streamingCallbacks?.onPulse?.('waiting', 'permission.request');
            await applyPermissionEffect({
              client: input.client,
              turn: input.turn,
              context: input.context,
              effect,
              canUseTool: input.canUseTool,
            });
            break;
          case 'runtime-activity':
            input.streamingCallbacks?.onPulse?.('sdk_started', effect.detail);
            break;
          case 'unknown-activity':
            input.streamingCallbacks?.onPulse?.('unknown_activity', 'unknown.event');
            break;
          case 'idle':
            input.settle();
            break;
          case 'error':
            input.settle(input.promptFailure());
            break;
        }
      }
    },
  };
}

async function loadOpenCodeMessageBaseline(
  client: OpenCodeClient,
  request: Parameters<OpenCodeClient['session']['messages']>[0]
): Promise<Set<string>> {
  const response = await client.session.messages(request);
  if (('error' in response && response.error) || !Array.isArray(response.data)) {
    throw new Error('OpenCode failed to capture the pre-turn message baseline');
  }
  return new Set(
    response.data.flatMap((entry) =>
      entry?.info && typeof entry.info.id === 'string' ? [entry.info.id] : []
    )
  );
}

function createOpenCodeEventCollector(input: {
  client: OpenCodeClient;
  context: TurnContext;
  signal: AbortSignal;
  baselineMessageIds: Set<string>;
  applyEffects: (effects: OpenCodeEventEffect[]) => Promise<void>;
  isTerminalSettled: () => boolean;
  settle: (error: Error) => void;
}) {
  const controller = new AbortController();
  let subscription: Awaited<ReturnType<OpenCodeClient['event']['subscribe']>> | undefined;
  let collector: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;

  const stop = () => {
    stopPromise ??= (async () => {
      controller.abort(input.signal.reason);
      if (subscription) await subscription.stream.return?.(undefined);
      if (collector) await collector;
    })();
    return stopPromise;
  };
  const start = async () => {
    subscription = await input.client.event.subscribe({
      query: input.context.branchPath ? { directory: input.context.branchPath } : undefined,
      signal: controller.signal,
    });
    const translator = createOpenCodeEventTranslator({
      sessionId: input.context.opencodeSessionId,
      baselineMessageIds: input.baselineMessageIds,
    });
    const iterator = asUnknownAsyncIterable(subscription.stream)[Symbol.asyncIterator]();
    collector = (async () => {
      try {
        for (;;) {
          const next = await iterator.next();
          if (next.done) {
            if (!input.isTerminalSettled() && !controller.signal.aborted) {
              input.settle(
                new Error('OpenCode event stream closed before the active turn became idle')
              );
            }
            return;
          }
          await input.applyEffects(translator.translate(next.value));
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          input.settle(error instanceof Error ? error : new Error(String(error)));
        }
      }
    })();
  };

  return { start, stop };
}

export class OpenCodeTool {
  private readonly dependencies: Pick<
    OpenCodeToolDependencies,
    | 'resolveBinary'
    | 'spawn'
    | 'randomBytes'
    | 'fetch'
    | 'createPermissionCallback'
    | 'cancelPendingPermissions'
    | 'enrichContentBlocks'
  > & {
    createClient?: typeof createOpencodeClient;
    resolveInvocationConfig: (input: RunOpenCodeTurnInput) => Promise<OpenCodeInvocationConfig>;
    resolveMcpServers: NonNullable<OpenCodeToolDependencies['resolveMcpServers']>;
    getDaemonUrl: NonNullable<OpenCodeToolDependencies['getDaemonUrl']>;
    readinessTimeoutMs: number;
    shutdownTimeoutMs: number;
    eventDrainMs: number;
    modelRefreshTimeoutMs: number;
    startManagedServer: typeof startManagedOpenCodeServer;
    refreshModels: typeof refreshOpenCodeModels;
  };

  constructor(dependencies: OpenCodeToolDependencies) {
    this.dependencies = {
      resolveBinary: dependencies.resolveBinary,
      spawn: dependencies.spawn,
      createClient: dependencies.createClient,
      resolveInvocationConfig:
        dependencies.resolveInvocationConfig ??
        ((input) =>
          this.buildInvocationConfig(input.agorSessionId, input.mcpToken, input.directory)),
      resolveMcpServers:
        dependencies.resolveMcpServers ??
        (async () => {
          throw new Error('OpenCode requires an MCP server resolver');
        }),
      getDaemonUrl:
        dependencies.getDaemonUrl ??
        (async () => {
          throw new Error('OpenCode requires the daemon URL');
        }),
      createPermissionCallback: dependencies.createPermissionCallback,
      cancelPendingPermissions: dependencies.cancelPendingPermissions,
      enrichContentBlocks: dependencies.enrichContentBlocks,
      randomBytes: dependencies.randomBytes,
      fetch: dependencies.fetch,
      readinessTimeoutMs: dependencies.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS,
      shutdownTimeoutMs: dependencies.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
      eventDrainMs: dependencies.eventDrainMs ?? DEFAULT_EVENT_DRAIN_MS,
      modelRefreshTimeoutMs: dependencies.modelRefreshTimeoutMs ?? 15_000,
      startManagedServer: dependencies.startManagedServer ?? startManagedOpenCodeServer,
      refreshModels: dependencies.refreshModels ?? refreshOpenCodeModels,
    };
  }

  private createPermissionCallback(
    sessionId: SessionID,
    taskId: TaskID
  ): OpenCodeCanUseToolCallback | undefined {
    return this.dependencies.createPermissionCallback?.(sessionId, taskId);
  }

  private protectedInvocationConfig(resolved: OpenCodeInvocationConfig): OpenCodeInvocationConfig {
    // `mcpToolPermissions` is Agor-side state read by `applyPermissionEffect`;
    // this return value is serialised into OPENCODE_CONFIG_CONTENT, which the
    // OpenCode process parses. Dropping it here keeps a key OpenCode has no
    // schema for out of its config — and a Map would serialise to `{}` anyway,
    // so leaving it in would be a confusing no-op rather than a useful one.
    const { mcpToolPermissions: _agorOnly, ...serialisable } = resolved;
    resolved = serialisable as OpenCodeInvocationConfig;
    const configuredAgents =
      typeof resolved.agent === 'object' && resolved.agent !== null
        ? (resolved.agent as Record<string, unknown>)
        : {};
    const configuredManagedAgent = configuredAgents[AGOR_MANAGED_AGENT];
    const managedAgent =
      typeof configuredManagedAgent === 'object' && configuredManagedAgent !== null
        ? (configuredManagedAgent as Record<string, unknown>)
        : {};
    const managedAgentTools =
      typeof managedAgent.tools === 'object' && managedAgent.tools !== null
        ? managedAgent.tools
        : {};
    return {
      ...resolved,
      permission: AGOR_PERMISSION_INTERCEPTION,
      tools: { ...resolved.tools, question: false, task: false },
      agent: {
        ...configuredAgents,
        [AGOR_MANAGED_AGENT]: {
          ...managedAgent,
          mode: 'primary',
          tools: { ...managedAgentTools, question: false, task: false },
          permission: AGOR_PERMISSION_INTERCEPTION,
        },
      },
    };
  }

  private async resolveSession(
    client: OpenCodeClient,
    input: RunOpenCodeTurnInput
  ): Promise<{ openCodeSessionId: string; sessionWasCreated: boolean }> {
    if (!input.existingOpenCodeSessionId) {
      const openCodeSessionId = await this.createSession(client, input.title, input.directory);
      await input.persistOpenCodeSessionId(openCodeSessionId);
      return { openCodeSessionId, sessionWasCreated: true };
    }

    const openCodeSessionId = input.existingOpenCodeSessionId;
    const response = await client.session.get({
      path: { id: openCodeSessionId },
      query: { directory: input.directory },
    });
    if (response.error || !response.data || response.data.id !== openCodeSessionId) {
      throw new Error(
        `Unable to resume stored OpenCode session ${openCodeSessionId}; verify that its state is available under the executor identity`
      );
    }
    return { openCodeSessionId, sessionWasCreated: false };
  }

  async runTurn(
    input: RunOpenCodeTurnInput,
    streamingCallbacks?: OpenCodeStreamingCallbacks
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
    let resolvedInvocationConfig: OpenCodeInvocationConfig;
    try {
      resolvedInvocationConfig = await this.dependencies.resolveInvocationConfig(input);
    } catch (error) {
      throw preliminarySanitizer.error(error);
    }
    // OPENCODE_CONFIG_CONTENT is the highest-precedence, invocation-scoped
    // configuration. Force every interceptable permission through Agor even if
    // the repository's opencode.json contains permissive rules.
    const invocationConfig = this.protectedInvocationConfig(resolvedInvocationConfig);
    const configContent = JSON.stringify(invocationConfig);
    const managedServerInput = {
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
    };
    const managedServerDependencies = {
      resolveBinary: this.dependencies.resolveBinary,
      spawn: this.dependencies.spawn,
      randomBytes: this.dependencies.randomBytes,
      fetch: this.dependencies.fetch,
      readinessTimeoutMs: this.dependencies.readinessTimeoutMs,
      shutdownTimeoutMs: this.dependencies.shutdownTimeoutMs,
    };
    const lifecycleSanitizer = createOpenCodeSanitizer(
      [input.mcpToken ?? '', input.dataHome ?? '', configContent, invocationConfig],
      managedServerInput.environment
    );
    let managedServer: ManagedOpenCodeServer | undefined;
    let client: OpenCodeClient | undefined;
    try {
      const createClient =
        this.dependencies.createClient ?? (await loadOpenCodeSdk()).createOpencodeClient;
      managedServer = await this.dependencies.startManagedServer(
        managedServerInput,
        managedServerDependencies
      );
      client = createClient({
        baseUrl: managedServer.baseUrl,
        directory: input.directory,
        headers: { Authorization: managedServer.authorization },
      });

      const availability = await this.inspectExplicitModelAvailability(
        client,
        input.directory,
        provider,
        model,
        input.effort
      );
      if (availability === 'curated-refresh-required') {
        // The current process captured its provider database before the
        // models.dev refresh completed. It cannot safely execute the curated
        // pair, so close it before touching its private cache namespace.
        await managedServer.close();
        managedServer = undefined;
        client = undefined;
        if (input.signal.aborted) {
          throw new Error('OpenCode turn was aborted before model catalog refresh');
        }
        if (!input.dataHome) {
          throw this.explicitModelUnavailableError();
        }
        try {
          await this.dependencies.refreshModels(
            {
              directory: input.directory,
              providerId: provider,
              dataHome: input.dataHome,
              environment: managedServerInput.environment,
              secrets: managedServerInput.secrets,
              signal: input.signal,
            },
            {
              resolveBinary: this.dependencies.resolveBinary,
              spawn: this.dependencies.spawn,
              shutdownTimeoutMs: this.dependencies.shutdownTimeoutMs,
              refreshTimeoutMs: this.dependencies.modelRefreshTimeoutMs,
            }
          );
        } catch (error) {
          const refreshFailure = lifecycleSanitizer.error(error);
          if (isOpenCodeCleanupUnverifiedError(refreshFailure)) {
            throw new OpenCodeCleanupUnverifiedError(
              'OpenCode model catalog refresh cleanup could not be verified',
              { cause: refreshFailure }
            );
          }
          if (input.signal.aborted) {
            throw new Error('OpenCode turn was aborted during model catalog refresh', {
              cause: refreshFailure,
            });
          }
          throw new Error(
            'OpenCode could not refresh the selected provider/model catalog; retry discovery or choose another available exact pair',
            { cause: refreshFailure }
          );
        }
        if (input.signal.aborted) {
          throw new Error('OpenCode turn was aborted before model catalog reload');
        }
        try {
          managedServer = await this.dependencies.startManagedServer(
            managedServerInput,
            managedServerDependencies
          );
        } catch (error) {
          const restartFailure = lifecycleSanitizer.error(error);
          if (isOpenCodeCleanupUnverifiedError(restartFailure)) {
            throw new OpenCodeCleanupUnverifiedError(
              'OpenCode refreshed server startup cleanup could not be verified',
              { cause: restartFailure }
            );
          }
          throw new Error(
            'OpenCode could not reload the refreshed provider/model catalog; retry discovery or choose another available exact pair',
            { cause: restartFailure }
          );
        }
        client = createClient({
          baseUrl: managedServer.baseUrl,
          directory: input.directory,
          headers: { Authorization: managedServer.authorization },
        });
        await this.assertExplicitModelAvailable(
          client,
          input.directory,
          provider,
          model,
          input.effort
        );
      }
      if (input.signal.aborted) throw new Error('OpenCode turn was aborted before session setup');
    } catch (error) {
      this.dependencies.cancelPendingPermissions?.(input.agorSessionId);
      const startupFailure = lifecycleSanitizer.error(error);
      if (!managedServer) throw startupFailure;
      try {
        await managedServer.close();
      } catch (closeError) {
        throw lifecycleSanitizer.error(
          new OpenCodeCleanupUnverifiedError('OpenCode model setup cleanup could not be verified', {
            cause: new AggregateError(
              [startupFailure, closeError],
              'OpenCode model setup and cleanup both failed'
            ),
          })
        );
      }
      throw startupFailure;
    }
    if (!managedServer || !client) throw new Error('OpenCode model setup ended without a server');
    const { close, sanitizer } = managedServer;
    let activeOpenCodeSessionId: string | undefined;
    let stopEventCollector = async () => {};
    let turnCompleted = false;
    let cleanupPromise: Promise<void> | undefined;
    const cleanup = () => {
      cleanupPromise ??= (async () => {
        const activeSessionAbort = turnCompleted
          ? Promise.resolve()
          : this.settleWithinOrThrow(
              this.abortActiveSession(client, activeOpenCodeSessionId, input.directory),
              this.dependencies.shutdownTimeoutMs,
              'OpenCode active session abort did not settle within the shutdown timeout'
            );
        const collectorStop = this.settleWithinOrThrow(
          stopEventCollector(),
          this.dependencies.shutdownTimeoutMs,
          'OpenCode event collector did not settle within the shutdown timeout'
        );
        this.dependencies.cancelPendingPermissions?.(input.agorSessionId);
        await this.settleRuntimeCleanup(activeSessionAbort, collectorStop, close);
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
      const { openCodeSessionId, sessionWasCreated } = await this.resolveSession(client, input);

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
          mcpToolPermissions: resolvedInvocationConfig.mcpToolPermissions,
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
      turnFailure = sanitizer.error(
        new OpenCodeCleanupUnverifiedError(error instanceof Error ? error.message : String(error), {
          cause: error,
        })
      );
    }

    if (turnFailure) throw turnFailure;
    if (!outcome) throw new Error('OpenCode turn ended without a result');
    return outcome;
  }

  private async settleRuntimeCleanup(
    activeSessionAbort: Promise<void>,
    collectorStop: Promise<void>,
    close: () => Promise<void>
  ): Promise<void> {
    const collectorStopResult = Promise.allSettled([collectorStop]);
    // Keep the server reachable until its active session abort settles.
    // Child containment still starts without waiting for collector shutdown.
    const abortResults = await Promise.allSettled([activeSessionAbort]);
    const [collectorResults, closeResults] = await Promise.all([
      collectorStopResult,
      Promise.allSettled([close()]),
    ]);
    const failures = [...abortResults, ...collectorResults, ...closeResults].flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    );
    if (failures.length > 1) {
      throw new AggregateError(failures, 'OpenCode runtime cleanup failed in multiple phases');
    }
    if (failures.length === 1) throw failures[0];
  }

  private async abortActiveSession(
    client: OpenCodeClient | undefined,
    openCodeSessionId: string | undefined,
    directory: string
  ): Promise<void> {
    if (!client || !openCodeSessionId) return;
    try {
      const response = await client.session.abort({
        path: { id: openCodeSessionId },
        query: { directory },
      });
      if (response.error || response.data !== true) {
        throw new OpenCodeCleanupUnverifiedError(
          'OpenCode active session abort could not be verified',
          { cause: response.error }
        );
      }
    } catch (error) {
      if (error instanceof OpenCodeCleanupUnverifiedError) throw error;
      throw new OpenCodeCleanupUnverifiedError(
        'OpenCode active session abort could not be verified',
        { cause: error }
      );
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
   * Require the exact pair against the executing server's configured catalog.
   * Curated membership is intentionally not sufficient here.
   */
  private async assertExplicitModelAvailable(
    client: OpenCodeClient,
    directory: string,
    providerId: string,
    modelId: string,
    effort?: EffortLevel
  ): Promise<void> {
    const availability = await this.inspectExplicitModelAvailability(
      client,
      directory,
      providerId,
      modelId,
      effort
    );
    if (availability !== 'available') throw this.explicitModelUnavailableError();
  }

  private explicitModelUnavailableError(): Error {
    return new Error(
      'The selected OpenCode provider/model is not available for this session owner and branch configuration; retry discovery or enter an available exact pair'
    );
  }

  private async inspectExplicitModelAvailability(
    client: OpenCodeClient,
    directory: string,
    providerId: string,
    modelId: string,
    effort?: EffortLevel
  ): Promise<ExplicitModelAvailability> {
    let providerConnected = false;
    let selectedModel: { variants?: Record<string, unknown> } | undefined;
    let effortAvailable = !effort;
    try {
      const query = { directory };
      const [catalogResponse, runtimeResponse] = await Promise.all([
        client.config.providers({ query }),
        client.provider.list({ query }),
      ]);
      const provider = catalogResponse.data?.providers.find((entry) => entry.id === providerId);
      selectedModel = provider
        ? (Object.entries(provider.models).find(
            ([candidateId, model]) => candidateId === modelId || model.id === modelId
          )?.[1] as { variants?: Record<string, unknown> } | undefined)
        : undefined;
      providerConnected =
        !catalogResponse.error &&
        !runtimeResponse.error &&
        Boolean(runtimeResponse.data?.connected.includes(providerId));
      if (providerConnected && selectedModel && effort) {
        // OpenCode returns native variants here; the generated SDK model type currently omits them.
        const variants = selectedModel.variants;
        effortAvailable = Boolean(variants && Object.hasOwn(variants, effort));
      }
    } catch {
      // Public failure stays independent of raw provider objects and SDK details.
    }
    if (!providerConnected || !selectedModel) {
      if (providerConnected && isKnownActiveOpenCodeModel(providerId, modelId)) {
        return 'curated-refresh-required';
      }
      throw this.explicitModelUnavailableError();
    }
    if (!effortAvailable) {
      throw new Error(
        "The selected OpenCode reasoning effort is not available for this session owner's provider/model and branch configuration; choose a supported effort or leave it unset"
      );
    }
    return 'available';
  }

  private async buildInvocationConfig(
    sessionId: string,
    mcpToken?: string,
    _branchPath?: string
  ): Promise<OpenCodeInvocationConfig> {
    if (!mcpToken) {
      throw new Error('OpenCode requires the built-in Agor MCP token');
    }
    const mcp: Record<string, unknown> = {};
    mcp[`agor_${shortId(sessionId)}`] = {
      type: 'remote',
      url: `${await this.dependencies.getDaemonUrl()}/mcp`,
      enabled: true,
      headers: { Authorization: `Bearer ${mcpToken}` },
    };

    const servers = await this.dependencies.resolveMcpServers(sessionId as SessionID);

    for (const { server } of servers) {
      const name = openCodeMcpServerKey(sessionId, server);
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
    return {
      mcp,
      permission: AGOR_PERMISSION_INTERCEPTION,
      mcpToolPermissions: buildOpenCodeMcpToolPermissions(sessionId, servers),
    };
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
    streamingCallbacks: OpenCodeStreamingCallbacks | undefined,
    registerStopEventCollector: (stop: () => Promise<void>) => void,
    sanitizer: OpenCodeSanitizer
  ): Promise<OpenCodeTurnResult['finalMessage']> {
    const promptFailure = (): Error =>
      new Error(
        `OpenCode prompt failed for ${context.provider}/${context.model}. Reconnect ${context.provider} in OpenCode settings or choose another provider/model.`
      );
    // Carry the shared Agor orientation on every turn. `system` appends to
    // OpenCode's provider baseline; the managed agent's own prompt would
    // replace it.
    const agorSystemPrompt = await renderAgorSystemPrompt();
    const request = {
      path: { id: context.opencodeSessionId },
      signal: input.signal,
      body: {
        agent: AGOR_MANAGED_AGENT,
        system: agorSystemPrompt,
        parts: [{ type: 'text' as const, text: input.prompt }],
        ...(input.effort ? { variant: input.effort } : {}),
        ...(context.model && context.provider
          ? { model: { providerID: context.provider, modelID: context.model } }
          : {}),
        // OpenCode accepts `variant`; the generated SDK request type currently omits it.
      } as NonNullable<Parameters<OpenCodeClient['session']['prompt']>[0]>['body'],
      query: context.branchPath ? { directory: context.branchPath } : undefined,
    };
    const transcriptRequest = {
      path: { id: context.opencodeSessionId },
      query: context.branchPath ? { directory: context.branchPath } : undefined,
    };

    const baselineMessageIds = await loadOpenCodeMessageBaseline(client, transcriptRequest);

    if (input.signal.aborted) throw new Error('OpenCode turn was aborted before event collection');
    let protocolError: Error | undefined;
    let terminalSettled = false;
    let settleTerminal!: (result: { error?: Error }) => void;
    const terminal = new Promise<{ error?: Error }>((resolve) => {
      settleTerminal = resolve;
    });
    const canUseTool = this.createPermissionCallback(input.agorSessionId, input.taskId);

    const settle = (error?: Error) => {
      if (terminalSettled) return;
      terminalSettled = true;
      settleTerminal({ error });
    };
    const settleAbort = () => settle(new Error('OpenCode turn was aborted'));
    input.signal.addEventListener('abort', settleAbort, { once: true });
    if (input.signal.aborted) settleAbort();

    const effects = createOpenCodeEffectConsumer({
      client,
      turn: input,
      context,
      streamingCallbacks,
      canUseTool,
      settle: (error) => {
        if (error) protocolError = error;
        settle(error);
      },
      promptFailure,
    });
    const eventCollector = createOpenCodeEventCollector({
      client,
      context,
      signal: input.signal,
      baselineMessageIds,
      applyEffects: effects.apply,
      isTerminalSettled: () => terminalSettled,
      settle: (error) => {
        protocolError = error;
        settle(error);
      },
    });
    registerStopEventCollector(eventCollector.stop);

    try {
      await eventCollector.start();

      const promptResponse = await client.session.prompt(request);
      if (promptResponse.error) throw promptFailure();

      const terminalResult = await terminal;
      if (terminalResult.error) throw terminalResult.error;

      await new Promise((resolve) => setTimeout(resolve, this.dependencies.eventDrainMs));
      await this.settleWithinOrThrow(
        eventCollector.stop(),
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
      this.dependencies.enrichContentBlocks?.(finalMessage.contentBlocks);

      if (effects.thinkingStarted) {
        await streamingCallbacks?.onThinkingEnd?.(input.agorAssistantMessageId);
      }
      if (effects.textStarted) await streamingCallbacks?.onStreamEnd(input.agorAssistantMessageId);
      return finalMessage;
    } catch (error) {
      const failure = sanitizer.error(error);
      if (effects.textStarted) {
        await streamingCallbacks?.onStreamError(input.agorAssistantMessageId, failure);
      }
      throw failure;
    } finally {
      input.signal.removeEventListener('abort', settleAbort);
      // The runTurn cleanup route owns collector, permission, session, and child shutdown.
    }
  }
}
