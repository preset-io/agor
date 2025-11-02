/**
 * Claude Prompt Service
 *
 * Handles live execution of prompts against Claude sessions using Claude Agent SDK.
 * Automatically loads CLAUDE.md and uses preset system prompts matching Claude Code CLI.
 */

import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk/sdk';
import type { MCPServerRepository } from '../../db/repositories/mcp-servers';
import type { MessagesRepository } from '../../db/repositories/messages';
import type { SessionMCPServerRepository } from '../../db/repositories/session-mcp-servers';
import type { SessionRepository } from '../../db/repositories/sessions';
import type { WorktreeRepository } from '../../db/repositories/worktrees';
import type { PermissionService } from '../../permissions/permission-service';
import type { SessionID, TaskID } from '../../types';
import { MessageRole } from '../../types';
import type { SessionsService, TasksService } from './claude-tool';
import { SDKMessageProcessor } from './message-processor';
import { setupQuery } from './query-builder';

export interface PromptResult {
  /** Assistant messages (can be multiple: tool invocation, then response) */
  messages: Array<{
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
  }>;
  /** Number of input tokens */
  inputTokens: number;
  /** Number of output tokens */
  outputTokens: number;
}

export class ClaudePromptService {
  /** Enable token-level streaming from Claude Agent SDK */
  private static readonly ENABLE_TOKEN_STREAMING = true;

  /** Idle timeout for SDK event loop - throws error if no messages received for this duration */
  private static readonly IDLE_TIMEOUT_MS = 300000; // 5 minutes

  /** Store active Query objects per session for interruption */
  // biome-ignore lint/suspicious/noExplicitAny: Query type from SDK is complex
  private activeQueries = new Map<SessionID, any>();

  /** Track stop requests for immediate loop breaking */
  private stopRequested = new Map<SessionID, boolean>();

  /** Serialize permission checks per session to prevent duplicate prompts for concurrent tool calls */
  private permissionLocks = new Map<SessionID, Promise<void>>();

  constructor(
    private messagesRepo: MessagesRepository,
    private sessionsRepo: SessionRepository,
    private apiKey?: string,
    private sessionMCPRepo?: SessionMCPServerRepository,
    private mcpServerRepo?: MCPServerRepository,
    private permissionService?: PermissionService,
    private tasksService?: TasksService,
    private sessionsService?: SessionsService, // FeathersJS Sessions service for WebSocket broadcasting
    private worktreesRepo?: WorktreeRepository,
    private reposRepo?: import('../../db/repositories/repos').RepoRepository,
    private messagesService?: import('./claude-tool').MessagesService, // FeathersJS Messages service for creating permission requests
    private mcpEnabled?: boolean
  ) {
    // No client initialization needed - Agent SDK is stateless
  }

