import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SessionID } from '@agor/core/types';
import type * as SDK from '@google/gemini-cli-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BranchRepository,
  MessagesRepository,
  SessionRepository,
} from '../../db/feathers-repositories.js';

const state = vi.hoisted(() => ({
  config: vi.fn(),
  auth: vi.fn(),
  prompts: vi.fn(),
  schedule: vi.fn(),
  dispose: vi.fn(),
  resume: vi.fn(),
  reset: vi.fn(),
  events: [] as SDK.ServerGeminiStreamEvent[][],
}));
vi.mock('../../config.js', () => ({ getDaemonUrl: vi.fn(async () => 'http://localhost:3030') }));
vi.mock('./runtime.js', async (original) => ({
  ...(await original<typeof import('./runtime.js')>()),
  enterGeminiRuntime: vi.fn(async () => async () => {}),
  findGeminiRecording: vi.fn(async () => undefined),
}));
vi.mock('./policy.js', () => ({
  buildGeminiPolicy: vi.fn(() => ({})),
  installGeminiPolicy: vi.fn(),
}));
vi.mock('@agor/core/agentic-integrations', () => ({
  loadManagedAgenticToolSdk: vi.fn(async () => ({
    ApprovalMode: { DEFAULT: 'default', AUTO_EDIT: 'autoEdit', YOLO: 'yolo' },
    AuthType: { USE_GEMINI: 'gemini' },
    classifyGoogleError: (error: unknown) => error,
    loadConversationRecord: vi.fn(async () => ({ messages: [] })),
    convertSessionToClientHistory: vi.fn(() => []),
    GeminiEventType: {
      Content: 'content',
      ModelInfo: 'model_info',
      ToolCallRequest: 'tool_call_request',
      Finished: 'finished',
      Error: 'error',
      UserCancelled: 'user_cancelled',
      LoopDetected: 'loop_detected',
      ContextWindowWillOverflow: 'context_window_will_overflow',
      InvalidStream: 'invalid_stream',
      MaxSessionTurns: 'max_session_turns',
      AgentExecutionStopped: 'agent_execution_stopped',
      ChatCompressed: 'chat_compressed',
      AgentExecutionBlocked: 'agent_execution_blocked',
    },
    Config: class {
      storage = { initialize: vi.fn() };
      constructor(options: unknown) {
        state.config(options);
      }
      getSessionId() {
        return 'sdk-id';
      }
      async initialize() {}
      refreshAuth = state.auth;
      dispose = state.dispose;
      getMessageBus() {
        return {};
      }
      getGeminiClient() {
        return {
          setTools: vi.fn(),
          getChatRecordingService: () => undefined,
          resumeChat: state.resume,
          resetChat: state.reset,
          sendMessageStream: async function* (...args: unknown[]) {
            state.prompts(...args);
            for (const event of state.events.shift() ?? []) yield event;
            return { getDebugResponses: () => [{ modelVersion: 'sdk-reported-model' }] };
          },
        };
      }
    },
    Scheduler: class {
      schedule = state.schedule;
      dispose() {}
    },
    MCPServerConfig: class {
      constructor(...args: unknown[]) {
        Object.assign(this, { headers: args[6] });
      }
    },
  })),
}));

import { GeminiPromptService, resolveGeminiInvocationModel } from './prompt-service.js';
import { findGeminiRecording } from './runtime.js';

let directory: string;
let messages: MessagesRepository;
let sessions: SessionRepository;
let branches: BranchRepository;
const id = 'session-id' as SessionID;
const event = (type: string, value?: unknown) => ({ type, value }) as SDK.ServerGeminiStreamEvent;
function service(key: string | undefined = 'fake-key') {
  return new GeminiPromptService(
    messages,
    sessions,
    key,
    branches,
    undefined,
    undefined,
    undefined,
    false
  );
}
async function collect(
  s = service(),
  mode: 'autoEdit' | 'default' | 'ask' | 'plan' | 'yolo' | undefined = 'autoEdit',
  signal?: AbortSignal
) {
  const events = [];
  for await (const e of s.promptSessionStreaming(id, 'hello', undefined, mode, undefined, signal))
    events.push(e);
  return events;
}
beforeEach(async () => {
  vi.clearAllMocks();
  state.events = [];
  vi.mocked(findGeminiRecording).mockResolvedValue(undefined);
  state.resume.mockResolvedValue(undefined);
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gemini-unit-'));
  messages = { getNextIndexBySessionId: vi.fn(async () => 1) } as unknown as MessagesRepository;
  sessions = {
    findById: vi.fn(async () => ({
      branch_id: 'branch',
      created_by: 'owner',
      model_config: { model: 'gemini-3.8-flash' },
    })),
  } as unknown as SessionRepository;
  branches = { findById: vi.fn(async () => ({ path: directory })) } as unknown as BranchRepository;
  state.schedule.mockResolvedValue([]);
});
afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

