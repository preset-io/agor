/**
 * Idempotence guard around the executor's fail-safe terminal patches.
 *
 * Background: the executor has four fail-safe paths that try to mark a
 * task terminal — the top-level catch in `start()`, the SIGTERM/SIGINT
 * shutdown handler, the `uncaughtException` handler, and the
 * `unhandledRejection` handler. The SDK handler (`base-executor`) is the
 * authoritative writer for terminal state and stamps a richer payload
 * (timing, `git_state.sha_at_end`, normalized SDK responses). The
 * fail-safe paths should NOT redundantly emit a second `'patched'`
 * event for the same task.
 *
 * These tests pin the idempotence guard at the source rather than the
 * UI hook that consumes the events.
 */
import { TaskStatus } from '@agor/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgorClient } from './services/feathers-client.js';
import { TERMINAL_STATUSES, tryMarkTaskTerminal } from './terminal-task.js';

type TaskShape = { task_id: string; status: TaskStatus };

interface MockTaskService {
  get: ReturnType<typeof vi.fn<(id: string) => Promise<TaskShape>>>;
  patch: ReturnType<
    typeof vi.fn<(id: string, data: Record<string, unknown>) => Promise<TaskShape>>
  >;
}

function makeClient(currentStatus: TaskStatus): {
  client: AgorClient;
  tasks: MockTaskService;
} {
  const tasks: MockTaskService = {
    get: vi.fn(async (id: string) => ({ task_id: id, status: currentStatus })),
    patch: vi.fn(async (id: string) => ({ task_id: id, status: currentStatus })),
  };
  const client = {
    service: vi.fn((name: string) => {
      if (name !== 'tasks') throw new Error(`unexpected service: ${name}`);
      return tasks;
    }),
  } as unknown as AgorClient;
  return { client, tasks };
}

describe('TERMINAL_STATUSES', () => {
  it('covers every status the executor can transition into terminally', () => {
    expect(TERMINAL_STATUSES.has(TaskStatus.COMPLETED)).toBe(true);
    expect(TERMINAL_STATUSES.has(TaskStatus.FAILED)).toBe(true);
    expect(TERMINAL_STATUSES.has(TaskStatus.STOPPED)).toBe(true);
    // TIMED_OUT is terminal too — permission/input timeout, executor exited.
    // Fail-safe paths must NOT overwrite it with FAILED or STOPPED.
    expect(TERMINAL_STATUSES.has(TaskStatus.TIMED_OUT)).toBe(true);
  });

  it('does not include in-flight statuses', () => {
    expect(TERMINAL_STATUSES.has(TaskStatus.QUEUED)).toBe(false);
    expect(TERMINAL_STATUSES.has(TaskStatus.CREATED)).toBe(false);
    expect(TERMINAL_STATUSES.has(TaskStatus.RUNNING)).toBe(false);
    expect(TERMINAL_STATUSES.has(TaskStatus.STOPPING)).toBe(false);
    expect(TERMINAL_STATUSES.has(TaskStatus.AWAITING_PERMISSION)).toBe(false);
    expect(TERMINAL_STATUSES.has(TaskStatus.AWAITING_INPUT)).toBe(false);
  });
});

describe('tryMarkTaskTerminal', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('patches the task when it is still in-flight', async () => {
    const { client, tasks } = makeClient(TaskStatus.RUNNING);

    await tryMarkTaskTerminal(client, 't1', TaskStatus.FAILED, 'boom');

    expect(tasks.get).toHaveBeenCalledWith('t1');
    expect(tasks.patch).toHaveBeenCalledTimes(1);
    const [id, data] = tasks.patch.mock.calls[0];
    expect(id).toBe('t1');
    expect(data).toMatchObject({
      status: TaskStatus.FAILED,
      error_message: 'boom',
      completed_at: expect.any(String),
    });
  });

  it.each([
    TaskStatus.COMPLETED,
    TaskStatus.FAILED,
    TaskStatus.STOPPED,
    TaskStatus.TIMED_OUT,
  ])('skips the patch when the task is already %s (e.g. inner SDK catch already wrote it)', async (current) => {
    const { client, tasks } = makeClient(current);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await tryMarkTaskTerminal(client, 't1', TaskStatus.FAILED, 'boom');

    expect(tasks.get).toHaveBeenCalledWith('t1');
    expect(tasks.patch).not.toHaveBeenCalled();
  });

  it('omits error_message when no message is supplied (e.g. SIGTERM stop)', async () => {
    const { client, tasks } = makeClient(TaskStatus.RUNNING);

    await tryMarkTaskTerminal(client, 't1', TaskStatus.STOPPED);

    expect(tasks.patch).toHaveBeenCalledTimes(1);
    const [, data] = tasks.patch.mock.calls[0];
    expect(data).not.toHaveProperty('error_message');
    expect(data).toMatchObject({
      status: TaskStatus.STOPPED,
      completed_at: expect.any(String),
    });
  });

  it('swallows network/service errors so the process can still exit', async () => {
    const tasks = {
      get: vi.fn().mockRejectedValue(new Error('socket closed')),
      patch: vi.fn(),
    };
    const client = {
      service: () => tasks,
    } as unknown as AgorClient;
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      tryMarkTaskTerminal(client, 't1', TaskStatus.FAILED, 'boom')
    ).resolves.toBeUndefined();
    expect(tasks.patch).not.toHaveBeenCalled();
  });
});