  /**
   * Prompt a session using Claude Agent SDK (streaming version with text chunking)
   *
   * Yields both complete assistant messages AND text chunks as they're generated.
   * This enables real-time typewriter effect in the UI.
   *
   * @param sessionId - Session to prompt
   * @param prompt - User prompt
   * @param taskId - Optional task ID for permission tracking
   * @param permissionMode - Optional permission mode for SDK
   * @param chunkCallback - Optional callback for text chunks (3-10 words)
   * @returns Async generator yielding assistant messages with SDK session ID
   */
  async *promptSessionStreaming(
    sessionId: SessionID,
    prompt: string,
    taskId?: TaskID,
    permissionMode?: PermissionMode,
    _chunkCallback?: (messageId: string, chunk: string) => void
  ): AsyncGenerator<
    | {
        type: 'partial';
        textChunk: string;
        agentSessionId?: string;
        resolvedModel?: string;
      }
    | {
        type: 'thinking_partial';
        thinkingChunk: string;
        agentSessionId?: string;
      }
    | {
        type: 'complete';
        role?: MessageRole.ASSISTANT | MessageRole.USER;
        content: Array<{
          type: string;
          text?: string;
          id?: string;
          name?: string;
          input?: Record<string, unknown>;
        }>;
        toolUses?: Array<{ id: string; name: string; input: Record<string, unknown> }>;
        agentSessionId?: string;
        resolvedModel?: string;
      }
    | {
        type: 'tool_start';
        toolName: string;
        toolUseId: string;
        agentSessionId?: string;
      }
    | {
        type: 'tool_complete';
        toolUseId: string;
        agentSessionId?: string;
      }
    | {
        type: 'message_start';
        agentSessionId?: string;
      }
    | {
        type: 'message_complete';
        agentSessionId?: string;
      }
    | {
        type: 'result';
        subtype: string;
        duration_ms?: number;
        cost?: number;
        token_usage?: unknown;
        agentSessionId?: string;
      }
  > {
    const { query: result, getStderr } = await setupQuery(
      sessionId,
      prompt,
      {
        sessionsRepo: this.sessionsRepo,
        reposRepo: this.reposRepo,
        messagesRepo: this.messagesRepo,
        apiKey: this.apiKey,
        sessionMCPRepo: this.sessionMCPRepo,
        mcpServerRepo: this.mcpServerRepo,
        permissionService: this.permissionService,
        tasksService: this.tasksService,
        mcpEnabled: this.mcpEnabled,
        sessionsService: this.sessionsService,
        messagesService: this.messagesService,
        worktreesRepo: this.worktreesRepo,
        permissionLocks: this.permissionLocks,
      },
      {
        taskId,
        permissionMode,
        resume: true,
      }
    );

    // Get session for reference (needed to check existing sdk_session_id)
    const session = await this.sessionsRepo?.findById(sessionId);
    const existingSdkSessionId = session?.sdk_session_id;

    // Create message processor for this query
    const processor = new SDKMessageProcessor({
      sessionId,
      existingSdkSessionId,
      enableTokenStreaming: ClaudePromptService.ENABLE_TOKEN_STREAMING,
      idleTimeoutMs: ClaudePromptService.IDLE_TIMEOUT_MS,
    });

    // Store query reference for interruption via stopTask()
    // This must happen BEFORE iteration starts so stopTask() can access it
    this.activeQueries.set(sessionId, result);
    console.log(`📌 Stored query reference for session ${sessionId.substring(0, 8)}`);

    try {
      for await (const msg of result) {
        // Check if stop was requested before processing message
        if (this.stopRequested.get(sessionId)) {
          console.log(
            `🛑 Stop requested for session ${sessionId.substring(0, 8)}, breaking event loop`
          );
          this.stopRequested.delete(sessionId);
          break;
        }

        // Check for timeout - throw error to trigger proper cleanup
        if (processor.hasTimedOut()) {
          const state = processor.getState();
          const idleSeconds = Math.round((Date.now() - state.lastActivityTime) / 1000);
          const timeoutSeconds = Math.round(state.idleTimeoutMs / 1000);

          throw new Error(
            `Claude SDK idle timeout: No activity for ${idleSeconds}s (timeout: ${timeoutSeconds}s). ` +
              `SDK may have hung or crashed. Last message type was #${state.messageCount}.`
          );
        }

        // Process message through processor
        const events = await processor.process(msg);

        // Handle each event from processor
        for (const event of events) {
          // Handle session ID capture
          if (event.type === 'session_id_captured') {
            if (this.sessionsRepo) {
              await this.sessionsRepo.update(sessionId, {
                sdk_session_id: event.agentSessionId,
              });
              console.log(`💾 Stored Agent SDK session_id in database`);
            }
            continue; // Don't yield this event upstream
          }

          // Handle end event (break loop)
          if (event.type === 'end') {
            console.log(`🏁 Conversation ended: ${event.reason}`);
            break; // Exit for-await loop
          }

          // Yield all events including result (for token usage capture)
          yield event;
        }

        // If we got an end event, break the outer loop
        if (events.some((e) => e.type === 'end')) {
          break;
        }
      }
    } catch (error) {
      const state = processor.getState();

      // Get actual error message from stderr if available
      const stderrOutput = getStderr();
      const errorContext = stderrOutput ? `\n\nClaude Code stderr output:\n${stderrOutput}` : '';

      // Enhance error with context
      const enhancedError = new Error(
        `Claude SDK error after ${state.messageCount} messages: ${error instanceof Error ? error.message : String(error)}${errorContext}`
      );
      // Preserve original stack
      if (error instanceof Error && error.stack) {
        enhancedError.stack = error.stack;
      }
      console.error(`❌ SDK iteration failed:`, {
        sessionId: sessionId.substring(0, 8),
        messageCount: state.messageCount,
        error: error instanceof Error ? error.message : String(error),
        stderr: stderrOutput || '(no stderr output)',
      });
      throw enhancedError;
    } finally {
      // Clean up query reference - always runs regardless of success/failure/stop
      this.activeQueries.delete(sessionId);
      console.log(`🧹 Cleaned up query reference for session ${sessionId.substring(0, 8)}`);
    }
  }

