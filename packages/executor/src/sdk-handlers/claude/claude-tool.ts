/**
 * Claude Code Tool Implementation
 *
 * Current capabilities:
 * - ✅ Import sessions from transcript files
 * - ✅ Live execution via Anthropic SDK
 * - ❌ Create new sessions (waiting for SDK)
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { generateId } from '@agor/core/db';
import type { PermissionMode as ClaudeSDKPermissionMode } from '@agor/core/sdk';
import { mapPermissionMode } from '@agor/core/utils/permission-mode-mapper';
import type {
  MCPServerRepository,
  MessagesRepository,
  RepoRepository,
  SessionMCPServerRepository,
  SessionRepository,
  WorktreeRepository,
} from '../../db/feathers-repositories.js';
import type { PermissionService } from '../../permissions/permission-service.js';
import type { NormalizedSdkResponse, RawSdkResponse } from '../../types/sdk-response.js';
// Removed import of calculateModelContextWindowUsage - inlined instead
import type { TokenUsage } from '../../types/token-usage.js';
import {
  type Message,
  type MessageID,
  MessageRole,
  type MessageSource,
  type PermissionMode,
  type SessionID,
  type TaskID,
  TaskStatus,
} from '../../types.js';
import type { ImportOptions, ITool, SessionData, ToolCapabilities } from '../base/index.js';
import { loadClaudeSession } from './import/load-session.js';
import { transcriptsToMessages } from './import/message-converter.js';
import {
  createAssistantMessage,
  createSystemMessage,
  createUserMessage,
  createUserMessageFromContent,
  extractTokenUsage,
} from './message-builder.js';
import type { ProcessedEvent } from './message-processor.js';
import { ClaudePromptService } from './prompt-service.js';

/**
 * Wrapper for withSessionGuard that accepts Feathers repositories
 * The Feathers repositories have the same interface but different type signatures
 */
async function withFeathersSessionGuard<T>(
  sessionId: SessionID,
  sessionsRepo: SessionRepository | undefined,
  operation: () => Promise<T>
): Promise<T | null> {
  // Check session exists before executing operation
  const sessionExists = await sessionsRepo?.findById(sessionId);
  if (!sessionExists) {
    console.warn(
      `⚠️  Session ${sessionId.substring(0, 8)} no longer exists, skipping guarded operation`
    );
    return null;
  }

  return operation();
}

/**
 * Service interface for creating messages via FeathersJS
 * This ensures WebSocket events are emitted when messages are created
 */
export interface MessagesService {
  create(data: Partial<Message>): Promise<Message>;
}

/**
 * Service interface for updating tasks via FeathersJS
 * This ensures WebSocket events are emitted when tasks are updated
 * Note: emit() is called directly on the service in handlers (socket.io feature)
 */
export interface TasksService {
  // biome-ignore lint/suspicious/noExplicitAny: FeathersJS service returns dynamic task data
  get(id: string): Promise<any>;
  // biome-ignore lint/suspicious/noExplicitAny: FeathersJS service accepts partial task updates
  patch(id: string, data: Partial<any>): Promise<any>;
}

/**
 * Service interface for updating sessions via FeathersJS
 * This ensures WebSocket events are emitted when sessions are updated (e.g., permission config)
 */
export interface SessionsService {
  // biome-ignore lint/suspicious/noExplicitAny: FeathersJS service accepts partial session updates
  patch(id: string, data: Partial<any>): Promise<any>;
}

export class ClaudeTool implements ITool {
  readonly toolType = 'claude-code' as const;
  readonly name = 'Claude Code';

  private promptService?: ClaudePromptService;

  constructor(
    private messagesRepo?: MessagesRepository,
    private sessionsRepo?: SessionRepository,
    apiKey?: string,
    private messagesService?: MessagesService,
    sessionMCPRepo?: SessionMCPServerRepository,
    mcpServerRepo?: MCPServerRepository,
    permissionService?: PermissionService,
    private tasksService?: TasksService,
    sessionsService?: SessionsService,
    worktreesRepo?: WorktreeRepository,
    reposRepo?: RepoRepository,
    mcpEnabled?: boolean,
    _useNativeAuth?: boolean, // Claude supports `claude login` OAuth, but no special handling needed in tool
    // biome-ignore lint/suspicious/noExplicitAny: Feathers service type
    mcpOAuthNotifyService?: any // Service for notifying UI about OAuth requirements
  ) {
    if (messagesRepo && sessionsRepo) {
      this.promptService = new ClaudePromptService(
        messagesRepo,
        sessionsRepo,
        apiKey,
        sessionMCPRepo,
        mcpServerRepo,
        permissionService,
        tasksService,
        sessionsService,
        worktreesRepo,
        reposRepo,
        messagesService,
        mcpEnabled,
        mcpOAuthNotifyService
      );
    }
  }

