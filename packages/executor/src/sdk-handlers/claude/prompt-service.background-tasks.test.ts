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

function fakeQuery(messages: SDKMessage[] | (() => AsyncGenerator<SDKMessage>)) {
  const releaseInput = vi.fn();
  const getContextUsage = vi.fn().mockResolvedValue({
    totalTokens: 15,
    maxTokens: 200_000,
    percentage: 0.0075,
    memoryFiles: [{ path: 'SENTINEL_CONTEXT_MEMORY', type: 'project', tokens: 2 }],
    providerExtension: 'SENTINEL_CONTEXT_EXTENSION',
  });
  const generator =
    typeof messages === 'function'
      ? messages()
      : (async function* () {
          yield* messages;
        })();
  return Object.assign(generator, {
    releaseInput,
    getContextUsage,
    interrupt: vi.fn(),
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

describe('ClaudePromptService background task query lifetime', () => {
  beforeEach(() => vi.clearAllMocks());

  it('logs only projected result and stderr metadata for a hostile error result', async () => {
    const sentinel = 'SENTINEL_HOSTILE_RESULT_AND_STDERR_8f31';
    const query = fakeQuery([
      {
        ...sdkResult('hostile-result'),
        subtype: sentinel,
        is_error: true,
        result: sentinel,
      } as unknown as SDKMessage,
    ]);
    vi.mocked(setupQuery).mockResolvedValue({
      query: query as never,
      resolvedModel: 'claude-sonnet-4-6',
      getStderrMetadata: () => ({ hasStderr: true, byteLength: 37 }),
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      for await (const _event of service().promptSessionStreaming(sessionId, 'prompt')) {
        // Drain the real prompt-service result boundary.
      }

      const logged = JSON.stringify(error.mock.calls);
      expect(logged).toContain('subtype=unknown');
      expect(logged).toContain('stderr_bytes=37');
      expect(logged).not.toContain(sentinel);
    } finally {
      error.mockRestore();
    }
  });

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
      getStderrMetadata: () => ({ hasStderr: false, byteLength: 0 }),
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
      getStderrMetadata: () => ({ hasStderr: false, byteLength: 0 }),
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
        getStderrMetadata: () => ({ hasStderr: false, byteLength: 0 }),
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
      getStderrMetadata: () => ({ hasStderr: false, byteLength: 0 }),
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
