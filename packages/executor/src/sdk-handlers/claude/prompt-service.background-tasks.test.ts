import type { SDKMessage } from '@agor/core/sdk';
import type { SessionID } from '@agor/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./query-builder.js', () => ({
  setupQuery: vi.fn(),
}));

import { ClaudePromptService } from './prompt-service.js';
import { setupQuery } from './query-builder.js';

const sessionId = 'session-1' as SessionID;

function sdkResult(uuid: string): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: false,
    num_turns: 1,
    result: '',
    stop_reason: null,
    total_cost_usd: 0.01,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
      service_tier: 'standard',
    },
    modelUsage: {},
    permission_denials: [],
    uuid,
    session_id: 'sdk-session',
  };
}

/**
 * Models the installed SDK Query as a wrapper distinct from its inner message
 * generator. Iterating the Query returns the inner generator
 * (`[Symbol.asyncIterator]() { return this.sdkMessages }`), while the Query's own
 * `return()` runs `cleanup()` FIRST — closing the transport — and only then
 * delegates to the inner generator's `return()`
 * (`async return(e){ return await this.cleanup(), this.sdkMessages.return(e) }`).
 * Closing the transport is what resolves a held read, so teardown must call the
 * Query's `return()`, not the inner iterator's.
 */
function fakeQuery(
  messages: SDKMessage[] | ((transportClosed: Promise<void>) => AsyncGenerator<SDKMessage>)
) {
  const releaseInput = vi.fn();
  const getContextUsage = vi.fn().mockResolvedValue({
    totalTokens: 15,
    maxTokens: 200_000,
    percentage: 0.0075,
    memoryFiles: [{ path: 'SENTINEL_CONTEXT_MEMORY', type: 'project', tokens: 2 }],
    providerExtension: 'SENTINEL_CONTEXT_EXTENSION',
  });

  // The fake transport: `cleanup()` closes it, which resolves any read the inner
  // stream is holding (a wedged fake stream awaits `transportClosed`).
  let closeTransport = () => {};
  const transportClosed = new Promise<void>((resolve) => {
    closeTransport = () => resolve();
  });

  const inner =
    typeof messages === 'function'
      ? messages(transportClosed)
      : (async function* () {
          yield* messages;
        })();
  const innerReturn = vi.fn(inner.return.bind(inner));
  inner.return = innerReturn as typeof inner.return;

  const cleanup = vi.fn(async () => {
    closeTransport();
  });
  const queryReturn = vi.fn(async (value?: unknown) => {
    await cleanup();
    return inner.return(value as never);
  });

  return {
    [Symbol.asyncIterator]: () => inner,
    interrupt: vi.fn(),
    releaseInput,
    getContextUsage,
    cleanup,
    innerReturn,
    return: queryReturn,
  };
}

function service() {
  return new ClaudePromptService(
    {} as never,
    {
      findById: vi.fn().mockResolvedValue({
        session_id: sessionId,
        sdk_session_id: 'sdk-session',
      }),
    } as never
  );
}