  getCapabilities(): ToolCapabilities {
    return {
      supportsSessionImport: true, // ✅ We have transcript parsing
      supportsSessionCreate: false, // ❌ Waiting for SDK
      supportsLiveExecution: true, // ✅ Now supported via Anthropic SDK
      supportsSessionFork: false,
      supportsChildSpawn: false,
      supportsGitState: true, // Transcripts contain git state
      supportsStreaming: true, // ✅ Streaming via callbacks during message generation
    };
  }

  async checkInstalled(): Promise<boolean> {
    try {
      // Check if ~/.claude directory exists
      const claudeDir = path.join(os.homedir(), '.claude');
      const stats = await fs.stat(claudeDir);
      return stats.isDirectory();
    } catch {
      return false;
    }
  }

  async importSession(sessionId: string, options?: ImportOptions): Promise<SessionData> {
    // Load session using existing transcript parser
    const session = await loadClaudeSession(sessionId, options?.projectDir);

    // Convert messages to Agor format
    const messages = transcriptsToMessages(session.messages, session.sessionId as SessionID);

    // Extract metadata
    const metadata = {
      sessionId: session.sessionId,
      toolType: this.toolType,
      status: TaskStatus.COMPLETED, // Historical sessions are always completed
      createdAt: new Date(session.messages[0]?.timestamp || Date.now()),
      lastUpdatedAt: new Date(
        session.messages[session.messages.length - 1]?.timestamp || Date.now()
      ),
      workingDirectory: session.cwd || undefined,
      messageCount: session.messages.length,
    };

    return {
      sessionId: session.sessionId,
      toolType: this.toolType,
      messages,
      metadata,
      workingDirectory: session.cwd || undefined,
    };
  }

