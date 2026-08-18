/**
 * Claude Prompt Service
 *
 * Handles live execution of prompts against Claude sessions using Claude Agent SDK.
 * Automatically loads CLAUDE.md and uses preset system prompts matching Claude Code CLI.
 */

import {
  type ResolvedClaudeBackgroundTaskConfig,
  resolveClaudeBackgroundTaskConfig,
} from '@agor/core/config';
import { shortId } from '@agor/core/db';
import type { PermissionMode, SDKMessage, SDKResultMessage } from '@agor/core/sdk';
import type {
  BranchRepository,
  MCPOAuthAuthHeadersRepository,
  MCPServerRepository,
  MessagesRepository,
  SessionMCPServerRepository,
  SessionRepository,
  UsersRepository,
} from '../../db/feathers-repositories.js';
import type { PermissionService } from '../../permissions/permission-service.js';
import { boundedDetail, reportSdkActivity, type SdkActivityCallback } from '../../sdk-watchdog.js';
import type { SessionID, TaskID } from '../../types.js';
import { MessageRole } from '../../types.js';
import type { MessagesService, SessionsPatchClient, TasksService } from '../base/index.js';
import { ClaudeBackgroundTaskLifecycle } from './background-task-lifecycle.js';
import { AWAIT_TIMEOUT, awaitWithTimeout } from './bounded-await.js';
import { type ProcessedEvent, SDKMessageProcessor } from './message-processor.js';
import { type InterruptibleQuery, setupQuery } from './query-builder.js';
import { aggregateClaudeResults } from './result-aggregation.js';

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

/**
 * Whether a message proves the *top-level* model turn resumed, as opposed to
 * background noise arriving while it stays finished.
 *
 * Only these lift the bounded-read regime below, and only at the top level:
 * traffic forwarded from a subagent (`parent_tool_use_id` set) means background
 * work is progressing, not that the model started thinking again, and must keep
 * the silence budget armed so a background agent that dies mid-flight is still
 * contained.
 */
function resumesTopLevelTurn(message: SDKMessage): boolean {
  if (message.type !== 'assistant' && message.type !== 'user' && message.type !== 'stream_event') {
    return false;
  }
  return message.parent_tool_use_id === null || message.parent_tool_use_id === undefined;
}

/**
 * How long the SDK has told us it intends to be quiet, as an absolute epoch ms.
 *
 * A rejected rate limit and an API retry are both waits the SDK announces once
 * and then sits out in complete silence — `SDKRateLimitEvent` is documented as
 * firing only "when rate limit info changes", and `system/api_retry` fires once
 * per attempt with the delay it is about to sleep. Without this the silence
 * budget would kill a turn that was going to resume on its own, and a five-hour
 * limit reset would do it every time.
 */
/** Prefix marking a pulse detail as a rate-limit block, for the UI to key off. */
export const RATE_LIMIT_PULSE_PREFIX = 'rate_limit.';
/** Resume signal that lifts the watchdog pause the block pulse installs. */
export const RATE_LIMIT_RESOLVED_DETAIL = 'rate_limit.resolved';

function announcedQuietUntil(message: SDKMessage, now: number): number | undefined {
  if (message.type === 'rate_limit_event') {
    const info = message.rate_limit_info;
    if (info?.status !== 'rejected') return undefined;
    // resetsAt is seconds since epoch.
    if (typeof info.resetsAt === 'number') return info.resetsAt * 1_000;
    // A rejection we cannot date is the one remaining false-kill window: the
    // budget still applies, so say so where a force-settle can be traced to it.
    console.warn(
      `⚠️  Rate limit rejected with no resetsAt (type: ${info.rateLimitType ?? 'unknown'}); ` +
        `a held turn stays bound by the background-task silence budget`
    );
    return undefined;
  }
  if (message.type === 'system' && message.subtype === 'api_retry') {
    return now + message.retry_delay_ms;
  }
  return undefined;
}

export class ClaudePromptService {
  /** Enable token-level streaming from Claude Agent SDK */
  private static readonly ENABLE_TOKEN_STREAMING = true;

