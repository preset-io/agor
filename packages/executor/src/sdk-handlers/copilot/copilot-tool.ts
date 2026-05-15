/**
 * Copilot Tool Implementation
 *
 * Current capabilities:
 * - ✅ Live execution via GitHub Copilot SDK
 * - ✅ Token-level streaming via assistant.message_delta events
 * - ✅ Thinking/reasoning via assistant.reasoning_delta events
 * - ✅ Session create/resume via CopilotClient
 * - ✅ MCP integration (stdio + HTTP transports)
 * - ✅ Permission mapping to onPermissionRequest callback
 * - ❌ Session import (deferred)
 * - ❌ Session fork (emulated via new sessions in Phase 2)
 */

import { generateId } from '@agor/core/db';
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
import type { NormalizedSdkResponse, RawSdkResponse } from '../../types/sdk-response.js';
import type { TokenUsage } from '../../types/token-usage.js';
import {
  type Message,
  type MessageID,
  MessageRole,
  type MessageSource,
  type PermissionMode,
  type SessionID,
  type TaskID,
} from '../../types.js';
import type {
  ITool,
  MessagesService,
  SessionsPatchClient,
  StreamingCallbacks,
  TasksService,
  ToolCapabilities,
} from '../base/index.js';
import { createUserMessage } from '../claude/message-builder.js';
import { DEFAULT_COPILOT_MODEL } from './models.js';
import { CopilotPromptService } from './prompt-service.js';

interface CopilotExecutionResult {
  userMessageId: MessageID;
  assistantMessageIds: MessageID[];
  tokenUsage?: TokenUsage;
  contextWindow?: number;
  contextWindowLimit?: number;
  model?: string;
  rawSdkResponse?: unknown;
  wasStopped?: boolean;
}

export class CopilotTool implements ITool {
  readonly toolType = 'copilot' as const;
  readonly name = 'GitHub Copilot';

  private promptService?: CopilotPromptService;
  private messagesRepo?: MessagesRepository;
  private sessionsRepo?: SessionRepository;
  private messagesService?: MessagesService;
  private tasksService?: TasksService;

  constructor(
    messagesRepo?: MessagesRepository,
    sessionsRepo?: SessionRepository,
    sessionMCPServerRepo?: SessionMCPServerRepository,
    worktreesRepo?: WorktreeRepository,
    reposRepo?: RepoRepository,
    apiKey?: string,
    messagesService?: MessagesService,
    tasksService?: TasksService,
    _useNativeAuth?: boolean,
    mcpServerRepo?: MCPServerRepository,
    usersRepo?: UsersRepository,
    permissionService?: PermissionService,
    sessionsService?: SessionsPatchClient
  ) {
    this.messagesRepo = messagesRepo;
    this.sessionsRepo = sessionsRepo;
    this.messagesService = messagesService;
    this.tasksService = tasksService;

    if (messagesRepo && sessionsRepo) {
      this.promptService = new CopilotPromptService(
        messagesRepo,
        sessionsRepo,
        sessionMCPServerRepo,
        worktreesRepo,
        reposRepo,
        apiKey,
        mcpServerRepo,
        usersRepo,
        permissionService,
        messagesService,
        tasksService,
        sessionsService
      );
    }
  }

  getCapabilities(): ToolCapabilities {
    return {
      supportsSessionImport: false,
      supportsSessionCreate: false, // Handled via executeTask
      supportsLiveExecution: true,
      supportsSessionFork: false, // Phase 2: emulated via new sessions
      supportsChildSpawn: false, // Phase 3: via Copilot's customAgents
      supportsGitState: false, // Agor manages git state
      supportsStreaming: true, // Token-level streaming via assistant.message_delta
    };
  }