  /**
   * Execute a prompt against a session WITH real-time streaming
   *
   * Creates user message, streams response chunks from Claude, then creates complete assistant messages.
   * Calls streamingCallbacks during message generation for real-time UI updates.
   * Agent SDK may return multiple assistant messages (e.g., tool invocation, then response).
   *
   * @param sessionId - Session to execute prompt in
   * @param prompt - User prompt text
   * @param taskId - Optional task ID for linking messages
   * @param permissionMode - Optional permission mode for SDK
   * @param streamingCallbacks - Optional callbacks for real-time streaming (enables typewriter effect)
   * @param abortController - Optional AbortController for cancellation support (passed to SDK)
   * @returns User message ID and array of assistant message IDs
   */
  async executePromptWithStreaming(
    sessionId: SessionID,
    prompt: string,
    taskId?: TaskID,
    permissionMode?: PermissionMode,
    streamingCallbacks?: import('../base').StreamingCallbacks,
    abortController?: AbortController,
    messageSource?: MessageSource
  ): Promise<{
    userMessageId: MessageID;
    assistantMessageIds: MessageID[];
    tokenUsage?: TokenUsage;
    durationMs?: number;
    agentSessionId?: string;
    contextWindow?: number;
    contextWindowLimit?: number;
    model?: string;
    modelUsage?: unknown;
    rawSdkResponse?: import('@agor/core/sdk').SDKResultMessage;
    wasStopped?: boolean;
  }> {
    if (!this.promptService || !this.messagesRepo) {
      throw new Error('ClaudeTool not initialized with repositories for live execution');
    }

    if (!this.messagesService) {
      throw new Error('ClaudeTool not initialized with messagesService for live execution');
    }

    // Get next message index
    const existingMessages = await this.messagesRepo.findBySessionId(sessionId);
    let nextIndex = existingMessages.length;

    // Create user message
    const userMessage = await createUserMessage(
      sessionId,
      prompt,
      taskId,
      nextIndex++,
      this.messagesService!,
      messageSource
    );

    // Execute prompt via Agent SDK with streaming
    const assistantMessageIds: MessageID[] = [];
    let capturedAgentSessionId: string | undefined;
    let resolvedModel: string | undefined;

    /**
     * Stream Separation Pattern (Option C)
     *
     * Each stream type (thinking, text, tool) gets its own independent message ID.
     * This prevents state conflicts when multiple streams are active simultaneously.
     *
     * Lifecycle:
     * 1. Thinking stream: thinking:start → thinking:chunk* → thinking:complete
     * 2. Text stream: streaming:start → streaming:chunk* → streaming:end
     * 3. Final message: Both streams merge into single DB message with same ID
     *
     * Example flow:
     * - Claude thinks (thinking stream with ID abc123)
     * - Claude responds (text stream with ID def456)
     * - Complete message saved (uses def456, or abc123 if no text, or generates new)
     *
     * Benefits:
     * - No ID collision between concurrent streams
     * - Clear separation of concerns
     * - Future-proof for tool streaming
     * - Easy to refactor to unified pattern later
     */
    let currentTextMessageId: MessageID | null = null;
    let currentThinkingMessageId: MessageID | null = null;
    // Future: let currentToolMessageId: MessageID | null = null;

    let streamStartTime = Date.now();
    let firstTokenTime: number | null = null;
    let tokenUsage: TokenUsage | undefined;
    let durationMs: number | undefined;
    let contextWindow: number | undefined;
    let contextWindowLimit: number | undefined;
    let modelUsage: unknown | undefined;
    let rawSdkResponse: import('@agor/core/sdk').SDKResultMessage | undefined;
    let wasStopped = false;

    // Map our permission mode to Claude SDK's permission mode
    const mappedPermissionMode = permissionMode
      ? (mapPermissionMode(permissionMode, 'claude-code') as ClaudeSDKPermissionMode)
      : undefined;

    for await (const event of this.promptService.promptSessionStreaming(
      sessionId,
      prompt,
      taskId,
      mappedPermissionMode,
      undefined, // chunkCallback (unused)
      abortController
    )) {
      // Detect if execution was stopped early
      if (event.type === 'stopped') {
        wasStopped = true;
        console.log(`🛑 Claude execution was stopped for session ${sessionId}`);
        continue; // Skip processing this event
      }

      // Capture resolved model from first event
      if (!resolvedModel && 'resolvedModel' in event && event.resolvedModel) {
        resolvedModel = event.resolvedModel;
      }

      // Capture Agent SDK session_id
      if (!capturedAgentSessionId && 'agentSessionId' in event && event.agentSessionId) {
        capturedAgentSessionId = event.agentSessionId;
        await this.captureAgentSessionId(sessionId, capturedAgentSessionId);
      }

      // Handle tool execution start
      if (event.type === 'tool_start') {
        if (this.tasksService && taskId) {
          // biome-ignore lint/suspicious/noExplicitAny: emit is available at runtime from socket.io
          (this.tasksService as any).emit('tool:start', {
            task_id: taskId,
            session_id: sessionId,
            tool_use_id: event.toolUseId,
            tool_name: event.toolName,
          });
        }
      }

      // Handle tool execution complete
      if (event.type === 'tool_complete') {
        if (this.tasksService && taskId) {
          // biome-ignore lint/suspicious/noExplicitAny: emit is available at runtime from socket.io
          (this.tasksService as any).emit('tool:complete', {
            task_id: taskId,
            session_id: sessionId,
            tool_use_id: event.toolUseId,
          });
        }
      }

      // Handle thinking partial (streaming)
      if (event.type === 'thinking_partial') {
        // Emit to tasks service for task-level tracking
        if (this.tasksService && taskId) {
          // biome-ignore lint/suspicious/noExplicitAny: emit is available at runtime from socket.io
          (this.tasksService as any).emit('thinking:chunk', {
            task_id: taskId,
            session_id: sessionId,
            chunk: event.thinkingChunk,
          });
        }

        // Emit to streaming callbacks for message-level UI updates
        // Thinking blocks are part of assistant messages, but tracked separately
        if (streamingCallbacks?.onThinkingChunk) {
          // Start thinking stream if needed (separate from text stream)
          if (!currentThinkingMessageId) {
            currentThinkingMessageId = generateId() as MessageID;
            const thinkingStartTime = Date.now();
            const ttfb = thinkingStartTime - streamStartTime;
            console.debug(`⏱️ [SDK] TTFB (thinking): ${ttfb}ms`);

            if (streamingCallbacks.onThinkingStart) {
              // Note: budget is extracted from thinking block if available
              await streamingCallbacks.onThinkingStart(currentThinkingMessageId, {
                budget: undefined, // TODO: Extract from SDK if available
              });
            }
          }

          // Stream thinking chunk with dedicated message ID
          await streamingCallbacks.onThinkingChunk(currentThinkingMessageId, event.thinkingChunk);
        }
      }

      // Handle thinking complete
      if (event.type === 'thinking_complete') {
        if (streamingCallbacks?.onThinkingEnd && currentThinkingMessageId) {
          await streamingCallbacks.onThinkingEnd(currentThinkingMessageId);
          // Keep ID around for potential merging with text message later
          // Don't reset to null - we may need it for the complete message
        }
      }

      // Handle system_complete events (e.g., compaction finished)
      // Store as NEW message to preserve timeline and metadata
      if (event.type === 'system_complete') {
        const systemCompleteEvent = event as Extract<ProcessedEvent, { type: 'system_complete' }>;
        if (systemCompleteEvent.systemType === 'compaction') {
          const metadata = systemCompleteEvent.metadata;
          console.log(
            `✅ Compaction complete (trigger: ${metadata?.trigger || 'unknown'}, pre_tokens: ${metadata?.pre_tokens || 'unknown'})`
          );

          // Create a NEW system message for compaction complete
          // This preserves the event stream and allows UI to aggregate
          await withFeathersSessionGuard(sessionId, this.sessionsRepo, async () => {
            const completeMessageId = generateId() as MessageID;

            // Start streaming event for this system message
            if (streamingCallbacks) {
              await streamingCallbacks.onStreamStart(completeMessageId, {
                session_id: sessionId,
                task_id: taskId,
                role: MessageRole.ASSISTANT,
                timestamp: new Date().toISOString(),
              });
            }

            await createSystemMessage(
              sessionId,
              completeMessageId,
              [
                {
                  type: 'system_complete',
                  systemType: 'compaction',
                  text: 'Context compacted successfully',
                  // Store metadata for UI rendering
                  trigger: metadata?.trigger,
                  pre_tokens: metadata?.pre_tokens,
                },
              ],
              taskId,
              nextIndex++,
              resolvedModel,
              this.messagesService!
            );

            // End streaming for this system message
            // This ensures UI removes the spinner immediately
            if (streamingCallbacks) {
              await streamingCallbacks.onStreamEnd(completeMessageId);
            }
          });
        }
      }

      // Capture raw SDK response for token accounting
      if (event.type === 'result') {
        rawSdkResponse = event.raw_sdk_message;
      }

      // Capture metadata from result events (SDK may not type this properly)
      if ('token_usage' in event && event.token_usage) {
        tokenUsage = extractTokenUsage(event.token_usage);
      }
      if ('duration_ms' in event && typeof event.duration_ms === 'number') {
        durationMs = event.duration_ms;
      }
      if ('model_usage' in event && event.model_usage) {
        // Save full model usage for later (per-model breakdown)
        // Token accounting now handled by ClaudeCodeNormalizer.normalizeMultiModel()
        modelUsage = event.model_usage;
      }

      // Handle partial streaming events (token-level chunks)
      if (event.type === 'partial' && event.textChunk) {
        // Start new text stream if needed (separate from thinking stream)
        if (!currentTextMessageId) {
          currentTextMessageId = generateId() as MessageID;
          firstTokenTime = Date.now();
          const ttfb = firstTokenTime - streamStartTime;
          console.debug(`⏱️ [SDK] TTFB (text): ${ttfb}ms`);

          if (streamingCallbacks) {
            await streamingCallbacks.onStreamStart(currentTextMessageId, {
              session_id: sessionId,
              task_id: taskId,
              role: MessageRole.ASSISTANT,
              timestamp: new Date().toISOString(),
            });
          }
        }

        // Emit chunk immediately (no artificial delays - true streaming!)
        if (streamingCallbacks) {
          await streamingCallbacks.onStreamChunk(currentTextMessageId, event.textChunk);
        }
      }
      // Handle complete message (save to database)
      else if (event.type === 'complete' && event.content) {
        // End text streaming if active (only for assistant messages)
        if (
          currentTextMessageId &&
          streamingCallbacks &&
          'role' in event &&
          event.role === MessageRole.ASSISTANT
        ) {
          const streamEndTime = Date.now();
          await streamingCallbacks.onStreamEnd(currentTextMessageId);
          const totalTime = streamEndTime - streamStartTime;
          const streamingTime = firstTokenTime ? streamEndTime - firstTokenTime : 0;
          console.debug(
            `⏱️ [Streaming] Complete - TTFB: ${firstTokenTime ? firstTokenTime - streamStartTime : 0}ms, streaming: ${streamingTime}ms, total: ${totalTime}ms`
          );
        }

        // Handle based on role (narrow to complete event type)
        if (event.type === 'complete' && event.role === MessageRole.ASSISTANT) {
          // Type assertion needed because TypeScript can't properly narrow discriminated unions with optional properties
          const completeEvent = event as Extract<ProcessedEvent, { type: 'complete' }>;
          /**
           * ID Selection Strategy:
           * 1. Prefer text message ID (most common case - response with thinking)
           * 2. Fallback to thinking ID (thinking-only message, rare)
           * 3. Generate new ID (no streaming happened, very rare)
           *
           * This ensures:
           * - UI sees consistent message ID from start to DB persistence
           * - Thinking + text messages merge properly under one ID
           * - Edge cases (no streaming) still work correctly
           */
          const assistantMessageId =
            currentTextMessageId || currentThinkingMessageId || (generateId() as MessageID);

          // Create assistant message with session guard (handles deleted sessions gracefully)
          const created = await withFeathersSessionGuard(sessionId, this.sessionsRepo, async () => {
            await createAssistantMessage(
              sessionId,
              assistantMessageId,
              completeEvent.content,
              completeEvent.toolUses,
              taskId,
              nextIndex++,
              resolvedModel,
              this.messagesService!,
              this.tasksService,
              completeEvent.parent_tool_use_id ?? null,
              tokenUsage
            );
            return true;
          });

          if (created) {
            assistantMessageIds.push(assistantMessageId);
          }

          // Reset all stream IDs for next message
          // Both thinking and text streams are complete at this point
          currentTextMessageId = null;
          currentThinkingMessageId = null;
          streamStartTime = Date.now();
          firstTokenTime = null;
        } else if (event.type === 'complete' && event.role === MessageRole.USER) {
          // Type assertion for user message
          const completeEvent = event as Extract<ProcessedEvent, { type: 'complete' }>;

          // Create user message with session guard (handles deleted sessions gracefully)
          await withFeathersSessionGuard(sessionId, this.sessionsRepo, async () => {
            const userMessageId = generateId() as MessageID;
            await createUserMessageFromContent(
              sessionId,
              userMessageId,
              completeEvent.content,
              taskId,
              nextIndex++,
              this.messagesService!,
              completeEvent.parent_tool_use_id ?? null
            );
          });
          // Don't add to assistantMessageIds - these are user messages
        } else if (event.type === 'complete' && event.role === MessageRole.SYSTEM) {
          // Type assertion for system message
          const completeEvent = event as Extract<ProcessedEvent, { type: 'complete' }>;

          // Create system message with session guard (handles deleted sessions gracefully)
          await withFeathersSessionGuard(sessionId, this.sessionsRepo, async () => {
            const systemMessageId = generateId() as MessageID;
            await createSystemMessage(
              sessionId,
              systemMessageId,
              completeEvent.content,
              taskId,
              nextIndex++,
              resolvedModel,
              this.messagesService!
            );

            // End streaming for system messages (e.g., compaction complete)
            // This ensures UI spinners stop when system events finish
            if (streamingCallbacks) {
              await streamingCallbacks.onStreamEnd(systemMessageId);
            }
          });
          // Don't add to assistantMessageIds - these are system messages
        }
      }
    }

    return {
      userMessageId: userMessage.message_id,
      assistantMessageIds,
      tokenUsage,
      durationMs,
      agentSessionId: capturedAgentSessionId,
      contextWindow,
      contextWindowLimit,
      model: resolvedModel,
      modelUsage,
      rawSdkResponse,
      wasStopped,
    };
  }

