import type { Task } from '@agor/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readExecutorTerminationState, reportExecutorQuiescence } from './termination-report.js';

const requestedAt = '2026-07-23T12:00:00.000Z';
const stopping = (executorQuiescedAt?: string) =>
  ({
    task_id: 'task-1',
    status: 'stopping',
    termination_request: {
      cause: 'user_stop',
      requested_at: requestedAt,
      ...(executorQuiescedAt ? { executor_quiesced_at: executorQuiescedAt } : {}),
    },
  }) as Task;

describe('reportExecutorQuiescence', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries transient failure and logs only the first outage', async () => {
    vi.useFakeTimers();
    const report = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new Error('still offline'))
      .mockResolvedValue({});
    const warn = vi.fn();
    const result = reportExecutorQuiescence({
      taskId: 'task-1',
      requestedAt,
      report,
      readTask: async () => stopping(),
      log: vi.fn(),
      warn,
    });

    await vi.runAllTimersAsync();
    await expect(result).resolves.toBeUndefined();
    expect(report).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('quiescence_report_failed'));
  });

  it('accepts durable quiescence when the write response was lost', async () => {
    const report = vi.fn().mockRejectedValue(new Error('response lost'));
    const warn = vi.fn();

    await expect(
      reportExecutorQuiescence({
        taskId: 'task-1',
        requestedAt,
        report,
        readTask: async () => stopping('2026-07-23T12:00:00.100Z'),
        log: vi.fn(),
        warn,
      })
    ).resolves.toBeUndefined();
    expect(report).toHaveBeenCalledOnce();
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not accept quiescence from a different termination request', async () => {
    vi.useFakeTimers();
    const report = vi.fn().mockRejectedValueOnce(new Error('response lost')).mockResolvedValue({});
    const warn = vi.fn();
    const stale = stopping('2026-07-23T12:00:00.100Z');
    stale.termination_request!.requested_at = '2026-07-23T11:59:59.000Z';
    const result = reportExecutorQuiescence({
      taskId: 'task-1',
      requestedAt,
      report,
      readTask: async () => stale,
      log: vi.fn(),
      warn,
    });

    await vi.runAllTimersAsync();
    await expect(result).resolves.toBeUndefined();
    expect(report).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('bounds a hung report and logs only first failure plus exhaustion', async () => {
    vi.useFakeTimers();
    const report = vi.fn(() => new Promise(() => undefined));
    const warn = vi.fn();
    const result = reportExecutorQuiescence({
      taskId: 'task-1',
      requestedAt,
      report,
      readTask: async () => stopping(),
      log: vi.fn(),
      warn,
    }).catch((error) => error as Error);

    await vi.advanceTimersByTimeAsync(20_000);

    await expect(result).resolves.toBeInstanceOf(Error);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenNthCalledWith(1, expect.stringContaining('quiescence_report_failed'));
    expect(warn).toHaveBeenNthCalledWith(2, expect.stringContaining('quiescence_report_exhausted'));
  });
});

describe('readExecutorTerminationState', () => {
  it('falls back to the task read when an older daemon lacks the projection method', async () => {
    const tasks = {
      getTerminationState: vi.fn().mockRejectedValue(
        Object.assign(new Error("Method 'getTerminationState' not allowed"), {
          name: 'MethodNotAllowed',
          code: 405,
        })
      ),
      get: vi.fn().mockResolvedValue({ ...stopping('2026-07-23T12:00:01.000Z'), prompt: 'x' }),
    };

    await expect(readExecutorTerminationState(tasks, 'task-1')).resolves.toEqual({
      task_id: 'task-1',
      status: 'stopping',
      termination_request: {
        cause: 'user_stop',
        requested_at: requestedAt,
        executor_quiesced_at: '2026-07-23T12:00:01.000Z',
      },
    });
    expect(tasks.get).toHaveBeenCalledWith('task-1');
  });

  it('does not fall back on other refusals', async () => {
    const tasks = {
      getTerminationState: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('Forbidden'), { name: 'Forbidden', code: 403 })),
      get: vi.fn(),
    };

    await expect(readExecutorTerminationState(tasks, 'task-1')).rejects.toMatchObject({
      code: 403,
    });
    expect(tasks.get).not.toHaveBeenCalled();
  });
});
