import type { Task } from '@agor/core/types';
import { TaskStatus } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { TasksService } from './tasks';

describe('TasksService termination request publication', () => {
  it('publishes durable state and the task-scoped executor control event', async () => {
    const task = {
      task_id: '018f0000-0000-7000-8000-000000000001',
      session_id: '018f0000-0000-7000-8000-000000000002',
      status: TaskStatus.STOPPING,
      termination_request: {
        cause: 'user_stop',
        requested_at: '2026-07-23T12:00:00.000Z',
      },
    } as Task;
    const claimTermination = vi.fn().mockResolvedValue({ outcome: 'claimed', task });
    const emit = vi.fn();
    const patchSession = vi.fn().mockResolvedValue({});
    const service = Object.create(TasksService.prototype) as TasksService;
    Reflect.set(service, 'taskRepo', { claimTermination });
    Reflect.set(service, 'app', {
      service(path: string) {
        if (path === 'tasks') return { emit };
        if (path === 'sessions') return { patch: patchSession };
        throw new Error(`Unexpected service ${path}`);
      },
    });

    await service.claimTermination({
      taskId: task.task_id,
      cause: 'user_stop',
      errorMessage: 'Stopped by user.',
    });

    expect(emit).toHaveBeenNthCalledWith(
      1,
      'patched',
      task,
      expect.objectContaining({ path: 'tasks', method: 'patch' })
    );
    expect(emit).toHaveBeenNthCalledWith(
      2,
      'termination_requested',
      task,
      expect.objectContaining({ path: 'tasks', method: 'patch' })
    );
    expect(patchSession).toHaveBeenCalledWith(
      task.session_id,
      { status: 'stopping', ready_for_prompt: false },
      expect.objectContaining({ provider: undefined })
    );
  });
});