  /**
   * Capture and store Agent SDK session_id for conversation continuity
   * @private
   */
  private async captureAgentSessionId(sessionId: SessionID, agentSessionId: string): Promise<void> {
    console.log(
      `🔑 Captured Agent SDK session_id for Agor session ${sessionId}: ${agentSessionId}`
    );

    if (this.sessionsRepo) {
      try {
        console.log(
          `📝 About to update session with: ${JSON.stringify({ sdk_session_id: agentSessionId })}`
        );
        const updated = await this.sessionsRepo.update(sessionId, {
          sdk_session_id: agentSessionId,
        });
        console.log(`💾 Stored Agent SDK session_id in Agor session`);
        console.log(`🔍 Verify: updated.sdk_session_id = ${updated.sdk_session_id}`);
      } catch (error) {
        // Session may have been deleted mid-execution - gracefully ignore
        if (error instanceof Error && error.message.includes('not found')) {
          console.log(
            `⚠️  Session ${sessionId} not found (likely deleted mid-execution) - skipping agent session ID capture`
          );
          return;
        }
        // Re-throw other errors
        throw error;
      }
    }
  }

  /**
   * Execute a prompt against a session (non-streaming version)
   *
   * Creates user message, streams response from Claude, creates assistant messages.
   * Agent SDK may return multiple assistant messages (e.g., tool invocation, then response).
   * Returns user message ID and array of assistant message IDs.
   *
   * Also captures and stores the Agent SDK session_id for conversation continuity.
   */
  async executePrompt(
    sessionId: SessionID,
    prompt: string,
    taskId?: TaskID,
    permissionMode?: PermissionMode,
    messageSource?: MessageSource
  ): Promise<{
    userMessageId: MessageID;
    assistantMessageIds: MessageID[];
    tokenUsage?: TokenUsage;
    durationMs?: number;
    agentSessionId?: string;
    contextWindow?: number;
    contextWindowLimit?: number;
    model?: string;
    modelUsage?: unknown;
    rawSdkResponse?: import('@agor/core/sdk').SDKResultMessage;
    wasStopped?: boolean;
  }> {
    if (!this.promptService || !this.messagesRepo) {
      throw new Error('ClaudeTool not initialized with repositories for live execution');
    }

    if (!this.messagesService) {
      throw new Error('ClaudeTool not initialized with messagesService for live execution');
    }

    // Get next message index
    const existingMessages = await this.messagesRepo.findBySessionId(sessionId);
    let nextIndex = existingMessages.length;

    // Create user message
    const userMessage = await createUserMessage(
      sessionId,
      prompt,
      taskId,
      nextIndex++,
      this.messagesService!,
      messageSource
    );

    // Execute prompt via Agent SDK
    const assistantMessageIds: MessageID[] = [];
    let capturedAgentSessionId: string | undefined;
    let resolvedModel: string | undefined;
    let tokenUsage: TokenUsage | undefined;
    let durationMs: number | undefined;
    let contextWindow: number | undefined;
    let contextWindowLimit: number | undefined;
    let modelUsage: unknown | undefined;
    let rawSdkResponse: import('@agor/core/sdk').SDKResultMessage | undefined;
    let wasStopped = false;

    // Map our permission mode to Claude SDK's permission mode
    const mappedPermissionMode = permissionMode
      ? (mapPermissionMode(permissionMode, 'claude-code') as ClaudeSDKPermissionMode)
      : undefined;

    for await (const event of this.promptService.promptSessionStreaming(
      sessionId,
      prompt,
      taskId,
      mappedPermissionMode
    )) {
      // Detect if execution was stopped early
      if (event.type === 'stopped') {
        wasStopped = true;
        console.log(`🛑 Claude execution was stopped for session ${sessionId}`);
        continue; // Skip processing this event
      }

      // Capture resolved model from first event
      if (!resolvedModel && 'resolvedModel' in event && event.resolvedModel) {
        resolvedModel = event.resolvedModel;
      }

      // Capture Agent SDK session_id
      if (!capturedAgentSessionId && 'agentSessionId' in event && event.agentSessionId) {
        capturedAgentSessionId = event.agentSessionId;
        await this.captureAgentSessionId(sessionId, capturedAgentSessionId);
      }

      // Capture raw SDK response for token accounting
      if (event.type === 'result') {
        rawSdkResponse = event.raw_sdk_message;
      }

      // Capture metadata from result events (SDK may not type this properly)
      if ('token_usage' in event && event.token_usage) {
        tokenUsage = extractTokenUsage(event.token_usage);
      }
      if ('duration_ms' in event && typeof event.duration_ms === 'number') {
        durationMs = event.duration_ms;
      }
      if ('model_usage' in event && event.model_usage) {
        // Save full model usage for later (per-model breakdown)
        // Token accounting now handled by ClaudeCodeNormalizer.normalizeMultiModel()
        modelUsage = event.model_usage;
      }

      // Skip partial events in non-streaming mode
      if (event.type === 'partial') {
        continue;
      }

      // Handle complete messages only
      if (event.type === 'complete' && event.content) {
        // Type assertion for complete event
        const completeEvent = event as Extract<ProcessedEvent, { type: 'complete' }>;
        const messageId = generateId() as MessageID;

        // Create message with session guard (handles deleted sessions gracefully)
        const created = await withFeathersSessionGuard(sessionId, this.sessionsRepo, async () => {
          if (completeEvent.role === MessageRole.ASSISTANT) {
            await createAssistantMessage(
              sessionId,
              messageId,
              completeEvent.content,
              completeEvent.toolUses,
              taskId,
              nextIndex++,
              resolvedModel,
              this.messagesService!,
              this.tasksService,
              completeEvent.parent_tool_use_id ?? null,
              tokenUsage
            );
            return true;
          } else if (completeEvent.role === MessageRole.SYSTEM) {
            // Handle system messages (compaction, etc.)
            await createSystemMessage(
              sessionId,
              messageId,
              completeEvent.content,
              taskId,
              nextIndex++,
              resolvedModel,
              this.messagesService!
            );
            return true;
          }
          return false;
        });

        if (created) {
          assistantMessageIds.push(messageId);
        }
      }

      // Handle system_complete events (compaction finished)
      if (event.type === 'system_complete') {
        const systemCompleteEvent = event as Extract<ProcessedEvent, { type: 'system_complete' }>;
        if (systemCompleteEvent.systemType === 'compaction') {
          console.log(`✅ Compaction complete`);
          // Could update last system message with completion status
          // For now, just log
        }
      }
    }

    return {
      userMessageId: userMessage.message_id,
      assistantMessageIds,
      tokenUsage,
      durationMs,
      agentSessionId: capturedAgentSessionId,
      contextWindow,
      contextWindowLimit,
      model: resolvedModel,
      modelUsage,
      rawSdkResponse,
      wasStopped,
    };
  }

