import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createRuntimeAwareTasksService,
  createRuntimeAwareTasksStreamingService,
  executeToolTask,
  installProviderConnection,
  resolveApiKeyForTask,
} from './base-executor.js';

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

describe('runtime-aware service wrappers', () => {
  it('preserves tool labels between start and complete streaming events', async () => {
    const pulse = vi.fn();
    const create = vi.fn(async () => ({}));
    const service = createRuntimeAwareTasksStreamingService({ create }, { pulse });

    await service.create({
      event: 'tool:start',
      data: {
        tool_use_id: 'tool-1',
        tool_name: 'Bash',
      },
    });
    await service.create({
      event: 'tool:complete',
      data: {
        tool_use_id: 'tool-1',
      },
    });

    expect(pulse).toHaveBeenNthCalledWith(1, {
      kind: 'tool.started',
      id: 'tool-1',
      label: 'Bash',
    });
    expect(pulse).toHaveBeenNthCalledWith(2, {
      kind: 'tool.finished',
      id: 'tool-1',
      label: 'Bash',
    });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('emits permission wait pulses without dropping the original task service surface', async () => {
    const pulse = vi.fn();
    const patch = vi.fn(async () => ({}));
    const emit = vi.fn();
    const service = createRuntimeAwareTasksService(
      {
        get: vi.fn(async () => ({})),
        patch,
        emit,
      },
      { pulse }
    );

    await service.patch('task-1', { status: 'awaiting_permission' });
    service.emit('task.cancelled', { task_id: 'task-1' });

    expect(pulse).toHaveBeenCalledWith({ kind: 'permission.wait_started', id: 'task-1' });
    expect(patch).toHaveBeenCalledWith('task-1', { status: 'awaiting_permission' });
    expect(emit).toHaveBeenCalledWith('task.cancelled', { task_id: 'task-1' });
  });
});

describe('executeToolTask Stop retirement', () => {
  it('does not write FAILED state or an error message when an SDK rejects after abort', async () => {
    const savedEnv = { ...process.env };
    const abortController = new AbortController();
    abortController.abort();
    const taskPatch = vi.fn(async () => ({}));
    const messageCreate = vi.fn(async () => ({}));
    const runtime = { pulse: vi.fn(), flush: vi.fn(async () => true) };
    const genericService = {
      create: vi.fn(async () => ({})),
      emit: vi.fn(),
      find: vi.fn(async () => []),
      get: vi.fn(async () => ({})),
      patch: vi.fn(async () => ({})),
    };
    const client = {
      service: vi.fn((name: string) => {
        if (name === 'sessions') {
          return { ...genericService, get: vi.fn(async () => ({ branch_id: undefined })) };
        }
        if (name === 'config/resolve-api-key') {
          return {
            create: vi.fn(async () => ({ source: 'native', useNativeAuth: true })),
          };
        }
        if (name === 'tasks') return { ...genericService, patch: taskPatch };
        if (name === 'messages') return { ...genericService, create: messageCreate };
        return genericService;
      }),
    };
    const tool = {
      executePromptWithStreaming: vi.fn(async () => {
        throw new Error('SDK aborted');
      }),
      stopTask: vi.fn(async () => ({ success: true })),
    };

    try {
      await expect(
        executeToolTask({
          client: client as never,
          sessionId: 'session-1' as never,
          taskId: 'task-1' as never,
          prompt: 'test Stop',
          abortController,
          apiKeyEnvVar: 'ANTHROPIC_API_KEY',
          toolName: 'claude-code',
          runtime,
          createTool: () => tool as never,
        })
      ).resolves.toBeUndefined();

      expect(tool.stopTask).toHaveBeenCalledOnce();
      expect(taskPatch).not.toHaveBeenCalled();
      expect(messageCreate).not.toHaveBeenCalled();
      expect(runtime.flush).not.toHaveBeenCalled();
    } finally {
      for (const key of Object.keys(process.env)) {
        if (!(key in savedEnv)) delete process.env[key];
      }
      Object.assign(process.env, savedEnv);
    }
  });
});
