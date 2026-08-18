import { resolveClaudeBackgroundTaskConfig } from '@agor/core/config';
import type { SDKMessage } from '@agor/core/sdk';
import type { SessionID } from '@agor/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./query-builder.js', () => ({
  setupQuery: vi.fn(),
}));

import {
  announcedQuietUntil,
  ClaudePromptService,
  MAX_ANNOUNCED_QUIET_MS,
} from './prompt-service.js';
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

function fakeQuery(messages: SDKMessage[] | (() => AsyncGenerator<SDKMessage>)) {
  const releaseInput = vi.fn();
  const getContextUsage = vi.fn().mockResolvedValue({
    totalTokens: 15,
    maxTokens: 200_000,
    percentage: 0.0075,
  });
  const generator =
    typeof messages === 'function'
      ? messages()
      : (async function* () {
          yield* messages;
        })();
  const closed = vi.fn(generator.return.bind(generator));
  return Object.assign(generator, {
    releaseInput,
    getContextUsage,
    interrupt: vi.fn().mockResolvedValue(undefined),
    return: closed,
    closed,
  });
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

/** Defaults the service falls back to when no daemon-resolved slice is passed. */
const { silence_timeout_ms: SILENCE_MS, settled_grace_ms: GRACE_MS } =
  resolveClaudeBackgroundTaskConfig();

const taskStarted = (taskId: string, toolUseId?: string): SDKMessage =>
  ({
    type: 'system',
    subtype: 'task_started',
    task_id: taskId,
    tool_use_id: toolUseId,
    description: 'Explore',
    uuid: `start-${taskId}`,
    session_id: 'sdk-session',
  }) as SDKMessage;

const taskNotification = (taskId: string): SDKMessage =>
  ({
    type: 'system',
    subtype: 'task_notification',
    task_id: taskId,
    status: 'completed',
    output_file: `/tmp/${taskId}`,
    summary: 'done',
    uuid: `notification-${taskId}`,
    session_id: 'sdk-session',
  }) as SDKMessage;

const assistantMessage = (
  uuid: string,
  parentToolUseId: string | null = null,
  launchedToolUseIds: string[] = []
): SDKMessage =>
  ({
    type: 'assistant',
    parent_tool_use_id: parentToolUseId,
    message: {
      role: 'assistant',
      content: launchedToolUseIds.length
        ? launchedToolUseIds.map((id) => ({ type: 'tool_use', id, name: 'Task', input: {} }))
        : [{ type: 'text', text: 'hi' }],
    },
    uuid,
    session_id: 'sdk-session',
  }) as SDKMessage;

const rateLimitEvent = (
  status: string,
  resetsAt?: number,
  rateLimitType = 'five_hour'
): SDKMessage =>
  ({
    type: 'rate_limit_event',
    rate_limit_info: { status, rateLimitType, resetsAt },
    uuid: `rate-limit-${status}`,
    session_id: 'sdk-session',
  }) as SDKMessage;

const userMessage = (uuid: string): SDKMessage =>
  ({
    type: 'user',
    parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] },
    uuid,
    session_id: 'sdk-session',
  }) as SDKMessage;

const statusMessage = (status: string): SDKMessage =>
  ({
    type: 'system',
    subtype: 'status',
    status,
    uuid: `status-${status}`,
    session_id: 'sdk-session',
  }) as SDKMessage;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const never = () => new Promise(() => {});

async function withFakeTimers(body: () => Promise<void>) {
  vi.useFakeTimers();
  try {
    await body();
  } finally {
    vi.useRealTimers();
  }
}