  /**
   * Stop currently executing task in session
   *
   * Uses Claude Agent SDK's native interrupt() method to gracefully stop execution.
   *
   * @param sessionId - Session identifier
   * @param taskId - Optional task ID (not used for Claude, session-level stop)
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
        reason: 'ClaudeTool not initialized with prompt service',
      };
    }

    const result = await this.promptService.stopTask(sessionId as SessionID);

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
   * Normalize Claude SDK response to common format
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
   * Compute token count from a Claude SDK raw response
   *
   * Sums across ALL models (Haiku for tools, Sonnet for responses, etc.)
   * since they all contribute to the context window.
   *
   * @param rawResponse - Raw SDK response from Claude Agent SDK
   * @returns Total tokens (input + output) across all models
   */
  private computeContextTokensFromRawResponse(rawResponse: unknown): number {
    const response = rawResponse as import('../../types/sdk-response').ClaudeCodeSdkResponseTyped;

    // If modelUsage exists, sum across all models
    if (response.modelUsage && typeof response.modelUsage === 'object') {
      let total = 0;
      for (const modelData of Object.values(response.modelUsage)) {
        const input = modelData.inputTokens || 0;
        const output = modelData.outputTokens || 0;
        total += input + output;
      }
      return total;
    }

    // Fallback to top-level usage (older SDK or single model)
    const inputTokens = response.usage?.input_tokens || 0;
    const outputTokens = response.usage?.output_tokens || 0;
    return inputTokens + outputTokens;
  }

