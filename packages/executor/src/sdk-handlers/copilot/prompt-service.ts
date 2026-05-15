/**
 * Copilot Prompt Service
 *
 * Handles live execution of prompts against Copilot sessions using @github/copilot-sdk.
 * Manages CopilotClient lifecycle, session creation/resumption, and event streaming.
 *
 * Architecture:
 * - One CopilotClient per executor invocation (spawns copilot CLI process)
 * - CopilotClient communicates with CLI via JSON-RPC over stdio
 * - Sessions are created or resumed via the client
 * - Events stream back through the session's event emitter
 */

import { renderAgorSystemPrompt } from '@agor/core/templates/session-context';
import type { CopilotSession } from '@github/copilot-sdk';
import { CopilotClient } from '@github/copilot-sdk';
import { getDaemonUrl } from '../../config.js';
import type {
  MCPServerRepository,
  MessagesRepository,
  RepoRepository,
  SessionMCPServerRepository,
  SessionRepository,
  UsersRepository,
  WorktreeRepository,
} from '../../db/feathers-repositories.js';
import type { PermissionService } from '../../permissions/permission-service.js';
import type { TokenUsage } from '../../types/token-usage.js';
import type { PermissionMode, SessionID, TaskID } from '../../types.js';
import type { MessagesService, SessionsPatchClient, TasksService } from '../base/index.js';
import { getMcpServersForSession } from '../base/mcp-scoping.js';
import type { CopilotSessionEvents } from './event-mapper.js';
import { DEFAULT_COPILOT_MODEL } from './models.js';
import { createPermissionHandler, type PermissionDeps } from './permission-mapper.js';

/**
 * Streaming event types for Copilot execution
 */
export type CopilotStreamEvent =
  | {
      type: 'partial';
      textChunk: string;
      sessionId?: string;
      resolvedModel?: string;
    }
  | {
      type: 'tool_start';
      toolUse: {
        id: string;
        name: string;
        input: Record<string, unknown>;
      };
      sessionId?: string;
    }
  | {
      type: 'tool_complete';
      toolUse: {
        id: string;
        name: string;
        input: Record<string, unknown>;
        output?: string;
        status?: string;
      };
      sessionId?: string;
    }
  | {
      type: 'stopped';
      sessionId?: string;
    }
  | {
      type: 'complete';
      content: Array<{
        type: string;
        text?: string;
        id?: string;
        name?: string;
        input?: Record<string, unknown>;
      }>;
      toolUses?: Array<{
        id: string;
        name: string;
        input: Record<string, unknown>;
      }>;
      sessionId: string;
      resolvedModel?: string;
      usage?: TokenUsage;
      rawSdkResponse?: CopilotRawResponse;
    };

/**
 * Raw Copilot SDK response stored for normalization
 */
export interface CopilotRawResponse {
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
  model?: string;
  sessionId?: string;
}

export class CopilotPromptService {
  private client: InstanceType<typeof CopilotClient> | null = null;
  private stopRequested = new Map<SessionID, boolean>();
  private apiKey: string | undefined;

  // Permission deps for interactive permission UI
  private permissionService?: PermissionService;
  private messagesRepo: MessagesRepository;
  private messagesService?: MessagesService;
  private tasksService?: TasksService;
  private sessionsService?: SessionsPatchClient;
  private permissionLocks = new Map<SessionID, Promise<void>>();

  constructor(
    messagesRepo: MessagesRepository,
    private sessionsRepo: SessionRepository,
    private sessionMCPServerRepo?: SessionMCPServerRepository,
    private worktreesRepo?: WorktreeRepository,
    private reposRepo?: RepoRepository,
    apiKey?: string,
    private mcpServerRepo?: MCPServerRepository,
    private usersRepo?: UsersRepository,
    permissionService?: PermissionService,
    messagesService?: MessagesService,
    tasksService?: TasksService,
    sessionsService?: SessionsPatchClient
  ) {
    this.apiKey = apiKey;
    this.messagesRepo = messagesRepo;
    this.permissionService = permissionService;
    this.messagesService = messagesService;
    this.tasksService = tasksService;
    this.sessionsService = sessionsService;
  }

