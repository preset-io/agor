import { generateId, SAFE_ZERO_TURN_PROVIDER_RESULT_MESSAGE } from '@agor/core';
import type { Message, MessageID, SessionID } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import type { MessagesService } from '../base/index.js';
import { createAssistantMessage } from './message-builder.js';
import { type ProcessedEvent, SDKMessageProcessor } from './message-processor.js';

function createProcessor() {
  return new SDKMessageProcessor({
    sessionId: 'test-session-id' as SessionID,
  });
}

function rateLimitMsg(info: Record<string, unknown>) {
  return { type: 'rate_limit_event', rate_limit_info: info } as never;
}

function systemMsg(payload: Record<string, unknown>) {
  return { type: 'system', ...payload } as never;
}

describe('SDKMessageProcessor result logging', () => {
  it('is silent and replaces synthesized provider text before emitting a message', async () => {
    const resultMessage = {
      type: 'result',
      subtype: 'success',
      duration_ms: 321,
      is_error: false,
      result: 'final response',
      total_cost_usd: 0.25,
      usage: {
        input_tokens: 123,
        output_tokens: 45,
      },
      modelUsage: {
        'claude-sonnet': {
          inputTokens: 100,
          outputTokens: 40,
          contextWindow: 200_000,
        },
      },
      permission_denials: [],
      uuid: 'result-uuid',
      session_id: 'sdk-session',
    };
    const processor = new SDKMessageProcessor({
      sessionId: 'test-session-id' as SessionID,
      existingSdkSessionId: 'sdk-session',
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      const events = await processor.process(resultMessage as never);
      expect(logSpy).not.toHaveBeenCalled();
      expect(events).toEqual([
        {
          type: 'complete',
          role: 'assistant',
          content: [{ type: 'text', text: SAFE_ZERO_TURN_PROVIDER_RESULT_MESSAGE }],
          toolUses: undefined,
          parent_tool_use_id: null,
          agentSessionId: undefined,
          resolvedModel: undefined,
          isSynthesizedResult: true,
        },
        {
          type: 'result',
          raw_sdk_message: resultMessage,
          agentSessionId: undefined,
        },
        { type: 'end', reason: 'result' },
      ]);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('withholds the #2288 zero-turn provider body from persistence metadata', async () => {
    const processor = createProcessor();
    const events = await processor.process({
      type: 'result',
      subtype: 'success',
      duration_ms: 0,
      duration_api_ms: 0,
      is_error: false,
      num_turns: 0,
      result: 'Credit balance is too low',
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
      modelUsage: {},
      permission_denials: [],
      uuid: 'result-uuid',
      session_id: 'sdk-session',
    } as never);
    const complete = events.find(
      (event): event is Extract<ProcessedEvent, { type: 'complete' }> => event.type === 'complete'
    );
    expect(complete?.isSynthesizedResult).toBe(true);

    const messagesService = {
      create: vi.fn(async (data: Partial<Message>) => data as Message),
    } as unknown as MessagesService;
    const message = await createAssistantMessage(
      'test-session-id' as SessionID,
      generateId() as MessageID,
      complete?.content ?? [],
      complete?.toolUses,
      undefined,
      0,
      complete?.resolvedModel,
      messagesService,
      undefined,
      complete?.parent_tool_use_id,
      undefined,
      complete?.isSynthesizedResult
    );

    expect(message.content).toEqual([
      { type: 'text', text: SAFE_ZERO_TURN_PROVIDER_RESULT_MESSAGE },
    ]);
    expect(JSON.stringify(message)).not.toContain('Credit balance is too low');
    expect(message.metadata?.is_zero_turn_result).toBe(true);
  });
});

describe('SDKMessageProcessor system event suppression', () => {
  it('keeps command discovery silent while preserving the init event', async () => {
    const processor = createProcessor();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      const events = await processor.process(
        systemMsg({
          subtype: 'init',
          model: 'claude-sonnet-4-6',
          slash_commands: ['/compact'],
          skills: ['example-skill'],
        })
      );

      expect(logSpy).not.toHaveBeenCalled();
      expect(events).toEqual([
        {
          type: 'slash_commands_discovered',
          slashCommands: ['/compact'],
          skills: ['example-skill'],
          agentSessionId: undefined,
        },
      ]);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('logs only the bounded compaction lifecycle event while preserving metadata', async () => {
    const processor = createProcessor();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      const events = await processor.process(
        systemMsg({
          subtype: 'compact_boundary',
          compact_metadata: { trigger: 'auto', pre_tokens: 123_456 },
        })
      );

      expect(logSpy.mock.calls).toEqual([['📦 SDK compact_boundary (compaction finished)']]);
      expect(events).toEqual([
        {
          type: 'system_complete',
          systemType: 'compaction',
          agentSessionId: undefined,
          metadata: { trigger: 'auto', pre_tokens: 123_456 },
        },
      ]);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('suppresses status=requesting (PR #1116)', async () => {
    const processor = createProcessor();
    const events = await processor.process(
      systemMsg({ subtype: 'status', status: 'requesting', session_id: 's', uuid: 'u' })
    );
    expect(events.filter((e) => e.type === 'sdk_event')).toHaveLength(0);
  });

  it('suppresses task_updated, including patches with an error field', async () => {
    const processor = createProcessor();
    const events = await processor.process(
      systemMsg({
        subtype: 'task_updated',
        task_id: 't1',
        patch: { status: 'failed', error: 'boom' },
        session_id: 's',
        uuid: 'u',
      })
    );
    expect(events.filter((e) => e.type === 'sdk_event')).toHaveLength(0);
  });

  it('suppresses hook lifecycle telemetry', async () => {
    const processor = createProcessor();

    for (const subtype of ['hook_started', 'hook_progress', 'hook_response']) {
      const events = await processor.process(
        systemMsg({
          subtype,
          hook_event_name: 'PreToolUse',
          session_id: 's',
          uuid: `u-${subtype}`,
        })
      );
      expect(events.filter((e) => e.type === 'sdk_event')).toHaveLength(0);
    }
  });

  it('suppresses thinking token telemetry', async () => {
    const processor = createProcessor();
    const events = await processor.process(
      systemMsg({
        subtype: 'thinking_tokens',
        thinking_tokens: 1234,
        session_id: 's',
        uuid: 'u',
      })
    );
    expect(events.filter((e) => e.type === 'sdk_event')).toHaveLength(0);
  });

  it('surfaces failed hook responses for diagnostics', async () => {
    const processor = createProcessor();
    const events = await processor.process(
      systemMsg({
        subtype: 'hook_response',
        hook_event: 'PreToolUse',
        outcome: 'error',
        stderr: 'hook failed',
        exit_code: 1,
        session_id: 's',
        uuid: 'u',
      })
    );

    const sdkEvents = events.filter((e) => e.type === 'sdk_event');
    expect(sdkEvents).toHaveLength(1);
    const event = sdkEvents[0] as Extract<ProcessedEvent, { type: 'sdk_event' }>;
    expect(event.sdkSubtype).toBe('hook_response');
  });

  it('surfaces user-meaningful system subtypes (e.g. mirror_error)', async () => {
    const processor = createProcessor();
    const events = await processor.process(
      systemMsg({
        subtype: 'mirror_error',
        error: 'disk full',
        key: { projectKey: 'p', sessionId: 's' },
        session_id: 's',
        uuid: 'u',
      })
    );
    const sdkEvents = events.filter((e) => e.type === 'sdk_event');
    expect(sdkEvents).toHaveLength(1);
    const event = sdkEvents[0] as Extract<ProcessedEvent, { type: 'sdk_event' }>;
    expect(event.sdkType).toBe('system');
    expect(event.sdkSubtype).toBe('mirror_error');
  });
});

describe('SDKMessageProcessor rate_limit_event handling', () => {
  it('suppresses allowed status with no overage concern', async () => {
    const processor = createProcessor();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      const events = await processor.process(
        rateLimitMsg({ status: 'allowed', rateLimitType: 'five_hour' })
      );
      expect(logSpy).not.toHaveBeenCalled();
      expect(events.filter((e) => e.type === 'rate_limit')).toHaveLength(0);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('suppresses allowed status even when overageStatus is rejected', async () => {
    const processor = createProcessor();
    const events = await processor.process(
      rateLimitMsg({
        status: 'allowed',
        overageStatus: 'rejected',
        rateLimitType: 'five_hour',
      })
    );
    expect(events.filter((e) => e.type === 'rate_limit')).toHaveLength(0);
  });

  it('suppresses allowed status even when overageStatus is allowed_warning', async () => {
    const processor = createProcessor();
    const events = await processor.process(
      rateLimitMsg({
        status: 'allowed',
        overageStatus: 'allowed_warning',
        rateLimitType: 'five_hour',
      })
    );
    expect(events.filter((e) => e.type === 'rate_limit')).toHaveLength(0);
  });

  it('surfaces rejected status', async () => {
    const processor = createProcessor();
    const events = await processor.process(
      rateLimitMsg({
        status: 'rejected',
        rateLimitType: 'five_hour',
        resetsAt: 1700000000,
      })
    );
    const rateLimitEvents = events.filter((e) => e.type === 'rate_limit');
    expect(rateLimitEvents).toHaveLength(1);
    const event = rateLimitEvents[0] as Extract<ProcessedEvent, { type: 'rate_limit' }>;
    expect(event.status).toBe('rejected');
    expect(event.rateLimitType).toBe('five_hour');
    expect(event.resetsAt).toBe(1700000000);
  });

  it('surfaces allowed_warning status', async () => {
    const processor = createProcessor();
    const events = await processor.process(
      rateLimitMsg({
        status: 'allowed_warning',
        rateLimitType: 'daily',
        resetsAt: 1700000000,
      })
    );
    const rateLimitEvents = events.filter((e) => e.type === 'rate_limit');
    expect(rateLimitEvents).toHaveLength(1);
    const event = rateLimitEvents[0] as Extract<ProcessedEvent, { type: 'rate_limit' }>;
    expect(event.status).toBe('allowed_warning');
  });

  it('suppresses unknown/future status values', async () => {
    const processor = createProcessor();
    const events = await processor.process(
      rateLimitMsg({ status: 'some_future_status', rateLimitType: 'five_hour' })
    );
    expect(events.filter((e) => e.type === 'rate_limit')).toHaveLength(0);
  });
});

describe('SDKMessageProcessor tool lifecycle', () => {
  it('keeps a tool active until its result arrives', async () => {
    const processor = createProcessor();
    const started = await processor.process({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'tool-1', name: 'Read' },
      },
    } as never);
    const streamed = await processor.process({
      type: 'stream_event',
      event: { type: 'content_block_stop', index: 0 },
    } as never);
    const completed = await processor.process({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'done' }],
      },
    } as never);

    expect(started).toEqual([expect.objectContaining({ type: 'tool_start', toolUseId: 'tool-1' })]);
    expect(streamed).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'tool_complete' })])
    );
    expect(completed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'tool_complete', toolUseId: 'tool-1' }),
      ])
    );
  });

  it('completes parallel tools, including errors, and ignores replayed results', async () => {
    const processor = createProcessor();
    const completed = await processor.process({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'tool-1', content: 'done' },
          { type: 'tool_result', tool_use_id: 'tool-2', content: 'failed', is_error: true },
        ],
      },
    } as never);
    const replayed = await processor.process({
      type: 'user',
      isReplay: true,
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'done' }],
      },
    } as never);

    expect(completed.filter((event) => event.type === 'tool_complete')).toEqual([
      expect.objectContaining({ toolUseId: 'tool-1' }),
      expect.objectContaining({ toolUseId: 'tool-2' }),
    ]);
    expect(replayed).toEqual([]);
  });
});
