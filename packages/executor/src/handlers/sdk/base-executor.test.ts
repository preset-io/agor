import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isTaskFailurePersisted } from '../../terminal-task.js';
import {
  createStreamingCallbacks,
  executeToolTask,
  installProviderConnection,
  resolveApiKeyForTask,
  settleTaskFailure,
} from './base-executor.js';

describe('createStreamingCallbacks', () => {
  it('stamps every event with immutable task/session attribution', async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    const callbacks = createStreamingCallbacks(
      { service: () => ({ create }) } as never,
      'codex',
      'session-1' as never,
      'task-1' as never
    );

    await callbacks.onStreamStart('message-1' as never, {
      role: 'assistant',
      timestamp: '2026-08-23T00:00:00.000Z',
    });
    await callbacks.onStreamChunk('message-1' as never, 'hello');
    await callbacks.onStreamEnd('message-1' as never);
    await callbacks.onStreamError('message-2' as never, new Error('failed'));
    await callbacks.onThinkingStart('message-3' as never, {});
    await callbacks.onThinkingChunk('message-3' as never, 'hmm');
    await callbacks.onThinkingEnd('message-3' as never);

    expect(create).toHaveBeenCalledTimes(7);
    for (const [envelope] of create.mock.calls) {
      expect(envelope.data).toMatchObject({
        session_id: 'session-1',
        task_id: 'task-1',
      });
    }
  });
});

vi.mock('./git-safe-directory.js', () => ({
  configureSessionGitSafeDirectories: vi.fn().mockResolvedValue(undefined),
}));

function makeClient(error: unknown) {
  return {
    service(name: string) {
      if (name !== 'config/resolve-api-key') {
        throw new Error(`unexpected service ${name}`);
      }
      return {
        create: vi.fn(async () => {
          throw error;
        }),
      };
    },
  } as never;
}

function makeSuccessfulClient(capture: { data?: unknown }) {
  return {
    service(name: string) {
      if (name !== 'config/resolve-api-key') {
        throw new Error(`unexpected service ${name}`);
      }
      return {
        create: vi.fn(async (data: unknown) => {
          capture.data = data;
          return { apiKey: 'daemon-key', source: 'user', useNativeAuth: false };
        }),
      };
    },
  } as never;
}

describe('resolveApiKeyForTask', () => {
  it('uses the authenticated executor connection without resending its bearer', async () => {
    const capture: { data?: unknown } = {};

    await expect(
      resolveApiKeyForTask(
        'OPENAI_API_KEY',
        makeSuccessfulClient(capture),
        'task-1' as never,
        'codex' as never
      )
    ).resolves.toMatchObject({ apiKey: 'daemon-key', source: 'user' });

    expect(capture.data).toMatchObject({
      taskId: 'task-1',
      keyName: 'OPENAI_API_KEY',
      tool: 'codex',
    });
  });

  it('does not fall back to local secret resolution after daemon authorization rejection', async () => {
    const forbidden = Object.assign(new Error('Executor token is not valid for this task'), {
      code: 403,
    });

    await expect(
      resolveApiKeyForTask(
        'OPENAI_API_KEY',
        makeClient(forbidden),
        'task-1' as never,
        'codex' as never
      )
    ).rejects.toThrow('Executor token is not valid for this task');
  });

  it('does not consult local config when the daemon is unavailable', async () => {
    await expect(
      resolveApiKeyForTask(
        'OPENAI_API_KEY',
        makeClient(new Error('fetch failed')),
        'task-1' as never,
        'codex' as never
      )
    ).rejects.toThrow('fetch failed');
  });
});

