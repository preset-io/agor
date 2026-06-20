import { type Task, TaskStatus } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import {
  formatExecutorExitError,
  isTaskStillActiveForExecutorExit,
  markActiveTaskFailedForExecutorExit,
} from './utils/executor-exit-safety-net.js';

describe('executor exit safety net helpers', () => {
  it('centralizes task statuses that should still be repaired on executor exit', () => {
    expect(isTaskStillActiveForExecutorExit({ status: TaskStatus.RUNNING })).toBe(true);
    expect(isTaskStillActiveForExecutorExit({ status: TaskStatus.AWAITING_PERMISSION })).toBe(true);
    expect(isTaskStillActiveForExecutorExit({ status: TaskStatus.AWAITING_INPUT })).toBe(true);
    expect(isTaskStillActiveForExecutorExit({ status: TaskStatus.STOPPING })).toBe(true);
    expect(isTaskStillActiveForExecutorExit({ status: TaskStatus.TIMED_OUT })).toBe(true);

    expect(isTaskStillActiveForExecutorExit({ status: TaskStatus.COMPLETED })).toBe(false);
    expect(isTaskStillActiveForExecutorExit({ status: TaskStatus.FAILED })).toBe(false);
    expect(isTaskStillActiveForExecutorExit({ status: TaskStatus.STOPPED })).toBe(false);
  });

  it('formats executor exit errors with stderr preferred over combined output', () => {
    expect(
      formatExecutorExitError(1, {
        stderrTail: 'stderr says why',
        combinedTail: 'stdout says less',
      })
    ).toContain('stderr says why');
    expect(formatExecutorExitError(null)).toBe('Executor exited unexpectedly with code unknown.');
  });

  it('marks non-latest active tasks failed while suppressing session/queue side effects', async () => {
    const activeTask = {
      task_id: 'task-1',
      status: TaskStatus.RUNNING,
    } as Task;
    const failedTask = {
      ...activeTask,
      status: TaskStatus.FAILED,
      completed_at: '2026-01-01T00:00:05.000Z',
      error_message: 'placeholder',
    } as Task;
    const get = vi.fn().mockResolvedValue(activeTask);
    const patch = vi.fn().mockImplementation((_id, data) =>
      Promise.resolve({
        ...failedTask,
        ...data,
      })
    );
    const service = vi.fn((name: string) => {
      if (name !== 'tasks') throw new Error(`Unexpected service: ${name}`);
      return { get, patch };
    });
    const app = { service } as Parameters<typeof markActiveTaskFailedForExecutorExit>[0]['app'];
    const params = { user: { user_id: 'user-1' } };

    const result = await markActiveTaskFailedForExecutorExit({
      app,
      params,
      taskId: 'task-1',
      code: 1,
      output: {
        stdoutTail: 'out',
        stderrTail: 'raw stderr',
        combinedTail: 'combined',
      },
      suppressTerminalSideEffects: true,
    });

    expect(result).toMatchObject({
      patched: true,
      task: {
        task_id: 'task-1',
        status: TaskStatus.FAILED,
        error_message: expect.stringContaining('raw stderr'),
      },
    });
    expect(get).toHaveBeenCalledWith('task-1', params);
    expect(patch).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        status: TaskStatus.FAILED,
        completed_at: expect.any(String),
        error_message: expect.stringContaining('raw stderr'),
      }),
      expect.objectContaining({
        user: { user_id: 'user-1' },
        suppressTerminalSessionIdle: true,
        suppressTerminalQueueProcessing: true,
      })
    );
  });

  it('reports patched=false when the terminal rewrite guard keeps the existing task', async () => {
    const timedOutTask = {
      task_id: 'task-1',
      status: TaskStatus.TIMED_OUT,
      completed_at: '2026-01-01T00:00:04.000Z',
    } as Task;
    const get = vi.fn().mockResolvedValue(timedOutTask);
    const patch = vi.fn().mockResolvedValue(timedOutTask);
    const service = vi.fn(() => ({ get, patch }));
    const app = { service } as Parameters<typeof markActiveTaskFailedForExecutorExit>[0]['app'];

    const result = await markActiveTaskFailedForExecutorExit({
      app,
      params: {},
      taskId: 'task-1',
      code: 1,
    });

    expect(result).toEqual({ patched: false, task: timedOutTask });
  });

  it('does not patch already-terminal tasks', async () => {
    const terminalTask = {
      task_id: 'task-1',
      status: TaskStatus.COMPLETED,
    } as Task;
    const get = vi.fn().mockResolvedValue(terminalTask);
    const patch = vi.fn();
    const service = vi.fn(() => ({ get, patch }));
    const app = { service } as Parameters<typeof markActiveTaskFailedForExecutorExit>[0]['app'];

    const result = await markActiveTaskFailedForExecutorExit({
      app,
      params: {},
      taskId: 'task-1',
      code: 1,
    });

    expect(result).toEqual({ patched: false, task: terminalTask });
    expect(patch).not.toHaveBeenCalled();
  });
});
