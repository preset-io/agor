/**
 * Gemini Tool Implementation
 *
 * Current capabilities:
 * - ✅ Live execution via @google/gemini-cli-core SDK
 * - ✅ Token-level streaming with AsyncGenerator
 * - ✅ Permission modes (ask, auto, allow-all)
 * - ✅ Session continuity via setHistory()
 * - ❌ Import sessions (deferred - need checkpoint format)
 * - ❌ Session creation (handled via live execution)
 */

import { execSync } from 'node:child_process';
import type { Database } from '../../db/client';
import type { MCPServerRepository } from '../../db/repositories/mcp-servers';
import type { MessagesRepository } from '../../db/repositories/messages';
import type { SessionMCPServerRepository } from '../../db/repositories/session-mcp-servers';
import type { SessionRepository } from '../../db/repositories/sessions';
import type { WorktreeRepository } from '../../db/repositories/worktrees';
import { generateId } from '../../lib/ids';
import {
  type Message,
  type MessageID,
  MessageRole,
  type PermissionMode,
  type SessionID,
  type TaskID,
} from '../../types';
import type { NormalizedSdkResponse, RawSdkResponse } from '../../types/sdk-response';
import type { TokenUsage } from '../../types/token-usage';
import type { ITool, StreamingCallbacks, ToolCapabilities } from '../base';
import type { MessagesService, TasksService } from '../claude/claude-tool';
import { DEFAULT_GEMINI_MODEL } from './models';
import { GeminiPromptService } from './prompt-service';

interface GeminiExecutionResult {
  userMessageId: MessageID;
  assistantMessageIds: MessageID[];
  tokenUsage?: TokenUsage;
  contextWindow?: number;
  contextWindowLimit?: number;
  model?: string;
  rawSdkResponse?: unknown; // Raw SDK event from Gemini
}

export class GeminiTool implements ITool {
  readonly toolType = 'gemini' as const;
  readonly name = 'Google Gemini';

  private promptService?: GeminiPromptService;

  constructor(
    private messagesRepo?: MessagesRepository,
    sessionsRepo?: SessionRepository,
    apiKey?: string,
    private messagesService?: MessagesService,
    private tasksService?: TasksService,
    worktreesRepo?: WorktreeRepository,
    mcpServerRepo?: MCPServerRepository,
    sessionMCPRepo?: SessionMCPServerRepository,
    mcpEnabled?: boolean,
    db?: Database
  ) {
    if (messagesRepo && sessionsRepo) {
      this.promptService = new GeminiPromptService(
        messagesRepo,
        sessionsRepo,
        apiKey,
        worktreesRepo,
        mcpServerRepo,
        sessionMCPRepo,
        mcpEnabled,
        db,
        tasksService
      );
    }
  }

  getCapabilities(): ToolCapabilities {
    return {
      supportsSessionImport: false, // ❌ Deferred until checkpoint format is documented
      supportsSessionCreate: false, // ❌ Not exposed (handled via executeTask)
      supportsLiveExecution: true, // ✅ Via @google/gemini-cli-core SDK
      supportsSessionFork: false,
      supportsChildSpawn: false,
      supportsGitState: false, // Agor manages git state
      supportsStreaming: true, // ✅ Via sendMessageStream()
    };
  }

