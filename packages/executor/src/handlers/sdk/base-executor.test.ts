import { resolveApiKey } from '@agor/core/config';
import { MessageRole, TaskStatus } from '@agor/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  attachRepositoryProgressReporting,
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