describe('settleTaskFailure', () => {
  it('appends after the maximum Message index rather than the row count', async () => {
    const taskPatch = vi.fn().mockResolvedValue(undefined);
    const messageFind = vi.fn().mockResolvedValue({
      total: 2,
      data: [{ index: 2 }],
    });
    const messageCreate = vi.fn().mockResolvedValue(undefined);
    const client = {
      service(name: string) {
        if (name === 'tasks') return { patch: taskPatch };
        if (name === 'messages') return { find: messageFind, create: messageCreate };
        throw new Error(`unexpected service ${name}`);
      },
    } as never;

    const failure = new Error('failed');
    await settleTaskFailure(client, 'session-1' as never, 'task-1' as never, failure, {
      status: 'failed',
      error_message: 'failed',
    });

    expect(messageFind).toHaveBeenCalledWith({
      query: {
        session_id: 'session-1',
        $sort: { index: -1 },
        $limit: 1,
        $select: ['index'],
      },
    });
    expect(messageCreate).toHaveBeenCalledWith(expect.objectContaining({ index: 3 }));
    expect(isTaskFailurePersisted(failure)).toBe(true);
  });

  it('does not mark a failure persisted until the terminal patch is acknowledged', async () => {
    const failure = new Error('failed');
    const client = {
      service(name: string) {
        if (name === 'tasks') {
          return { patch: vi.fn().mockRejectedValue(new Error('socket disconnected')) };
        }
        if (name === 'messages') {
          return {
            find: vi.fn().mockResolvedValue({ total: 0, data: [] }),
            create: vi.fn().mockResolvedValue(undefined),
          };
        }
        throw new Error(`unexpected service ${name}`);
      },
    } as never;

    await expect(
      settleTaskFailure(client, 'session-1' as never, 'task-1' as never, failure, {
        status: 'failed',
        error_message: 'failed',
      })
    ).rejects.toThrow('socket disconnected');
    expect(isTaskFailurePersisted(failure)).toBe(false);
  });

  it('does not persist Drizzle query parameters in task or transcript diagnostics', async () => {
    const secret = 'secret-binary-tool-result';
    const taskPatch = vi.fn().mockResolvedValue(undefined);
    const messageCreate = vi.fn().mockResolvedValue(undefined);
    const client = {
      service(name: string) {
        if (name === 'tasks') return { patch: taskPatch };
        if (name === 'messages') {
          return {
            find: vi.fn().mockResolvedValue({ total: 0, data: [] }),
            create: messageCreate,
          };
        }
        throw new Error(`unexpected service ${name}`);
      },
    } as never;
    const failure = Object.assign(new Error(`Failed query: update messages params: ${secret}`), {
      query: 'update messages',
      params: [secret],
      cause: { code: '22P05' },
    });

    await settleTaskFailure(client, 'session-1' as never, 'task-1' as never, failure, {
      status: 'failed',
      error_message: failure.message,
    });

    const persisted = JSON.stringify({
      message: messageCreate.mock.calls,
      task: taskPatch.mock.calls,
    });
    expect(persisted).not.toContain(secret);
    expect(persisted).not.toContain('update messages');
    expect(persisted).toContain('Database operation failed');
  });
});

describe('executeToolTask credential preflight', () => {
  it('persists an explicit missing-credential failure before invoking the tool', async () => {
    const order: string[] = [];
    const taskPatch = vi.fn(async () => order.push('task'));
    const messageCreate = vi.fn(async () => order.push('message'));
    const client = {
      service(name: string) {
        if (name === 'config/resolve-api-key') {
          return {
            create: vi.fn().mockResolvedValue({
              apiKey: null,
              connection: {},
              source: 'none',
              useNativeAuth: false,
            }),
          };
        }
        if (name === 'tasks') return { patch: taskPatch };
        if (name === 'messages') {
          return {
            find: vi.fn().mockResolvedValue({ total: 0, data: [] }),
            create: messageCreate,
          };
        }
        if (name === 'sessions') {
          return { get: vi.fn().mockRejectedValue(new Error('no git state in unit test')) };
        }
        if (name === 'messages' || name === 'tasks' || name === '/tasks/streaming') {
          return {};
        }
        throw new Error(`unexpected service ${name}`);
      },
    } as never;
    const createTool = vi.fn();

    await expect(
      executeToolTask({
        client,
        sessionId: 'session-1' as never,
        taskId: 'task-1' as never,
        prompt: 'hello',
        abortController: new AbortController(),
        apiKeyEnvVar: 'GEMINI_API_KEY',
        toolName: 'gemini',
        createTool,
      })
    ).rejects.toThrow('No scoped gemini credential');

    expect(createTool).not.toHaveBeenCalled();
    expect(taskPatch).toHaveBeenCalledWith('task-1', expect.objectContaining({ status: 'failed' }));
    expect(messageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: {
          is_task_failure: true,
          is_missing_credential_failure: true,
        },
      })
    );
    expect(order).toEqual(['message', 'task']);
  });

  it('does not launch provider work when cancellation arrives before tool execution', async () => {
    const abortController = new AbortController();
    abortController.abort();
    const stopTask = vi.fn().mockResolvedValue({ success: true });
    const executePromptWithStreaming = vi.fn();
    const createTool = vi.fn(() => ({
      stopTask,
      executePromptWithStreaming,
    }));
    const client = {
      service(name: string) {
        if (name === 'config/resolve-api-key') {
          return {
            create: vi.fn().mockResolvedValue({
              apiKey: 'daemon-key',
              source: 'user',
              useNativeAuth: false,
            }),
          };
        }
        if (name === 'sessions') {
          return { get: vi.fn().mockRejectedValue(new Error('no git state in unit test')) };
        }
        if (name === 'messages' || name === 'tasks' || name === '/tasks/streaming') {
          return {};
        }
        throw new Error(`unexpected service ${name}`);
      },
    } as never;

    await expect(
      executeToolTask({
        client,
        sessionId: 'session-1' as never,
        taskId: 'task-1' as never,
        prompt: 'hello',
        abortController,
        apiKeyEnvVar: 'GEMINI_API_KEY',
        toolName: 'gemini',
        createTool,
      })
    ).resolves.toBeUndefined();

    expect(createTool).toHaveBeenCalledOnce();
    expect(stopTask).toHaveBeenCalledWith('session-1', 'task-1');
    expect(executePromptWithStreaming).not.toHaveBeenCalled();
  });
});