  /**
   * Compute cumulative context window usage for a Claude Code session
   *
   * Algorithm:
   * 1. Query messages to find compaction boundary events
   * 2. Build set of task IDs that had compaction events
   * 3. Query previous completed tasks (ordered by created_at ASC for proper iteration)
   * 4. Find the most recent compaction task
   * 5. Sum tokens only from tasks AFTER the last compaction
   * 6. Add BASELINE context on FIRST message after session start or compaction:
   *    - Fresh session: cache_read + cache_creation (~23-27K for system prompt + tools)
   *    - Post-compaction: cache_creation only (the compacted conversation summary)
   * 7. Add current task tokens (and baseline if this IS the first task)
   *
   * Why baseline matters:
   * - cache_read_tokens: System prompt, tool definitions (~20K tokens)
   * - cache_creation_tokens: CLAUDE.md, MCP server tools (~3-7K tokens)
   * - These are part of the context window but not reported in input/output tokens
   *
   * Note: This is called BEFORE the task UPDATE, so querying the DB is safe.
   * The current task is not yet in the DB, so we receive its raw response separately.
   *
   * @param sessionId - Session ID to compute context for
   * @param currentTaskId - Current task ID (excluded from DB query)
   * @param currentRawSdkResponse - Raw SDK response for the current task (not yet in DB)
   * @returns Promise resolving to computed context window usage in tokens
   */
  async computeContextWindow(
    sessionId: string,
    currentTaskId?: string,
    currentRawSdkResponse?: unknown
  ): Promise<number> {
    // Start with current task tokens
    let currentTaskTokens = 0;
    if (currentRawSdkResponse) {
      currentTaskTokens = this.computeContextTokensFromRawResponse(currentRawSdkResponse);
    }

    // Query previous completed tasks to sum their tokens
    // This is safe because we're called BEFORE the UPDATE (not during)
    if (!this.tasksService) {
      console.warn(
        `⚠️  computeContextWindow: tasksService not available, returning current task tokens only`
      );
      return currentTaskTokens;
    }

    try {
      // Step 1: Find compaction events from messages
      const compactionTaskIds = await this.findCompactionTaskIds(sessionId as SessionID);

      // Step 2: Query previous completed tasks (chronological order for proper iteration)
      // biome-ignore lint/suspicious/noExplicitAny: FeathersJS service find returns paginated or array
      const result = await (this.tasksService as any).find({
        query: {
          session_id: sessionId,
          status: 'completed', // Only completed tasks have token data
          $sort: { created_at: 1 }, // Chronological order (oldest first)
          $limit: 100, // Reasonable limit for context window computation
        },
      });

      // biome-ignore lint/suspicious/noExplicitAny: FeathersJS service returns dynamic task data
      const tasks: any[] = Array.isArray(result) ? result : result.data || [];

      // Step 3: Find the most recent compaction event index
      let lastCompactionIndex = -1;
      for (let i = tasks.length - 1; i >= 0; i--) {
        if (compactionTaskIds.has(tasks[i].task_id)) {
          lastCompactionIndex = i;
          break;
        }
      }

      // Step 4: Sum tokens starting from after the last compaction
      const startIndex = lastCompactionIndex >= 0 ? lastCompactionIndex + 1 : 0;
      let totalTokens = 0;
      let tasksCounted = 0;
      let baselineTokensAdded = 0;

      for (let i = startIndex; i < tasks.length; i++) {
        const task = tasks[i];
        // Skip current task (it's not in DB yet anyway, but just in case)
        if (task.task_id === currentTaskId) continue;

        // Get tokens from normalized_sdk_response
        const normalized = task.normalized_sdk_response;
        if (normalized?.tokenUsage) {
          const taskTokens =
            (normalized.tokenUsage.inputTokens || 0) + (normalized.tokenUsage.outputTokens || 0);
          totalTokens += taskTokens;
          tasksCounted++;

          // CRITICAL: Add baseline context on FIRST message after start/compaction
          // This accounts for system prompt, CLAUDE.md, MCP tools, etc.
          if (i === startIndex) {
            if (lastCompactionIndex === -1) {
              // Fresh session: cache_read (~20K system prompt) + cache_creation (CLAUDE.md + MCP tools ~3-7K)
              // Total baseline: ~23K-27K tokens for a fresh session
              const cacheRead = normalized.tokenUsage.cacheReadInputTokens || 0;
              const cacheCreation = normalized.tokenUsage.cacheCreationInputTokens || 0;
              baselineTokensAdded = cacheRead + cacheCreation;
              totalTokens += baselineTokensAdded;
            } else {
              // Post-compaction: cache_creation only (the compacted conversation summary)
              // Note: We exclude cache_read here because it can exceed 200K context limits
              // post-compaction (observed: 248K-1.9M tokens), likely due to cumulative caching
              const cacheCreation = normalized.tokenUsage.cacheCreationInputTokens || 0;
              baselineTokensAdded = cacheCreation;
              totalTokens += baselineTokensAdded;
            }
          }
        }
      }

      // Add current task tokens
      totalTokens += currentTaskTokens;

      // CRITICAL: Handle the case where THIS is the first task (no previous tasks)
      // In this case, we need to add baseline context from the current task's raw response
      if (tasksCounted === 0 && currentRawSdkResponse && lastCompactionIndex === -1) {
        const response =
          currentRawSdkResponse as import('../../types/sdk-response').ClaudeCodeSdkResponseTyped;
        // Extract cache tokens from the first model in modelUsage
        if (response.modelUsage && typeof response.modelUsage === 'object') {
          const firstModelUsage = Object.values(response.modelUsage)[0];
          if (firstModelUsage) {
            // Fresh session: add cache_read + cache_creation as baseline
            const cacheRead = firstModelUsage.cacheReadInputTokens || 0;
            const cacheCreation = firstModelUsage.cacheCreationInputTokens || 0;
            baselineTokensAdded = cacheRead + cacheCreation;
            totalTokens += baselineTokensAdded;
          }
        }
      }

      const compactionInfo =
        lastCompactionIndex >= 0
          ? ` (reset after compaction at task index ${lastCompactionIndex})`
          : ' (no compaction detected)';

      const baselineInfo = baselineTokensAdded > 0 ? `, baseline: ${baselineTokensAdded}` : '';

      console.log(
        `✅ Computed cumulative context window for session ${sessionId}: ${totalTokens} tokens (${tasksCounted} previous tasks + current${baselineInfo})${compactionInfo}`
      );

      return totalTokens;
    } catch (error) {
      console.error(`❌ Failed to compute context window:`, error);
      // Fall back to just current task tokens
      return currentTaskTokens;
    }
  }

