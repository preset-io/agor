import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { loadManagedAgenticToolSdk } from '@agor/core/agentic-integrations';
import { shortId } from '@agor/core/db';
import {
  getMcpServersForSession,
  listMcpToolsWithPermission,
  PERMISSIONS_BLOCKED_WITHOUT_PROMPT,
  resolveScopedMCPAuthHeaders,
  sanitizeMCPExternalError,
} from '@agor/core/mcp';
import {
  renderAgorSessionIdentity,
  renderAgorSystemPrompt,
} from '@agor/core/templates/session-context';
import { mergeMCPRemoteHeaders } from '@agor/core/tools/mcp/http-headers';
import { MCP_CLIENT_HINT_HEADER, MCP_CLIENT_HINTS } from '@agor/core/types';
import { GEMINI_MANUAL_MESSAGE, isGeminiManualMode } from '@agor/core/utils/permission-mode-mapper';
import type * as GeminiTypes from '@google/gemini-cli-core';
import type { Part } from '@google/genai';
import { getDaemonUrl } from '../../config.js';
import type {
  BranchRepository,
  MCPOAuthAuthHeadersRepository,
  MCPServerRepository,
  MessagesRepository,
  RepoRepository,
  SessionMCPServerRepository,
  SessionRepository,
  UsersRepository,
} from '../../db/feathers-repositories.js';
import { McpAuthDiagnosticAccumulator } from '../../diagnostics/mcp-auth-diagnostic-accumulator.js';
import { reportSdkActivity, type SdkActivityCallback } from '../../sdk-watchdog.js';
import type { TokenUsage } from '../../types/token-usage.js';
import type { PermissionMode, SessionID, TaskID, UserID } from '../../types.js';
import { resolveContextUserId } from '../base/context-user.js';
import type { TasksService } from '../base/index.js';
import { buildGeminiMcpServerConfig } from './mcp-server-config.js';
import { DEFAULT_GEMINI_MODEL } from './models.js';
import { mapPermissionMode } from './permission-mapper.js';
import { buildGeminiPolicy, installGeminiPolicy } from './policy.js';
import {
  disposeGeminiRuntime,
  enterGeminiRuntime,
  findGeminiRecording,
  GEMINI_HISTORY_NOTICE,
  GEMINI_KEY_MESSAGE,
  GeminiIntegrationError,
  geminiError,
  geminiSessionId,
} from './runtime.js';
import { extractGeminiTokenUsage } from './usage.js';

const Gemini = await loadManagedAgenticToolSdk<typeof GeminiTypes>('gemini');
type ContentBlock = {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
};
export type GeminiStreamEvent =
  | { type: 'stopped' }
  | { type: 'partial'; textChunk: string; resolvedModel?: string; sessionId?: string }
  | {
      type: 'complete';
      content: ContentBlock[];
      toolUses?: Array<{ id: string; name: string; input: Record<string, unknown> }>;
      resolvedModel?: string;
      sessionId?: string;
      usage?: TokenUsage;
      rawSdkResponse?: import('../../types/sdk-response.js').GeminiSdkResponse;
    }
  | { type: 'tool_start'; toolName: string; toolInput: Record<string, unknown> }
  | { type: 'tool_complete'; toolName: string; result: unknown };

const RETIRED: Record<string, string | null> = {
  'gemini-2.0-flash': 'gemini-3.8-flash',
  'gemini-2.0-flash-thinking-experimental': 'gemini-3.8-flash',
  'gemini-3-flash': 'gemini-3.8-flash',
  'gemini-2.0-flash-lite': 'gemini-3.5-flash-lite',
  'gemini-2.0-pro': null,
  'gemini-3-pro': null,
};
export function resolveGeminiInvocationModel(session: {
  model_config?: { model?: string } | null;
}): string {
  const model = session.model_config?.model ?? DEFAULT_GEMINI_MODEL;
  if (Object.hasOwn(RETIRED, model)) {
    if (RETIRED[model] === null)
      throw new GeminiIntegrationError(`Model ${model} is retired. Pick another Gemini model.`);
    return RETIRED[model]!;
  }
  return model;
}
const TOOL_ALIASES: Record<string, string> = {
  read_file: 'Read',
  read_many_files: 'Read',
  write_file: 'Write',
  replace: 'Edit',
  run_shell_command: 'Bash',
  list_directory: 'LS',
  glob: 'Glob',
  grep_search: 'Grep',
  web_fetch: 'WebFetch',
  google_web_search: 'WebSearch',
};