  /**
   * Build MCP servers configuration for Copilot session
   *
   * Converts Agor's MCP server config to Copilot SDK format.
   * Copilot supports both 'local' (stdio) and 'http' (streamable HTTP) transports.
   */
  private async buildMcpServers(
    sessionId: SessionID,
    mcpToken?: string
  ): Promise<Record<string, unknown>> {
    const copilotMcpServers: Record<string, unknown> = {};

    // Fetch MCP servers for this session
    const serversWithSource = await getMcpServersForSession(sessionId, {
      sessionMCPRepo: this.sessionMCPServerRepo,
      mcpServerRepo: this.mcpServerRepo,
    });

    const mcpServers = serversWithSource.map((s) => s.server);
    console.log(`📊 [Copilot MCP] Found ${mcpServers.length} MCP server(s) for session`);

    for (const server of mcpServers) {
      const serverName = server.name.toLowerCase().replace(/[^a-z0-9_-]/g, '_');

      if (server.transport === 'stdio') {
        copilotMcpServers[serverName] = {
          type: 'local',
          command: server.command,
          args: server.args,
          env: server.env,
          tools: ['*'],
        };
        console.log(`   📝 [Copilot MCP] Configured STDIO server: ${server.name}`);
      } else if (server.transport === 'http' || server.transport === 'sse') {
        const serverConfig: Record<string, unknown> = {
          type: 'http',
          url: server.url,
          tools: ['*'],
        };

        // Add auth headers for bearer token
        if (server.auth?.type === 'bearer' && server.auth.token) {
          serverConfig.headers = {
            Authorization: `Bearer ${server.auth.token}`,
          };
        }

        copilotMcpServers[serverName] = serverConfig;
        console.log(`   📝 [Copilot MCP] Configured HTTP server: ${server.name}`);
      }
    }

    // Include Agor self-access MCP server
    if (mcpToken) {
      const daemonUrl = await getDaemonUrl();
      copilotMcpServers.agor = {
        type: 'http',
        url: `${daemonUrl}/mcp`,
        headers: {
          Authorization: `Bearer ${mcpToken}`,
        },
        tools: ['*'],
      };
      console.log(`   📝 [Copilot MCP] Configured Agor MCP server (HTTP)`);
    }

    return copilotMcpServers;
  }

  /**
   * Create Agor system prompt for Copilot session context
   */
  private async buildSystemMessage(sessionId: SessionID): Promise<string> {
    return renderAgorSystemPrompt(sessionId, {
      sessions: this.sessionsRepo,
      worktrees: this.worktreesRepo,
      repos: this.reposRepo,
      users: this.usersRepo,
    });
  }

