/**
 * Codex Tool Implementation
 *
 * Current capabilities:
 * - ✅ Live execution via OpenAI Codex SDK
 * - ❌ Import sessions (deferred - need real session JSONL format)
 * - ❌ Session creation (handled via live execution)
 */

import { execSync } from 'node:child_process';
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
import {
  clearToolInvocationState,
  enrichContentBlocks,
  registerToolInvocationStart,
} from '../base/diff-enrichment.js';
import type {
  ITool,
  MessagesService,
  StreamingCallbacks,
  TasksService,
  TasksStreamingService,
  ToolCapabilities,
} from '../base/index.js';
import { createUserMessage } from '../claude/message-builder.js';
import { DEFAULT_CODEX_MODEL } from './models.js';
import { CodexPromptService } from './prompt-service.js';
import { extractCodexContextWindowUsage } from './usage.js';

interface CodexExecutionResult {
  userMessageId: MessageID;
  assistantMessageIds: MessageID[];
  tokenUsage?: TokenUsage;
  contextWindow?: number;
  contextWindowLimit?: number;
  model?: string;
  rawSdkResponse?: unknown; // Raw SDK event from Codex
  rawContextUsage?: {
    totalTokens: number;
    maxTokens: number;
    percentage: number;
  };
  wasStopped?: boolean; // True if execution was stopped early via stopTask()
}

export class CodexTool implements ITool {
  readonly toolType = 'codex' as const;
  readonly name = 'OpenAI Codex';

  private promptService?: CodexPromptService;
  private messagesRepo?: MessagesRepository;
  private sessionsRepo?: SessionRepository;
  private worktreesRepo?: WorktreeRepository;
  private messagesService?: MessagesService;
  private tasksService?: TasksService;
  private tasksStreamingService?: TasksStreamingService;

  constructor(
    messagesRepo?: MessagesRepository,
    sessionsRepo?: SessionRepository,
    sessionMCPServerRepo?: SessionMCPServerRepository,
    worktreesRepo?: WorktreeRepository,
    reposRepo?: RepoRepository,
    apiKey?: string,
    messagesService?: MessagesService,
    tasksService?: TasksService,
    tasksStreamingService?: TasksStreamingService,
    useNativeAuth?: boolean,
    mcpServerRepo?: MCPServerRepository,
    usersRepo?: UsersRepository
  ) {
    this.messagesRepo = messagesRepo;
    this.sessionsRepo = sessionsRepo;
    this.worktreesRepo = worktreesRepo;
    this.messagesService = messagesService;
    this.tasksService = tasksService;
    this.tasksStreamingService = tasksStreamingService;

    if (messagesRepo && sessionsRepo) {
      this.promptService = new CodexPromptService(
        messagesRepo,
        sessionsRepo,
        sessionMCPServerRepo,
        worktreesRepo,
        reposRepo,
        apiKey,
        mcpServerRepo,
        usersRepo,
        useNativeAuth ?? false
      );
    }
  }

  getCapabilities(): ToolCapabilities {
    return {
      supportsSessionImport: false, // ❌ Deferred until we have real JSONL format
      supportsSessionCreate: false, // ❌ Not exposed (handled via executeTask)
      supportsLiveExecution: true, // ✅ Via Codex SDK
      supportsSessionFork: true,
      supportsChildSpawn: false,
      supportsGitState: false, // Agor manages git state
      supportsStreaming: true, // ✅ Via runStreamed()
    };
  }

  async checkInstalled(): Promise<boolean> {
    try {
      // Check if codex CLI is installed
      execSync('which codex', { encoding: 'utf-8' });
      return true;
    } catch {
      return false;
    }
  }

  private async emitTaskEvent(
    event: 'tool:start' | 'tool:complete' | 'thinking:chunk',
    data: Record<string, unknown>
  ): Promise<void> {
    if (this.tasksStreamingService) {
      await this.tasksStreamingService.create({ event, data });
      return;
    }

    // Fallback for environments that don't expose /tasks/streaming.
    this.tasksService?.emit(event, data);
  }