  async checkInstalled(): Promise<boolean> {
    try {
      // Check if gemini CLI is installed
      execSync('which gemini', { encoding: 'utf-8' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Execute a prompt against a session WITH real-time streaming
   *
   * Creates user message, streams response chunks from Gemini, then creates complete assistant messages.
   * Calls streamingCallbacks during message generation for real-time UI updates.
   *
   * @param sessionId - Session to execute prompt in
   * @param prompt - User prompt text
   * @param taskId - Optional task ID for linking messages
   * @param permissionMode - Permission mode for tool execution ('ask' | 'auto' | 'allow-all')
   * @param streamingCallbacks - Optional callbacks for real-time streaming (enables typewriter effect)
   * @returns User message ID and array of assistant message IDs
   */
  async executePromptWithStreaming(
    sessionId: SessionID,
    prompt: string,
    taskId?: TaskID,
    permissionMode?: PermissionMode,
    streamingCallbacks?: StreamingCallbacks
  ): Promise<GeminiExecutionResult> {
    if (!this.promptService || !this.messagesRepo) {
      throw new Error('GeminiTool not initialized with repositories for live execution');
    }

    if (!this.messagesService) {
      throw new Error('GeminiTool not initialized with messagesService for live execution');
    }

    // Get next message index
    const existingMessages = await this.messagesRepo.findBySessionId(sessionId);
    let nextIndex = existingMessages.length;

    // Create user message
    const userMessage = await this.createUserMessage(sessionId, prompt, taskId, nextIndex++);

    // Execute prompt via Gemini SDK with streaming
    const assistantMessageIds: MessageID[] = [];
    let resolvedModel: string | undefined;
    let currentMessageId: MessageID | null = null;
    let tokenUsage: TokenUsage | undefined;
    let streamStartTime = Date.now();
    let firstTokenTime: number | null = null;
    let rawSdkResponse: unknown;

    for await (const event of this.promptService.promptSessionStreaming(
      sessionId,
      prompt,
      taskId,
      permissionMode
    )) {
      // Capture resolved model from partial/complete events
      if (!resolvedModel) {
        if (event.type === 'partial') {
          resolvedModel = event.resolvedModel;
        } else if (event.type === 'complete') {
          resolvedModel = event.resolvedModel;
        }
      }

      // Capture token usage from complete event
      if (event.type === 'complete' && event.usage) {
        tokenUsage = event.usage;
      }

      // Capture raw SDK response for token accounting
      if (event.type === 'complete' && event.rawSdkResponse) {
        rawSdkResponse = event.rawSdkResponse;
      }

      // Handle partial streaming events (token-level chunks)
      if (event.type === 'partial' && event.textChunk) {
        // Start new message if needed
        if (!currentMessageId) {
          currentMessageId = generateId() as MessageID;
          firstTokenTime = Date.now();
          const ttfb = firstTokenTime - streamStartTime;
          console.debug(`⏱️  [Gemini] TTFB: ${ttfb}ms`);

          if (streamingCallbacks) {
            streamingCallbacks.onStreamStart(currentMessageId, {
              session_id: sessionId,
              task_id: taskId,
              role: MessageRole.ASSISTANT,
              timestamp: new Date().toISOString(),
            });
          }
        }

        // Emit chunk immediately
        if (streamingCallbacks) {
          streamingCallbacks.onStreamChunk(currentMessageId, event.textChunk);
        }
      }
      // Handle complete message (save to database)
      else if (event.type === 'complete' && event.content) {
        // End streaming if active
        if (currentMessageId && streamingCallbacks) {
          const streamEndTime = Date.now();
          streamingCallbacks.onStreamEnd(currentMessageId);
          const totalTime = streamEndTime - streamStartTime;
          const streamingTime = firstTokenTime ? streamEndTime - firstTokenTime : 0;
          console.debug(
            `⏱️  [Streaming] Complete - TTFB: ${firstTokenTime ? firstTokenTime - streamStartTime : 0}ms, streaming: ${streamingTime}ms, total: ${totalTime}ms`
          );
        }

        // Use existing message ID or generate new one
        const assistantMessageId = currentMessageId || (generateId() as MessageID);

        // Create complete message in DB
        await this.createAssistantMessage(
          sessionId,
          assistantMessageId,
          event.content,
          event.toolUses,
          taskId,
          nextIndex++,
          resolvedModel,
          tokenUsage
        );
        assistantMessageIds.push(assistantMessageId);

        // Reset for next message
        currentMessageId = null;
        streamStartTime = Date.now();
        firstTokenTime = null;
      }
    }

    return {
      userMessageId: userMessage.message_id,
      assistantMessageIds,
      tokenUsage,
      // Gemini SDK doesn't provide contextWindow/contextWindowLimit
      contextWindow: undefined,
      contextWindowLimit: undefined,
      model: resolvedModel,
      rawSdkResponse,
    };
  }

  /**
   * Create user message in database
   * @private
   */
  private async createUserMessage(
    sessionId: SessionID,
    prompt: string,
    taskId: TaskID | undefined,
    nextIndex: number
  ): Promise<Message> {
    const userMessage: Message = {
      message_id: generateId() as MessageID,
      session_id: sessionId,
      type: 'user',
      role: MessageRole.USER,
      index: nextIndex,
      timestamp: new Date().toISOString(),
      content_preview: prompt.substring(0, 200),
      content: prompt,
      task_id: taskId,
    };

    await this.messagesService?.create(userMessage);
    return userMessage;
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
    // Extract text content for preview
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
        model: resolvedModel || DEFAULT_GEMINI_MODEL,
        tokens: {
          input: tokenUsage?.input_tokens || 0,
          output: tokenUsage?.output_tokens || 0,
        },
      },
    };

    await this.messagesService?.create(message);

    // If task exists, update it with resolved model
    if (taskId && resolvedModel && this.tasksService) {
      await this.tasksService.patch(taskId, { model: resolvedModel });
    }

    return message;
  }

  /**
   * Execute a prompt against a session (non-streaming version)
   *
   * Creates user message, collects response from Gemini, creates assistant messages.
   * Returns user message ID and array of assistant message IDs.
   *
   * @param sessionId - Session to execute prompt in
   * @param prompt - User prompt text
   * @param taskId - Optional task ID for linking messages
   * @param permissionMode - Permission mode for tool execution ('ask' | 'auto' | 'allow-all')
   */
  async executePrompt(
    sessionId: SessionID,
    prompt: string,
    taskId?: TaskID,
    permissionMode?: PermissionMode
  ): Promise<GeminiExecutionResult> {
    if (!this.promptService || !this.messagesRepo) {
      throw new Error('GeminiTool not initialized with repositories for live execution');
    }

    if (!this.messagesService) {
      throw new Error('GeminiTool not initialized with messagesService for live execution');
    }

    // Get next message index
    const existingMessages = await this.messagesRepo.findBySessionId(sessionId);
    let nextIndex = existingMessages.length;

    // Create user message
    const userMessage = await this.createUserMessage(sessionId, prompt, taskId, nextIndex++);

    // Execute prompt via Gemini SDK
    const assistantMessageIds: MessageID[] = [];
    let resolvedModel: string | undefined;
    let tokenUsage: TokenUsage | undefined;
    let _contextWindow: number | undefined;
    let _contextWindowLimit: number | undefined;
    let rawSdkResponse: unknown;

    for await (const event of this.promptService.promptSessionStreaming(
      sessionId,
      prompt,
      taskId,
      permissionMode
    )) {
      // Capture resolved model from partial/complete events
      if (!resolvedModel) {
        if (event.type === 'partial') {
          resolvedModel = event.resolvedModel;
        } else if (event.type === 'complete') {
          resolvedModel = event.resolvedModel;
        }
      }

      // Capture token usage from complete event
      if (event.type === 'complete' && event.usage) {
        tokenUsage = event.usage;
      }

      // Skip partial and tool events in non-streaming mode
      if (
        event.type === 'partial' ||
        event.type === 'tool_start' ||
        event.type === 'tool_complete'
      ) {
        continue;
      }

      // Handle complete messages only
      if (event.type === 'complete' && event.content && event.content.length > 0) {
        const messageId = generateId() as MessageID;
        await this.createAssistantMessage(
          sessionId,
          messageId,
          event.content,
          event.toolUses,
          taskId,
          nextIndex++,
          resolvedModel,
          tokenUsage
        );
        assistantMessageIds.push(messageId);
      }
    }

    return {
      userMessageId: userMessage.message_id,
      assistantMessageIds,
      tokenUsage,
      // Gemini SDK doesn't provide contextWindow/contextWindowLimit
      contextWindow: undefined,
      contextWindowLimit: undefined,
      model: resolvedModel,
      rawSdkResponse,
    };
  }

  /**
   * Stop currently executing task in session
   *
   * Uses AbortController to gracefully cancel the streaming request.
   *
   * @param sessionId - Session identifier
   * @param taskId - Optional task ID (not used for Gemini, session-level stop)
   * @returns Success status and reason if failed
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
        reason: 'GeminiTool not initialized with prompt service',
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
  // Token Accounting (NEW)
  // ============================================================

  /**
   * Normalize Gemini SDK response to common format
   *
   * @deprecated This method is deprecated - use normalizeRawSdkResponse() from utils/sdk-normalizer instead
   * This stub remains for API compatibility but should not be used.
   */
  normalizedSdkResponse(_rawResponse: RawSdkResponse): NormalizedSdkResponse {
    throw new Error(
      'normalizedSdkResponse() is deprecated - use normalizeRawSdkResponse() from utils/sdk-normalizer instead'
    );
  }

  /**
   * Compute cumulative context window usage for a Gemini session
   *
   * For Gemini, the SDK already provides cumulative token counts in each task's response.
   * The promptTokenCount field includes the full conversation history up to that point.
   * We just need to extract and return the contextWindow from the current task's SDK response.
   *
   * @param sessionId - Session ID to compute context for
   * @param currentTaskId - Optional current task ID (not used for Gemini, kept for interface consistency)
   * @param currentRawSdkResponse - Optional raw SDK response from current task (if available in memory)
   * @returns Promise resolving to computed context window usage in tokens
   */
  async computeContextWindow(
    sessionId: string,
    _currentTaskId?: string,
    currentRawSdkResponse?: unknown
  ): Promise<number> {
    // Gemini SDK provides cumulative tokens in usageMetadata
    // Simply extract promptTokenCount + candidatesTokenCount from the raw response
    if (currentRawSdkResponse) {
      const response =
        currentRawSdkResponse as import('../../types/sdk-response').GeminiSdkResponse;
      const inputTokens = response.value?.usageMetadata?.promptTokenCount || 0;
      const outputTokens = response.value?.usageMetadata?.candidatesTokenCount || 0;
      const cumulativeTokens = inputTokens + outputTokens;
      console.log(
        `✅ Computed context window for Gemini session ${sessionId}: ${cumulativeTokens} tokens (from current task)`
      );
      return cumulativeTokens;
    }

    // IMPORTANT: Do NOT query database when currentRawSdkResponse is not provided
    // This method is called during task UPDATE operations, and querying the database
    // during a pending UPDATE causes deadlocks in PostgreSQL due to read-while-write
    // in the same transaction. The caller should ALWAYS provide currentRawSdkResponse
    // during task completion.
    console.warn(
      `⚠️  computeContextWindow called without currentRawSdkResponse for session ${sessionId}. ` +
        'This should not happen during task completion. Returning 0 to avoid database deadlock.'
    );
    return 0;
  }
}