  /**
   * Upper bound on the terminal-result `getContextUsage()` control request.
   *
   * This is a fast local round-trip to the CLI subprocess (normally answered in
   * milliseconds). The SDK gives it no timeout of its own, so when a subprocess
   * fails to answer after the final `result` — while we are holding stdin open
   * for exactly this request — the await would otherwise never settle and the
   * Task would stay `running` forever. 15s is far beyond any healthy response
   * yet still bounds the hang; on timeout we settle the turn without a context
   * snapshot rather than wedge the query. */
  static readonly CONTEXT_USAGE_TIMEOUT_MS = 15_000;

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
    private branchesRepo?: BranchRepository,
    private reposRepo?: import('../../db/feathers-repositories').RepoRepository,
    private messagesService?: MessagesService, // FeathersJS Messages service for creating permission requests
    private mcpEnabled?: boolean,
    private usersRepo?: UsersRepository,
    private mcpOAuthAuthHeadersRepo?: MCPOAuthAuthHeadersRepository,
    /**
     * Last-resort bounds on the query a finished turn holds open for its
     * background tasks. See {@link ClaudePromptService.nextReadTimeoutMs}.
     */
    private backgroundTasksConfig: ResolvedClaudeBackgroundTaskConfig = resolveClaudeBackgroundTaskConfig()
  ) {
    // No client initialization needed - Agent SDK is stateless
  }

  /**
   * Budget for the next read while a finished turn is held open for background
   * tasks — the only state in which reads are bounded at all.
   *
   * Two tiers, because the two waits are nothing alike:
   *
   * - **Tasks outstanding** → `silence_timeout_ms` (30m). The tasks may
   *   legitimately be working with nothing to say on the parent stream, so this
   *   is a genuine last resort. Every message re-arms it.
   * - **Nothing outstanding** → `settled_grace_ms` (2m). The last task settled
   *   and `resultDisposition` is not recomputed until another `result` arrives,
   *   so if the SDK does not wake a continuation turn nothing ever re-checks
   *   and the query sits on zero work. All that legitimately remains here is
   *   local scheduling plus the first message of the next turn.
   *
   * A wait the SDK announced (rate-limit reset, API retry backoff) is added on
   * top of whichever tier applies, so an expected silence is never mistaken for
   * a wedge. A rejected rate limit with no `resetsAt` gets no extension — the
   * tier still applies — which is the one remaining false-kill window.
   */
  private nextReadTimeoutMs(activeTaskCount: number, quietUntil: number): number {
    const tierMs =
      activeTaskCount > 0
        ? this.backgroundTasksConfig.silence_timeout_ms
        : this.backgroundTasksConfig.settled_grace_ms;
    return tierMs + Math.max(0, quietUntil - Date.now());
  }

  /**
   * Close out a turn: take a bounded context snapshot, then release the input
   * stream the SDK is holding stdin open for.
   *
   * Shared by the ordinary terminal result and the force-settle path below, so
   * `releaseInput()` can never be skipped on a path that ends the turn.
   */
  private async *finalizeTurn(query: InterruptibleQuery): AsyncGenerator<ProcessedEvent> {
    try {
      // Bounded: a subprocess that never answers this control request
      // must not wedge the query generator open (Task stuck running).
      const contextUsage = await awaitWithTimeout(
        query.getContextUsage(),
        ClaudePromptService.CONTEXT_USAGE_TIMEOUT_MS
      );
      if (contextUsage === AWAIT_TIMEOUT) {
        console.warn(
          `⚠️  getContextUsage() did not respond within ${ClaudePromptService.CONTEXT_USAGE_TIMEOUT_MS}ms; settling turn without a context snapshot`
        );
      } else {
        yield { type: 'context_usage', contextUsage };
      }
    } catch (error) {
      console.warn(
        `⚠️  getContextUsage() unavailable (subprocess may have exited): ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      // Release the held input iterable so the SDK can close stdin
      query.releaseInput();
    }
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
    abortController?: AbortController,
    onActivity?: SdkActivityCallback
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
        branchesRepo: this.branchesRepo,
        usersRepo: this.usersRepo,
        mcpOAuthAuthHeadersRepo: this.mcpOAuthAuthHeadersRepo,
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
    });
    const backgroundTasks = new ClaudeBackgroundTaskLifecycle();
    const sdkResults: SDKResultMessage[] = [];
    const clearBackgroundTaskActivity = () => {
      const activeTaskCount = backgroundTasks.clearActiveTasks();
      for (let index = 0; index < activeTaskCount; index++) {
        onActivity?.('progress', 'background_task.complete');
      }
    };

    // With AbortController passed to SDK, cancellation is handled natively.
    // When abortController.abort() is called, SDK throws AbortError which we catch below.

    const iterator = result[Symbol.asyncIterator]();
    // True only while a successful result is held back and the model has not
    // resumed. Reads are bounded exclusively inside that window: it is the one
    // state in which nothing is left to wait for but background work.
    let turnHeldForBackgroundTasks = false;
    // Absolute epoch ms the SDK has announced it will be silent until.
    let quietUntil = 0;
    // Whether the session is currently blocked on a rate limit, so the pulse
    // says "blocked", not "hung", and so the pause gets its matching resume.
    let rateLimitBlocked = false;
    // A force-settled query is presumed wedged; do not block teardown on it.
    let queryIsWedged = false;

    try {
      while (true) {
        const timeoutMs = turnHeldForBackgroundTasks
          ? this.nextReadTimeoutMs(backgroundTasks.activeTaskCount, quietUntil)
          : undefined;
        const next =
          timeoutMs === undefined
            ? await iterator.next()
            : await awaitWithTimeout(iterator.next(), timeoutMs);

        if (next === AWAIT_TIMEOUT) {
          const leaked = backgroundTasks.activeTaskIds;
          console.warn(
            leaked.length > 0
              ? `⚠️  No SDK activity for ${timeoutMs}ms with ${leaked.length} background task(s) ` +
                  `still unsettled [${leaked.join(', ')}]; force-settling the turn`
              : `⚠️  Every background task settled but the SDK did not resume within ${timeoutMs}ms; ` +
                  `force-settling the turn`
          );
          // Same escape hatch a non-success result already takes: stop
          // deferring, settle what the turn produced, and let the SDK close.
          clearBackgroundTaskActivity();
          queryIsWedged = true;
          yield* this.finalizeTurn(result);
          if (sdkResults.length > 0) {
            yield { type: 'result', raw_sdk_message: aggregateClaudeResults(sdkResults) };
          }
          break;
        }
        if (next.done) break;
        const msg = next.value;

        // The model is producing again, so the turn is no longer merely parked
        // on background work: stop bounding reads until the next held result.
        // Without this, a resumed turn that thinks for a long time or makes one
        // long silent tool call would be force-settled mid-flight.
        const modelResumed = resumesTopLevelTurn(msg);
        if (modelResumed) turnHeldForBackgroundTasks = false;
        quietUntil = Math.max(quietUntil, announcedQuietUntil(msg, Date.now()) ?? 0);

        reportSdkActivity(onActivity, 'claude-code', msg.type);
        // Emitted after the generic activity pulse so it wins as the sticky
        // latest pulse: the heartbeat re-sends that pulse every beat, which is
        // the only reason a block stays visible through a wait the SDK spends
        // in complete silence.
        const rateLimit = msg.type === 'rate_limit_event' ? msg.rate_limit_info : undefined;
        if (rateLimit?.status === 'rejected') {
          if (!rateLimitBlocked) {
            rateLimitBlocked = true;
            onActivity?.(
              'waiting',
              boundedDetail(`${RATE_LIMIT_PULSE_PREFIX}${rateLimit.rateLimitType ?? 'unknown'}`)
            );
          }
        } else if (rateLimitBlocked && (rateLimit !== undefined || modelResumed)) {
          // The limit lifted, or the model started producing again. Both end the
          // block; the resume is mandatory because a `waiting` pulse pauses the
          // watchdog until something explicitly lifts it.
          rateLimitBlocked = false;
          onActivity?.('sdk_started', RATE_LIMIT_RESOLVED_DETAIL);
        }
        const lifecycleTransition = backgroundTasks.observe(msg);
        const { resultDisposition } = lifecycleTransition;
        if (
          msg.type === 'result' &&
          msg.subtype !== 'success' &&
          backgroundTasks.activeTaskCount > 0
        ) {
          clearBackgroundTaskActivity();
        }
        if (lifecycleTransition.taskTransition === 'started') {
          // Keep the SDK watchdog paused for the documented lifetime of the
          // background task, not merely the Agent/Workflow launch tool call.
          onActivity?.('progress', 'background_task.start');
        }
        if (lifecycleTransition.taskTransition === 'settled') {
          for (let index = 0; index < (lifecycleTransition.settledTaskCount ?? 1); index++) {
            onActivity?.('progress', 'background_task.complete');
          }
        }
        // Process message through processor
        const events = await processor.process(msg);

        // Handle each event from processor
        for (const event of events) {
          if (event.type === 'tool_start') onActivity?.('progress', 'tool.start');
          if (event.type === 'tool_complete') onActivity?.('progress', 'tool.complete');
          // Handle session ID capture (only set if not already set — sdk_session_id is immutable)
          if (event.type === 'session_id_captured') {
            if (this.sessionsRepo && !existingSdkSessionId) {
              await this.sessionsRepo.update(sessionId, {
                sdk_session_id: event.agentSessionId,
              });
              console.log(`💾 Stored Agent SDK session_id in database`);
            } else if (existingSdkSessionId && existingSdkSessionId !== event.agentSessionId) {
              console.warn(
                `⚠️  SDK returned new session_id ${shortId(event.agentSessionId)} but session already has ${shortId(existingSdkSessionId)} — keeping original`
              );
            }
            continue; // Don't yield this event upstream
          }

          // On result event, call getContextUsage() then release the held input
          // stream so the SDK can close stdin.  The input iterable is kept alive
          // (via a pending Promise) specifically so this control request can use
          // stdin.  We must release it afterward regardless of success/failure.
          if (event.type === 'result') {
            sdkResults.push(event.raw_sdk_message);
            if (resultDisposition === 'await-background-tasks') {
              turnHeldForBackgroundTasks = true;
              console.log(
                `⏳ Parent turn ended with ${backgroundTasks.activeTaskCount} background task(s) still active ` +
                  `[${backgroundTasks.activeTaskIds.join(', ')}]; keeping SDK query alive`
              );
            } else {
              event.raw_sdk_message = aggregateClaudeResults(sdkResults);
              yield* this.finalizeTurn(result);
            }
          }

          // Handle end event
          if (event.type === 'end') {
            if (resultDisposition === 'await-background-tasks') {
              continue;
            }
            console.log(`🏁 Conversation ended: ${event.reason}`);
            break; // Stop draining this batch of processor events
          }

          // Yield all events including result (for token usage capture)
          yield event;
        }

        // If we got an end event, break the outer loop
        if (
          resultDisposition !== 'await-background-tasks' &&
          events.some((e) => e.type === 'end')
        ) {
          break;
        }
      }
    } catch (error) {
      // Ensure stdin is released on any error so the subprocess can exit cleanly
      clearBackgroundTaskActivity();
      result.releaseInput();

      const state = processor.getState();

      // Check if this is an AbortError from AbortController.abort()
      // This is EXPECTED during stop - the SDK throws AbortError when cancelled
      if (
        error instanceof Error &&
        (error.name === 'AbortError' || error.message.includes('abort'))
      ) {
        console.log(`🛑 [Stop] Query aborted for session ${shortId(sessionId)} - this is expected`);
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
        sessionId: shortId(sessionId),
        messageCount: state.messageCount,
        error: error instanceof Error ? error.message : String(error),
        stderr: stderrOutput || '(no stderr output)',
      });
      throw enhancedError;
    } finally {
      // `for await` used to close the query on break or on an abandoned
      // consumer; keep doing that explicitly now that iteration is manual, so
      // the subprocess is still torn down. A force-settled query already has a
      // read in flight that will never resolve, so its close is not awaited.
      const closed = Promise.resolve(iterator.return?.(undefined)).catch(() => {});
      if (!queryIsWedged) await closed;
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
        branchesRepo: this.branchesRepo,
        usersRepo: this.usersRepo,
        mcpOAuthAuthHeadersRepo: this.mcpOAuthAuthHeadersRepo,
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
          `🛑 [Stop] Query aborted via interrupt() for session ${shortId(sessionId)} (non-streaming) - this is expected`
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
      `🛑 [Deprecated] stopTask called for session ${shortId(sessionId)} - actual stop handled by AbortController`
    );
    // Cancellation is now handled by AbortController passed to SDK
    // This method is kept for API compatibility
    return { success: true };
  }
}
