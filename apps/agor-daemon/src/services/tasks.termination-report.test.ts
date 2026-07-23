import type { Task } from '@agor/core/types';
import { TaskStatus } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';

const requestExecutorTermination = vi.hoisted(() => vi.fn().mockResolvedValue({}));
vi.mock('../termination-coordinator.js', () => ({
  beginExecutorTermination: vi.fn(),
  requestExecutorTermination,
}));

import { TasksService } from './tasks';

describe('TasksService executor termination report', () => {
  it('persists and publishes quiescence before coordinating asynchronously', async () => {
    const requestedAt = '2026-07-23T12:00:00.000Z';
    const task = {
      task_id: '018f0000-0000-7000-8000-000000000001',
      session_id: '018f0000-0000-7000-8000-000000000002',
      status: TaskStatus.STOPPING,
      termination_request: {
        cause: 'user_stop',
        requested_at: requestedAt,
        executor_quiesced_at: '2026-07-23T12:00:00.125Z',
      },
    } as Task;
    const recordExecutorQuiescence = vi.fn().mockResolvedValue(task);
    const emit = vi.fn();
    const service = Object.create(TasksService.prototype) as TasksService;
    Reflect.set(service, 'taskRepo', { recordExecutorQuiescence });
    Reflect.set(service, 'app', { service: () => ({ emit }) });

    await expect(
      service.reportTerminationComplete({
        task_id: task.task_id,
        requested_at: requestedAt,
      })
    ).resolves.toBe(task);

    expect(recordExecutorQuiescence).toHaveBeenCalledWith({
      task_id: task.task_id,
      requested_at: requestedAt,
    });
    expect(emit).toHaveBeenCalledWith('patched', task, expect.objectContaining({ path: 'tasks' }));
    expect(requestExecutorTermination).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: task.task_id,
        cause: 'user_stop',
        params: expect.objectContaining({ provider: undefined }),
      })
    );
  });
});