/** Start draining a query and expose whether the generator has finished yet. */
function drain(query: ReturnType<typeof fakeQuery>, activity?: ReturnType<typeof vi.fn>) {
  vi.mocked(setupQuery).mockResolvedValue({
    query: query as never,
    resolvedModel: 'claude-sonnet-4-6',
    getStderr: () => '',
  });
  const events: Array<{ type: string; raw_sdk_message?: { uuid: string } }> = [];
  let finished = false;
  const done = (async () => {
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
    finished = true;
  })();
  return {
    events,
    done,
    settled: () => finished,
    // A force-settle also emits a `result`, so counting them cannot tell the
    // two outcomes apart — the terminal UUID can.
    resultUuids: () =>
      events.filter((event) => event.type === 'result').map((event) => event.raw_sdk_message?.uuid),
  };
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

  it('force-settles a turn whose background task never reports a terminal signal', async () => {
    await withFakeTimers(async () => {
      // The production hang: `end_turn` arrives, one task ID never settles, and
      // the query then goes silent forever instead of waking another turn.
      const query = fakeQuery(async function* () {
        yield taskStarted('task-1');
        yield sdkResult('parent-result');
        await never();
      });
      const activity = vi.fn();
      const run = drain(query, activity);

      await vi.advanceTimersByTimeAsync(SILENCE_MS - 1_000);
      expect(run.settled()).toBe(false);
      await vi.advanceTimersByTimeAsync(1_010);
      expect(run.settled()).toBe(true);
      await run.done;

      // The turn settles on the aggregated result instead of staying `running`.
      expect(run.events.at(-1)?.type).toBe('result');
      expect(query.releaseInput).toHaveBeenCalledTimes(1);
      // Watchdog accounting is balanced again, so the next query is not born
      // with a permanently suppressed stall check.
      expect(activity).toHaveBeenCalledWith('progress', 'background_task.complete');
    });
  });

  it('keeps waiting while background tasks are still reporting progress', async () => {
    await withFakeTimers(async () => {
      const query = fakeQuery(async function* () {
        yield taskStarted('task-1');
        yield sdkResult('parent-result');
        // Progress well past the silence budget: it is a silence budget, so a
        // task that is still working is never cut short.
        for (let tick = 0; tick < 3; tick++) {
          await sleep(SILENCE_MS - 1_000);
          yield {
            type: 'system',
            subtype: 'task_progress',
            task_id: 'task-1',
            uuid: `progress-${tick}`,
            session_id: 'sdk-session',
          };
        }
        yield taskNotification('task-1');
        yield sdkResult('continuation-result');
      });
      const run = drain(query);

      await vi.advanceTimersByTimeAsync(3 * SILENCE_MS);
      await run.done;

      expect(run.resultUuids()).toEqual(['parent-result', 'continuation-result']);
      expect(query.releaseInput).toHaveBeenCalledTimes(1);
    });
  });

  it('ends the turn on the settled grace when the last task settles and no turn follows', async () => {
    await withFakeTimers(async () => {
      // `resultDisposition` is only recomputed on a `result`, so a last task
      // that settles without waking a continuation turn leaves the query alive
      // with zero outstanding work and nothing left to re-check it.
      const query = fakeQuery(async function* () {
        yield taskStarted('task-1');
        yield sdkResult('parent-result');
        yield taskNotification('task-1');
        await never();
      });
      const run = drain(query);

      await vi.advanceTimersByTimeAsync(GRACE_MS - 1_000);
      expect(run.settled()).toBe(false);
      await vi.advanceTimersByTimeAsync(1_010);
      // Settled on the short grace, not after the far longer silence budget.
      expect(run.settled()).toBe(true);
      await run.done;

      expect(GRACE_MS).toBeLessThan(SILENCE_MS);
      expect(run.events.at(-1)?.type).toBe('result');
      expect(query.releaseInput).toHaveBeenCalledTimes(1);
    });
  });

  it('never bounds reads again once the model resumes, however long it then thinks', async () => {
    await withFakeTimers(async () => {
      // A task settles, the SDK wakes a continuation turn, and that turn makes
      // one long silent call (a slow MCP tool, extended thinking). The turn is
      // live work, not a wedge, and must not be force-settled.
      const query = fakeQuery(async function* () {
        yield taskStarted('task-1');
        yield sdkResult('parent-result');
        yield taskNotification('task-1');
        yield assistantMessage('resumed');
        await sleep(4 * SILENCE_MS);
        yield sdkResult('continuation-result');
      });
      const run = drain(query);

      await vi.advanceTimersByTimeAsync(5 * SILENCE_MS);
      await run.done;

      // The continuation result, not a force-settled replay of the parent.
      expect(run.resultUuids()).toEqual(['parent-result', 'continuation-result']);
      expect(query.releaseInput).toHaveBeenCalledTimes(1);
    });
  });

  it('keeps background-task traffic bounded even after a subagent speaks', async () => {
    await withFakeTimers(async () => {
      // Forwarded subagent output proves background work is progressing, not
      // that the top-level turn resumed, so it must not lift the budget.
      const query = fakeQuery(async function* () {
        yield taskStarted('task-1');
        yield sdkResult('parent-result');
        yield assistantMessage('subagent-chatter', 'tool-1');
        await never();
      });
      const run = drain(query);

      await vi.advanceTimersByTimeAsync(SILENCE_MS + 1_000);
      expect(run.settled()).toBe(true);
      await run.done;
    });
  });

  it('does not force-settle a turn the SDK told us is waiting on a rate-limit reset', async () => {
    await withFakeTimers(async () => {
      // A rejected rate limit is announced once and then waited out in total
      // silence — `resetsAt` here is five hours out, far past the budget.
      const resetsAt = Math.floor(Date.now() / 1_000) + 5 * 60 * 60;
      const query = fakeQuery(async function* () {
        yield taskStarted('task-1');
        yield sdkResult('parent-result');
        yield {
          type: 'rate_limit_event',
          rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt },
          uuid: 'rate-limit',
          session_id: 'sdk-session',
        };
        await sleep(5 * 60 * 60 * 1_000);
        yield taskNotification('task-1');
        yield sdkResult('continuation-result');
      });
      const activity = vi.fn();
      const run = drain(query, activity);

      await vi.advanceTimersByTimeAsync(SILENCE_MS + 1_000);
      expect(run.settled()).toBe(false);
      await vi.advanceTimersByTimeAsync(5 * 60 * 60 * 1_000);
      await run.done;

      expect(run.resultUuids()).toEqual(['parent-result', 'continuation-result']);
    });
  });

  it('leaves the rate-limit block standing as the latest pulse for the whole wait', async () => {
    await withFakeTimers(async () => {
      const resetsAt = Math.floor(Date.now() / 1_000) + 5 * 60 * 60;
      // The block lands mid-turn, before any result: no held turn, nothing
      // bounded — the pulse is the whole point here.
      const query = fakeQuery(async function* () {
        yield rateLimitEvent('rejected', resetsAt);
        // The SDK emits nothing at all across the block, which is exactly why
        // the pulse has to be sticky rather than event-driven.
        await sleep(5 * 60 * 60 * 1_000);
        yield assistantMessage('back-after-reset');
        yield sdkResult('done');
      });
      const activity = vi.fn();
      const run = drain(query, activity);

      await vi.advanceTimersByTimeAsync(60_000);
      const waits = activity.mock.calls.filter(([kind]) => kind === 'waiting');
      expect(waits.length).toBeGreaterThan(0);
      expect(new Set(waits.map(([, detail]) => detail))).toEqual(new Set(['rate_limit.five_hour']));
      // The heartbeat re-sends whichever pulse came last, so what matters is
      // that the block is it — for hours, through a stream saying nothing.
      expect(activity.mock.calls.at(-1)).toEqual(['waiting', 'rate_limit.five_hour']);

      await vi.advanceTimersByTimeAsync(5 * 60 * 60 * 1_000);
      await run.done;

      // The pause the block installed is lifted, or the watchdog would stay
      // disarmed for the rest of the query.
      expect(activity).toHaveBeenCalledWith('sdk_started', 'rate_limit.resolved');
    });
  });

  it('sanitizes an unexpected rate-limit type into a bounded pulse detail', async () => {
    await withFakeTimers(async () => {
      // The daemon rejects a detail outside [A-Za-z0-9._:/-] with a BadRequest,
      // and the heartbeat re-sends the latest pulse on every beat — so one bad
      // detail would fail every later heartbeat write, not just its own.
      const query = fakeQuery(async function* () {
        yield rateLimitEvent('rejected', undefined, 'weird type!! 🚫');
        yield sdkResult('done');
      });
      const activity = vi.fn();
      const run = drain(query, activity);

      await vi.advanceTimersByTimeAsync(1_000);
      await run.done;
      const [[, detail]] = activity.mock.calls.filter(([kind]) => kind === 'waiting');
      expect(detail).toMatch(/^[A-Za-z0-9._:/-]+$/);
      expect(Buffer.byteLength(detail as string, 'utf8')).toBeLessThanOrEqual(128);
    });
  });

  it('stays bounded when only the harness speaks on the held turn', async () => {
    await withFakeTimers(async () => {
      // A top-level `user` frame is a tool_result or an injected reminder, not
      // the model resuming. Treating it as a resume would unbound the query for
      // good, since the regime only re-arms on the next held result.
      const query = fakeQuery(async function* () {
        yield taskStarted('task-1');
        yield sdkResult('parent-result');
        yield userMessage('harness-chatter');
        await never();
      });
      const run = drain(query);

      await vi.advanceTimersByTimeAsync(SILENCE_MS + 1_000);
      expect(run.settled()).toBe(true);
      await run.done;
    });
  });

  it('does not discard a continuation turn that is compacting', async () => {
    await withFakeTimers(async () => {
      // Auto-compaction emits `system/status` and then nothing until the
      // summarization lands — easily past the settled grace, and the turn it
      // is compacting for is live work.
      const query = fakeQuery(async function* () {
        yield taskStarted('task-1');
        yield sdkResult('parent-result');
        yield taskNotification('task-1');
        yield statusMessage('compacting');
        await sleep(4 * GRACE_MS);
        yield assistantMessage('post-compaction');
        yield sdkResult('continuation-result');
      });
      const run = drain(query);

      await vi.advanceTimersByTimeAsync(5 * GRACE_MS);
      await run.done;

      expect(run.resultUuids()).toEqual(['parent-result', 'continuation-result']);
    });
  });

  it('keeps the rate-limit pulse latest while background tasks keep talking', async () => {
    await withFakeTimers(async () => {
      // Every SDK frame overwrites the sticky pulse, so a block that coincides
      // with a working background task would otherwise read as "Active".
      const resetsAt = Math.floor(Date.now() / 1_000) + 5 * 60 * 60;
      const query = fakeQuery(async function* () {
        yield taskStarted('task-1');
        yield rateLimitEvent('rejected', resetsAt);
        yield {
          type: 'system',
          subtype: 'task_progress',
          task_id: 'task-1',
          uuid: 'progress',
          session_id: 'sdk-session',
        };
        yield taskNotification('task-1');
        await never();
      });
      const activity = vi.fn();
      drain(query, activity);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(activity.mock.calls.at(-1)).toEqual(['waiting', 'rate_limit.five_hour']);
    });
  });

  it('clears the announced allowance once the block lifts', async () => {
    await withFakeTimers(async () => {
      // A seven-day reset grants a six-day allowance. If it survived the clear,
      // every later read in this query would be bounded by "tier + six days".
      const resetsAt = Math.floor(Date.now() / 1_000) + 6 * 24 * 60 * 60;
      const query = fakeQuery(async function* () {
        yield taskStarted('task-1');
        yield sdkResult('parent-result');
        yield rateLimitEvent('rejected', resetsAt, 'seven_day');
        yield rateLimitEvent('allowed');
        await never();
      });
      const run = drain(query);

      await vi.advanceTimersByTimeAsync(SILENCE_MS + 1_000);
      expect(run.settled()).toBe(true);
      await run.done;
    });
  });

  it('clamps an implausible announced wait instead of inverting the budget', () => {
    // setTimeout clamps any delay past 2^31-1ms to *1ms*, so an unclamped
    // epoch-milliseconds `resetsAt` would force-settle instantly — the exact
    // opposite of what the extension exists for. Asserted on the function
    // rather than through a fake-timer run, because fake timers do not
    // reproduce that overflow clamp.
    const now = 1_700_000_000_000;
    const epochMsMistake = rateLimitEvent('rejected', now); // seconds field holding ms
    expect(announcedQuietUntil(epochMsMistake, now)).toBe(now + MAX_ANNOUNCED_QUIET_MS);
    // The clamp is itself under the overflow threshold, so no budget built from
    // it can ever reach the inverting path.
    expect(MAX_ANNOUNCED_QUIET_MS).toBeLessThan(2 ** 31 - 1);
    // A real seven-day reset is far under the clamp and passes through intact.
    const sevenDay = rateLimitEvent('rejected', Math.floor(now / 1_000) + 7 * 24 * 60 * 60);
    expect(announcedQuietUntil(sevenDay, now)).toBe(now + 7 * 24 * 60 * 60 * 1_000);
    // An already-elapsed reset grants nothing.
    expect(announcedQuietUntil(rateLimitEvent('rejected', 1), now)).toBeUndefined();
  });

  it('emits one completion per task when a launch site retires several at once', async () => {
    await withFakeTimers(async () => {
      const query = fakeQuery(async function* () {
        yield taskStarted('nested-1', 'tool-2');
        yield taskStarted('nested-2', 'tool-3');
        yield sdkResult('parent-result');
        yield assistantMessage('subagent-launch', 'tool-1', ['tool-2', 'tool-3']);
        await never();
      });
      const activity = vi.fn();
      const run = drain(query, activity);

      await vi.advanceTimersByTimeAsync(GRACE_MS + 1_000);
      await run.done;

      // Two starts, two completions: anything less leaves the watchdog counter
      // above zero for the rest of the query.
      const starts = activity.mock.calls.filter(([, detail]) => detail === 'background_task.start');
      const completes = activity.mock.calls.filter(
        ([, detail]) => detail === 'background_task.complete'
      );
      expect(starts).toHaveLength(2);
      expect(completes).toHaveLength(2);
    });
  });

  it('closes the query on every exit and cancels a wedged one', async () => {
    await withFakeTimers(async () => {
      const wedged = fakeQuery(async function* () {
        yield taskStarted('task-1');
        yield sdkResult('parent-result');
        await never();
      });
      const wedgedRun = drain(wedged);
      await vi.advanceTimersByTimeAsync(SILENCE_MS + 1_000);
      await wedgedRun.done;
      // A pending read means `return()` can never run the SDK's own teardown,
      // so the wedged path has to cancel rather than only abandon.
      expect(wedged.interrupt).toHaveBeenCalledTimes(1);
      expect(wedged.closed).toHaveBeenCalledTimes(1);

      const healthy = fakeQuery([sdkResult('only-result')]);
      const healthyRun = drain(healthy);
      await healthyRun.done;
      expect(healthy.closed).toHaveBeenCalledTimes(1);
      expect(healthy.interrupt).not.toHaveBeenCalled();
    });
  });

  it('releases input when the SDK generator ends with tasks outstanding', async () => {
    await withFakeTimers(async () => {
      const query = fakeQuery(async function* () {
        yield taskStarted('task-1');
      });
      const activity = vi.fn();
      const run = drain(query, activity);
      await run.done;

      expect(query.releaseInput).toHaveBeenCalledTimes(1);
      expect(activity).toHaveBeenCalledWith('progress', 'background_task.complete');
    });
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
