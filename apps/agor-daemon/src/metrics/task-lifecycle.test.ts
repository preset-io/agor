import type { Task } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { recordTaskSettlement } from './task-lifecycle.js';
import type { DaemonMetrics } from './types.js';

function createMetrics() {
  const increment = vi.fn();
  const metrics = {
    enabled: true,
    increment,
    decrement: vi.fn(),
    gauge: vi.fn(),
    histogram: vi.fn(),
    timing: vi.fn(),
    distribution: vi.fn(),
    startTimer: vi.fn(() => () => 0),
    flush: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  } satisfies DaemonMetrics;
  return { metrics, increment };
}

function settledTask(overrides: Partial<Task> = {}): Task {
  return {
    status: 'completed',
    executor_mode: 'local',
    started_at: '2026-09-01T00:00:00.000Z',
    completed_at: '2026-09-01T00:00:05.000Z',
    ...overrides,
  } as Task;
}

describe('recordTaskSettlement', () => {
  it('counts a background-task timeout separately when the Task carries the flag', () => {
    const { metrics, increment } = createMetrics();

    recordTaskSettlement(metrics, settledTask({ metadata: { background_task_timeout: true } }));

    expect(increment).toHaveBeenCalledWith('task.settlements', 1, {
      status: 'completed',
      mode: 'local',
    });
    expect(increment).toHaveBeenCalledWith('task.background_task_timeout', 1, { mode: 'local' });
  });

  it('does not emit the timeout counter for a normal settlement', () => {
    const { metrics, increment } = createMetrics();

    recordTaskSettlement(metrics, settledTask({ metadata: { source: 'agor' } }));

    expect(increment).toHaveBeenCalledWith('task.settlements', 1, {
      status: 'completed',
      mode: 'local',
    });
    expect(increment.mock.calls.some(([name]) => name === 'task.background_task_timeout')).toBe(
      false
    );
  });
});
