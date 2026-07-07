import { resolveApiKey } from '@agor/core/config';
import { MessageRole, type Task, TaskStatus } from '@agor/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  attachRepositoryProgressReporting,
  executeToolTask,
  resolveApiKeyForTask,
  withProgressCallbacks,
} from './base-executor.js';

vi.mock('@agor/core/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agor/core/config')>();
  return {
    ...actual,
    resolveApiKey: vi.fn(),
  };
});

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
  beforeEach(() => {
    vi.mocked(resolveApiKey).mockReset();
  });

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

    expect(resolveApiKey).not.toHaveBeenCalled();
  });

  it('keeps local fallback for legacy or unavailable daemon resolution', async () => {
    vi.mocked(resolveApiKey).mockReturnValue({
      apiKey: 'local-key',
      source: 'env',
      useNativeAuth: false,
    });

    await expect(
      resolveApiKeyForTask(
        'OPENAI_API_KEY',
        makeClient(new Error('fetch failed')),
        'task-1' as never,
        'codex' as never
      )
    ).resolves.toMatchObject({ apiKey: 'local-key', source: 'env' });

    expect(resolveApiKey).toHaveBeenCalledWith('OPENAI_API_KEY', {});
  });
});

describe('SDK executor progress reporting', () => {
  function makeProgressReporter() {
    return {
      markActivity: vi.fn(),
      markAgentProgress: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
    };
  }

  it('does not treat local user-message creation as agent progress', async () => {
    const progress = makeProgressReporter();
    const repos = {
      messages: {
        create: vi.fn(async (message) => message),
      },
      messagesService: {
        create: vi.fn(async (message) => message),
      },
      tasksStreamingService: {
        create: vi.fn(async (event) => event),
      },
      tasksService: {
        patch: vi.fn(async (_id, patch) => patch),
      },
    };

    attachRepositoryProgressReporting(repos as never, progress);

    await repos.messagesService.create({
      role: MessageRole.USER,
      type: 'user',
      content: 'hello',
    });

    expect(progress.markActivity).toHaveBeenCalledWith('message-service:create:user');
    expect(progress.markAgentProgress).not.toHaveBeenCalled();
  });

  it('treats assistant message creation as agent progress for non-streaming paths', async () => {
    const progress = makeProgressReporter();
    const repos = {
      messages: {
        create: vi.fn(async (message) => message),
      },
      messagesService: {
        create: vi.fn(async (message) => message),
      },
      tasksStreamingService: {
        create: vi.fn(async (event) => event),
      },
      tasksService: {
        patch: vi.fn(async (_id, patch) => patch),
      },
    };

    attachRepositoryProgressReporting(repos as never, progress);

    await repos.messages.create({
      role: MessageRole.ASSISTANT,
      type: 'assistant',
      content: 'done',
    });

    expect(progress.markAgentProgress).toHaveBeenCalledWith('message:create:assistant');
  });

  it('treats task-stream and streaming callback events as agent progress', async () => {
    const progress = makeProgressReporter();
    const repos = {
      messages: {
        create: vi.fn(async (message) => message),
      },
      messagesService: {
        create: vi.fn(async (message) => message),
      },
      tasksStreamingService: {
        create: vi.fn(async (event) => event),
      },
      tasksService: {
        patch: vi.fn(async (_id, patch) => patch),
      },
    };

    attachRepositoryProgressReporting(repos as never, progress);
    await repos.tasksStreamingService.create({ event: 'tool:start', data: {} });

    const callbacks = withProgressCallbacks(
      {
        onStreamStart: vi.fn(async () => {}),
        onStreamChunk: vi.fn(async () => {}),
        onStreamEnd: vi.fn(async () => {}),
        onStreamError: vi.fn(async () => {}),
      },
      progress
    );
    await callbacks.onStreamStart('message-1' as never, {
      session_id: 'session-1' as never,
      role: MessageRole.ASSISTANT,
      timestamp: new Date().toISOString(),
    });

    expect(progress.markAgentProgress).toHaveBeenCalledWith('task-stream:tool:start');
    expect(progress.markAgentProgress).toHaveBeenCalledWith('stream:start');
  });

  it('pauses first-progress timeout while permission owns the wait', async () => {
    const progress = makeProgressReporter();
    const repos = {
      messages: {
        create: vi.fn(async (message) => message),
      },
      messagesService: {
        create: vi.fn(async (message) => message),
      },
      tasksStreamingService: {
        create: vi.fn(async (event) => event),
      },
      tasksService: {
        patch: vi.fn(async (_id, patch) => patch),
      },
    };

    attachRepositoryProgressReporting(repos as never, progress);

    await repos.tasksService.patch('task-1', { status: TaskStatus.AWAITING_PERMISSION });
    await repos.tasksService.patch('task-1', { status: TaskStatus.RUNNING });

    expect(progress.pause).toHaveBeenCalledWith('task:awaiting_permission');
    expect(progress.resume).toHaveBeenCalledWith('task:running');
  });
});

