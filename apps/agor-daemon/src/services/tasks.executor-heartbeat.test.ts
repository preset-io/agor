import { TaskStatus } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { TasksService } from './tasks';

describe('TasksService executor heartbeat helpers', () => {
  it('fails lost heartbeat tasks and marks the session failed without draining its queue', async () => {
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
    const sessionsPatch = vi.fn().mockResolvedValue(undefined);
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

    const result = await service.failForLostHeartbeat(
      taskId,
      {
        completed_at: '2026-01-01T00:00:05.000Z',
        error_message: 'Executor heartbeat lost',
      },
      {
        user: { user_id: '018f0000-0000-7000-8000-000000000009' },
      }
    );

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
    expect(sessionsPatch).toHaveBeenCalledWith(
      sessionId,
      { status: 'failed', ready_for_prompt: true },
      expect.objectContaining({
        user: { user_id: '018f0000-0000-7000-8000-000000000009' },
      })
    );
    expect(triggerQueueProcessing).not.toHaveBeenCalled();
  });

  it('does not let a late terminal executor patch rewrite a heartbeat failure', async () => {
    const taskId = '018f0000-0000-7000-8000-000000000003';
    const failedTask = {
      task_id: taskId,
      session_id: '018f0000-0000-7000-8000-000000000004',
      status: TaskStatus.FAILED,
      created_at: '2026-01-01T00:00:00.000Z',
      completed_at: '2026-01-01T00:00:05.000Z',
      error_message: 'Executor heartbeat lost',
    };
    const service = Object.create(TasksService.prototype) as TasksService & {
      get: ReturnType<typeof vi.fn>;
      repository: { update: ReturnType<typeof vi.fn> };
      id: string;
      emit: ReturnType<typeof vi.fn>;
    };
    service.get = vi.fn().mockResolvedValue(failedTask);
    service.repository = { update: vi.fn() };
    service.id = 'task_id';
    service.emit = vi.fn();

    const result = await service.patch(taskId, {
      status: TaskStatus.COMPLETED,
      completed_at: '2026-01-01T00:00:06.000Z',
    });

    expect(result).toBe(failedTask);
    expect(service.repository.update).not.toHaveBeenCalled();
    expect(service.emit).not.toHaveBeenCalled();
  });
});