describe('Gemini prompt boundary', () => {
  it.each(['default', 'ask', 'plan'] as const)(
    'rejects Manual mapping %s before SDK startup',
    async (mode) => {
      await expect(collect(service(), mode)).rejects.toThrow("Manual approval isn't available");
      expect(state.config).not.toHaveBeenCalled();
    }
  );
  it('rejects a missing mode without promoting it', async () => {
    const s = service();
    await expect(async () => {
      for await (const _ of s.promptSessionStreaming(id, 'hello')) {
      }
    }).rejects.toThrow("Manual approval isn't available");
  });
  it('rejects absent credentials and missing branches before SDK startup', async () => {
    await expect(collect(service(''))).rejects.toThrow('Gemini needs an API key');
    vi.mocked(branches.findById).mockResolvedValue(null);
    await expect(collect()).rejects.toThrow('Gemini session has no accessible branch');
    expect(state.config).not.toHaveBeenCalled();
  });
  it('starts fresh with a notice when SDK resume rejects a damaged recording', async () => {
    vi.mocked(findGeminiRecording).mockResolvedValue('/fixture/recording.jsonl');
    vi.mocked(messages.getNextIndexBySessionId).mockResolvedValue(3);
    state.resume.mockRejectedValueOnce(new Error('private recording detail'));
    const result = await collect();
    expect(state.reset).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).toContain('Earlier Gemini conversation could not be restored');
    expect(JSON.stringify(result)).not.toContain('private recording detail');
  });

  it('uses one SDK-owned client, API-key auth and private defaults', async () => {
    state.events = [
      [
        event('content', 'answer'),
        event('finished', { usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2 } }),
      ],
    ];
    const result = await collect();
    expect(state.auth).toHaveBeenCalledWith('gemini', 'fake-key');
    expect(state.config).toHaveBeenCalledWith(
      expect.objectContaining({
        debugMode: false,
        enableHooks: false,
        extensionsEnabled: false,
        usageStatisticsEnabled: false,
      })
    );
    expect(state.prompts).toHaveBeenCalledWith(
      [{ text: 'hello' }, { text: expect.stringContaining(`Current Agor session ID: ${id}`) }],
      expect.any(AbortSignal),
      expect.any(String)
    );
    expect(result.at(-1)).toMatchObject({
      resolvedModel: 'sdk-reported-model',
      usage: { input_tokens: 4, output_tokens: 2 },
    });
    expect(state.dispose).toHaveBeenCalledOnce();
  });
  it('records every tool result and sums model turns, keeping last context usage', async () => {
    state.events = [
      [
        event('tool_call_request', {
          callId: 'call',
          name: 'run_shell_command',
          args: { command: 'x' },
          prompt_id: 'p',
        }),
        event('finished', { usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 } }),
      ],
      [
        event('content', 'done'),
        event('finished', { usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 3 } }),
      ],
    ];
    state.schedule.mockResolvedValue([
      {
        request: { callId: 'call' },
        status: 'error',
        response: {
          resultDisplay: 'needs Bypass',
          responseParts: [
            {
              functionResponse: { name: 'run_shell_command', response: { error: 'needs Bypass' } },
            },
          ],
        },
      },
    ]);
    const result = await collect();
    expect(result).toContainEqual(
      expect.objectContaining({
        content: [
          expect.objectContaining({
            type: 'tool_result',
            tool_use_id: 'call',
            content: 'needs Bypass',
            is_error: true,
          }),
        ],
      })
    );
    expect(result.at(-1)).toMatchObject({
      usage: { input_tokens: 30, output_tokens: 5 },
      rawSdkResponse: { value: { usageMetadata: { promptTokenCount: 20 } } },
    });
    expect(state.schedule.mock.calls[0][0][0]).not.toHaveProperty('isClientInitiated');
  });
  it.each([
    ['loop_detected', 'detected a loop'],
    ['context_window_will_overflow', 'too large'],
    ['invalid_stream', 'invalid response'],
    ['max_session_turns', 'turn limit'],
  ])('fails on %s instead of completing', async (type, message) => {
    state.events = [[event(type)]];
    await expect(collect()).rejects.toThrow(message);
  });
  it('adds notices for compression and blocked-then-continued', async () => {
    state.events = [
      [event('chat_compressed'), event('agent_execution_blocked'), event('content', 'done')],
    ];
    const result = await collect();
    expect(JSON.stringify(result)).toContain('compressed');
    expect(JSON.stringify(result)).toContain('blocked an action');
  });
  it('does not reflect raw provider errors', async () => {
    state.events = [[event('error', { error: { status: 401, message: 'SECRET' } })]];
    await expect(collect()).rejects.toThrow('Gemini rejected the API key.');
  });
  it('stops during a tool without sending another turn', async () => {
    const abort = new AbortController();
    state.events = [[event('tool_call_request', { callId: 'c', name: 'read_file', args: {} })]];
    state.schedule.mockImplementation(async () => {
      abort.abort();
      return [];
    });
    await collect(service(), 'autoEdit', abort.signal);
    expect(state.prompts).toHaveBeenCalledOnce();
  });
  it('warns only when prior messages exist and history is unavailable', async () => {
    expect(JSON.stringify(await collect())).not.toContain('could not be restored');
    vi.mocked(messages.getNextIndexBySessionId).mockResolvedValue(3);
    expect(JSON.stringify(await collect())).toContain('could not be restored');
  });
});

describe('retired models', () => {
  it.each(['gemini-2.0-flash', 'gemini-2.0-flash-thinking-experimental', 'gemini-3-flash'])(
    'remaps %s without modifying settings',
    (model) => {
      const session = { model_config: { model } };
      expect(resolveGeminiInvocationModel(session)).toBe('gemini-3.8-flash');
      expect(session.model_config.model).toBe(model);
    }
  );
  it('keeps 2.5 and remaps Lite, but fails retired Pro', () => {
    expect(resolveGeminiInvocationModel({ model_config: { model: 'gemini-2.5-pro' } })).toBe(
      'gemini-2.5-pro'
    );
    expect(resolveGeminiInvocationModel({ model_config: { model: 'gemini-2.0-flash-lite' } })).toBe(
      'gemini-3.5-flash-lite'
    );
    expect(() => resolveGeminiInvocationModel({ model_config: { model: 'gemini-3-pro' } })).toThrow(
      'retired'
    );
  });
});
