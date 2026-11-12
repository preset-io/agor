import { generateId, SAFE_ZERO_TURN_PROVIDER_RESULT_MESSAGE } from '@agor/core';
import type { SDKMessage, SDKResultMessage, SDKSystemMessage } from '@agor/core/sdk';
import type { Message, SessionID, TaskID } from '@agor/core/types';
import { MessageRole, withProviderDetail } from '@agor/core/types';
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
  sessionsRepo: { update: ReturnType<typeof vi.fn> };
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
    sessionsRepo,
  };
}

// Deliberately partial usage: exercise the same closed accounting projection as older SDKs.
function rawResult(subtype: 'success' | 'error_during_execution'): SDKResultMessage {
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
  } as unknown as SDKResultMessage;
}

function resultEvent(raw: ReturnType<typeof rawResult>): ProcessedEvent {
  return { type: 'result', raw_sdk_message: raw };
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

describe('ClaudeTool command discovery persistence', () => {
  it('persists filtered commands and skills through the existing session context fields', async () => {
    const processor = new SDKMessageProcessor({ sessionId: generateId() as SessionID });
    const initMessage = {
      type: 'system',
      subtype: 'init',
      slash_commands: ['compact', 'usage', 'doctor'],
      terminal_slash_commands: ['doctor'],
      skills: ['doctor', 'project-review'],
    } satisfies Pick<
      SDKSystemMessage,
      'type' | 'subtype' | 'slash_commands' | 'terminal_slash_commands' | 'skills'
    >;
    promptState.events = await processor.process(initMessage as SDKSystemMessage);
    const harness = createHarness();
    await execute(harness.tool, 'streaming', generateId() as TaskID);
    expect(harness.sessionsRepo.update).toHaveBeenCalledWith(expect.any(String), {
      custom_context: {
        slash_commands: ['compact', 'usage'],
        skills: ['project-review'],
      },
    });
  });
});

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
        expect(result.errorDetails).toEqual([
          withProviderDetail(SAFE_ZERO_TURN_PROVIDER_RESULT_MESSAGE, 'error_during_execution'),
        ]);
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
        expect(result.errorDetails).toEqual([
          withProviderDetail(SAFE_ZERO_TURN_PROVIDER_RESULT_MESSAGE, 'error_during_execution'),
        ]);
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

describe('Claude diagnosis propagation', () => {
  it.each(['streaming', 'non-streaming'] as const)(
    'retains one result diagnosis and accounting without granting credential recovery in %s',
    async (mode) => {
      const harness = createHarness();
      const processor = new SDKMessageProcessor({ sessionId: generateId() as SessionID });
      const raw = {
        ...rawResult('error_during_execution'),
        errors: ['Not logged in. Please run /login SECRET'],
      };
      promptState.events = await processor.process(raw as SDKMessage);
      const diagnosed = promptState.events.find(
        (event) => (event as ProcessedEvent).type === 'result'
      ) as Extract<ProcessedEvent, { type: 'result' }>;
      const result = await execute(harness.tool, mode, generateId() as TaskID);
      expect(result.hadError).toBe(true);
      expect(result.errorDetails).toEqual([
        withProviderDetail(diagnosed.failure!.message, 'error_during_execution'),
      ]);
      expect(result.rawSdkResponse).toMatchObject({
        usage: raw.usage,
        total_cost_usd: raw.total_cost_usd,
      });
      expect(harness.outgoing.at(-1)?.metadata?.is_provider_failure_result).toBe(true);
      expect(
        harness.outgoing.some((message) => message.metadata?.is_missing_credential_failure)
      ).toBe(false);
      expect(JSON.stringify({ result, outgoing: harness.outgoing })).not.toContain('SECRET');
    }
  );
});

describe('ClaudeTool permission_denied handling', () => {
  function findDenialMessages(harness: Harness) {
    return harness.outgoing.filter(
      (m) =>
        m.role === MessageRole.SYSTEM &&
        Array.isArray(m.content) &&
        m.content.some((b) => b.type === 'sdk_event' && b.sdkSubtype === 'permission_denied')
    );
  }

  it.each(['streaming', 'non-streaming'] as const)(
    'persists safe permission_denied metadata without raw fields or is_error in %s',
    async (mode) => {
      const harness = createHarness();
      promptState.events = [
        {
          type: 'permission_denied',
          toolName: 'Bash',
          toolUseId: 'toolu_bash_1',
          agentId: 'subagent_1',
          message: 'Command refused by policy',
          decisionReason: 'Execution policy denial',
          decisionReasonType: 'rule',
          summary: 'Permission denied: Bash — Command refused by policy',
        },
        resultEvent(rawResult('success')),
      ];

      const result = await execute(harness.tool, mode, generateId() as TaskID);

      expect(result.hadError).toBe(false);
      const denialMessages = findDenialMessages(harness);
      expect(denialMessages).toHaveLength(1);
      expect(denialMessages[0].content).toEqual([
        {
          type: 'sdk_event',
          text: 'Permission denied: Bash — Command refused by policy',
          sdkType: 'system',
          sdkSubtype: 'permission_denied',
          metadata: {
            tool_name: 'Bash',
            tool_use_id: 'toolu_bash_1',
            agent_id: 'subagent_1',
            decision_reason_type: 'rule',
          },
        },
      ]);
      expect('is_error' in (denialMessages[0].content?.[0] ?? {})).toBe(false);
    }
  );

  it.each(['streaming', 'non-streaming'] as const)(
    'reconciles unobserved denials from final result while stripping sensitive tool_input in %s',
    async (mode) => {
      const harness = createHarness();
      const sentinelSecret = 'SENTINEL_API_TOKEN_DO_NOT_PERSIST';
      const rawWithDenials = {
        ...rawResult('success'),
        permission_denials: [
          {
            tool_name: 'Bash',
            tool_use_id: 'toolu_streamed',
            tool_input: { command: `curl -H "Authorization: Bearer ${sentinelSecret}"` },
          },
          {
            tool_name: 'Edit',
            tool_use_id: 'toolu_unobserved',
            tool_input: { file_path: '/etc/hosts', content: sentinelSecret },
            provider_extra: sentinelSecret,
          },
        ],
      } as unknown as SDKResultMessage;

      promptState.events = [
        {
          type: 'permission_denied',
          toolName: 'Bash',
          toolUseId: 'toolu_streamed',
          message: 'Denied by user',
          summary: 'Permission denied: Bash — Denied by user',
        },
        resultEvent(rawWithDenials),
      ];

      const result = await execute(harness.tool, mode, generateId() as TaskID);
      expect(result.hadError).toBe(false);

      const denialMessages = findDenialMessages(harness);
      expect(denialMessages).toHaveLength(2);
      expect(denialMessages[0].content).toEqual([
        {
          type: 'sdk_event',
          text: 'Permission denied: Bash — Denied by user',
          sdkType: 'system',
          sdkSubtype: 'permission_denied',
          metadata: {
            tool_name: 'Bash',
            tool_use_id: 'toolu_streamed',
          },
        },
      ]);
      expect(denialMessages[1].content).toEqual([
        {
          type: 'sdk_event',
          text: 'Permission denied: Edit',
          sdkType: 'system',
          sdkSubtype: 'permission_denied',
          metadata: {
            tool_name: 'Edit',
            tool_use_id: 'toolu_unobserved',
          },
        },
      ]);
      expect(JSON.stringify(harness.outgoing)).not.toContain(sentinelSecret);
      expect(JSON.stringify(harness.outgoing)).not.toContain('tool_input');
      expect(JSON.stringify(harness.outgoing)).not.toContain('provider_extra');
    }
  );

  it.each(['streaming', 'non-streaming'] as const)(
    'deduplicates repeated denials with matching tool_use_id in %s',
    async (mode) => {
      const harness = createHarness();
      promptState.events = [
        {
          type: 'permission_denied',
          toolName: 'Bash',
          toolUseId: 'toolu_dup_1',
          message: 'Denied by policy',
          summary: 'Permission denied: Bash — Denied by policy',
        },
        {
          type: 'permission_denied',
          toolName: 'Bash',
          toolUseId: 'toolu_dup_1',
          message: 'Denied by policy',
          summary: 'Permission denied: Bash — Denied by policy',
        },
        resultEvent(rawResult('success')),
      ];

      const result = await execute(harness.tool, mode, generateId() as TaskID);
      expect(result.hadError).toBe(false);

      const denialMessages = findDenialMessages(harness);
      expect(denialMessages).toHaveLength(1);
      expect(denialMessages[0].content).toEqual([
        {
          type: 'sdk_event',
          text: 'Permission denied: Bash — Denied by policy',
          sdkType: 'system',
          sdkSubtype: 'permission_denied',
          metadata: {
            tool_name: 'Bash',
            tool_use_id: 'toolu_dup_1',
          },
        },
      ]);
    }
  );

  it.each(['streaming', 'non-streaming'] as const)(
    'preserves multiple ID-less denials from both streamed events and final result in %s',
    async (mode) => {
      const harness = createHarness();
      const rawWithIdlessDenials = {
        ...rawResult('success'),
        permission_denials: [
          {
            tool_name: 'Bash',
            tool_input: { command: 'rm -rf /tmp/a' },
          },
          {
            tool_name: 'Bash',
            tool_input: { command: 'rm -rf /tmp/b' },
          },
        ],
      } as unknown as SDKResultMessage;

      promptState.events = [
        {
          type: 'permission_denied',
          toolName: 'Bash',
          message: 'First denial without id',
          summary: 'Permission denied: Bash — First denial without id',
        },
        {
          type: 'permission_denied',
          toolName: 'Bash',
          message: 'Second denial without id',
          summary: 'Permission denied: Bash — Second denial without id',
        },
        resultEvent(rawWithIdlessDenials),
      ];

      const result = await execute(harness.tool, mode, generateId() as TaskID);
      expect(result.hadError).toBe(false);

      const denialMessages = findDenialMessages(harness);
      expect(denialMessages).toHaveLength(4);
      expect(denialMessages.map((m) => (m.content?.[0] as { text?: string })?.text)).toEqual([
        'Permission denied: Bash — First denial without id',
        'Permission denied: Bash — Second denial without id',
        'Permission denied: Bash',
        'Permission denied: Bash',
      ]);
    }
  );

  it.each(['streaming', 'non-streaming'] as const)(
    'safely ignores malformed final-response permission_denials without failing the turn in %s',
    async (mode) => {
      const harness = createHarness();
      const rawWithMalformed = {
        ...rawResult('success'),
        permission_denials: 'not-an-array',
      } as unknown as SDKResultMessage;

      promptState.events = [
        {
          type: 'complete',
          role: MessageRole.ASSISTANT,
          content: [{ type: 'text', text: 'Completed despite malformed field.' }],
        },
        resultEvent(rawWithMalformed),
      ];

      const result = await execute(harness.tool, mode, generateId() as TaskID);
      expect(result.hadError).toBe(false);
      expect(findDenialMessages(harness)).toHaveLength(0);
    }
  );

  it.each(['streaming', 'non-streaming'] as const)(
    'attributes concurrent subagent denials with independent tool_use_ids and agent_ids in %s',
    async (mode) => {
      const harness = createHarness();
      promptState.events = [
        {
          type: 'permission_denied',
          toolName: 'Bash',
          toolUseId: 'toolu_sub1_bash',
          agentId: 'subagent_instance_A',
          message: 'Command refused by policy',
          summary: 'Permission denied: Bash — Command refused by policy',
        },
        {
          type: 'permission_denied',
          toolName: 'Write',
          toolUseId: 'toolu_sub2_write',
          agentId: 'subagent_instance_B',
          message: 'Path outside sandbox',
          summary: 'Permission denied: Write — Path outside sandbox',
        },
        resultEvent(rawResult('success')),
      ];

      const result = await execute(harness.tool, mode, generateId() as TaskID);
      expect(result.hadError).toBe(false);

      const denialMessages = findDenialMessages(harness);
      expect(denialMessages).toHaveLength(2);
      expect(denialMessages[0].content).toEqual([
        expect.objectContaining({
          text: 'Permission denied: Bash — Command refused by policy',
          metadata: {
            tool_name: 'Bash',
            tool_use_id: 'toolu_sub1_bash',
            agent_id: 'subagent_instance_A',
          },
        }),
      ]);
      expect(denialMessages[1].content).toEqual([
        expect.objectContaining({
          text: 'Permission denied: Write — Path outside sandbox',
          metadata: {
            tool_name: 'Write',
            tool_use_id: 'toolu_sub2_write',
            agent_id: 'subagent_instance_B',
          },
        }),
      ]);
    }
  );

  it.each(['streaming', 'non-streaming'] as const)(
    'continues turn cleanly after denial without fabricating tool_result or forcing hadError in %s',
    async (mode) => {
      const harness = createHarness();
      promptState.events = [
        {
          type: 'permission_denied',
          toolName: 'Bash',
          toolUseId: 'toolu_denied_bash',
          message: 'Bash refused',
          summary: 'Permission denied: Bash — Bash refused',
        },
        {
          type: 'complete',
          role: MessageRole.ASSISTANT,
          content: [
            { type: 'text', text: 'Bash was refused, so I used the alternative approach.' },
          ],
        },
        resultEvent(rawResult('success')),
      ];

      const result = await execute(harness.tool, mode, generateId() as TaskID);
      expect(result.hadError).toBe(false);

      const assistantMessage = harness.outgoing.find((m) => m.role === MessageRole.ASSISTANT);
      expect(assistantMessage?.content_preview).toBe(
        'Bash was refused, so I used the alternative approach.'
      );
      const hasToolResult = harness.outgoing.some(
        (m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result')
      );
      expect(hasToolResult).toBe(false);
    }
  );

  it.each(['streaming', 'non-streaming'] as const)(
    'preserves earlier streamed denial when session is cancelled before result in %s',
    async (mode) => {
      const harness = createHarness();
      promptState.events = [
        {
          type: 'permission_denied',
          toolName: 'Bash',
          toolUseId: 'toolu_before_stop',
          message: 'Denied by policy',
          summary: 'Permission denied: Bash — Denied by policy',
        },
        { type: 'stopped' },
      ];

      const result = await execute(harness.tool, mode, generateId() as TaskID);
      expect(result.wasStopped).toBe(true);
      expect(result.hadError).toBe(false);
      expect(findDenialMessages(harness)).toHaveLength(1);
    }
  );

  it('invokes streamingCallbacks for streamed and reconciled denials in streaming mode', async () => {
    const harness = createHarness();
    const onStreamStart = vi.fn(async () => {});
    const onStreamEnd = vi.fn(async () => {});
    const rawWithUnobserved = {
      ...rawResult('success'),
      permission_denials: [{ tool_name: 'Edit', tool_use_id: 'toolu_late', tool_input: {} }],
    } as unknown as SDKResultMessage;

    promptState.events = [
      {
        type: 'permission_denied',
        toolName: 'Bash',
        toolUseId: 'toolu_early',
        summary: 'Permission denied: Bash',
      },
      resultEvent(rawWithUnobserved),
    ];

    const result = await harness.tool.executePromptWithStreaming(
      generateId() as SessionID,
      'prompt',
      generateId() as TaskID,
      undefined,
      {
        onStreamStart,
        onStreamChunk: vi.fn(async () => {}),
        onStreamEnd,
      }
    );

    expect(result.hadError).toBe(false);
    expect(onStreamStart).toHaveBeenCalledTimes(2);
    expect(onStreamStart).toHaveBeenNthCalledWith(
      1,
      expect.any(String),
      expect.objectContaining({ role: MessageRole.SYSTEM })
    );
    expect(onStreamStart).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      expect.objectContaining({ role: MessageRole.SYSTEM })
    );
    expect(onStreamEnd).toHaveBeenCalledTimes(2);
  });

  it('persists api_wait before first permission_denied when streaming API response exceeds 30s', async () => {
    const harness = createHarness();
    const promptService = (
      harness.tool as unknown as {
        promptService: { promptSessionStreaming: () => AsyncGenerator<ProcessedEvent> };
      }
    ).promptService;

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      vi.spyOn(promptService, 'promptSessionStreaming').mockImplementation(async function* () {
        vi.advanceTimersByTime(31_000);
        yield {
          type: 'permission_denied',
          toolName: 'Bash',
          toolUseId: 'toolu_after_wait',
          summary: 'Permission denied: Bash',
        };
        yield resultEvent(rawResult('success'));
      });

      const result = await harness.tool.executePromptWithStreaming(
        generateId() as SessionID,
        'prompt',
        generateId() as TaskID
      );

      expect(result.hadError).toBe(false);
      const systemBlocks = harness.outgoing
        .filter((m) => m.role === MessageRole.SYSTEM)
        .flatMap((m) => (Array.isArray(m.content) ? m.content.map((b) => b.type) : []));
      expect(systemBlocks).toEqual(['api_wait', 'sdk_event']);
    } finally {
      vi.useRealTimers();
    }
  });
});
