import { generateId, SAFE_ZERO_TURN_PROVIDER_RESULT_MESSAGE } from '@agor/core';
import type { Message, SessionID, TaskID } from '@agor/core/types';
import { MessageRole } from '@agor/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessagesService } from '../base/index.js';
import { type ProcessedEvent, SDKMessageProcessor } from './message-processor.js';

const promptState = vi.hoisted(() => ({ events: [] as unknown[] }));

vi.mock('./prompt-service.js', () => ({
  ClaudePromptService: class {
    async *promptSessionStreaming(): AsyncGenerator<ProcessedEvent> {
      for (const event of promptState.events) {
        yield event as ProcessedEvent;
      }
    }
  },
}));

import { ClaudeTool } from './claude-tool.js';

const RAW_PROVIDER_BODY = 'provider-secret-body';

type Harness = {
  tool: ClaudeTool;
  outgoing: Partial<Message>[];
  persisted: Message[];
};

function createHarness(classifiedKind?: 'missing_credential'): Harness {
  const sessionId = generateId() as SessionID;
  const outgoing: Partial<Message>[] = [];
  const persisted: Message[] = [];
  const messagesService = {
    create: vi.fn(async (data: Partial<Message>) => {
      outgoing.push(data);
      const daemonMessage = {
        ...data,
        ...(classifiedKind && data.metadata?.is_zero_turn_result
          ? {
              type: 'system' as const,
              role: MessageRole.SYSTEM,
              content: 'This session needs to be connected before it can run.',
              content_preview: 'This session needs to be connected before it can run.',
              metadata: { ...data.metadata, error_kind: classifiedKind },
            }
          : {}),
        ...(classifiedKind && data.metadata?.is_provider_failure_result
          ? {
              content: 'This session needs to be connected before it can run.',
              content_preview: 'This session needs to be connected before it can run.',
              metadata: { ...data.metadata, error_kind: classifiedKind },
            }
          : {}),
      } as Message;
      persisted.push(daemonMessage);
      return daemonMessage;
    }),
  } as unknown as MessagesService;

  const messagesRepo = {
    findBySessionId: vi.fn().mockResolvedValue([]),
    findInitialUserMessagesByTaskId: vi.fn().mockResolvedValue([]),
    getNextIndexBySessionId: vi.fn().mockResolvedValue(0),
  };
  const sessionsRepo = {
    findById: vi.fn().mockResolvedValue({ session_id: sessionId }),
    update: vi.fn().mockResolvedValue({ session_id: sessionId }),
  };
  const tasksService = {
    patch: vi.fn().mockResolvedValue(undefined),
    emit: vi.fn(),
  };

  return {
    tool: new ClaudeTool(
      messagesRepo as never,
      sessionsRepo as never,
      '',
      messagesService,
      undefined,
      undefined,
      undefined,
      tasksService as never
    ),
    outgoing,
    persisted,
  };
}

function rawResult(subtype: 'success' | 'error_during_execution') {
  return {
    type: 'result' as const,
    subtype,
    duration_ms: 42,
    duration_api_ms: 31,
    is_error: subtype !== 'success',
    num_turns: 1,
    stop_reason: null,
    total_cost_usd: 0.12,
    usage: {
      input_tokens: 10,
      output_tokens: 4,
      cache_creation_input_tokens: 2,
      cache_read_input_tokens: 3,
    },
    modelUsage: {
      'claude-sonnet-4-6': {
        inputTokens: 10,
        outputTokens: 4,
        cacheCreationInputTokens: 2,
        cacheReadInputTokens: 3,
        contextWindow: 200_000,
      },
    },
    permission_denials: [],
    uuid: generateId(),
    session_id: generateId(),
    ...(subtype === 'success'
      ? { result: RAW_PROVIDER_BODY }
      : { errors: [RAW_PROVIDER_BODY, 'Credit balance is too low'] }),
  };
}

function resultEvent(raw: ReturnType<typeof rawResult>): ProcessedEvent {
  return { type: 'result', raw_sdk_message: raw } as ProcessedEvent;
}

function synthesizedAssistantEvent(): ProcessedEvent {
  return {
    type: 'complete',
    role: MessageRole.ASSISTANT,
    content: [{ type: 'text', text: RAW_PROVIDER_BODY }],
    isSynthesizedResult: true,
  };
}

