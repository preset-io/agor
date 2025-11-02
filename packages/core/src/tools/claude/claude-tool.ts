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
import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import type { MCPServerRepository } from '../../db/repositories/mcp-servers';
import type { MessagesRepository } from '../../db/repositories/messages';
import type { RepoRepository } from '../../db/repositories/repos';
import type { SessionMCPServerRepository } from '../../db/repositories/session-mcp-servers';
import type { SessionRepository } from '../../db/repositories/sessions';
import type { WorktreeRepository } from '../../db/repositories/worktrees';
import { generateId } from '../../lib/ids';
import type { PermissionService } from '../../permissions/permission-service';
import {
  type Message,
  type MessageID,
  MessageRole,
  type SessionID,
  type TaskID,
  TaskStatus,
} from '../../types';
import type { TokenUsage } from '../../utils/pricing';
import type { ImportOptions, ITool, SessionData, ToolCapabilities } from '../base';
import { loadClaudeSession } from './import/load-session';
import { transcriptsToMessages } from './import/message-converter';
import {
  createAssistantMessage,
  createUserMessage,
  createUserMessageFromContent,
  extractTokenUsage,
} from './message-builder';
import { ClaudePromptService } from './prompt-service';

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
 */
export interface TasksService {
  // biome-ignore lint/suspicious/noExplicitAny: FeathersJS service returns dynamic task data
  get(id: string): Promise<any>;
  // biome-ignore lint/suspicious/noExplicitAny: FeathersJS service accepts partial task updates
  patch(id: string, data: Partial<any>): Promise<any>;
  // biome-ignore lint/suspicious/noExplicitAny: FeathersJS emit types are not strict
  emit(event: string, data: any): void;
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
    mcpEnabled?: boolean
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
        mcpEnabled
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
   * @returns User message ID and array of assistant message IDs
   */
  async executePromptWithStreaming(
    sessionId: SessionID,
    prompt: string,
    taskId?: TaskID,
    permissionMode?: PermissionMode,
    streamingCallbacks?: import('../base').StreamingCallbacks
  ): Promise<{
    userMessageId: MessageID;
    assistantMessageIds: MessageID[];
    tokenUsage?: TokenUsage;
    durationMs?: number;
    agentSessionId?: string;
    contextWindow?: number;
    contextWindowLimit?: number;
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
      this.messagesService!
    );

    // Execute prompt via Agent SDK with streaming
    const assistantMessageIds: MessageID[] = [];
    let capturedAgentSessionId: string | undefined;
    let resolvedModel: string | undefined;
    let currentMessageId: MessageID | null = null;
    let streamStartTime = Date.now();
    let firstTokenTime: number | null = null;
    let tokenUsage: TokenUsage | undefined;
    let durationMs: number | undefined;
    let contextWindow: number | undefined;
    let contextWindowLimit: number | undefined;

