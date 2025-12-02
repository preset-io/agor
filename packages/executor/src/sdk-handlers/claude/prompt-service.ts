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
import { type InterruptibleQuery, setupQuery } from './query-builder.js';

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

  /** Store active Query objects per session for interruption */
  private activeQueries = new Map<SessionID, InterruptibleQuery>();

  /** Track stop requests for immediate loop breaking */
  private stopRequested = new Map<SessionID, boolean>();

  /** Serialize permission checks per session to prevent duplicate prompts for concurrent tool calls */
  private permissionLocks = new Map<SessionID, Promise<void>>();

  /** Active stop monitors per session - cleanup handles for concurrent stop detection */
  private stopMonitors = new Map<SessionID, NodeJS.Timeout>();

  /** Track if interrupt() is in flight to prevent overlapping calls */
  private interruptInFlight = new Map<SessionID, boolean>();

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
  ): AsyncGenerator<ProcessedEvent> {
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

    // 🔥 Start concurrent stop monitor - polls stopRequested independently of message loop
    // This ensures stop works even during long-running tool executions (build, lint, etc.)
    this.startStopMonitor(sessionId, result);

    try {
      for await (const msg of result) {
        // Check if stop was requested before processing message
        if (this.stopRequested.get(sessionId)) {
          console.log(
            `🛑 Stop requested for session ${sessionId.substring(0, 8)}, breaking event loop`
          );
          this.stopRequested.delete(sessionId);
          // Yield a 'stopped' event to signal execution was halted
          yield { type: 'stopped' } as ProcessedEvent;
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

      // Check if this is an AbortError from interrupt() - this is EXPECTED during stop
      if (
        error instanceof Error &&
        (error.name === 'AbortError' || error.message.includes('abort'))
      ) {
        console.log(
          `🛑 [Stop] Query aborted via interrupt() for session ${sessionId.substring(0, 8)} - this is expected`
        );
        // Yield stopped event if we haven't already
        if (this.stopRequested.get(sessionId)) {
          yield { type: 'stopped' } as ProcessedEvent;
          this.stopRequested.delete(sessionId);
        }
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
    } finally {
      // Stop the concurrent stop monitor
      this.stopStopMonitor(sessionId);

      // CRITICAL: Always clear stopRequested flag to prevent poisoning the session
      // If we don't clear it here, a stop near the end leaves the flag set forever,
      // causing the next prompt to auto-stop immediately
      this.stopRequested.delete(sessionId);

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

    // 🔥 Start concurrent stop monitor (same as streaming mode)
    this.startStopMonitor(sessionId, result);

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
    } finally {
      // Stop the concurrent stop monitor
      this.stopStopMonitor(sessionId);

      // CRITICAL: Always clear stopRequested flag to prevent poisoning the session
      this.stopRequested.delete(sessionId);

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
   * Start concurrent stop monitor for a session
   *
   * This monitor polls stopRequested every 100ms and calls interrupt() immediately when detected.
   * This is CRITICAL for stopping long-running tool executions (build, lint, etc.) where the
   * SDK doesn't yield messages for extended periods.
   *
   * Without this monitor, stop only works when the message loop iterates, which may not happen
   * for 30+ seconds during tool execution.
   *
   * @param sessionId - Session to monitor
   * @param query - Query object with interrupt() method
   */
  private startStopMonitor(sessionId: SessionID, query: InterruptibleQuery): void {
    // Check every 100ms - fast enough to feel instant (<100ms is imperceptible to users)
    // but light enough to not impact performance (simple boolean check 10x/second)
    const checkInterval = setInterval(async () => {
      // Only proceed if stop was requested AND we're not already calling interrupt()
      if (!this.stopRequested.get(sessionId)) {
        return;
      }

      // Prevent overlapping interrupt() calls
      if (this.interruptInFlight.get(sessionId)) {
        return;
      }

      console.log(
        `🔥 [Stop Monitor] Detected stop request for ${sessionId.substring(0, 8)}, calling interrupt()...`
      );

      this.interruptInFlight.set(sessionId, true);

      try {
        // Call interrupt() IMMEDIATELY - don't wait for next message in loop
        await query.interrupt();
        console.log(`✅ [Stop Monitor] interrupt() called successfully`);
        // Note: interrupt() causes the SDK to stop yielding messages
        // The main loop will detect this via stopRequested check and yield { type: 'stopped' }
        // This ensures wasStopped flag is set properly in claude-tool.ts

        // Success! Stop monitoring since interrupt worked
        this.stopStopMonitor(sessionId);
      } catch (error) {
        console.error(`❌ [Stop Monitor] interrupt() failed:`, error);
        // Don't stop monitoring - keep trying in case it was a transient error
        // The finally block cleanup will handle stopRequested regardless
      } finally {
        this.interruptInFlight.delete(sessionId);
      }
    }, 100); // Poll every 100ms

    this.stopMonitors.set(sessionId, checkInterval);
    console.log(`👁️  [Stop Monitor] Started for session ${sessionId.substring(0, 8)}`);
  }

  /**
   * Stop the concurrent stop monitor for a session
   *
   * Called when query completes naturally or is interrupted.
   */
  private stopStopMonitor(sessionId: SessionID): void {
    const monitor = this.stopMonitors.get(sessionId);
    if (monitor) {
      clearInterval(monitor);
      this.stopMonitors.delete(sessionId);
      this.interruptInFlight.delete(sessionId); // Clean up in-flight flag too
      console.log(`👁️  [Stop Monitor] Stopped for session ${sessionId.substring(0, 8)}`);
    }
  }

  /**
   * Stop currently executing task
   *
   * Uses Claude Agent SDK's native interrupt() method to gracefully stop execution.
   * This is the same mechanism used by the Escape key in Claude Code CLI.
   *
   * NOTE: The actual interrupt() call happens in the concurrent stop monitor (startStopMonitor)
   * which polls stopRequested every 100ms. This ensures stop works even during long-running
   * tool executions where SDK messages aren't being yielded.
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
      // Set stop flag - the concurrent monitor will detect this within 100ms and call interrupt()
      this.stopRequested.set(sessionId, true);
      console.log(
        `🚩 [Stop Task] Set stopRequested flag - monitor will call interrupt() within 100ms`
      );

      console.log(`✅ Initiated stop for session ${sessionId.substring(0, 8)}`);
      return { success: true };
    } catch (error) {
      console.error('Failed to set stop flag:', error);
      // Clean up stop flag on error
      this.stopRequested.delete(sessionId);
      return {
        success: false,
        reason: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
}