  /**
   * Find task IDs that have compaction events in their messages
   *
   * Compaction events are system messages with:
   * - type === 'system' AND content is object with status === 'compacting'
   * - OR content is array with a block having type === 'system_status' and status === 'compacting'
   */
  private async findCompactionTaskIds(sessionId: SessionID): Promise<Set<string>> {
    const compactionTaskIds = new Set<string>();

    if (!this.messagesRepo) {
      console.warn(
        `⚠️  findCompactionTaskIds: messagesRepo not available, skipping compaction detection`
      );
      return compactionTaskIds;
    }

    try {
      const messages = await this.messagesRepo.findBySessionId(sessionId);

      for (const msg of messages) {
        if (msg.role !== MessageRole.SYSTEM) continue;
        if (!msg.content || typeof msg.content !== 'object') continue;

        const content = msg.content as { type?: string; status?: string } | unknown[];

        // Check if content is array with compaction block
        if (Array.isArray(content)) {
          const hasCompaction = (content as Array<{ type?: string; status?: string }>).some(
            (block) => block.type === 'system_status' && block.status === 'compacting'
          );
          if (hasCompaction && msg.task_id) {
            compactionTaskIds.add(msg.task_id);
          }
        }
        // Check if content is object with compacting status
        else if (content.status === 'compacting' && msg.task_id) {
          compactionTaskIds.add(msg.task_id);
        }
      }

      if (compactionTaskIds.size > 0) {
        console.log(
          `🔄 Found ${compactionTaskIds.size} compaction event(s) in session ${sessionId}`
        );
      }
    } catch (error) {
      console.error(`❌ Failed to find compaction events:`, error);
    }

    return compactionTaskIds;
  }
}