  /**
   * Execute a prompt against a session WITH real-time streaming
   *
   * Creates user message, streams response chunks from Codex, then creates complete assistant messages.
   * Calls streamingCallbacks during message generation for real-time UI updates.
   *
   * @param sessionId - Session to execute prompt in
   * @param prompt - User prompt text
   * @param taskId - Optional task ID for linking messages
   * @param permissionMode - Permission mode for tool execution ('ask' | 'auto' | 'allow-all')
   * @param streamingCallbacks - Optional callbacks for real-time streaming (enables typewriter effect)
   * @param abortController - Optional AbortController for cancellation support
   * @returns User message ID and array of assistant message IDs
   */
  async executePromptWithStreaming(
    sessionId: SessionID,
    prompt: string,
    taskId?: TaskID,
    permissionMode?: PermissionMode,
    streamingCallbacks?: StreamingCallbacks,
    abortController?: AbortController,
    messageSource?: MessageSource
  ): Promise<CodexExecutionResult> {
    if (!this.promptService || !this.messagesRepo) {
      throw new Error('CodexTool not initialized with repositories for live execution');
    }

    if (!this.messagesService) {
      throw new Error('CodexTool not initialized with messagesService for live execution');
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

    // Execute prompt via Codex SDK with streaming
    const assistantMessageIds: MessageID[] = [];
    let capturedThreadId: string | undefined;
    let resolvedModel: string | undefined;
    let currentMessageId: MessageID | null = null;
    let tokenUsage: TokenUsage | undefined;
    let rawContextUsage:
      | {
          totalTokens: number;
          maxTokens: number;
          percentage: number;
        }
      | undefined;
    let _streamStartTime = Date.now();
    let _firstTokenTime: number | null = null;
    let rawSdkResponse: unknown;
    let streamStarted = false; // tracks whether onStreamStart succeeded (for safe onStreamEnd)
    let wasStopped = false;
    let workingDirectory: string | undefined;
    const pendingToolMessageIds = new Map<string, MessageID>();
    const pendingSnapshotToolIds = new Set<string>();
    const snapshotContext = { snapshotScope: sessionId };

    if (this.sessionsRepo && this.worktreesRepo) {
      const session = await this.sessionsRepo.findById(sessionId);
      if (session) {
        const worktree = await this.worktreesRepo.findById(session.worktree_id);
        workingDirectory = worktree?.path;
      }
    }

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
        console.log(`🛑 Codex execution was stopped for session ${sessionId}`);
        for (const toolUseId of pendingSnapshotToolIds) {
          clearToolInvocationState(toolUseId, snapshotContext);
        }
        pendingSnapshotToolIds.clear();
        continue; // Skip processing this event
      }
      // Capture resolved model from partial/complete events
      if (!resolvedModel) {
        if (event.type === 'partial') {
          resolvedModel = event.resolvedModel;
        } else if (event.type === 'complete') {
          resolvedModel = event.resolvedModel;
        }
      }

      // Handle tool execution start (live UI indicator)
      if (event.type === 'tool_start') {
        registerToolInvocationStart(event.toolUse.id, event.toolUse.name, event.toolUse.input, {
          ...(workingDirectory ? { workingDirectory } : {}),
          ...snapshotContext,
        });
        pendingSnapshotToolIds.add(event.toolUse.id);

        if (taskId) {
          await this.emitTaskEvent('tool:start', {
            task_id: taskId,
            session_id: sessionId,
            tool_use_id: event.toolUse.id,
            tool_name: event.toolUse.name,
          });
        }

        // Create tool row immediately so UI shows "running" state.
        const toolMessageId = generateId() as MessageID;
        await this.createAssistantMessage(
          sessionId,
          toolMessageId,
          [
            {
              type: 'tool_use',
              id: event.toolUse.id,
              name: event.toolUse.name,
              input: event.toolUse.input,
            },
          ],
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
        pendingToolMessageIds.set(event.toolUse.id, toolMessageId);
      }

      if (event.type === 'complete' && event.usage) {
        tokenUsage = event.usage;
      }

      if (event.type === 'complete' && event.rawContextUsage) {
        rawContextUsage = event.rawContextUsage;
      }

      // Capture raw SDK response for token accounting
      if (event.type === 'complete' && event.rawSdkEvent) {
        rawSdkResponse = event.rawSdkEvent;
      }

      // Capture Codex thread ID
      if (!capturedThreadId && event.threadId) {
        capturedThreadId = event.threadId;
        await this.captureThreadId(sessionId, capturedThreadId);
      }

      // Handle partial streaming events (token-level chunks)
      // NOTE: Codex SDK does NOT emit partial/delta events for text — agent_message text
      // arrives all at once via item.completed → complete events (which are handled below).
      // This code path is kept for future compatibility if OpenAI adds true token-level streaming.
      if (event.type === 'partial' && event.textChunk) {
        // Start new message if needed
        if (!currentMessageId) {
          const newMessageId = generateId() as MessageID;
          _firstTokenTime = Date.now();

          if (streamingCallbacks) {
            try {
              await streamingCallbacks.onStreamStart(newMessageId, {
                session_id: sessionId,
                task_id: taskId,
                role: MessageRole.ASSISTANT,
                timestamp: new Date().toISOString(),
              });
              // Only track message ID after successful start
              currentMessageId = newMessageId;
              streamStarted = true;
            } catch (err) {
              console.error(`[Codex] Streaming start failed for ${newMessageId}:`, err);
              try {
                await streamingCallbacks.onStreamError(
                  newMessageId,
                  err instanceof Error ? err : new Error(String(err))
                );
              } catch {
                /* best-effort */
              }
            }
          } else {
            currentMessageId = newMessageId;
          }
        }

        // Emit chunk immediately
        if (streamingCallbacks && currentMessageId) {
          try {
            await streamingCallbacks.onStreamChunk(currentMessageId, event.textChunk);
          } catch (err) {
            console.error(`[Codex] Streaming chunk failed for ${currentMessageId}:`, err);
            try {
              await streamingCallbacks.onStreamError(
                currentMessageId,
                err instanceof Error ? err : new Error(String(err))
              );
            } catch {
              /* best-effort */
            }
          }
        }
      }
      // Handle tool completion (create message immediately for live updates)
      else if (event.type === 'tool_complete') {
        if (taskId) {
          await this.emitTaskEvent('tool:complete', {
            task_id: taskId,
            session_id: sessionId,
            tool_use_id: event.toolUse.id,
          });
        }

        const toolResultContent =
          event.toolUse.output !== undefined
            ? event.toolUse.output
            : event.toolUse.status
              ? `[${event.toolUse.status}]`
              : '';
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
                  content: toolResultContent,
                  is_error: event.toolUse.status === 'failed' || event.toolUse.status === 'error',
                },
              ]
            : []),
        ];

        // Best-effort diff enrichment for Edit/Write tool results
        enrichContentBlocks(toolContent, {
          ...(workingDirectory ? { workingDirectory } : {}),
          ...snapshotContext,
        });
        clearToolInvocationState(event.toolUse.id, snapshotContext);
        pendingSnapshotToolIds.delete(event.toolUse.id);

        const existingToolMessageId = pendingToolMessageIds.get(event.toolUse.id);
        if (existingToolMessageId) {
          await this.messagesService?.patch(existingToolMessageId, {
            content: toolContent as Message['content'],
            content_preview:
              typeof toolResultContent === 'string' ? toolResultContent.substring(0, 200) : '',
          });
          pendingToolMessageIds.delete(event.toolUse.id);
        } else {
          // Fallback path if start event wasn't observed.
          const toolMessageId = generateId() as MessageID;
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
      }
      // Handle complete message (save to database)
      else if (event.type === 'complete' && event.content) {
        const usageForMessage = event.usage ?? tokenUsage;
        // Filter out tool_use and tool_result blocks (already saved via tool_complete events),
        // but keep text + thinking blocks so Codex reasoning is visible in the UI.
        const nonToolContent = event.content.filter(
          (block) => block.type === 'text' || block.type === 'thinking'
        );

        // Only create message if there's non-tool content (not just tools)
        if (nonToolContent.length > 0) {
          // Extract full text for streaming callback
          const fullText = nonToolContent
            .filter((block) => block.type === 'text')
            .map((block) => (block as { text?: string }).text || '')
            .join('');
          const fullThinking = nonToolContent
            .filter((block) => block.type === 'thinking')
            .map((block) => (block as { text?: string }).text || '')
            .join('');

          // Use existing message ID from streaming (if any) or generate new
          const assistantMessageId = currentMessageId || (generateId() as MessageID);

          // Codex SDK doesn't support token-level text streaming, but we can still
          // use streaming callbacks to show text immediately via WebSocket before DB write.
          // This sends the complete text as a single "chunk" for instant display.
          if (streamingCallbacks && fullText) {
            try {
              if (!currentMessageId) {
                // No partial path — send full start/chunk/end sequence
                await streamingCallbacks.onStreamStart(assistantMessageId, {
                  session_id: sessionId,
                  task_id: taskId,
                  role: MessageRole.ASSISTANT,
                  timestamp: new Date().toISOString(),
                });
                streamStarted = true;
                await streamingCallbacks.onStreamChunk(assistantMessageId, fullText);
              }
              // Only close stream if one was successfully started
              if (streamStarted) {
                await streamingCallbacks.onStreamEnd(assistantMessageId);
              }
            } catch (err) {
              console.error(`[Codex] Streaming callback failed for ${assistantMessageId}:`, err);
              // Notify UI so it can clear spinner/pending state
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

          // Codex reasoning is not token-streamed by SDK. Emit a synthetic single
          // thinking chunk so users see reasoning activity in real time.
          if (streamingCallbacks && fullThinking && !fullText) {
            try {
              if (streamingCallbacks.onThinkingStart) {
                await streamingCallbacks.onThinkingStart(assistantMessageId, {});
              }
              if (streamingCallbacks.onThinkingChunk) {
                await streamingCallbacks.onThinkingChunk(assistantMessageId, fullThinking);
              }
              if (streamingCallbacks.onThinkingEnd) {
                await streamingCallbacks.onThinkingEnd(assistantMessageId);
              }
            } catch (err) {
              console.error(`[Codex] Thinking callback failed for ${assistantMessageId}:`, err);
            }
          }

          // Create complete message in DB (non-tool content only, tools already saved)
          await this.createAssistantMessage(
            sessionId,
            assistantMessageId,
            nonToolContent,
            undefined, // No tool uses in this message (already saved separately)
            taskId,
            nextIndex++,
            resolvedModel,
            usageForMessage
          );
          assistantMessageIds.push(assistantMessageId);

          // Reset for next message
          currentMessageId = null;
          streamStarted = false;
        }

        _streamStartTime = Date.now();
        _firstTokenTime = null;
      }
    }

    return {
      userMessageId: userMessage.message_id,
      assistantMessageIds,
      tokenUsage,
      // Codex SDK doesn't provide contextWindow/contextWindowLimit
      contextWindow: undefined,
      contextWindowLimit: undefined,
      model: resolvedModel || DEFAULT_CODEX_MODEL,
      rawSdkResponse,
      rawContextUsage,
      wasStopped,
    };
  }

  /**
   * Capture and store Codex thread ID for conversation continuity.
   * Throws if the Codex CLI returned a different thread than the one we asked to resume,
   * which means the original thread file was lost (e.g. container rebuild wiped /tmp).
   * @private
   */
  private async captureThreadId(sessionId: SessionID, threadId: string): Promise<void> {
    console.log(`🔑 Captured Codex thread ID for Agor session ${sessionId}: ${threadId}`);

    if (this.sessionsRepo) {
      const existingSession = await this.sessionsRepo.findById(sessionId);
      if (existingSession?.sdk_session_id) {
        if (existingSession.sdk_session_id !== threadId) {
          const msg =
            `Codex thread lost: asked to resume ${existingSession.sdk_session_id.substring(0, 8)} ` +
            `but Codex started a new thread ${threadId.substring(0, 8)}. ` +
            `The previous conversation history is no longer available (the thread file was likely deleted when the environment was rebuilt). ` +
            `Please start a new session to continue.`;
          console.error(`❌ ${msg}`);
          throw new Error(msg);
        }
        return;
      }
      await this.sessionsRepo.update(sessionId, { sdk_session_id: threadId });
      console.log(`💾 Stored Codex thread ID in Agor session`);
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
    // Extract preview text (prefer normal text, then thinking text)
    const textBlocks = content.filter((b) => b.type === 'text').map((b) => b.text || '');
    const fullTextContent = textBlocks.join('');
    const fallbackThinking = content
      .filter((b) => b.type === 'thinking')
      .map((b) => b.text || '')
      .join('');
    const contentPreview = (fullTextContent || fallbackThinking).substring(0, 200);

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
        model: resolvedModel || DEFAULT_CODEX_MODEL,
        tokens: {
          input: tokenUsage?.input_tokens ?? 0,
          output: tokenUsage?.output_tokens ?? 0,
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
   * Creates user message, collects response from Codex, creates assistant messages.
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
    permissionMode?: PermissionMode,
    messageSource?: MessageSource
  ): Promise<CodexExecutionResult> {
    if (!this.promptService || !this.messagesRepo) {
      throw new Error('CodexTool not initialized with repositories for live execution');
    }

    if (!this.messagesService) {
      throw new Error('CodexTool not initialized with messagesService for live execution');
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

    // Execute prompt via Codex SDK
    const assistantMessageIds: MessageID[] = [];
    let capturedThreadId: string | undefined;
    let resolvedModel: string | undefined;
    let tokenUsage: TokenUsage | undefined;
    let _contextWindow: number | undefined;
    let _contextWindowLimit: number | undefined;
    let rawSdkResponse: unknown;
    let rawContextUsage:
      | {
          totalTokens: number;
          maxTokens: number;
          percentage: number;
        }
      | undefined;
    let wasStopped = false;

    for await (const event of this.promptService.promptSessionStreaming(
      sessionId,
      prompt,
      taskId,
      permissionMode
    )) {
      // Detect if execution was stopped early
      if (event.type === 'stopped') {
        wasStopped = true;
        console.log(`🛑 Codex execution was stopped for session ${sessionId}`);
        continue; // Skip processing this event
      }

      // Capture resolved model from partial/complete events
      if (!resolvedModel) {
        if (event.type === 'partial') {
          resolvedModel = event.resolvedModel;
        } else if (event.type === 'complete') {
          resolvedModel = event.resolvedModel;
        }
      }

      if (event.type === 'complete' && event.usage) {
        tokenUsage = event.usage;
      }

      if (event.type === 'complete' && event.rawContextUsage) {
        rawContextUsage = event.rawContextUsage;
      }

      // Capture raw SDK response for token accounting
      if (event.type === 'complete' && event.rawSdkEvent) {
        rawSdkResponse = event.rawSdkEvent;
      }

      // Capture Codex thread ID
      if (!capturedThreadId && event.threadId) {
        capturedThreadId = event.threadId;
        await this.captureThreadId(sessionId, capturedThreadId);
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
      if (event.type === 'complete' && event.content) {
        const messageId = generateId() as MessageID;
        const usageForMessage = event.usage ?? tokenUsage;
        await this.createAssistantMessage(
          sessionId,
          messageId,
          event.content,
          event.toolUses,
          taskId,
          nextIndex++,
          resolvedModel,
          usageForMessage
        );
        assistantMessageIds.push(messageId);
      }
    }

    return {
      userMessageId: userMessage.message_id,
      assistantMessageIds,
      tokenUsage,
      // Codex SDK doesn't provide contextWindow/contextWindowLimit
      contextWindow: undefined,
      contextWindowLimit: undefined,
      model: resolvedModel || DEFAULT_CODEX_MODEL,
      rawSdkResponse,
      rawContextUsage,
      wasStopped,
    };
  }

  /**
   * Stop currently executing task in session
   *
   * Uses a flag-based approach to break the event loop on the next iteration.
   *
   * @param sessionId - Session identifier
   * @param taskId - Optional task ID (not used for Codex, session-level stop)
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
        reason: 'CodexTool not initialized with prompt service',
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
   * Normalize Codex SDK response to common format
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
   * Compute context window usage for a Codex session
   *
   * Codex SDK usage is reported per turn (not cumulative across tasks).
   * For context occupancy, use input-side tokens only:
   * - usage.input_tokens
   * - usage.cached_input_tokens
   *
   * Output tokens are excluded because they are generated during the turn and
   * are not prompt-side context occupancy.
   *
   * @param sessionId - Session ID to compute context for
   * @param currentTaskId - Optional current task ID (not used for Codex, kept for interface consistency)
   * @param currentRawSdkResponse - Optional raw SDK response from current task (if available in memory)
   * @returns Promise resolving to context usage in tokens
   */
  async computeContextWindow(
    sessionId: string,
    _currentTaskId?: string,
    currentRawSdkResponse?: unknown
  ): Promise<number> {
    if (currentRawSdkResponse) {
      const contextWindow = extractCodexContextWindowUsage(currentRawSdkResponse);
      if (contextWindow !== undefined) {
        console.log(
          `✅ Computed context window for Codex session ${sessionId}: ${contextWindow} tokens`
        );
        return contextWindow;
      }

      console.warn(
        `⚠️  Could not extract Codex context window usage from rawSdkResponse for session ${sessionId}, returning 0`
      );
      return 0;
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