describe('executeToolTask first-progress watchdog', () => {
  it('marks the task failed with watchdog metadata when no first agent event arrives', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-20T00:00:00.000Z'));
    const previousInterval = process.env.AGOR_AGENT_PROGRESS_WATCHDOG_INTERVAL_MS;
    process.env.AGOR_AGENT_PROGRESS_WATCHDOG_INTERVAL_MS = '100';

    try {
      const taskPatches: Partial<Task>[] = [];
      const createdMessages: unknown[] = [];
      const services: Record<string, unknown> = {
        'config/resolve-api-key': {
          create: vi.fn(async () => ({ apiKey: '', source: 'env', useNativeAuth: true })),
        },
        sessions: {
          get: vi.fn(async () => ({ session_id: 'session-1' })),
          patch: vi.fn(async (_id, patch) => patch),
        },
        messages: {
          find: vi.fn(async () => ({ total: 0, data: [] })),
          create: vi.fn(async (message) => {
            createdMessages.push(message);
            return message;
          }),
        },
        tasks: {
          patch: vi.fn(async (_id, patch) => {
            taskPatches.push(patch as Partial<Task>);
            return patch;
          }),
        },
        '/tasks/streaming': {
          create: vi.fn(async (event) => event),
        },
      };
      const client = {
        service: vi.fn((name: string) => {
          const service = services[name];
          if (!service) throw new Error(`unexpected service ${name}`);
          return service;
        }),
      } as never;

      const stopTask = vi.fn(async () => ({ success: true }));
      const execution = executeToolTask({
        client,
        sessionId: 'session-1' as never,
        taskId: 'task-1' as never,
        prompt: 'hello',
        abortController: new AbortController(),
        apiKeyEnvVar: 'OPENAI_API_KEY',
        toolName: 'codex',
        resolvedConfig: { execution: { agent_first_progress_timeout_ms: 1000 } },
        createTool: () => ({
          stopTask,
          executePromptWithStreaming: vi.fn(
            (_sessionId, _prompt, _taskId, _permissionMode, _callbacks, abortController) =>
              new Promise<never>((_resolve, reject) => {
                abortController?.signal.addEventListener('abort', () => {
                  reject(new Error('aborted'));
                });
              })
          ),
        }),
      });

      const executionExpectation = expect(execution).rejects.toThrow(
        'no first meaningful agent event'
      );
      await vi.advanceTimersByTimeAsync(1000);
      await executionExpectation;
      expect(stopTask).toHaveBeenCalledWith('session-1', 'task-1');
      expect(taskPatches).toContainEqual(
        expect.objectContaining({
          status: 'failed',
          error_message: expect.stringContaining('no first meaningful agent event'),
          metadata: {
            first_agent_progress_watchdog: expect.objectContaining({
              status: 'stalled',
              tool: 'codex',
              watchdog_started_at: '2026-06-20T00:00:00.000Z',
              timeout_ms: 1000,
            }),
          },
        })
      );
      expect(createdMessages).toContainEqual(
        expect.objectContaining({
          role: MessageRole.SYSTEM,
          content: expect.stringContaining('no first meaningful agent event'),
        })
      );
    } finally {
      if (previousInterval === undefined) {
        delete process.env.AGOR_AGENT_PROGRESS_WATCHDOG_INTERVAL_MS;
      } else {
        process.env.AGOR_AGENT_PROGRESS_WATCHDOG_INTERVAL_MS = previousInterval;
      }
      vi.useRealTimers();
    }
  });
});