export class GeminiPromptService {
  private activeControllers = new Map<SessionID, AbortController>();
  constructor(
    private messagesRepo: MessagesRepository,
    private sessionsRepo: SessionRepository,
    private apiKey?: string,
    private branchesRepo?: BranchRepository,
    _reposRepo?: RepoRepository,
    private mcpServerRepo?: MCPServerRepository,
    private sessionMCPRepo?: SessionMCPServerRepository,
    private mcpEnabled?: boolean,
    _useNativeAuth?: boolean,
    _usersRepo?: UsersRepository,
    private tasksService?: TasksService,
    private mcpOAuthAuthHeadersRepo?: MCPOAuthAuthHeadersRepository
  ) {}

  async *promptSessionStreaming(
    sessionId: SessionID,
    prompt: string,
    taskId?: TaskID,
    permissionMode?: PermissionMode,
    onActivity?: SdkActivityCallback,
    outerAbortSignal?: AbortSignal
  ): AsyncGenerator<GeminiStreamEvent> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (outerAbortSignal?.aborted) abort();
    outerAbortSignal?.addEventListener('abort', abort, { once: true });
    this.activeControllers.set(sessionId, controller);
    let cleanup: (() => Promise<void>) | undefined;
    let config: GeminiTypes.Config | undefined;
    let model = DEFAULT_GEMINI_MODEL as string;
    try {
      if (!this.apiKey) throw new GeminiIntegrationError(GEMINI_KEY_MESSAGE);
      if (isGeminiManualMode(permissionMode))
        throw new GeminiIntegrationError(GEMINI_MANUAL_MESSAGE);
      const session = await this.sessionsRepo.findById(sessionId);
      const branch = session?.branch_id
        ? await this.branchesRepo?.findById(session.branch_id).catch(() => null)
        : null;
      if (
        !session ||
        !branch?.path ||
        !(await fs.stat(branch.path).catch(() => null))?.isDirectory()
      ) {
        throw new GeminiIntegrationError(
          'Gemini session has no accessible branch; the task was not started'
        );
      }
      try {
        await fs.access(branch.path, constants.R_OK | constants.X_OK);
      } catch {
        throw new GeminiIntegrationError(
          'Gemini session has no accessible branch; the task was not started'
        );
      }
      const requestedModel = session.model_config?.model ?? DEFAULT_GEMINI_MODEL;
      model = resolveGeminiInvocationModel(session);
      if (requestedModel !== model)
        yield {
          type: 'complete',
          content: [{ type: 'text', text: `Model ${requestedModel} is retired; using ${model}.` }],
        };
      if (controller.signal.aborted) {
        yield { type: 'stopped' };
        return;
      }
      cleanup = await enterGeminiRuntime();
      const contextUserId = await resolveContextUserId({
        session,
        taskId,
        tasksService: this.tasksService,
      });
      config = await this.createConfig(
        sessionId,
        branch.path,
        model,
        permissionMode,
        contextUserId
      );
      await config.storage.initialize();
      const file = await findGeminiRecording(Gemini, config, config.getSessionId());
      const conversation = file
        ? await Gemini.loadConversationRecord(file).catch(() => undefined)
        : undefined;
      await config.initialize();
      installGeminiPolicy(Gemini, config);
      if (controller.signal.aborted) {
        yield { type: 'stopped' };
        return;
      }
      await config.refreshAuth(Gemini.AuthType.USE_GEMINI, this.apiKey);
      const client = config.getGeminiClient();
      let restored = false;
      if (conversation && file) {
        const startup = client.getChatRecordingService();
        const startupFile = startup?.getConversationFilePath();
        try {
          await client.resumeChat(Gemini.convertSessionToClientHistory(conversation.messages), {
            conversation,
            filePath: file,
          });
          restored = true;
        } catch {
          // A damaged recording is not reconstructed from Agor's rendered messages.
          await client.resetChat();
        }
        if (startupFile !== file) await startup?.deleteCurrentSessionIfNotResumableAsync();
      }
      if (!restored && (await this.messagesRepo.getNextIndexBySessionId(sessionId)) > 1) {
        yield { type: 'complete', content: [{ type: 'text', text: GEMINI_HISTORY_NOTICE }] };
      }
      await client.setTools();
      let parts: Part[] = [{ text: prompt }, { text: renderAgorSessionIdentity(sessionId) }];
      const promptId = `${sessionId}-${Date.now()}`;
      const totals: TokenUsage = {};
      let reportedModel: string | undefined;
      for (let round = 0; round < 50; round++) {
        if (controller.signal.aborted) {
          yield { type: 'stopped' };
          return;
        }
        let text = '';
        const pending: GeminiTypes.ToolCallRequestInfo[] = [];
        let lastUsage: GeminiTypes.GeminiFinishedEventValue['usageMetadata'];
        const stream = client.sendMessageStream(parts, controller.signal, promptId);
        let next = await stream.next();
        while (!next.done) {
          const event = next.value;
          reportSdkActivity(onActivity, 'gemini', String(event.type));
          switch (event.type) {
            case Gemini.GeminiEventType.Content:
              text += event.value;
              yield { type: 'partial', textChunk: event.value, resolvedModel: reportedModel };
              break;
            case Gemini.GeminiEventType.ModelInfo:
              reportedModel = event.value;
              break;
            case Gemini.GeminiEventType.ToolCallRequest:
              pending.push(event.value);
              break;
            case Gemini.GeminiEventType.Finished:
              lastUsage = event.value.usageMetadata;
              break;
            case Gemini.GeminiEventType.Error:
              throw geminiError(Gemini.classifyGoogleError(event.value.error), model);
            case Gemini.GeminiEventType.UserCancelled:
              controller.abort();
              yield { type: 'stopped' };
              return;
            case Gemini.GeminiEventType.LoopDetected:
              throw new GeminiIntegrationError('Gemini stopped because it detected a loop.');
            case Gemini.GeminiEventType.ContextWindowWillOverflow:
              throw new GeminiIntegrationError(
                'Gemini conversation is too large. Start a new session.'
              );
            case Gemini.GeminiEventType.InvalidStream:
              throw new GeminiIntegrationError('Gemini returned an invalid response. Try again.');
            case Gemini.GeminiEventType.MaxSessionTurns:
              throw new GeminiIntegrationError(
                'Gemini reached the session turn limit. Start a new session.'
              );
            case Gemini.GeminiEventType.AgentExecutionStopped:
              throw new GeminiIntegrationError('Gemini stopped the agent execution.');
            case Gemini.GeminiEventType.ChatCompressed:
              yield {
                type: 'complete',
                content: [{ type: 'text', text: 'Gemini compressed the conversation context.' }],
              };
              break;
            case Gemini.GeminiEventType.AgentExecutionBlocked:
              yield {
                type: 'complete',
                content: [{ type: 'text', text: 'Gemini blocked an action and continued.' }],
              };
              break;
          }
          next = await stream.next();
        }
        const response = next.value?.getDebugResponses().at(-1);
        reportedModel = response?.modelVersion ?? reportedModel;
        const usage = extractGeminiTokenUsage(lastUsage);
        if (usage)
          for (const key of Object.keys(usage) as (keyof TokenUsage)[])
            totals[key] = (totals[key] ?? 0) + (usage[key] ?? 0);
        const toolUses = pending.map((call) => ({
          id: call.callId,
          name: TOOL_ALIASES[call.name] ?? call.name,
          input: call.args,
        }));
        yield {
          type: 'complete',
          content: [
            ...(text ? [{ type: 'text', text }] : []),
            ...toolUses.map((tool) => ({ type: 'tool_use', ...tool })),
          ],
          toolUses,
          resolvedModel: reportedModel,
          usage: { ...totals },
          rawSdkResponse: {
            type: Gemini.GeminiEventType.Finished,
            value: { reason: undefined, usageMetadata: lastUsage },
            agor: { usage: { ...totals }, requestedModel, reportedModel, costEstimated: true },
          },
        };
        if (taskId && this.tasksService) {
          const task = await this.tasksService.get(taskId);
          await this.tasksService.patch(taskId, {
            metadata: {
              ...task.metadata,
              gemini: { requestedModel, reportedModel, costEstimated: true },
            },
          });
        }
        if (!pending.length) return;
        const scheduler = new Gemini.Scheduler({
          context: config,
          messageBus: config.getMessageBus(),
          getPreferredEditor: () => undefined,
          schedulerId: `${promptId}-${round}`,
        });
        let completed: Awaited<ReturnType<typeof scheduler.schedule>>;
        try {
          completed = await scheduler.schedule(pending, controller.signal);
        } finally {
          scheduler.dispose();
        }
        parts = [];
        const results: ContentBlock[] = [];
        for (const call of completed) {
          const responseParts = call.response?.responseParts ?? [];
          parts.push(...responseParts);
          results.push({
            type: 'tool_result',
            tool_use_id: call.request.callId,
            content:
              typeof call.response?.resultDisplay === 'string'
                ? call.response.resultDisplay
                : JSON.stringify(responseParts),
            is_error: call.status !== 'success',
          });
        }
        yield { type: 'complete', content: results, resolvedModel: reportedModel };
        if (controller.signal.aborted) {
          yield { type: 'stopped' };
          return;
        }
      }
      throw new GeminiIntegrationError(
        'Gemini reached the limit of 50 tool rounds. Send a follow-up to continue.'
      );
    } catch (error) {
      if (controller.signal.aborted) {
        yield { type: 'stopped' };
        return;
      }
      throw geminiError(
        error instanceof GeminiIntegrationError ? error : Gemini.classifyGoogleError(error),
        model
      );
    } finally {
      try {
        await disposeGeminiRuntime(config, cleanup);
      } finally {
        outerAbortSignal?.removeEventListener('abort', abort);
        this.activeControllers.delete(sessionId);
      }
    }
  }

  private async createConfig(
    sessionId: SessionID,
    workingDirectory: string,
    model: string,
    permissionMode: PermissionMode | undefined,
    contextUserId?: UserID
  ): Promise<GeminiTypes.Config> {
    const session = await this.sessionsRepo.findById(sessionId);
    if (!session)
      throw new GeminiIntegrationError(
        'Gemini session has no accessible branch; the task was not started'
      );
    // Fetch and configure MCP servers for this session (hierarchical scoping)
    const mcpServersConfig: Record<string, InstanceType<typeof Gemini.MCPServerConfig>> = {};

    // Configure Agor MCP server (self-access to daemon) - only if MCP is enabled
    if (this.mcpEnabled !== false) {
      const mcpToken = session.mcp_token;

      if (mcpToken) {
        // Get daemon URL from config
        const daemonUrl = await getDaemonUrl();

        console.log(`🔌 Configuring Agor MCP server at ${daemonUrl}/mcp`);
        // Use httpUrl parameter for HTTP transport. Token goes in the
        // Authorization header (not the URL) to avoid leaking via logs / history.
        mcpServersConfig.agor = new Gemini.MCPServerConfig(
          undefined, // command
          undefined, // args
          {}, // env
          undefined, // cwd
          undefined, // url (websocket)
          `${daemonUrl}/mcp`, // httpUrl
          { Authorization: `Bearer ${mcpToken}`, [MCP_CLIENT_HINT_HEADER]: MCP_CLIENT_HINTS.gemini } // headers
        );
      } else {
        console.warn(
          `⚠️  No MCP token found for session ${shortId(sessionId)} - MCP tools unavailable`
        );
      }
    } else {
      console.log(`🔒 Agor MCP server disabled - skipping MCP configuration`);
    }

    // Fetch user-configured MCP servers
    if (this.sessionMCPRepo && this.mcpServerRepo) {
      try {
        // Use shared MCP scoping utility. forUserId injects the prompter's
        // per-user OAuth tokens for personal OAuth-protected MCP servers.
        const serversWithSource = await getMcpServersForSession(
          sessionId,
          {
            sessionMCPRepo: this.sessionMCPRepo,
            mcpServerRepo: this.mcpServerRepo,
            mcpOAuthAuthHeadersRepo: this.mcpOAuthAuthHeadersRepo,
            forUserId: contextUserId,
          },
          { toolFiltering: 'exclude' }
        );

        const authDiagnostics = new McpAuthDiagnosticAccumulator();
        // Convert to Gemini SDK format
        for (const scoped of serversWithSource) {
          const { server } = scoped;
          let headers: Record<string, string> | undefined;
          try {
            const authHeaders = await resolveScopedMCPAuthHeaders(scoped, {
              surfaceAuthorityError: true,
            });
            headers = mergeMCPRemoteHeaders({ custom: server.headers, auth: authHeaders });
            if (
              server.transport !== 'stdio' &&
              server.auth &&
              server.auth.type !== 'none' &&
              !authHeaders?.Authorization
            ) {
              authDiagnostics.recordUnavailable();
            }
          } catch {
            authDiagnostics.recordResolutionFailure();
          }

          const excludeTools = listMcpToolsWithPermission(
            server,
            PERMISSIONS_BLOCKED_WITHOUT_PROMPT
          );

          // Convert Agor's MCP server format to Gemini SDK's MCPServerConfig
          if (server.transport === 'stdio') {
            mcpServersConfig[server.name] = buildGeminiMcpServerConfig(Gemini.MCPServerConfig, {
              command: server.command,
              args: server.args || [],
              env: server.env || {},
              cwd: workingDirectory, // Use branch path as cwd
              excludeTools,
            });
          } else if (server.transport === 'http') {
            // HTTP transport: use httpUrl parameter
            mcpServersConfig[server.name] = buildGeminiMcpServerConfig(Gemini.MCPServerConfig, {
              env: server.env || {},
              httpUrl: server.url,
              headers,
              excludeTools,
            });
          } else if (server.transport === 'sse') {
            // SSE transport: use url parameter (websocket/sse)
            mcpServersConfig[server.name] = buildGeminiMcpServerConfig(Gemini.MCPServerConfig, {
              env: server.env || {},
              url: server.url, // url (websocket/sse)
              headers,
              excludeTools,
            });
          }

          if (excludeTools.length > 0) {
            const asked = listMcpToolsWithPermission(server, ['ask']);
            console.warn(
              `   ⛔ [Gemini] Excluding ${excludeTools.length} tool(s) on "${server.name}" per tool_permissions` +
                (asked.length > 0
                  ? ` (${asked.length} set to "ask"; Gemini runs headless with no approval prompt, so they fail closed)`
                  : '')
            );
          }

          if (headers && server.transport !== 'stdio') {
            console.log(
              `     🔐 Added ${Object.keys(headers).length} HTTP header(s) for ${server.name}`
            );
          }
        }

        authDiagnostics.emitSummary('gemini');

        if (Object.keys(mcpServersConfig).length > 0) {
          console.log(
            `   🔧 MCP config for Gemini SDK:`,
            JSON.stringify(
              Object.keys(mcpServersConfig).reduce(
                (acc, key) => {
                  acc[key] = {
                    transport: mcpServersConfig[key].command ? 'stdio' : 'http/sse',
                  };
                  return acc;
                },
                {} as Record<string, { transport: string }>
              ),
              null,
              2
            )
          );
        }
      } catch (error) {
        const safe = sanitizeMCPExternalError(error, { stage: 'runtime' });
        console.warn(
          `⚠️  Failed to fetch MCP servers for Gemini session category=${safe.category} type=${safe.diagnostic.type}`
        );
        // Continue without MCP servers - non-fatal error
      }
    }

    const approvalMode = mapPermissionMode(permissionMode);
    return new Gemini.Config({
      sessionId: geminiSessionId(sessionId),
      targetDir: workingDirectory,
      cwd: workingDirectory,
      model,
      interactive: false,
      approvalMode,
      debugMode: false,
      folderTrust: true,
      trustedFolder: true,
      usageStatisticsEnabled: false,
      telemetry: { enabled: false, logPrompts: false },
      enableHooks: false,
      enableHooksUI: false,
      extensionsEnabled: false,
      enableEnvironmentVariableRedaction: false,
      enableAgents: true,
      agents: { overrides: { browser: { enabled: false } } },
      policyEngineConfig: buildGeminiPolicy(Gemini, approvalMode, mcpServersConfig),
      mcpServers: mcpServersConfig,
      userMemory: await renderAgorSystemPrompt(),
      fileFiltering: { respectGitIgnore: true, respectGeminiIgnore: true },
    });
  }

  stopTask(sessionId: SessionID): { success: boolean; reason?: string } {
    const controller = this.activeControllers.get(sessionId);
    if (!controller) return { success: false, reason: 'No active task found for this session' };
    controller.abort();
    return { success: true };
  }

  async closeSession(sessionId: SessionID): Promise<void> {
    this.stopTask(sessionId);
  }
}
