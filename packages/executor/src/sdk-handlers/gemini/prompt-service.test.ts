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
  streamError: undefined as unknown,
  events: [] as SDK.ServerGeminiStreamEvent[][],
}));
vi.mock('../../config.js', () => ({ getDaemonUrl: vi.fn(async () => 'http://localhost:3030') }));
const mcp = vi.hoisted(() => ({
  servers: [] as unknown[],
  authorization: undefined as string | undefined,
  lookupFails: false,
}));
vi.mock('@agor/core/mcp', async (original) => ({
  ...(await original<typeof import('@agor/core/mcp')>()),
  getMcpServersForSession: vi.fn(async () =>
    mcp.servers.map((server) => ({ server, source: 'global', oauthAuthResolution: 'unavailable' }))
  ),
  resolveScopedMCPAuthHeaders: vi.fn(async () => {
    if (mcp.lookupFails) throw new Error('authority timed out');
    return mcp.authorization ? { Authorization: mcp.authorization } : undefined;
  }),
}));
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
    UnauthorizedError: class UnauthorizedError extends Error {
      override name = 'UnauthorizedError';
    },
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
            if (state.streamError) throw state.streamError;
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

import { expectSignalQuiescence } from '../../../test/helpers/signal-quiescence.js';
import { GeminiPromptService, resolveGeminiInvocationModel } from './prompt-service.js';
import { findGeminiRecording } from './runtime.js';
import { Gemini } from './sdk.js';

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
  controller?: AbortController
) {
  const events = [];
  for await (const e of s.promptSessionStreaming(
    id,
    'hello',
    undefined,
    mode,
    undefined,
    controller
  ))
    events.push(e);
  return events;
}
beforeEach(async () => {
  vi.clearAllMocks();
  mcp.servers = [];
  mcp.authorization = undefined;
  mcp.lookupFails = false;
  state.events = [];
  state.streamError = undefined;
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
  it('persists successful read content when the SDK display is empty', async () => {
    state.events = [
      [
        event('tool_call_request', {
          callId: 'read',
          name: 'read_file',
          args: { file_path: 'a.txt' },
        }),
      ],
      [event('content', 'read complete')],
    ];
    state.schedule.mockResolvedValue([
      {
        request: { callId: 'read' },
        status: 'success',
        response: {
          resultDisplay: '',
          responseParts: [
            { functionResponse: { name: 'read_file', response: { output: 'VISIBLE_MARKER' } } },
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
            tool_use_id: 'read',
            content: expect.stringContaining('VISIBLE_MARKER'),
            is_error: false,
          }),
        ],
      })
    );
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
  it('completes after model text without an executor-forbidden metadata patch', async () => {
    state.events = [[event('content', 'READY'), event('finished', { usageMetadata: {} })]];
    const tasksService = {
      get: vi.fn(async () => ({ created_by: 'owner', metadata: {} })),
      patch: vi.fn(async () => {
        throw Object.assign(new Error('Task patch contains fields that are not executor-managed'), {
          status: 403,
        });
      }),
    };
    const s = new GeminiPromptService(
      messages,
      sessions,
      'fake-key',
      branches,
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      tasksService as never
    );
    const result = [];
    for await (const item of s.promptSessionStreaming(id, 'hello', 'task-id' as never, 'autoEdit'))
      result.push(item);
    expect(result).toContainEqual(expect.objectContaining({ type: 'complete' }));
    expect(tasksService.patch).not.toHaveBeenCalled();
  });
  it('does not classify a local Forbidden error as a rejected provider key', async () => {
    const diagnostic = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.mocked(messages.getNextIndexBySessionId).mockRejectedValueOnce(
      Object.assign(new Error('private repository detail'), { status: 403 })
    );
    try {
      await expect(collect()).rejects.toThrow('Gemini integration error.');
      expect(diagnostic).toHaveBeenCalledWith('Gemini task failure stage=history category=local\n');
      expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('private repository detail');
    } finally {
      diagnostic.mockRestore();
    }
  });
  it('does not classify a local SDK-iteration Forbidden error as a rejected provider key', async () => {
    state.streamError = Object.assign(new Error('private local detail'), { status: 403 });
    await expect(collect()).rejects.toThrow('Gemini integration error.');
  });
  it('preserves a network category for the SDK auto-compression generation wrapper', async () => {
    // The pinned SDK's BaseLlmClient throws this prefix before any Error event
    // when its pre-turn compression generateContent request fails.
    state.streamError = new Error('Failed to generate content: fetch failed PRIVATE_URL');
    await expect(collect()).rejects.toMatchObject({ message: 'Could not reach the Gemini API.' });
  });
  it('preserves the pinned SDK model-not-found wrapper from auto-compression', async () => {
    state.streamError = new Error('Failed to generate content: Requested entity was not found.');
    await expect(collect()).rejects.toMatchObject({
      message: "Model gemini-3.8-flash isn't available to this API key. Pick another Gemini model.",
    });
  });
  it('does not infer model status from an unrelated local not-found error', async () => {
    state.streamError = Object.assign(new Error('Requested entity was not found.'), {
      status: 404,
    });
    await expect(collect()).rejects.toMatchObject({ message: 'Gemini integration error.' });
  });
  it('does not turn a local 403 inside the SDK generation wrapper into a key error', async () => {
    state.streamError = Object.assign(new Error('Failed to generate content: local forbidden'), {
      status: 403,
    });
    await expect(collect()).rejects.toMatchObject({ message: 'Gemini integration error.' });
  });
  it('does not infer provider model status from a local 403 with the SDK wrapper text', async () => {
    state.streamError = Object.assign(
      new Error('Failed to generate content: Requested entity was not found.'),
      { status: 403 }
    );
    await expect(collect()).rejects.toMatchObject({ message: 'Gemini integration error.' });
  });
  it('keeps the SDK explicit unauthorized error classified as a rejected key', async () => {
    state.streamError = new Gemini.UnauthorizedError('private provider detail');
    await expect(collect()).rejects.toThrow('Gemini rejected the API key.');
  });
  it.each([false, true])(
    'does not turn successful cancellation into teardown evidence (disposeFails=%s)',
    async (disposeFails) => {
      const controller = new AbortController();
      const promptService = service();
      state.events = [[event('tool_call_request', { callId: 'c', name: 'read_file', args: {} })]];
      state.schedule.mockImplementationOnce(async () => {
        expect(promptService.stopTask(id)).toEqual({ success: true });
        controller.abort();
        return [];
      });
      if (disposeFails) state.dispose.mockRejectedValueOnce(new Error('dispose failed'));
      const execution = collect(promptService, 'autoEdit', controller);
      if (disposeFails) await expect(execution).rejects.toThrow('Gemini integration error.');
      else await execution;
      expect(state.dispose).toHaveBeenCalledOnce();
      await expectSignalQuiescence(controller, !disposeFails);
    }
  );

  it('stops during a tool without sending another turn', async () => {
    const abort = new AbortController();
    state.events = [[event('tool_call_request', { callId: 'c', name: 'read_file', args: {} })]];
    state.schedule.mockImplementation(async () => {
      abort.abort();
      return [];
    });
    await collect(service(), 'autoEdit', abort);
    expect(state.prompts).toHaveBeenCalledOnce();
  });
  it('warns only when prior messages exist and history is unavailable', async () => {
    expect(JSON.stringify(await collect())).not.toContain('could not be restored');
    vi.mocked(messages.getNextIndexBySessionId).mockResolvedValue(3);
    expect(JSON.stringify(await collect())).toContain('could not be restored');
  });
  it('does not mistake a persisted retired-model notice for prior history', async () => {
    let nextIndex = 1; // The current user turn is already stored.
    vi.mocked(messages.getNextIndexBySessionId).mockImplementation(async () => nextIndex);
    vi.mocked(sessions.findById).mockResolvedValue({
      branch_id: 'branch',
      created_by: 'owner',
      model_config: { model: 'gemini-3-flash' },
    } as Awaited<ReturnType<SessionRepository['findById']>>);
    const events = [];
    for await (const item of service().promptSessionStreaming(id, 'hello', undefined, 'autoEdit')) {
      events.push(item);
      if (item.type === 'complete') nextIndex++; // Caller persists assistant notices.
    }
    expect(JSON.stringify(events)).toContain('is retired; using');
    expect(JSON.stringify(events)).not.toContain('could not be restored');
    expect(messages.getNextIndexBySessionId).toHaveBeenCalledOnce();
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

describe('Gemini MCP servers without an OAuth grant', () => {
  const remote = (name: string, auth: Record<string, unknown>) => ({
    mcp_server_id: `${name}-id`,
    name,
    display_name: name === 'asana' ? 'Asana' : undefined,
    transport: 'http',
    url: `https://mcp.${name}.test/mcp`,
    auth,
  });
  async function configure() {
    state.events = [[event('content', 'answer'), event('finished', {})]];
    const s = new GeminiPromptService(
      messages,
      sessions,
      'fake-key',
      branches,
      undefined,
      {} as never,
      {} as never,
      false
    );
    await collect(s);
    return state.config.mock.calls[0][0] as {
      mcpServers: Record<string, unknown>;
      userMemory: string;
    };
  }

  it('withholds a configured-client server and asks for sign-in', async () => {
    mcp.servers = [
      remote('asana', {
        type: 'oauth',
        oauth_mode: 'shared',
        oauth_dcr_mode: 'disabled',
        oauth_client_id: 'customer-app',
      }),
    ];
    const config = await configure();
    expect(config.mcpServers.asana).toBeUndefined();
    expect(config.userMemory).toContain('- mcpServerId: asana-id, label: "Asana"');
    expect(config.userMemory).toContain('agor_widgets_request_oauth');
    expect(config.userMemory).toContain('tools are not loaded');
  });

  it('keeps passing a DCR server through, with the Connect note', async () => {
    mcp.servers = [remote('dcr', { type: 'oauth' })];
    const config = await configure();
    expect(config.mcpServers.dcr).toBeDefined();
    expect(config.userMemory).toContain('- mcpServerId: dcr-id, label: "dcr"');
    expect(config.userMemory).not.toContain('tools are not loaded');
  });

  it('withholds a configured client whose credential lookup fails, asking to retry', async () => {
    mcp.servers = [
      remote('asana', { type: 'oauth', oauth_dcr_mode: 'disabled', oauth_client_id: 'app' }),
      remote('dcr', { type: 'oauth' }),
    ];
    mcp.lookupFails = true;
    const config = await configure();
    expect(config.mcpServers.asana).toBeUndefined();
    expect(config.userMemory).toContain("couldn't load the sign-in");
    expect(config.userMemory).toContain('mcpServerId: asana-id');
    // DCR keeps today's catch behavior: dispatched, no notice.
    expect(config.mcpServers.dcr).toBeDefined();
    expect(config.userMemory).not.toContain('dcr-id');
  });

  it('adds no notice when the grant is present', async () => {
    mcp.servers = [
      remote('asana', { type: 'oauth', oauth_dcr_mode: 'disabled', oauth_client_id: 'app' }),
    ];
    mcp.authorization = 'Bearer token';
    const config = await configure();
    expect(config.mcpServers.asana).toMatchObject({ headers: { Authorization: 'Bearer token' } });
    expect(config.userMemory).not.toContain('need sign-in');
  });
});
