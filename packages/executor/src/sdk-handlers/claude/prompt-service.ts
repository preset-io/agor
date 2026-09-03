/**
 * Claude Prompt Service
 *
 * Handles live execution of prompts against Claude sessions using Claude Agent SDK.
 * Automatically loads CLAUDE.md and uses preset system prompts matching Claude Code CLI.
 */

import { projectContextUsageSnapshot } from '@agor/core';
import { shortId } from '@agor/core/db';
import { isMCPAbortError, sanitizeMCPExternalError } from '@agor/core/mcp';
import type { PermissionMode, SDKResultMessage } from '@agor/core/sdk';
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
import { reportSdkActivity, type SdkActivityCallback } from '../../sdk-watchdog.js';
import type { SessionID, TaskID } from '../../types.js';
import { MessageRole } from '../../types.js';
import type { MessagesService, SessionsPatchClient, TasksService } from '../base/index.js';
import {
  BACKGROUND_TASK_TIMEOUT_EVENT,
  ClaudeBackgroundTaskLifecycle,
} from './background-task-lifecycle.js';
import { AWAIT_TIMEOUT, awaitWithTimeout } from './bounded-await.js';
import { type ProcessedEvent, SDKMessageProcessor } from './message-processor.js';
import { setupQuery } from './query-builder.js';
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

  /**
   * Generous upper bound on how long the query is held open when the model turn
   * ended while a background task (SDK `system/task_started`) is STILL active —
   * i.e. the agent exited its turn with background work running.
   *
   * A background task keeps running in the SDK subprocess and emits a
   * `task_notification` when it settles, optionally waking a continuation turn.
   * We keep the query alive so that continuation can be captured and so a real
   * build/test/install cycle the agent left running has time to finish. There is
   * no way to poll whether the task is still alive, and the SDK watchdog is
   * *paused* for its lifetime, so this bound is the only backstop against holding
   * the Task `running` forever if a settlement never arrives (subprocess died,
   * signal dropped, or a genuinely never-ending process). It is deliberately
   * generous — most background workloads finish well inside it — and the timer
   * resets on every SDK message, so an active task that streams progress is
   * never cut off. On timeout we settle the turn (which tears down the
   * subprocess, stopping the background work) and surface a clear, identifiable
   * system message so the event is visible and can be tuned later. Single
   * constant on purpose; bump it if your workloads background longer work. */
  static readonly BACKGROUND_TASK_ACTIVE_TIMEOUT_MS = 15 * 60_000;

  /**
   * Short grace, applied once every background task has SETTLED, to fold in an
   * auto-continuation turn the SDK may emit after the last task completes.
   * Unlike the active-task bound, no work is running here — the tasks finished —
   * so if no continuation arrives we settle promptly and cleanly, with no
   * teardown notice. This closes the "task finished but no continuation `result`
   * followed" gap in seconds instead of minutes. */
  static readonly POST_RESULT_CONTINUATION_GRACE_MS = 20_000;

  /**
   * Bounded budget for finalizing the SDK query iterator during teardown.
   *
   * Driving the iterator manually (instead of `for await`) means we own the
   * cleanup that `for await` performed automatically on `break`: closing the SDK
   * generator so its transport/subprocess is torn down. `iterator.return()` can
   * queue behind a stuck `next()`, so it must be bounded to guarantee the turn
   * still settles even if the subprocess never answers. */
  static readonly QUERY_CLOSE_TIMEOUT_MS = 5_000;

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
    private mcpOAuthAuthHeadersRepo?: MCPOAuthAuthHeadersRepository
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

    // Drive the query iterator manually (instead of `for await`) so the
    // post-`result` wait for a background-task continuation can be bounded. While
    // the query is held open past the model turn's `result`, each `next()` is
    // raced against a budget: a generous BACKGROUND_TASK_ACTIVE_TIMEOUT_MS while
    // a task is still running, or a short POST_RESULT_CONTINUATION_GRACE_MS once
    // every task has settled. This settles the Task rather than wedging it in
    // `running` forever. Because we own the iteration, we also own the iterator
    // finalization `for await` did on break (see the `finally` below).
    const iterator = result[Symbol.asyncIterator]();
    let awaitingPostResultContinuation = false;
    try {
      while (true) {
        let iteration: Awaited<ReturnType<typeof iterator.next>> | typeof AWAIT_TIMEOUT;
        if (awaitingPostResultContinuation) {
          // Tasks still active → give real background work time to finish; all
          // settled → only a short grace for an auto-continuation turn.
          const budget =
            backgroundTasks.activeTaskCount > 0
              ? ClaudePromptService.BACKGROUND_TASK_ACTIVE_TIMEOUT_MS
              : ClaudePromptService.POST_RESULT_CONTINUATION_GRACE_MS;
          iteration = await awaitWithTimeout(iterator.next(), budget);
        } else {
          iteration = await iterator.next();
        }

        if (iteration === AWAIT_TIMEOUT) {
          // The model turn's `result` was already captured; the query then went
          // silent past its budget. Settle the turn as the successful completion
          // it already is instead of holding the Task `running` forever, and
          // rebalance the watchdog paused for the background-task lifetime.
          const abandonedTaskCount = backgroundTasks.activeTaskCount;
          if (abandonedTaskCount > 0) {
            // The agent exited its turn with background work still running and it
            // never reported completion within the generous budget. Settling
            // here tears down the subprocess (stopping that work), so surface a
            // clear, identifiable notice into the conversation — visible to the
            // user and the agent, and queryable via its `sdkSubtype` for tuning.
            const timeoutMs = ClaudePromptService.BACKGROUND_TASK_ACTIVE_TIMEOUT_MS;
            const minutes = Math.round(timeoutMs / 60_000);
            // Stable, greppable operational event for the rare timeout — one line
            // with a fixed event name + bounded key=value fields (no per-turn
            // chatter; the normal held/settled paths log at most once each).
            console.warn(
              `⚠️  event=${BACKGROUND_TASK_TIMEOUT_EVENT} tasks=${abandonedTaskCount} timeout_ms=${timeoutMs} — agent ended its turn with background work still running; none reported completion in time, so the turn was settled and the background work was stopped`
            );
            yield {
              type: 'sdk_event',
              sdkType: 'agor',
              sdkSubtype: BACKGROUND_TASK_TIMEOUT_EVENT,
              summary: `The agent ended its turn with ${abandonedTaskCount} background task(s) still running. Agor waited ${minutes} minutes for them to report completion; they did not, so the turn was settled and the background work was stopped.`,
              rawMessage: {
                abandonedBackgroundTasks: abandonedTaskCount,
                timeoutMs,
              },
            } as ProcessedEvent;
          } else {
            // Every task settled, but the SDK emitted no auto-continuation
            // result. The work finished; settle cleanly with no teardown notice.
            console.log(
              '🏁 Background tasks all settled with no continuation result; settling the turn'
            );
          }
          clearBackgroundTaskActivity();
          try {
            // Best-effort cancellation of any still-running subprocess work so
            // the held `next()` can resolve and the iterator can finalize.
            // Swallow both sync throws and async rejection (and tolerate a mock
            // that returns void) so teardown never surfaces as a turn failure.
            result.interrupt?.()?.catch(() => {});
          } catch {
            // ignore — interrupt is advisory here
          }
          result.releaseInput();
          // If continuation results were collected before the wait went silent,
          // re-emit their aggregate so the terminal patch keeps cumulative
          // usage/cost. A single result was already yielded raw and is its own
          // aggregate, so only the multi-result case needs this.
          if (sdkResults.length > 1) {
            yield {
              type: 'result',
              raw_sdk_message: aggregateClaudeResults(sdkResults),
              agentSessionId: processor.getState().capturedAgentSessionId,
            } as ProcessedEvent;
          }
          break;
        }

        if (iteration.done) {
          // Generator closed on its own (e.g. subprocess exited). Release the
          // held input so nothing downstream waits on stdin, then settle.
          result.releaseInput();
          break;
        }

        const msg = iteration.value;
        reportSdkActivity(onActivity, 'claude-code', msg.type);
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
          onActivity?.('progress', 'background_task.complete');
        }
        // Process message through processor
        const events = await processor.process(msg);

        let ended = false;
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
              // Bound the wait: from here every `next()` is raced against the
              // idle timeout so a continuation that never arrives cannot wedge
              // the query open indefinitely.
              awaitingPostResultContinuation = true;
              console.log(
                `⏳ Parent turn ended with ${backgroundTasks.activeTaskCount} background task(s) still active; keeping SDK query alive`
              );
            } else {
              awaitingPostResultContinuation = false;
              event.raw_sdk_message = aggregateClaudeResults(sdkResults);
              try {
                // Bounded: a subprocess that never answers this control request
                // must not wedge the query generator open (Task stuck running).
                const contextUsage = await awaitWithTimeout(
                  result.getContextUsage(),
                  ClaudePromptService.CONTEXT_USAGE_TIMEOUT_MS
                );
                if (contextUsage === AWAIT_TIMEOUT) {
                  console.warn(
                    `⚠️  getContextUsage() did not respond within ${ClaudePromptService.CONTEXT_USAGE_TIMEOUT_MS}ms; settling turn without a context snapshot`
                  );
                } else {
                  const snapshot = projectContextUsageSnapshot(contextUsage);
                  if (snapshot) {
                    yield { type: 'context_usage', contextUsage: snapshot } as ProcessedEvent;
                  } else {
                    console.warn(
                      '⚠️  getContextUsage() returned an invalid context snapshot; settling turn without it'
                    );
                  }
                }
              } catch (error) {
                const safe = sanitizeMCPExternalError(error, { stage: 'runtime' });
                console.warn(
                  `⚠️  getContextUsage() unavailable category=${safe.category} type=${safe.diagnostic.type}`
                );
              } finally {
                // Release the held input iterable so the SDK can close stdin
                result.releaseInput();
              }
            }
          }

          // Handle end event
          if (event.type === 'end') {
            if (resultDisposition === 'await-background-tasks') {
              continue;
            }
            console.log(`🏁 Conversation ended: ${event.reason}`);
            ended = true;
            break; // Stop processing this batch of events
          }

          // Yield all events including result (for token usage capture)
          yield event;
        }

        // A terminal `end` (outside the background-task hold) closes the query.
        if (ended) {
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
      if (isMCPAbortError(error)) {
        console.log(`🛑 [Stop] Query aborted for session ${shortId(sessionId)} - this is expected`);
        // Yield stopped event to signal execution was halted
        yield { type: 'stopped' } as ProcessedEvent;
        // Don't throw - this is a clean stop, not an error
        return;
      }

      // stderr and SDK exceptions can contain MCP URLs, headers, or reflected
      // provider payloads. Retain only presence + closed failure metadata.
      const stderrOutput = getStderr();
      const safe = sanitizeMCPExternalError(error, { stage: 'runtime' });
      console.error(`❌ SDK iteration failed:`, {
        sessionId: shortId(sessionId),
        messageCount: state.messageCount,
        category: safe.category,
        type: safe.diagnostic.type,
        hasStderr: Boolean(stderrOutput),
      });
      throw new Error(safe.message);
    } finally {
      // Manual iteration means we own the finalization `for await` did on break:
      // close the SDK Query so its transport/subprocess is torn down and no stray
      // query is left alive to race the next resume. Finalize the Query OBJECT
      // (`result.return()`), NOT `iterator.return()`: the Query's own `return()`
      // runs `cleanup()` first — closing the transport/stdin — which is what
      // resolves an outstanding held read, whereas the inner iterator's
      // `return()` is serialized behind that same stuck read and would never run.
      // Bounded because `cleanup()` awaits the subprocess exit.
      try {
        const closing = result.return?.();
        if (closing) {
          await awaitWithTimeout(closing, ClaudePromptService.QUERY_CLOSE_TIMEOUT_MS);
        }
      } catch {
        // best-effort — teardown must never turn a settled turn into a failure
      }
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
      if (isMCPAbortError(error)) {
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
      throw new Error(sanitizeMCPExternalError(error, { stage: 'runtime' }).message);
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