    for await (const event of this.promptService.promptSessionStreaming(
      sessionId,
      prompt,
      taskId,
      permissionMode
    )) {
      // Capture resolved model from first event
      if (!resolvedModel && 'resolvedModel' in event && event.resolvedModel) {
        resolvedModel = event.resolvedModel;
      }

      // Capture Agent SDK session_id
      if (!capturedAgentSessionId && event.agentSessionId) {
        capturedAgentSessionId = event.agentSessionId;
        await this.captureAgentSessionId(sessionId, capturedAgentSessionId);
      }

      // Handle tool execution start
      if (event.type === 'tool_start') {
        if (this.tasksService && taskId) {
          this.tasksService.emit('tool:start', {
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
          this.tasksService.emit('tool:complete', {
            task_id: taskId,
            session_id: sessionId,
            tool_use_id: event.toolUseId,
          });
        }
      }

      // Handle thinking partial (streaming)
      if (event.type === 'thinking_partial') {
        if (this.tasksService && taskId) {
          this.tasksService.emit('thinking:chunk', {
            task_id: taskId,
            session_id: sessionId,
            chunk: event.thinkingChunk,
          });
        }
      }

      // Capture metadata from result events (SDK may not type this properly)
      if ('token_usage' in event && event.token_usage) {
        tokenUsage = extractTokenUsage(event.token_usage);
      }
      if ('duration_ms' in event && typeof event.duration_ms === 'number') {
        durationMs = event.duration_ms;
      }
      if ('model_usage' in event && event.model_usage) {
        // Extract context window data from model usage
        const modelUsage = event.model_usage as Record<
          string,
          {
            inputTokens: number;
            outputTokens: number;
            cacheReadInputTokens?: number;
            cacheCreationInputTokens?: number;
            contextWindow: number;
          }
        >;
        // Find the model with the highest context usage
        // (each model has its own context window, not shared)
        let maxUsage = 0;
        let maxLimit = 0;
        for (const modelData of Object.values(modelUsage)) {
          const usage =
            (modelData.inputTokens || 0) +
            (modelData.outputTokens || 0) +
            (modelData.cacheReadInputTokens || 0) +
            (modelData.cacheCreationInputTokens || 0);
          const limit = modelData.contextWindow || 0;
          if (usage > maxUsage) {
            maxUsage = usage;
            maxLimit = limit;
          }
        }
        contextWindow = maxUsage;
        contextWindowLimit = maxLimit;
        console.log(
          `🔍 [ClaudeTool] Context window: ${contextWindow}/${contextWindowLimit} (${((contextWindow / contextWindowLimit) * 100).toFixed(1)}%)`
        );
      }

      // Handle partial streaming events (token-level chunks)
      if (event.type === 'partial' && event.textChunk) {
        // Start new message if needed
        if (!currentMessageId) {
          currentMessageId = generateId() as MessageID;
          firstTokenTime = Date.now();
          const ttfb = firstTokenTime - streamStartTime;
          console.debug(`⏱️ [SDK] TTFB: ${ttfb}ms`);

          if (streamingCallbacks) {
            streamingCallbacks.onStreamStart(currentMessageId, {
              session_id: sessionId,
              task_id: taskId,
              role: MessageRole.ASSISTANT,
              timestamp: new Date().toISOString(),
            });
          }
        }

        // Emit chunk immediately (no artificial delays - true streaming!)
        if (streamingCallbacks) {
          streamingCallbacks.onStreamChunk(currentMessageId, event.textChunk);
        }
      }
      // Handle complete message (save to database)
      else if (event.type === 'complete' && event.content) {
        // End streaming if active (only for assistant messages)
        if (
          currentMessageId &&
          streamingCallbacks &&
          'role' in event &&
          event.role === MessageRole.ASSISTANT
        ) {
          const streamEndTime = Date.now();
          streamingCallbacks.onStreamEnd(currentMessageId);
          const totalTime = streamEndTime - streamStartTime;
          const streamingTime = firstTokenTime ? streamEndTime - firstTokenTime : 0;
          console.debug(
            `⏱️ [Streaming] Complete - TTFB: ${firstTokenTime ? firstTokenTime - streamStartTime : 0}ms, streaming: ${streamingTime}ms, total: ${totalTime}ms`
          );
        }

        // Handle based on role
        if ('role' in event && event.role === MessageRole.ASSISTANT) {
          // Use existing message ID or generate new one
          const assistantMessageId = currentMessageId || (generateId() as MessageID);

          // Create complete assistant message in DB
          await createAssistantMessage(
            sessionId,
            assistantMessageId,
            event.content,
            event.toolUses,
            taskId,
            nextIndex++,
            resolvedModel,
            this.messagesService!,
            this.tasksService
          );
          assistantMessageIds.push(assistantMessageId);

          // Reset for next message
          currentMessageId = null;
          streamStartTime = Date.now();
          firstTokenTime = null;
        } else if ('role' in event && event.role === MessageRole.USER) {
          // Create user message (tool results, etc.)
          const userMessageId = generateId() as MessageID;
          await createUserMessageFromContent(
            sessionId,
            userMessageId,
            event.content,
            taskId,
            nextIndex++,
            this.messagesService!
          );
          // Don't add to assistantMessageIds - these are user messages
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
    permissionMode?: PermissionMode
  ): Promise<{
    userMessageId: MessageID;
    assistantMessageIds: MessageID[];
    tokenUsage?: TokenUsage;
    durationMs?: number;
    agentSessionId?: string;
    contextWindow?: number;
    contextWindowLimit?: number;
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
      this.messagesService!
    );

    // Execute prompt via Agent SDK
    const assistantMessageIds: MessageID[] = [];
    let capturedAgentSessionId: string | undefined;
    let resolvedModel: string | undefined;
    let tokenUsage: TokenUsage | undefined;
    let durationMs: number | undefined;
    let contextWindow: number | undefined;
    let contextWindowLimit: number | undefined;

    for await (const event of this.promptService.promptSessionStreaming(
      sessionId,
      prompt,
      taskId,
      permissionMode
    )) {
      // Capture resolved model from first event
      if (!resolvedModel && 'resolvedModel' in event && event.resolvedModel) {
        resolvedModel = event.resolvedModel;
      }

      // Capture Agent SDK session_id
      if (!capturedAgentSessionId && event.agentSessionId) {
        capturedAgentSessionId = event.agentSessionId;
        await this.captureAgentSessionId(sessionId, capturedAgentSessionId);
      }

      // Capture metadata from result events (SDK may not type this properly)
      if ('token_usage' in event && event.token_usage) {
        tokenUsage = extractTokenUsage(event.token_usage);
      }
      if ('duration_ms' in event && typeof event.duration_ms === 'number') {
        durationMs = event.duration_ms;
      }
      if ('model_usage' in event && event.model_usage) {
        // Extract context window data from model usage
        const modelUsage = event.model_usage as Record<
          string,
          {
            inputTokens: number;
            outputTokens: number;
            cacheReadInputTokens?: number;
            cacheCreationInputTokens?: number;
            contextWindow: number;
          }
        >;
        // Find the model with the highest context usage
        // (each model has its own context window, not shared)
        let maxUsage = 0;
        let maxLimit = 0;
        for (const modelData of Object.values(modelUsage)) {
          const usage =
            (modelData.inputTokens || 0) +
            (modelData.outputTokens || 0) +
            (modelData.cacheReadInputTokens || 0) +
            (modelData.cacheCreationInputTokens || 0);
          const limit = modelData.contextWindow || 0;
          if (usage > maxUsage) {
            maxUsage = usage;
            maxLimit = limit;
          }
        }
        contextWindow = maxUsage;
        contextWindowLimit = maxLimit;
        console.log(
          `🔍 [ClaudeTool] Context window: ${contextWindow}/${contextWindowLimit} (${((contextWindow / contextWindowLimit) * 100).toFixed(1)}%)`
        );
      }

      // Skip partial events in non-streaming mode
      if (event.type === 'partial') {
        continue;
      }

      // Handle complete messages only
      if (event.type === 'complete' && event.content) {
        const messageId = generateId() as MessageID;
        await createAssistantMessage(
          sessionId,
          messageId,
          event.content,
          event.toolUses,
          taskId,
          nextIndex++,
          resolvedModel,
          this.messagesService!,
          this.tasksService
        );
        assistantMessageIds.push(messageId);
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
}
