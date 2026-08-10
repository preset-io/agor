import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RuntimeCleanupError } from '../../terminal-task.js';
import {
  createStreamingCallbacks,
  executeToolTask,
  installProviderConnection,
  resolveApiKeyForTask,
} from './base-executor.js';

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
    executorSessionToken: 'executor-jwt',
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

function makeExecutionClient() {
  const taskPatch = vi.fn().mockResolvedValue(undefined);
  const messageCreate = vi.fn().mockResolvedValue(undefined);
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
      if (name === 'tasks') return { patch: taskPatch };
      if (name === 'messages') {
        return {
          find: vi.fn().mockResolvedValue({ total: 0, data: [] }),
          create: messageCreate,
        };
      }
      if (name === '/tasks/streaming') return {};
      throw new Error(`unexpected service ${name}`);
    },
  } as never;
  return { client, messageCreate, taskPatch };
}

describe('streaming callback settlement', () => {
  it('waits for callbacks that an adapter intentionally did not await', async () => {
    let release!: () => void;
    const create = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    const callbacks = createStreamingCallbacks(
      { service: () => ({ create }) } as never,
      'codex',
      'session-1' as never
    );

    void callbacks.onStreamChunk('message-1' as never, 'partial');
    const flush = callbacks.flushPending();
    let flushed = false;
    void flush.then(() => {
      flushed = true;
    });

    await Promise.resolve();
    expect(flushed).toBe(false);
    release();
    await flush;

    expect(flushed).toBe(true);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ event: 'streaming:chunk' }));
  });
});

describe('resolveApiKeyForTask', () => {
  it('sends the executor session token as explicit task-scoped proof', async () => {
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
      executorSessionToken: 'executor-jwt',
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

describe('executeToolTask credential preflight', () => {
  it('returns an explicit missing-credential outcome before invoking the tool', async () => {
    const taskPatch = vi.fn().mockResolvedValue(undefined);
    const messageCreate = vi.fn().mockResolvedValue(undefined);
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

    const outcome = await executeToolTask({
      client,
      sessionId: 'session-1' as never,
      taskId: 'task-1' as never,
      prompt: 'hello',
      abortController: new AbortController(),
      apiKeyEnvVar: 'GEMINI_API_KEY',
      toolName: 'gemini',
      createTool,
    });

    expect(createTool).not.toHaveBeenCalled();
    expect(taskPatch).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({
      result: 'failure',
      failureCause: 'runtime_failure',
      taskPatch: {
        error_message: expect.stringContaining('No scoped gemini credential'),
      },
      error: expect.objectContaining({
        message: expect.stringContaining('No scoped gemini credential'),
      }),
    });
    expect(messageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: {
          is_task_failure: true,
          is_missing_credential_failure: true,
        },
      })
    );
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

  it('returns completion data without writing terminal task state', async () => {
    const { client, taskPatch } = makeExecutionClient();
    const executePromptWithStreaming = vi.fn().mockResolvedValue({
      userMessageId: 'user-message',
      assistantMessageIds: ['assistant-message'],
      wasStopped: false,
      hadError: false,
      model: 'test-model',
    });
    const outcome = await executeToolTask({
      client,
      sessionId: 'session-1' as never,
      taskId: 'task-1' as never,
      prompt: 'hello',
      abortController: new AbortController(),
      apiKeyEnvVar: 'GEMINI_API_KEY',
      toolName: 'gemini',
      createTool: () => ({ executePromptWithStreaming }),
    });

    expect(outcome).toMatchObject({
      result: 'success',
      taskPatch: { model: 'test-model' },
    });
    expect(taskPatch).not.toHaveBeenCalled();
  });

  it('normalizes the configured Copilot SDK deadline', async () => {
    const { client, messageCreate } = makeExecutionClient();
    const outcome = await executeToolTask({
      client,
      sessionId: 'session-1' as never,
      taskId: 'task-1' as never,
      prompt: 'hello',
      abortController: new AbortController(),
      apiKeyEnvVar: 'COPILOT_GITHUB_TOKEN',
      toolName: 'copilot',
      createTool: () => ({
        executePromptWithStreaming: vi
          .fn()
          .mockRejectedValue(new Error('Timeout after 14400000ms waiting for session.idle')),
      }),
    });

    expect(outcome).toMatchObject({
      result: 'failure',
      failureCause: 'agentic_tool_timeout',
    });
    expect(messageCreate).toHaveBeenCalledOnce();
  });

  it('escalates cleanup uncertainty instead of returning a terminal outcome', async () => {
    const { client, messageCreate } = makeExecutionClient();

    await expect(
      executeToolTask({
        client,
        sessionId: 'session-1' as never,
        taskId: 'task-1' as never,
        prompt: 'hello',
        abortController: new AbortController(),
        apiKeyEnvVar: 'COPILOT_GITHUB_TOKEN',
        toolName: 'copilot',
        createTool: () => ({
          executePromptWithStreaming: vi
            .fn()
            .mockRejectedValue(new RuntimeCleanupError('Copilot', new Error('stop failed'))),
        }),
      })
    ).rejects.toThrow('Copilot runtime cleanup failed');

    expect(messageCreate).not.toHaveBeenCalled();
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
