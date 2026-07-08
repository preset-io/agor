import { resolveApiKey } from '@agor/core/config';
import { TaskRuntimePhase, TaskStatus } from '@agor/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { executeToolTask, resolveApiKeyForTask } from './base-executor.js';

vi.mock('@agor/core/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agor/core/config')>();
  return {
    ...actual,
    resolveApiKey: vi.fn(),
  };
});

vi.mock('../../git/index.js', () => ({
  getCurrentBranch: vi.fn(async () => 'test-branch'),
  getGitState: vi.fn(async () => 'abc123'),
}));

vi.mock('./git-safe-directory.js', () => ({
  configureSessionGitSafeDirectories: vi.fn(async () => undefined),
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

describe('executeToolTask runtime vitals failure handling', () => {
  it('writes terminal failed vitals when setup fails after sdk_starting', async () => {
    const taskPatches: Array<{ id: string; data: Record<string, unknown> }> = [];
    const messages: Array<Record<string, unknown>> = [];
    const client = {
      service(name: string) {
        if (name === 'tasks') {
          return {
            get: vi.fn(async (id: string) => ({ task_id: id })),
            emit: vi.fn(),
            patch: vi.fn(async (id: string, data: Record<string, unknown>) => {
              taskPatches.push({ id, data });
              return { task_id: id, ...data };
            }),
          };
        }
        if (name === 'sessions') {
          return {
            get: vi.fn(async () => ({ branch_id: 'branch-1', git_state: {} })),
            patch: vi.fn(async () => ({})),
          };
        }
        if (name === 'branches') {
          return { get: vi.fn(async () => ({ path: '/tmp/agor-test-branch' })) };
        }
        if (name === 'config/resolve-api-key') {
          return {
            create: vi.fn(async () => ({
              apiKey: undefined,
              source: 'native',
              useNativeAuth: true,
            })),
          };
        }
        if (name === 'messages') {
          return {
            find: vi.fn(async () => ({ total: 0 })),
            create: vi.fn(async (data: Record<string, unknown>) => {
              messages.push(data);
              return data;
            }),
          };
        }
        if (name === '/tasks/streaming') {
          return { create: vi.fn(async (data: Record<string, unknown>) => data) };
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
        abortController: new AbortController(),
        apiKeyEnvVar: 'OPENAI_API_KEY',
        toolName: 'codex' as never,
        createTool: () => {
          throw new Error('tool factory failed');
        },
      })
    ).rejects.toThrow('tool factory failed');

    expect(taskPatches[0]).toMatchObject({
      id: 'task-1',
      data: {
        runtime_vitals: expect.objectContaining({ phase: TaskRuntimePhase.SDK_STARTING }),
      },
    });
    expect(taskPatches).toContainEqual(
      expect.objectContaining({
        id: 'task-1',
        data: expect.objectContaining({
          git_state: { ref_at_start: 'test-branch', sha_at_start: 'abc123' },
        }),
      })
    );
    expect(taskPatches).toContainEqual(
      expect.objectContaining({
        id: 'task-1',
        data: expect.objectContaining({
          status: TaskStatus.FAILED,
          error_message: 'tool factory failed',
          runtime_vitals: expect.objectContaining({ phase: TaskRuntimePhase.FAILED }),
        }),
      })
    );
    expect(messages[0]).toMatchObject({
      task_id: 'task-1',
      role: 'system',
      content: 'tool factory failed',
    });
  });

  it('does not create fallback system-error messages when a stale failure patch is ignored', async () => {
    const taskPatches: Array<{ id: string; data: Record<string, unknown> }> = [];
    const messages: Array<Record<string, unknown>> = [];
    const client = {
      service(name: string) {
        if (name === 'tasks') {
          return {
            get: vi.fn(async (id: string) => ({ task_id: id })),
            emit: vi.fn(),
            patch: vi.fn(async (id: string, data: Record<string, unknown>) => {
              taskPatches.push({ id, data });
              if (data.status === TaskStatus.FAILED) {
                return {
                  task_id: id,
                  status: TaskStatus.RUNNING,
                  runtime_patch_ignored: true,
                  runtime_patch_ignored_reason: 'stale attempt old (current new)',
                };
              }
              return { task_id: id, ...data };
            }),
          };
        }
        if (name === 'sessions') {
          return {
            get: vi.fn(async () => ({ branch_id: 'branch-1', git_state: {} })),
            patch: vi.fn(async () => ({})),
          };
        }
        if (name === 'branches') {
          return { get: vi.fn(async () => ({ path: '/tmp/agor-test-branch' })) };
        }
        if (name === 'config/resolve-api-key') {
          return {
            create: vi.fn(async () => ({
              apiKey: undefined,
              source: 'native',
              useNativeAuth: true,
            })),
          };
        }
        if (name === 'messages') {
          return {
            find: vi.fn(async () => ({ total: 0 })),
            create: vi.fn(async (data: Record<string, unknown>) => {
              messages.push(data);
              return data;
            }),
          };
        }
        if (name === '/tasks/streaming') {
          return { create: vi.fn(async (data: Record<string, unknown>) => data) };
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
        abortController: new AbortController(),
        apiKeyEnvVar: 'OPENAI_API_KEY',
        toolName: 'codex' as never,
        createTool: () => {
          throw new Error('tool factory failed');
        },
      })
    ).rejects.toThrow('tool factory failed');

    expect(taskPatches).toContainEqual(
      expect.objectContaining({
        id: 'task-1',
        data: expect.objectContaining({
          status: TaskStatus.FAILED,
          error_message: 'tool factory failed',
        }),
      })
    );
    expect(messages).toHaveLength(0);
  });
});