  /**
   * Prompt a session using Claude Agent SDK (non-streaming version)
   *
   * The Agent SDK automatically:
   * - Loads CLAUDE.md from the working directory
   * - Uses Claude Code preset system prompt
   * - Handles streaming via async generators
   *
   * @param sessionId - Session to prompt
   * @param prompt - User prompt
   * @returns Complete assistant response with metadata
   */
  async promptSession(sessionId: SessionID, prompt: string): Promise<PromptResult> {
    const { query: result } = await setupQuery(
      sessionId,
      prompt,
      {
        sessionsRepo: this.sessionsRepo,
        reposRepo: this.reposRepo,
        messagesRepo: this.messagesRepo,
        apiKey: this.apiKey,
        sessionMCPRepo: this.sessionMCPRepo,
        mcpServerRepo: this.mcpServerRepo,
        permissionService: this.permissionService,
        tasksService: this.tasksService,
        mcpEnabled: this.mcpEnabled,
        sessionsService: this.sessionsService,
        messagesService: this.messagesService,
        worktreesRepo: this.worktreesRepo,
        permissionLocks: this.permissionLocks,
      },
      {
        taskId: undefined,
        permissionMode: undefined,
        resume: false,
      }
    );

    // Get session for reference
    const session = await this.sessionsRepo?.findById(sessionId);
    const existingSdkSessionId = session?.sdk_session_id;

    // Create message processor
    const processor = new SDKMessageProcessor({
      sessionId,
      existingSdkSessionId,
      enableTokenStreaming: false, // Non-streaming mode
      idleTimeoutMs: ClaudePromptService.IDLE_TIMEOUT_MS,
    });

    // Store query reference for interruption via stopTask()
    this.activeQueries.set(sessionId, result);
    console.log(
      `📌 Stored query reference for session ${sessionId.substring(0, 8)} (non-streaming)`
    );

    // Collect response messages from async generator
    // IMPORTANT: Keep assistant messages SEPARATE (don't merge into one)
    const assistantMessages: Array<{
      content: Array<{
        type: string;
        text?: string;
        id?: string;
        name?: string;
        input?: Record<string, unknown>;
      }>;
      toolUses?: Array<{ id: string; name: string; input: Record<string, unknown> }>;
    }> = [];

    // Accumulate token usage from result events
    let tokenUsage:
      | {
          input_tokens?: number;
          output_tokens?: number;
          cache_creation_tokens?: number;
          cache_read_tokens?: number;
        }
      | undefined;

    try {
      for await (const msg of result) {
        const events = await processor.process(msg);

        for (const event of events) {
          // Only collect complete assistant messages
          if (event.type === 'complete' && event.role === MessageRole.ASSISTANT) {
            assistantMessages.push({
              content: event.content,
              toolUses: event.toolUses,
            });
          }

          // Capture token usage from result events
          if (event.type === 'result' && event.token_usage) {
            tokenUsage = event.token_usage as {
              input_tokens?: number;
              output_tokens?: number;
              cache_creation_tokens?: number;
              cache_read_tokens?: number;
            };
          }

          // Break on end event
          if (event.type === 'end') {
            break;
          }
        }
      }
    } finally {
      // Clean up query reference - always runs regardless of success/failure/stop
      this.activeQueries.delete(sessionId);
      console.log(
        `🧹 Cleaned up query reference for session ${sessionId.substring(0, 8)} (non-streaming)`
      );
    }

    // Extract token counts from SDK result metadata
    return {
      messages: assistantMessages,
      inputTokens: tokenUsage?.input_tokens || 0,
      outputTokens: tokenUsage?.output_tokens || 0,
    };
  }

  /**
   * Stop currently executing task
   *
   * Uses Claude Agent SDK's native interrupt() method to gracefully stop execution.
   * This is the same mechanism used by the Escape key in Claude Code CLI.
   *
   * @param sessionId - Session identifier
   * @returns Success status
   */
  async stopTask(sessionId: SessionID): Promise<{ success: boolean; reason?: string }> {
    console.log(`🛑 Stopping task for session ${sessionId.substring(0, 8)}`);

    const queryObj = this.activeQueries.get(sessionId);

    if (!queryObj) {
      return {
        success: false,
        reason: 'No active task found for this session',
      };
    }

    try {
      // Set stop flag first for immediate loop breaking
      this.stopRequested.set(sessionId, true);

      // Call native interrupt() method on Query object
      // This is exactly what the Escape key uses in Claude Code CLI
      await queryObj.interrupt();

      // Clean up query reference
      this.activeQueries.delete(sessionId);

      console.log(`✅ Stopped Claude execution for session ${sessionId.substring(0, 8)}`);
      return { success: true };
    } catch (error) {
      console.error('Failed to interrupt Claude execution:', error);
      // Clean up stop flag on error
      this.stopRequested.delete(sessionId);
      return {
        success: false,
        reason: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
}