  async checkInstalled(): Promise<boolean> {
    try {
      // Check if @github/copilot CLI is available
      // The SDK spawns the copilot CLI binary from @github/copilot package
      const { execSync } = await import('node:child_process');
      execSync('which copilot', { encoding: 'utf-8' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Execute a prompt against a session WITH real-time streaming
   *
   * Creates user message, streams response chunks from Copilot, then creates complete assistant messages.
   * Calls streamingCallbacks during message generation for real-time UI updates.
   */
  async executePromptWithStreaming(
    sessionId: SessionID,
    prompt: string,
    taskId?: TaskID,
    permissionMode?: PermissionMode,
    streamingCallbacks?: StreamingCallbacks,
    abortController?: AbortController,
    messageSource?: MessageSource
  ): Promise<CopilotExecutionResult> {
    if (!this.promptService || !this.messagesRepo) {
      throw new Error('CopilotTool not initialized with repositories for live execution');
    }

    if (!this.messagesService) {
      throw new Error('CopilotTool not initialized with messagesService for live execution');
    }

    // Get next message index
    const existingMessages = await this.messagesRepo.findBySessionId(sessionId);
    let nextIndex = existingMessages.length;

    // Create user message (or reuse the daemon's pre-write — see Alt D in
    // docs/never-lose-prompt-design.md).
    const userMessage = await createUserMessage(
      sessionId,
      prompt,
      taskId,
      nextIndex,
      this.messagesService!,
      { messageSource, existingMessages }
    );
    nextIndex = userMessage.index + 1;

    // Execute prompt via Copilot SDK with streaming
    const assistantMessageIds: MessageID[] = [];
    let capturedSessionId: string | undefined;
    let resolvedModel: string | undefined;
    let currentMessageId: MessageID | null = null;
    let tokenUsage: TokenUsage | undefined;
    let rawSdkResponse: unknown;
    let streamStarted = false;
    let wasStopped = false;

    for await (const event of this.promptService.promptSessionStreaming(
      sessionId,
      prompt,
      taskId,
      permissionMode,
      abortController
    )) {
      // Detect if execution was stopped early
      if (event.type === 'stopped') {
        wasStopped = true;
        console.log(`🛑 Copilot execution was stopped for session ${sessionId}`);
        continue;
      }

      // Capture resolved model from complete events
      if (!resolvedModel && event.type === 'complete') {
        resolvedModel = event.resolvedModel;
      }

      if (event.type === 'complete' && event.usage) {
        tokenUsage = event.usage;
      }

      // Capture raw SDK response for token accounting
      if (event.type === 'complete' && event.rawSdkResponse) {
        rawSdkResponse = event.rawSdkResponse;
      }

      // Capture Copilot SDK session ID
      if (!capturedSessionId && event.type === 'complete' && event.sessionId) {
        capturedSessionId = event.sessionId;
        await this.captureSessionId(sessionId, capturedSessionId);
      }

      // Handle tool completion events
      if (event.type === 'tool_complete') {
        const toolMessageId = generateId() as MessageID;
        const toolContent = [
          {
            type: 'tool_use',
            id: event.toolUse.id,
            name: event.toolUse.name,
            input: event.toolUse.input,
          },
          ...(event.toolUse.output !== undefined || event.toolUse.status
            ? [
                {
                  type: 'tool_result',
                  tool_use_id: event.toolUse.id,
                  content: event.toolUse.output || `[${event.toolUse.status}]`,
                  is_error: event.toolUse.status === 'error',
                },
              ]
            : []),
        ];

        await this.createAssistantMessage(
          sessionId,
          toolMessageId,
          toolContent as Array<{
            type: string;
            text?: string;
            id?: string;
            name?: string;
            input?: Record<string, unknown>;
          }>,
          [
            {
              id: event.toolUse.id,
              name: event.toolUse.name,
              input: event.toolUse.input,
            },
          ],
          taskId,
          nextIndex++,
          resolvedModel
        );
        assistantMessageIds.push(toolMessageId);
      }
      // Handle complete message
      else if (event.type === 'complete' && event.content) {
        const usageForMessage = event.usage ?? tokenUsage;

        // Filter to text blocks only (tools already saved via tool_complete events)
        const textOnlyContent = event.content.filter((block) => block.type === 'text');

        if (textOnlyContent.length > 0) {
          const fullText = textOnlyContent
            .map((block) => (block as { text?: string }).text || '')
            .join('');

          const assistantMessageId = currentMessageId || (generateId() as MessageID);

          // Stream the complete text via WebSocket for instant display
          if (streamingCallbacks && fullText) {
            try {
              if (!currentMessageId) {
                await streamingCallbacks.onStreamStart(assistantMessageId, {
                  session_id: sessionId,
                  task_id: taskId,
                  role: MessageRole.ASSISTANT,
                  timestamp: new Date().toISOString(),
                });
                streamStarted = true;
                await streamingCallbacks.onStreamChunk(assistantMessageId, fullText);
              }
              if (streamStarted) {
                await streamingCallbacks.onStreamEnd(assistantMessageId);
              }
            } catch (err) {
              console.error(`[Copilot] Streaming callback failed for ${assistantMessageId}:`, err);
              try {
                await streamingCallbacks.onStreamError(
                  assistantMessageId,
                  err instanceof Error ? err : new Error(String(err))
                );
              } catch {
                /* best-effort */
              }
            }
          }

          // Create complete message in DB
          await this.createAssistantMessage(
            sessionId,
            assistantMessageId,
            textOnlyContent,
            undefined,
            taskId,
            nextIndex++,
            resolvedModel,
            usageForMessage
          );
          assistantMessageIds.push(assistantMessageId);

          currentMessageId = null;
          streamStarted = false;
        }
      }
    }

    return {
      userMessageId: userMessage.message_id,
      assistantMessageIds,
      tokenUsage,
      contextWindow: undefined,
      contextWindowLimit: undefined,
      model: resolvedModel || DEFAULT_COPILOT_MODEL,
      rawSdkResponse,
      wasStopped,
    };
  }

  /**
   * Capture and store Copilot SDK session ID for conversation continuity
   * @private
   */
  private async captureSessionId(sessionId: SessionID, sdkSessionId: string): Promise<void> {
    console.log(`🔑 Captured Copilot session ID for Agor session ${sessionId}: ${sdkSessionId}`);

    if (this.sessionsRepo) {
      const existingSession = await this.sessionsRepo.findById(sessionId);
      if (existingSession?.sdk_session_id) {
        if (existingSession.sdk_session_id !== sdkSessionId) {
          console.warn(
            `⚠️  Copilot returned new session_id ${sdkSessionId.substring(0, 8)} but session already has ${existingSession.sdk_session_id.substring(0, 8)} — keeping original`
          );
        }
        return;
      }
      await this.sessionsRepo.update(sessionId, { sdk_session_id: sdkSessionId });
      console.log(`💾 Stored Copilot session ID in Agor session`);
    }
  }

  /**
   * Create complete assistant message in database
   * @private
   */
  private async createAssistantMessage(
    sessionId: SessionID,
    messageId: MessageID,
    content: Array<{
      type: string;
      text?: string;
      id?: string;
      name?: string;
      input?: Record<string, unknown>;
    }>,
    toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }> | undefined,
    taskId: TaskID | undefined,
    nextIndex: number,
    resolvedModel?: string,
    tokenUsage?: TokenUsage
  ): Promise<Message> {
    const textBlocks = content.filter((b) => b.type === 'text').map((b) => b.text || '');
    const fullTextContent = textBlocks.join('');
    const contentPreview = fullTextContent.substring(0, 200);

    const message: Message = {
      message_id: messageId,
      session_id: sessionId,
      type: 'assistant',
      role: MessageRole.ASSISTANT,
      index: nextIndex,
      timestamp: new Date().toISOString(),
      content_preview: contentPreview,
      content: content as Message['content'],
      tool_uses: toolUses,
      task_id: taskId,
      metadata: {
        model: resolvedModel || DEFAULT_COPILOT_MODEL,
        tokens: {
          input: tokenUsage?.input_tokens ?? 0,
          output: tokenUsage?.output_tokens ?? 0,
        },
      },
    };

    await this.messagesService?.create(message);

    if (taskId && resolvedModel && this.tasksService) {
      await this.tasksService.patch(taskId, { model: resolvedModel });
    }

    return message;
  }

  /**
   * Execute a prompt against a session (non-streaming version)
   */
  async executePrompt(
    sessionId: SessionID,
    prompt: string,
    taskId?: TaskID,
    permissionMode?: PermissionMode,
    messageSource?: MessageSource
  ): Promise<CopilotExecutionResult> {
    // Delegate to streaming version without callbacks
    return this.executePromptWithStreaming(
      sessionId,
      prompt,
      taskId,
      permissionMode,
      undefined, // no streaming callbacks
      undefined, // no abort controller
      messageSource
    );
  }

  /**
   * Stop currently executing task in session
   */
  async stopTask(
    sessionId: string,
    taskId?: string
  ): Promise<{
    success: boolean;
    partialResult?: Partial<{ taskId: string; status: 'completed' | 'failed' | 'cancelled' }>;
    reason?: string;
  }> {
    if (!this.promptService) {
      return {
        success: false,
        reason: 'CopilotTool not initialized with prompt service',
      };
    }

    const result = this.promptService.stopTask(sessionId as SessionID);

    if (result.success) {
      return {
        success: true,
        partialResult: {
          taskId: taskId || 'unknown',
          status: 'cancelled',
        },
      };
    }

    return result;
  }

  // ============================================================
  // Token Accounting
  // ============================================================

  /**
   * Normalize Copilot SDK response to common format
   *
   * @deprecated Use normalizeRawSdkResponse() from utils/sdk-normalizer instead
   */
  normalizedSdkResponse(_rawResponse: RawSdkResponse): NormalizedSdkResponse {
    throw new Error(
      'normalizedSdkResponse() is deprecated - use normalizeRawSdkResponse() from utils/sdk-normalizer instead'
    );
  }

  /**
   * Compute cumulative context window usage for a Copilot session
   *
   * Copilot SDK provides usage data via assistant.usage events.
   * The input_tokens field includes the full conversation history up to that point.
   */
  async computeContextWindow(
    sessionId: string,
    _currentTaskId?: string,
    currentRawSdkResponse?: unknown
  ): Promise<number> {
    if (currentRawSdkResponse) {
      const response = currentRawSdkResponse as {
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      const inputTokens = response.usage?.input_tokens || 0;
      const outputTokens = response.usage?.output_tokens || 0;
      const cumulativeTokens = inputTokens + outputTokens;
      console.log(
        `✅ Computed context window for Copilot session ${sessionId}: ${cumulativeTokens} tokens`
      );
      return cumulativeTokens;
    }

    // Avoid database queries during task UPDATE to prevent deadlocks
    console.warn(
      `⚠️  computeContextWindow called without currentRawSdkResponse for session ${sessionId}. ` +
        'Returning 0 to avoid database deadlock.'
    );
    return 0;
  }
}