describe('ClaudePromptService background task query lifetime', () => {
  beforeEach(() => vi.clearAllMocks());

  it('retains the parent result and releases input only after the continuation result', async () => {
    const query = fakeQuery([
      {
        type: 'system',
        subtype: 'task_started',
        task_id: 'task-1',
        description: 'Explore',
        uuid: 'start',
        session_id: 'sdk-session',
      },
      sdkResult('parent-result'),
      {
        type: 'system',
        subtype: 'task_notification',
        task_id: 'task-1',
        status: 'completed',
        output_file: '/tmp/task-1',
        summary: 'done',
        uuid: 'notification',
        session_id: 'sdk-session',
      },
      sdkResult('continuation-result'),
    ]);
    vi.mocked(setupQuery).mockResolvedValue({
      query: query as never,
      resolvedModel: 'claude-sonnet-4-6',
      getStderr: () => '',
    });
    const activity = vi.fn();

    const events = [];
    for await (const event of service().promptSessionStreaming(
      sessionId,
      'prompt',
      undefined,
      undefined,
      undefined,
      undefined,
      activity
    )) {
      events.push(event);
    }

    expect(
      events.filter((event) => event.type === 'result').map((event) => event.raw_sdk_message.uuid)
    ).toEqual(['parent-result', 'continuation-result']);
    // `end` is an internal processor sentinel and is never yielded upstream.
    expect(events.filter((event) => event.type === 'end')).toHaveLength(0);
    expect(events.filter((event) => event.type === 'context_usage')).toHaveLength(1);
    expect(events.find((event) => event.type === 'context_usage')).toEqual({
      type: 'context_usage',
      contextUsage: { totalTokens: 15, maxTokens: 200_000, percentage: 0.0075 },
    });
    expect(JSON.stringify(events)).not.toContain('SENTINEL_CONTEXT');
    expect(query.getContextUsage).toHaveBeenCalledTimes(1);
    expect(query.releaseInput).toHaveBeenCalledTimes(1);
    const terminalResult = events.filter((event) => event.type === 'result').at(-1);
    expect(terminalResult?.raw_sdk_message).toMatchObject({
      total_cost_usd: 0.02,
      num_turns: 2,
      usage: { input_tokens: 20, output_tokens: 10 },
    });
    expect(activity).toHaveBeenCalledWith('progress', 'background_task.start');
    expect(activity).toHaveBeenCalledWith('progress', 'background_task.complete');
  });

  it('settles an early task_updated completion when no task_notification follows', async () => {
    const query = fakeQuery([
      {
        type: 'system',
        subtype: 'task_started',
        task_id: 'task-1',
        description: 'Short background Bash',
        uuid: 'start',
        session_id: 'sdk-session',
      },
      {
        type: 'system',
        subtype: 'task_updated',
        task_id: 'task-1',
        patch: { status: 'completed', end_time: 1_000 },
        uuid: 'updated',
        session_id: 'sdk-session',
      },
      sdkResult('terminal-result'),
    ]);
    vi.mocked(setupQuery).mockResolvedValue({
      query: query as never,
      resolvedModel: 'claude-sonnet-4-6',
      getStderr: () => '',
    });
    const activity = vi.fn();

    const events = [];
    for await (const event of service().promptSessionStreaming(
      sessionId,
      'prompt',
      undefined,
      undefined,
      undefined,
      undefined,
      activity
    )) {
      events.push(event);
    }

    expect(events.filter((event) => event.type === 'result')).toHaveLength(1);
    expect(query.releaseInput).toHaveBeenCalledTimes(1);
    expect(activity).toHaveBeenCalledWith('progress', 'background_task.start');
    expect(activity).toHaveBeenCalledWith('progress', 'background_task.complete');
  });

  it('settles the terminal turn even when getContextUsage never responds', async () => {
    vi.useFakeTimers();
    try {
      const query = fakeQuery([sdkResult('terminal-result')]);
      // Reproduce the production hang: the control request is issued (stdin is
      // held open for it) but the subprocess never answers it.
      query.getContextUsage.mockReturnValue(new Promise(() => {}));
      vi.mocked(setupQuery).mockResolvedValue({
        query: query as never,
        resolvedModel: 'claude-sonnet-4-6',
        getStderr: () => '',
      });

      const events: Array<{ type: string }> = [];
      const drained = (async () => {
        for await (const event of service().promptSessionStreaming(sessionId, 'prompt')) {
          events.push(event);
        }
      })();

      // Advance past the bounded getContextUsage budget; without the timeout the
      // generator would never break out of its for-await loop.
      await vi.advanceTimersByTimeAsync(ClaudePromptService.CONTEXT_USAGE_TIMEOUT_MS + 10);
      await drained;

      expect(events.filter((event) => event.type === 'result')).toHaveLength(1);
      // No context snapshot is yielded when the request times out.
      expect(events.filter((event) => event.type === 'context_usage')).toHaveLength(0);
      // Input is still released so the subprocess can close stdin and exit.
      expect(query.releaseInput).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles the turn when a background task never emits a terminal notification', async () => {
    // Production hang (#2288 follow-up): the model turn produced its `result`,
    // but a background task stayed `task_started` forever with no
    // task_notification/task_updated. The SDK watchdog is paused for the
    // background-task lifetime, so nothing bounds the wait — the Task would stay
    // `running` until a manual Stop, which then corrupts resume state and makes
    // the next prompt zero-turn. The bounded wait must settle the turn instead.
    vi.useFakeTimers();
    let finalized = false;
    try {
      const query = fakeQuery((transportClosed) =>
        (async function* () {
          try {
            yield {
              type: 'system',
              subtype: 'task_started',
              task_id: 'task-1',
              description: 'Never-settling background Bash',
              uuid: 'start',
              session_id: 'sdk-session',
            };
            yield sdkResult('parent-result');
            // The task never reports terminal and no continuation result arrives:
            // the read stays held exactly as the wedged subprocess did, until the
            // Query's cleanup() closes the transport.
            await transportClosed;
          } finally {
            finalized = true;
          }
        })()
      );
      vi.mocked(setupQuery).mockResolvedValue({
        query: query as never,
        resolvedModel: 'claude-sonnet-4-6',
        getStderr: () => '',
      });
      const activity = vi.fn();

      const events: Array<{
        type: string;
        raw_sdk_message?: { uuid?: string };
        sdkSubtype?: string;
      }> = [];
      const drained = (async () => {
        for await (const event of service().promptSessionStreaming(
          sessionId,
          'prompt',
          undefined,
          undefined,
          undefined,
          undefined,
          activity
        )) {
          events.push(event);
        }
      })();

      // A background task is still active, so the generous active-task budget
      // applies. Advance past it; without the timeout the held read would never
      // resolve. No separate close-budget advance is needed: the Query's
      // cleanup() closes the transport, which resolves the held read and lets
      // teardown converge — that is exactly what this test proves.
      await vi.advanceTimersByTimeAsync(ClaudePromptService.BACKGROUND_TASK_ACTIVE_TIMEOUT_MS + 10);
      await drained;

      // The parent turn's success result is the terminal response; the turn
      // settles as a normal completion (no `stopped`, no error). A single
      // captured result is its own aggregate, so it is not re-emitted.
      expect(
        events
          .filter((event) => event.type === 'result')
          .map((event) => event.raw_sdk_message?.uuid)
      ).toEqual(['parent-result']);
      expect(events.some((event) => event.type === 'stopped')).toBe(false);
      // Input is released, subprocess work is cancelled best-effort, and the
      // Query is finalized: `return()` runs `cleanup()` (closing the transport),
      // which resolves the held read so the generator's finalizer actually runs —
      // no stray query is left alive to race the next resume.
      expect(query.releaseInput).toHaveBeenCalledTimes(1);
      expect(query.interrupt).toHaveBeenCalledTimes(1);
      expect(query.return).toHaveBeenCalledTimes(1);
      expect(query.cleanup).toHaveBeenCalledTimes(1);
      expect(finalized).toBe(true);
      // Because a background task was still active (its work was stopped by the
      // teardown), a clear, queryable notice is surfaced into the conversation
      // for the user and the agent.
      const notice = events.find(
        (event) => event.type === 'sdk_event' && event.sdkSubtype === 'background_task_timeout'
      );
      expect(notice).toBeDefined();
      // The paused SDK watchdog is rebalanced for the abandoned background task.
      expect(activity).toHaveBeenCalledWith('progress', 'background_task.start');
      expect(activity).toHaveBeenCalledWith('progress', 'background_task.complete');
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles when a background task settles but no continuation result follows', async () => {
    // Second silent state: the background task DID report terminal (draining the
    // active set to zero), but the SDK never woke a continuation `result`. The
    // query is still held open awaiting that continuation, so the idle timeout
    // must settle it — with activeBackgroundTasks already at zero.
    vi.useFakeTimers();
    let finalized = false;
    try {
      const query = fakeQuery((transportClosed) =>
        (async function* () {
          try {
            yield {
              type: 'system',
              subtype: 'task_started',
              task_id: 'task-1',
              description: 'Short background Bash',
              uuid: 'start',
              session_id: 'sdk-session',
            };
            yield sdkResult('parent-result');
            yield {
              type: 'system',
              subtype: 'task_notification',
              task_id: 'task-1',
              status: 'completed',
              output_file: '/tmp/task-1',
              summary: 'done',
              uuid: 'notification',
              session_id: 'sdk-session',
            };
            // The task settled, but no continuation result ever arrives.
            await transportClosed;
          } finally {
            finalized = true;
          }
        })()
      );
      vi.mocked(setupQuery).mockResolvedValue({
        query: query as never,
        resolvedModel: 'claude-sonnet-4-6',
        getStderr: () => '',
      });
      const activity = vi.fn();

      const events: Array<{
        type: string;
        raw_sdk_message?: { uuid?: string };
        sdkSubtype?: string;
      }> = [];
      const drained = (async () => {
        for await (const event of service().promptSessionStreaming(
          sessionId,
          'prompt',
          undefined,
          undefined,
          undefined,
          undefined,
          activity
        )) {
          events.push(event);
        }
      })();

      // All tasks have settled, so only the short continuation grace applies —
      // not the generous active-task budget. Advancing just past the grace
      // settles the turn.
      await vi.advanceTimersByTimeAsync(ClaudePromptService.POST_RESULT_CONTINUATION_GRACE_MS + 10);
      await drained;

      expect(
        events
          .filter((event) => event.type === 'result')
          .map((event) => event.raw_sdk_message?.uuid)
      ).toEqual(['parent-result']);
      expect(events.some((event) => event.type === 'stopped')).toBe(false);
      // The work finished (all tasks settled) — this is a clean settle, so NO
      // background-task-timeout notice is surfaced.
      expect(
        events.some(
          (event) => event.type === 'sdk_event' && event.sdkSubtype === 'background_task_timeout'
        )
      ).toBe(false);
      expect(query.releaseInput).toHaveBeenCalledTimes(1);
      expect(query.interrupt).toHaveBeenCalledTimes(1);
      expect(query.return).toHaveBeenCalledTimes(1);
      expect(query.cleanup).toHaveBeenCalledTimes(1);
      expect(finalized).toBe(true);
      // The task's own settlement balances the watchdog; the timeout has no
      // remaining active tasks to rebalance.
      expect(activity).toHaveBeenCalledWith('progress', 'background_task.start');
      expect(activity).toHaveBeenCalledWith('progress', 'background_task.complete');
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases input and balances watchdog activity when cancellation interrupts a task', async () => {
    const query = fakeQuery(async function* () {
      yield {
        type: 'system',
        subtype: 'task_started',
        task_id: 'task-1',
        description: 'Explore',
        uuid: 'start',
        session_id: 'sdk-session',
      };
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    });
    vi.mocked(setupQuery).mockResolvedValue({
      query: query as never,
      resolvedModel: 'claude-sonnet-4-6',
      getStderr: () => '',
    });
    const activity = vi.fn();

    const events = [];
    for await (const event of service().promptSessionStreaming(
      sessionId,
      'prompt',
      undefined,
      undefined,
      undefined,
      undefined,
      activity
    )) {
      events.push(event);
    }

    expect(events).toContainEqual({ type: 'stopped' });
    expect(query.releaseInput).toHaveBeenCalledTimes(1);
    expect(activity).toHaveBeenCalledWith('progress', 'background_task.start');
    expect(activity).toHaveBeenCalledWith('progress', 'background_task.complete');
  });
});