describe('executeToolTask provider-failure settlement', () => {
  it('patches a classified Claude result with sanitized raw response and accounting', async () => {
    const secret = 'provider-secret-body';
    const taskPatch = vi.fn().mockResolvedValue(undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const safeRawResponse = {
      type: 'result',
      subtype: 'error_during_execution',
      duration_ms: 42,
      duration_api_ms: 31,
      is_error: true,
      num_turns: 1,
      stop_reason: null,
      total_cost_usd: 0.12,
      usage: { input_tokens: 10, output_tokens: 4 },
      modelUsage: {
        'claude-sonnet-4-6': {
          inputTokens: 10,
          outputTokens: 4,
          contextWindow: 200_000,
        },
      },
      permission_denials: [],
    };
    const client = {
      service(name: string) {
        if (name === 'config/resolve-api-key') {
          return {
            create: vi.fn().mockResolvedValue({
              apiKey: 'daemon-key',
              source: 'user',
              useNativeAuth: false,
            }),
          };
        }
        if (name === 'sessions') return { get: vi.fn().mockResolvedValue({}) };
        if (name === 'tasks') return { patch: taskPatch };
        if (name === 'messages') return { create: vi.fn(), patch: vi.fn() };
        if (name === '/tasks/streaming') return { create: vi.fn() };
        throw new Error(`unexpected service ${name}`);
      },
    } as never;
    const createTool = vi.fn(() => ({
      executePromptWithStreaming: vi.fn().mockResolvedValue({
        userMessageId: 'user-1',
        assistantMessageIds: [],
        hadError: true,
        errorDetails: undefined,
        rawSdkResponse: safeRawResponse,
        rawContextUsage: {
          totalTokens: 14,
          maxTokens: 200_000,
          percentage: 0.007,
          memoryFiles: [{ path: secret }],
          providerExtension: { secret },
        },
      }),
    }));

    try {
      await executeToolTask({
        client,
        sessionId: 'session-1' as never,
        taskId: 'task-1' as never,
        prompt: 'hello',
        abortController: new AbortController(),
        apiKeyEnvVar: 'ANTHROPIC_API_KEY',
        toolName: 'claude-code',
        createTool,
      });
    } finally {
      errorSpy.mockRestore();
    }

    const patch = taskPatch.mock.calls[0]?.[1];
    expect(patch).toMatchObject({
      status: 'failed',
      raw_sdk_response: safeRawResponse,
      normalized_sdk_response: {
        tokenUsage: { inputTokens: 10, outputTokens: 4 },
        durationMs: 42,
        costUsd: 0.12,
        contextWindowLimit: 200_000,
        contextUsageSnapshot: {
          totalTokens: 14,
          maxTokens: 200_000,
          percentage: 0.007,
        },
      },
      computed_context_window: 14,
    });
    expect(JSON.stringify(patch)).not.toContain(secret);
  });
});

describe('installProviderConnection', () => {
  // Regression tests for the 2026-07-13 incident: the pre-install strip was
  // tool-agnostic and deleted user-configured env vars (GITHUB_TOKEN in
  // particular) from every session's environment.
  const SEEDED = {
    GITHUB_TOKEN: 'ghp_user',
    MY_CUSTOM_VAR: 'hello',
    ANTHROPIC_API_KEY: 'stale-user-key',
    CLAUDE_CODE_OAUTH_TOKEN: 'stale-oauth',
    AGOR_USER_ENV_KEYS: 'GITHUB_TOKEN,MY_CUSTOM_VAR,ANTHROPIC_API_KEY',
  } as const;

  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    Object.assign(process.env, SEEDED);
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
  });

  it('replaces the running tool provider surface but keeps user env vars', () => {
    installProviderConnection('claude-code', { ANTHROPIC_API_KEY: 'resolved-key' });

    expect(process.env.ANTHROPIC_API_KEY).toBe('resolved-key');
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined(); // stale user value cannot shadow the resolved connection
    expect(process.env.GITHUB_TOKEN).toBe('ghp_user');
    expect(process.env.MY_CUSTOM_VAR).toBe('hello');
  });

  it('leaves other tools user credentials alone for a codex session', () => {
    installProviderConnection('codex', { OPENAI_API_KEY: 'resolved-openai' });

    expect(process.env.OPENAI_API_KEY).toBe('resolved-openai');
    expect(process.env.GITHUB_TOKEN).toBe('ghp_user');
    expect(process.env.ANTHROPIC_API_KEY).toBe('stale-user-key');
  });

  it('still strips ambient GitHub tokens for copilot sessions', () => {
    installProviderConnection('copilot', { COPILOT_GITHUB_TOKEN: 'resolved-copilot' });

    expect(process.env.COPILOT_GITHUB_TOKEN).toBe('resolved-copilot');
    expect(process.env.GITHUB_TOKEN).toBeUndefined();
    expect(process.env.GH_TOKEN).toBeUndefined();
  });

  it('rewrites AGOR_USER_ENV_KEYS to only advertise surviving vars', () => {
    installProviderConnection('copilot', { COPILOT_GITHUB_TOKEN: 'resolved-copilot' });

    const advertised = (process.env.AGOR_USER_ENV_KEYS ?? '').split(',');
    expect(advertised).not.toContain('GITHUB_TOKEN');
    expect(advertised).toContain('MY_CUSTOM_VAR');
  });
});
