/**
 * Claude Prompt Service
 *
 * Handles live execution of prompts against Claude sessions using Claude Agent SDK.
 * Automatically loads CLAUDE.md and uses preset system prompts matching Claude Code CLI.
 */

import type { PermissionMode } from '@agor/core/sdk';
import type {
  MCPServerRepository,
  MessagesRepository,
  SessionMCPServerRepository,
  SessionRepository,
  WorktreeRepository,
} from '../../db/feathers-repositories.js';
import type { PermissionService } from '../../permissions/permission-service.js';
import type { SessionID, TaskID } from '../../types.js';
import { MessageRole } from '../../types.js';
import type { SessionsService, TasksService } from './claude-tool.js';
import { type ProcessedEvent, SDKMessageProcessor } from './message-processor.js';
import { setupQuery } from './query-builder.js';

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
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: toggled in future when streaming support lands
  private static readonly ENABLE_TOKEN_STREAMING = true;

  /** Idle timeout for SDK event loop - throws error if no messages received for this duration */
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: reserved for future SDK config toggles
  private static readonly IDLE_TIMEOUT_MS = 300000; // 5 minutes

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
    private reposRepo?: import('../../db/feathers-repositories').RepoRepository,
    private messagesService?: import('./claude-tool').MessagesService, // FeathersJS Messages service for creating permission requests
    private mcpEnabled?: boolean,
    // biome-ignore lint/suspicious/noExplicitAny: Feathers service type
    private mcpOAuthNotifyService?: any // Service for notifying UI about OAuth requirements
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
   * @param abortController - Optional AbortController for cancellation support (passed to SDK)
   * @returns Async generator yielding assistant messages with SDK session ID
   */
  async *promptSessionStreaming(
    sessionId: SessionID,
    prompt: string,
    taskId?: TaskID,
    permissionMode?: PermissionMode,
    _chunkCallback?: (messageId: string, chunk: string) => void,
    abortController?: AbortController
  ): AsyncGenerator<ProcessedEvent> {
    const {
      query: result,
      getStderr,
      oauthServersNeedingAuth,
    } = await setupQuery(
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
        abortController,
      }
    );

    // Notify UI if OAuth MCP servers need authentication
    if (oauthServersNeedingAuth.length > 0 && this.mcpOAuthNotifyService) {
      try {
        // Call the daemon's oauth-notify service to broadcast to UI
        await this.mcpOAuthNotifyService.create({
          session_id: sessionId,
          servers: oauthServersNeedingAuth,
        });
        console.log(
          `[OAuth] Notified UI about ${oauthServersNeedingAuth.length} server(s) needing auth`
        );
      } catch (error) {
        console.warn('[OAuth] Failed to notify UI about OAuth requirements:', error);
      }
    }

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

    // With AbortController passed to SDK, cancellation is handled natively.
    // When abortController.abort() is called, SDK throws AbortError which we catch below.

    try {
      for await (const msg of result) {
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

      // Check if this is an AbortError from AbortController.abort()
      // This is EXPECTED during stop - the SDK throws AbortError when cancelled
      if (
        error instanceof Error &&
        (error.name === 'AbortError' || error.message.includes('abort'))
      ) {
        console.log(
          `🛑 [Stop] Query aborted for session ${sessionId.substring(0, 8)} - this is expected`
        );
        // Yield stopped event to signal execution was halted
        yield { type: 'stopped' } as ProcessedEvent;
        // Don't throw - this is a clean stop, not an error
        return;
      }

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
    const { query: result, oauthServersNeedingAuth } = await setupQuery(
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

    // Notify UI if OAuth MCP servers need authentication
    if (oauthServersNeedingAuth.length > 0 && this.mcpOAuthNotifyService) {
      try {
        await this.mcpOAuthNotifyService.create({
          session_id: sessionId,
          servers: oauthServersNeedingAuth,
        });
      } catch (error) {
        console.warn('[OAuth] Failed to notify UI about OAuth requirements:', error);
      }
    }

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
          if (event.type === 'result' && event.raw_sdk_message?.usage) {
            tokenUsage = event.raw_sdk_message.usage as {
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
    } catch (error) {
      // Check if this is an AbortError from interrupt() - this is EXPECTED during stop
      if (
        error instanceof Error &&
        (error.name === 'AbortError' || error.message.includes('abort'))
      ) {
        console.log(
          `🛑 [Stop] Query aborted via interrupt() for session ${sessionId.substring(0, 8)} (non-streaming) - this is expected`
        );
        // Don't throw - this is a clean stop, not an error
        // Return empty result since we were stopped
        return {
          messages: assistantMessages,
          inputTokens: tokenUsage?.input_tokens || 0,
          outputTokens: tokenUsage?.output_tokens || 0,
        };
      }
      // Re-throw other errors
      throw error;
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
   * @deprecated This method is no longer needed - cancellation is now handled via AbortController
   * passed directly to the SDK. The executor's abortController.abort() triggers SDK's AbortError.
   *
   * Kept for API compatibility but returns success immediately (actual stop happens via AbortController).
   *
   * @param sessionId - Session identifier
   * @returns Success status (always true since actual stop is via AbortController)
   */
  async stopTask(sessionId: SessionID): Promise<{ success: boolean; reason?: string }> {
    console.log(
      `🛑 [Deprecated] stopTask called for session ${sessionId.substring(0, 8)} - actual stop handled by AbortController`
    );
    // Cancellation is now handled by AbortController passed to SDK
    // This method is kept for API compatibility
    return { success: true };
  }
}
