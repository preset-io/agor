/**
 * Claude Prompt Service
 *
 * Handles live execution of prompts against Claude sessions using Claude Agent SDK.
 * Automatically loads CLAUDE.md and uses preset system prompts matching Claude Code CLI.
 */

import type { PermissionMode, SDKResultMessage } from '@agor/core/sdk';
import type {
  MCPServerRepository,
  MessagesRepository,
  SessionMCPServerRepository,
  SessionRepository,
  UsersRepository,
  WorktreeRepository,
} from '../../db/feathers-repositories.js';
import type { PermissionService } from '../../permissions/permission-service.js';
import type { SessionID, TaskID } from '../../types.js';
import { MessageRole } from '../../types.js';
import type { MessagesService, SessionsPatchClient, TasksService } from '../base/index.js';
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
  private static readonly ENABLE_TOKEN_STREAMING = true;

  /** Idle timeout for SDK event loop - throws error if no messages received for this duration */
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
    private sessionsService?: SessionsPatchClient, // FeathersJS Sessions service for WebSocket broadcasting
    private worktreesRepo?: WorktreeRepository,
    private reposRepo?: import('../../db/feathers-repositories').RepoRepository,
    private messagesService?: MessagesService, // FeathersJS Messages service for creating permission requests
    private mcpEnabled?: boolean,
    private usersRepo?: UsersRepository
  ) {
    // No client initialization needed - Agent SDK is stateless
  }

  /**
   * Build help message for CLI-only commands that don't work through the SDK
   */
  private buildCLICommandHelpMessage(command: string): string {
    if (command === 'login') {
      return `**[Agor system message]**

\`/login\` is a CLI-only command that doesn't work in Agor.

To configure your Anthropic API key:

1. **System Settings → Agentic Tools → Claude Code**
2. **User Settings → Claude Code**
3. **For Claude Max Pro plan (OAuth):** You must start a \`claude\` CLI session while logged in as the Agor user

If you continue to see authentication errors, please contact your Agor administrator.`;
    }

    return `**[Agor system message]**

\`/${command}\` is a CLI-only command that only works in the standalone Claude Code terminal, not through Agor's SDK integration.`;
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
    // Intercept slash commands that don't work via the Claude Agent SDK.
    // Commands like /compact and /cost are handled natively by the SDK and pass through.
    // Commands like /clear, /help, /usage are CLI-only and return "Unknown skill" errors
    // from the SDK, so we intercept them with helpful messages instead.
    const trimmedPrompt = prompt.trim();
    const agorCommandMatch = trimmedPrompt.match(/^\/(\w+)(?:\s|$)/);
    if (agorCommandMatch) {
      const command = agorCommandMatch[1];
      const agorInterceptedCommands = ['login', 'clear', 'help', 'usage'];

      if (agorInterceptedCommands.includes(command)) {
        const helpMessage = this.buildCLICommandHelpMessage(command);

        // Yield synthetic complete message
        yield {
          type: 'complete',
          role: MessageRole.ASSISTANT,
          content: [{ type: 'text', text: helpMessage }],
          toolUses: undefined,
          parent_tool_use_id: null,
          agentSessionId: undefined,
          resolvedModel: undefined,
        };

        // Yield result with zero usage
        yield {
          type: 'result',
          raw_sdk_message: {
            type: 'result',
            subtype: 'success',
            duration_ms: 0,
            duration_api_ms: 0,
            is_error: false,
            num_turns: 0,
            result: '',
            stop_reason: null,
            total_cost_usd: 0,
            usage: {
              input_tokens: 0,
              output_tokens: 0,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            } as SDKResultMessage['usage'],
            modelUsage: {},
            permission_denials: [],
            uuid: '00000000-0000-0000-0000-000000000000',
            session_id: '00000000-0000-0000-0000-000000000000',
          },
          agentSessionId: undefined,
        };

        // Yield end
        yield { type: 'end', reason: 'result' };
        return;
      }
    }

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
        usersRepo: this.usersRepo,
        permissionLocks: this.permissionLocks,
      },
      {
        taskId,
        permissionMode,
        resume: true,
        abortController,
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
          // Handle session ID capture (only set if not already set — sdk_session_id is immutable)
          if (event.type === 'session_id_captured') {
            if (this.sessionsRepo && !existingSdkSessionId) {
              await this.sessionsRepo.update(sessionId, {
                sdk_session_id: event.agentSessionId,
              });
              console.log(`💾 Stored Agent SDK session_id in database`);
            } else if (existingSdkSessionId && existingSdkSessionId !== event.agentSessionId) {
              console.warn(
                `⚠️  SDK returned new session_id ${event.agentSessionId.substring(0, 8)} but session already has ${existingSdkSessionId.substring(0, 8)} — keeping original`
              );
            }
            continue; // Don't yield this event upstream
          }

          // On result event, call getContextUsage() then release the held input
          // stream so the SDK can close stdin.  The input iterable is kept alive
          // (via a pending Promise) specifically so this control request can use
          // stdin.  We must release it afterward regardless of success/failure.
          if (event.type === 'result') {
            try {
              const contextUsage = await result.getContextUsage();
              console.log(
                `📊 SDK context usage: ${contextUsage.totalTokens}/${contextUsage.maxTokens} tokens (${contextUsage.percentage}%)`
              );
              yield { type: 'context_usage', contextUsage } as ProcessedEvent;
            } catch (error) {
              console.warn(
                `⚠️  getContextUsage() unavailable (subprocess may have exited): ${error instanceof Error ? error.message : String(error)}`
              );
            } finally {
              // Release the held input iterable so the SDK can close stdin
              result.releaseInput();
            }
          }

          // Handle end event
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
      // Ensure stdin is released on any error so the subprocess can exit cleanly
      result.releaseInput();

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
        usersRepo: this.usersRepo,
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