  /**
   * Execute prompt with streaming support
   *
   * Creates CopilotClient, creates or resumes session, sends prompt,
   * and yields streaming events.
   *
   * @param sessionId - Agor session ID
   * @param prompt - User prompt
   * @param taskId - Optional task ID
   * @param permissionMode - Permission mode for tool execution
   * @param abortController - Optional AbortController for cancellation support
   * @returns Async generator of streaming events
   */
  async *promptSessionStreaming(
    sessionId: SessionID,
    prompt: string,
    taskId?: TaskID,
    permissionMode?: PermissionMode,
    abortController?: AbortController
  ): AsyncGenerator<CopilotStreamEvent> {
    // Get session to check for existing SDK session ID and working directory
    const session = await this.sessionsRepo.findById(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    console.log(`🔍 [Copilot] Starting prompt execution for session ${sessionId.substring(0, 8)}`);
    console.log(`   Permission mode: ${permissionMode || 'not specified (will use default)'}`);
    console.log(
      `   Existing SDK session ID: ${session.sdk_session_id || 'none (will create new)'}`
    );

    // Fetch worktree to get working directory
    const worktree = this.worktreesRepo
      ? await this.worktreesRepo.findById(session.worktree_id)
      : null;
    if (!worktree) {
      throw new Error(`Worktree ${session.worktree_id} not found for session ${sessionId}`);
    }

    console.log(`   Working directory: ${worktree.path}`);

    // Create CopilotClient (spawns CLI process)
    this.client = new CopilotClient({
      useStdio: true,
      githubToken:
        this.apiKey ||
        process.env.COPILOT_GITHUB_TOKEN ||
        process.env.GH_TOKEN ||
        process.env.GITHUB_TOKEN,
      env: {
        HOME: process.env.HOME || '',
      },
    });

    try {
      await this.client.start();
      console.log(`✅ [Copilot] Client started`);

      // Build session configuration with interactive permission support
      const permissionDeps: PermissionDeps | undefined =
        this.permissionService && this.tasksService && taskId
          ? {
              permissionService: this.permissionService,
              tasksService: this.tasksService,
              sessionsRepo: this.sessionsRepo,
              messagesRepo: this.messagesRepo,
              messagesService: this.messagesService,
              sessionsService: this.sessionsService,
              permissionLocks: this.permissionLocks,
              mcpServerRepo: this.mcpServerRepo,
              sessionMCPRepo: this.sessionMCPServerRepo,
            }
          : undefined;

      const permissionHandler = createPermissionHandler(
        sessionId,
        taskId || ('' as TaskID),
        permissionMode,
        permissionDeps
      );
      const mcpServers = await this.buildMcpServers(sessionId, session.mcp_token);
      const systemMessage = await this.buildSystemMessage(sessionId);

      // Read model from session config (settable per-prompt — picker changes
      // re-emit a new model_config and we re-bind it to the SDK every turn).
      const resolvedModel = session.model_config?.model || DEFAULT_COPILOT_MODEL;
      console.log(`🎯 [Copilot] Using model: ${resolvedModel}`);

      // Create or resume session
      let copilotSession: CopilotSession;
      const sessionConfig = {
        workingDirectory: worktree.path,
        streaming: true,
        model: resolvedModel,
        onPermissionRequest: permissionHandler,
        mcpServers: mcpServers as Record<string, import('@github/copilot-sdk').MCPServerConfig>,
        systemMessage: { mode: 'append' as const, content: systemMessage },
      };

      if (session.sdk_session_id) {
        console.log(`🔄 [Copilot] Resuming session: ${session.sdk_session_id}`);
        try {
          copilotSession = await this.client.resumeSession(session.sdk_session_id, sessionConfig);
        } catch (resumeError) {
          console.log(
            `⚠️  [Copilot] Resume failed (${resumeError instanceof Error ? resumeError.message : resumeError}), creating new session`
          );
          copilotSession = await this.client.createSession(sessionConfig);

          // Update stored SDK session ID
          const sdkSessionId = (copilotSession as { sessionId?: string }).sessionId;
          if (sdkSessionId) {
            console.log(`🔑 Captured new Copilot session ID: ${sdkSessionId}`);
            await this.sessionsRepo.update(sessionId, { sdk_session_id: sdkSessionId });
          }
        }
      } else {
        console.log(`🆕 [Copilot] Creating new session`);
        copilotSession = await this.client.createSession(sessionConfig);

        // Store the SDK session ID for future resumption
        const sdkSessionId = (copilotSession as { sessionId?: string }).sessionId;
        if (sdkSessionId) {
          console.log(`🔑 Captured Copilot session ID: ${sdkSessionId}`);
          await this.sessionsRepo.update(sessionId, { sdk_session_id: sdkSessionId });
        }
      }

      // Belt-and-suspenders: explicitly bind the model on the session object
      // after create/resume. The SDK accepts `model` in the session config
      // above, but `setModel()` is the documented post-init API and guarantees
      // mid-session picker changes take effect on the next prompt — even on a
      // resumed session whose original model differs.
      try {
        await (
          copilotSession as unknown as {
            setModel: (m: string) => Promise<void>;
          }
        ).setModel(resolvedModel);
      } catch (err) {
        console.warn(
          `⚠️  [Copilot] setModel("${resolvedModel}") failed; relying on session config:`,
          err instanceof Error ? err.message : err
        );
      }

      // Clear any stale stop flag
      if (this.stopRequested.has(sessionId)) {
        console.log(`⚠️  Clearing stale stop flag for session ${sessionId}`);
        this.stopRequested.delete(sessionId);
      }

      console.log(
        `▶️  [Copilot] Sending prompt: "${prompt.substring(0, 50)}${prompt.length > 50 ? '...' : ''}"`
      );

      // Send prompt and wait for completion
      // Copilot SDK supports both fire-and-forget (send) and blocking (sendAndWait)
      // We use sendAndWait with event listeners for streaming
      const textChunks: string[] = [];
      const toolUses: Array<{
        id: string;
        name: string;
        input: Record<string, unknown>;
        output?: string;
        status?: string;
      }> = [];
      let usageData: TokenUsage | undefined;
      const copilotSessionId = (copilotSession as { sessionId?: string }).sessionId || '';

      // Wire up event listeners for streaming
      const sessionEvents = copilotSession as unknown as CopilotSessionEvents;

      sessionEvents.on('assistant.message_delta', (event) => {
        const chunk = event.data.deltaContent;
        if (chunk) {
          textChunks.push(chunk);
        }
      });

      sessionEvents.on('tool.execution_start', (event) => {
        const data = event.data;
        const toolName = data.mcpServerName
          ? `${data.mcpServerName}.${data.mcpToolName || data.toolName}`
          : data.toolName;

        // Yield tool_start event (collected below in event loop)
        toolUses.push({
          id: data.toolCallId,
          name: toolName,
          input: data.input || {},
        });
      });

      sessionEvents.on('tool.execution_complete', (event) => {
        const data = event.data;
        const _toolName = data.mcpServerName
          ? `${data.mcpServerName}.${data.mcpToolName || data.toolName}`
          : data.toolName;

        // Update existing tool use entry with output/status
        const existing = toolUses.find((t) => t.id === data.toolCallId);
        if (existing) {
          existing.output = data.output;
          existing.status = data.status;
        }
      });

      sessionEvents.on('assistant.usage', (event) => {
        const data = event.data;
        usageData = {
          input_tokens: data.input_tokens,
          output_tokens: data.output_tokens,
          total_tokens: data.total_tokens,
        };
      });

      // Use sendAndWait for blocking execution with timeout
      const timeoutMs = 10 * 60 * 1000; // 10 minutes
      try {
        await copilotSession.sendAndWait({ prompt }, timeoutMs);
      } catch (error) {
        // Check for abort
        if (
          error instanceof Error &&
          (error.name === 'AbortError' || error.message.includes('abort'))
        ) {
          console.log(`🛑 [Copilot] Query aborted for session ${sessionId.substring(0, 8)}`);
          yield { type: 'stopped', sessionId: copilotSessionId };
          return;
        }
        throw error;
      }

      // Check if stop was requested during execution
      if (this.stopRequested.get(sessionId)) {
        console.log(`🛑 Stop requested for Copilot session ${sessionId}`);
        this.stopRequested.delete(sessionId);
        yield { type: 'stopped', sessionId: copilotSessionId };
        return;
      }

      // Build complete message content
      const fullText = textChunks.join('');
      const content: Array<{
        type: string;
        text?: string;
        id?: string;
        name?: string;
        input?: Record<string, unknown>;
      }> = [];

      // Add tool use/result blocks
      for (const tool of toolUses) {
        content.push({
          type: 'tool_use',
          id: tool.id,
          name: tool.name,
          input: tool.input,
        });
        if (tool.output !== undefined || tool.status) {
          content.push({
            type: 'tool_result',
            id: tool.id,
            name: tool.name,
            input: { content: tool.output || `[${tool.status}]` },
          });
        }
      }

      // Add text block
      if (fullText) {
        content.push({ type: 'text', text: fullText });
      }

      // Build raw SDK response for normalization
      const rawSdkResponse: CopilotRawResponse = {
        usage: usageData
          ? {
              input_tokens: usageData.input_tokens,
              output_tokens: usageData.output_tokens,
              total_tokens: usageData.total_tokens,
            }
          : undefined,
        model: resolvedModel,
        sessionId: copilotSessionId,
      };

      // Yield complete event
      yield {
        type: 'complete',
        content,
        toolUses:
          toolUses.length > 0
            ? toolUses.map((t) => ({ id: t.id, name: t.name, input: t.input }))
            : undefined,
        sessionId: copilotSessionId,
        resolvedModel,
        usage: usageData,
        rawSdkResponse,
      };

      // Disconnect session (preserves state on disk for resumption)
      await copilotSession.disconnect();
    } catch (error) {
      // Check if this is an AbortError
      if (
        error instanceof Error &&
        (error.name === 'AbortError' || error.message.includes('abort'))
      ) {
        console.log(
          `🛑 [Stop] Copilot query aborted for session ${sessionId.substring(0, 8)} - this is expected`
        );
        yield { type: 'stopped', sessionId: '' };
        return;
      }

      console.error('❌ Copilot streaming error:', error);
      throw error;
    } finally {
      // Clean up client (stops CLI process)
      if (this.client) {
        try {
          await this.client.stop();
          console.log(`✅ [Copilot] Client stopped`);
        } catch (err) {
          console.warn(`⚠️  [Copilot] Failed to stop client:`, err);
        }
        this.client = null;
      }
    }
  }

  /**
   * Stop currently executing task
   *
   * Sets a flag that is checked during execution.
   * Primary cancellation happens via AbortController.
   */
  stopTask(sessionId: SessionID): { success: boolean; reason?: string } {
    this.stopRequested.set(sessionId, true);
    console.log(`🛑 Stop requested for Copilot session ${sessionId}`);
    return { success: true };
  }

  /**
   * Clean up session resources
   */
  async closeSession(sessionId: SessionID): Promise<void> {
    this.stopRequested.delete(sessionId);

    // Clean up client if still running
    if (this.client) {
      try {
        await this.client.stop();
      } catch {
        /* best-effort */
      }
      this.client = null;
    }
  }
}
