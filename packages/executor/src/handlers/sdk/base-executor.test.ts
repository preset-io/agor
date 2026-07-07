import { resolveApiKey } from '@agor/core/config';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveApiKeyForTask } from './base-executor.js';

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
