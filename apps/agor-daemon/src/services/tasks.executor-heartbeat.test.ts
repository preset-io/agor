import { TaskStatus } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { TasksService } from './tasks';

describe('TasksService executor heartbeat helpers', () => {
  it('fails lost heartbeat tasks without idling the session or draining its queue', async () => {
    const taskId = '018f0000-0000-7000-8000-000000000001';
    const sessionId = '018f0000-0000-7000-8000-000000000002';
    const currentTask = {
      task_id: taskId,
      session_id: sessionId,
      status: TaskStatus.RUNNING,
      created_at: '2026-01-01T00:00:00.000Z',
    };
    const failedTask = {
      ...currentTask,
      status: TaskStatus.FAILED,
      completed_at: '2026-01-01T00:00:05.000Z',
      error_message: 'Executor heartbeat lost',
    };
    const sessionsPatch = vi.fn();
    const triggerQueueProcessing = vi.fn();
    const service = Object.create(TasksService.prototype) as TasksService & {
      app: unknown;
      get: ReturnType<typeof vi.fn>;
      repository: { update: ReturnType<typeof vi.fn> };
      id: string;
      emit: ReturnType<typeof vi.fn>;
    };
    service.get = vi.fn().mockResolvedValue(currentTask);
    service.repository = { update: vi.fn().mockResolvedValue(failedTask) };
    service.id = 'task_id';
    service.emit = vi.fn();
    service.app = {
      service: (name: string) => {
        if (name === 'sessions') {
          return {
            get: vi.fn().mockResolvedValue({
              session_id: sessionId,
              status: 'running',
              tasks: [taskId],
            }),
            patch: sessionsPatch,
            triggerQueueProcessing,
          };
        }
        throw new Error(`unexpected service ${name}`);
      },
    };

    const result = await service.failForLostHeartbeat(taskId, {
      completed_at: '2026-01-01T00:00:05.000Z',
      error_message: 'Executor heartbeat lost',
    });

    expect(result).toMatchObject({
      task_id: '018f0000-0000-7000-8000-000000000001',
      status: TaskStatus.FAILED,
    });
    expect(service.repository.update).toHaveBeenCalledWith(taskId, {
      status: TaskStatus.FAILED,
      completed_at: '2026-01-01T00:00:05.000Z',
      error_message: 'Executor heartbeat lost',
      duration_ms: 5000,
    });
    expect(sessionsPatch).not.toHaveBeenCalled();
    expect(triggerQueueProcessing).not.toHaveBeenCalled();
  });
});