async function execute(tool: ClaudeTool, mode: 'streaming' | 'non-streaming', taskId: TaskID) {
  const sessionId = generateId() as SessionID;
  if (mode === 'streaming') {
    return tool.executePromptWithStreaming(sessionId, 'prompt', taskId);
  }
  return tool.executePrompt(sessionId, 'prompt', taskId);
}

describe('ClaudeTool provider-failure settlement', () => {
  beforeEach(() => {
    promptState.events = [];
  });

  describe.each(['streaming', 'non-streaming'] as const)('%s terminal evidence', (mode) => {
    const assistant: ProcessedEvent = {
      type: 'complete',
      role: MessageRole.ASSISTANT,
      content: [{ type: 'text', text: 'Partial model response' }],
    };

    it.each([
      ['empty success', () => [synthesizedAssistantEvent(), resultEvent(rawResult('success'))]],
      [
        'success with error flag',
        () => [assistant, resultEvent({ ...rawResult('success'), is_error: true })],
      ],
      ['EOF before any result', () => []],
      ['EOF after assistant output', () => [assistant]],
      [
        'error after assistant output',
        () => [assistant, resultEvent(rawResult('error_during_execution'))],
      ],
    ] as const)('fails %s without losing persisted model output', async (_name, events) => {
      const harness = createHarness();
      promptState.events = events();
      const result = await execute(harness.tool, mode, generateId() as TaskID);
      expect(result.hadError).toBe(true);
      expect(result.errorDetails?.length).toBeGreaterThan(0);
      if (promptState.events.includes(assistant)) {
        expect(
          harness.persisted.some((message) =>
            JSON.stringify(message.content).includes('Partial model response')
          )
        ).toBe(true);
      }
    });

    it('propagates recorded SDK success/is_error through the real processor without exposing its body', async () => {
      const harness = createHarness();
      const processor = new SDKMessageProcessor({ sessionId: generateId() as SessionID });
      // Synthetic shape from the pinned SDK contract, not a production trace.
      const raw = { ...rawResult('success'), is_error: true, num_turns: 0 };
      promptState.events = await processor.process(raw as never);
      const result = await execute(harness.tool, mode, generateId() as TaskID);
      expect(result.hadError).toBe(true);
      expect(result.rawSdkResponse).toMatchObject({
        subtype: 'success',
        is_error: true,
        num_turns: 0,
      });
      expect(
        harness.persisted.filter((message) => message.metadata?.is_provider_failure_result)
      ).toHaveLength(1);
      expect(JSON.stringify({ outgoing: harness.outgoing, result })).not.toContain(
        RAW_PROVIDER_BODY
      );
    });

    it('accepts a tool-only assistant turn with an explicit successful result', async () => {
      const harness = createHarness();
      promptState.events = [
        { ...assistant, content: [{ type: 'tool_use', id: 'tool-1', name: 'example', input: {} }] },
        resultEvent(rawResult('success')),
      ];
      const result = await execute(harness.tool, mode, generateId() as TaskID);
      expect(result.hadError).toBe(false);
      expect(result.assistantMessageIds).toHaveLength(1);
    });

    it('does not reinterpret an interrupted turn as missing-result failure', async () => {
      const harness = createHarness();
      promptState.events = [assistant, { type: 'stopped' }];
      const result = await execute(harness.tool, mode, generateId() as TaskID);
      expect(result.wasStopped).toBe(true);
      expect(result.hadError).toBe(false);
    });
  });

  it.each(['streaming', 'non-streaming'] as const)(
    'uses the daemon-confirmed assistant message for classified zero-turn %s turns',
    async (mode) => {
      const harness = createHarness('missing_credential');
      const raw = rawResult('success');
      const contextUsage = {
        totalTokens: 123,
        maxTokens: 200_000,
        percentage: 0.0615,
        memoryFiles: [{ path: 'SENTINEL_CLAUDE_MEMORY_PATH' }],
        providerExtension: 'SENTINEL_CLAUDE_CONTEXT_EXTENSION',
      } as unknown as import('@agor/core/sdk').SDKControlGetContextUsageResponse;
      promptState.events = [
        synthesizedAssistantEvent(),
        { type: 'context_usage', contextUsage },
        resultEvent(raw),
      ];

      const result = await execute(harness.tool, mode, generateId() as TaskID);

      expect(harness.persisted.at(-1)).toMatchObject({
        type: 'system',
        role: MessageRole.SYSTEM,
        content: 'This session needs to be connected before it can run.',
        metadata: { error_kind: 'missing_credential' },
      });
      expect(result.rawSdkResponse).not.toHaveProperty('result');
      expect(result.rawSdkResponse).toMatchObject({
        subtype: 'success',
        usage: raw.usage,
        duration_ms: raw.duration_ms,
        total_cost_usd: raw.total_cost_usd,
      });
      expect(result.rawSdkResponse).not.toHaveProperty('modelUsage');
      expect(result.hadError).toBe(true);
      expect(result.errorDetails).toEqual([SAFE_ZERO_TURN_PROVIDER_RESULT_MESSAGE]);
      expect(result.rawContextUsage).toEqual({
        totalTokens: 123,
        maxTokens: 200_000,
        percentage: 0.0615,
      });
      expect(JSON.stringify(result)).not.toContain('SENTINEL_CLAUDE');
      expect(
        JSON.stringify({ outgoing: harness.outgoing, persisted: harness.persisted, result })
      ).not.toContain(RAW_PROVIDER_BODY);
    }
  );

  it.each(['streaming', 'non-streaming'] as const)(
    'keeps daemon-classified non-success %s results safe while preserving accounting',
    async (mode) => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const harness = createHarness('missing_credential');
        const raw = rawResult('error_during_execution');
        promptState.events = [resultEvent(raw)];

        const result = await execute(harness.tool, mode, generateId() as TaskID);

        const persistedFailure = harness.persisted.at(-1);
        expect(persistedFailure).toMatchObject({
          content: 'This session needs to be connected before it can run.',
          metadata: { error_kind: 'missing_credential' },
        });
        expect(harness.outgoing.at(-1)?.content).toEqual([
          {
            type: 'text',
            text: SAFE_ZERO_TURN_PROVIDER_RESULT_MESSAGE,
          },
        ]);
        expect(result.rawSdkResponse).not.toHaveProperty('errors');
        expect(result.rawSdkResponse).toMatchObject({
          subtype: 'error_during_execution',
          usage: raw.usage,
          duration_ms: raw.duration_ms,
          num_turns: raw.num_turns,
          total_cost_usd: raw.total_cost_usd,
        });
        expect(result.rawSdkResponse).not.toHaveProperty('modelUsage');
        expect(result.errorDetails).toEqual([SAFE_ZERO_TURN_PROVIDER_RESULT_MESSAGE]);
        expect(
          JSON.stringify({ outgoing: harness.outgoing, persisted: harness.persisted, result })
        ).not.toContain(RAW_PROVIDER_BODY);
        expect(errorSpy.mock.calls.flat().join(' ')).not.toContain(RAW_PROVIDER_BODY);
        expect(errorSpy.mock.calls.flat().join(' ')).toContain('missing_credential');
      } finally {
        errorSpy.mockRestore();
      }
    }
  );

  it.each(['streaming', 'non-streaming'] as const)(
    'withholds raw diagnostics when the daemon does not classify an executor marker in %s turns',
    async (mode) => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const harness = createHarness();
        const raw = rawResult('error_during_execution');
        promptState.events = [resultEvent(raw)];

        const result = await execute(harness.tool, mode, generateId() as TaskID);

        expect(result.rawSdkResponse).not.toHaveProperty('errors');
        expect(result.rawSdkResponse).toMatchObject({
          subtype: 'error_during_execution',
          usage: raw.usage,
          duration_ms: raw.duration_ms,
          num_turns: raw.num_turns,
          total_cost_usd: raw.total_cost_usd,
        });
        expect(result.rawSdkResponse).not.toHaveProperty('modelUsage');
        expect(result.errorDetails).toEqual([SAFE_ZERO_TURN_PROVIDER_RESULT_MESSAGE]);
        expect(
          JSON.stringify({ outgoing: harness.outgoing, persisted: harness.persisted, result })
        ).not.toContain(RAW_PROVIDER_BODY);
        expect(errorSpy.mock.calls.flat().join(' ')).not.toContain(RAW_PROVIDER_BODY);
      } finally {
        errorSpy.mockRestore();
      }
    }
  );
});
