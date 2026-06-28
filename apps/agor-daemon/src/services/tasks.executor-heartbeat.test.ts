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
        suppressTerminalQueueProcessing: true,
      })
    );
    expect(triggerQueueProcessing).not.toHaveBeenCalled();
  });

  it('does not mark session failed when heartbeat failure loses to normal completion', async () => {
    const taskId = '018f0000-0000-7000-8000-000000000003';
    const completedTask = {
      task_id: taskId,
      session_id: '018f0000-0000-7000-8000-000000000004',
      status: TaskStatus.COMPLETED,
      created_at: '2026-01-01T00:00:00.000Z',
      completed_at: '2026-01-01T00:00:04.000Z',
    };
    const sessionsPatch = vi.fn();
    const service = Object.create(TasksService.prototype) as TasksService & {
      app: unknown;
      get: ReturnType<typeof vi.fn>;
      repository: { update: ReturnType<typeof vi.fn> };
      id: string;
      emit: ReturnType<typeof vi.fn>;
    };
    service.get = vi.fn().mockResolvedValue(completedTask);
    service.repository = { update: vi.fn() };
    service.id = 'task_id';
    service.emit = vi.fn();
    service.app = {
      service: (name: string) => {
        if (name === 'sessions') {
          return { patch: sessionsPatch };
        }
        throw new Error(`unexpected service ${name}`);
      },
    };

    const result = await service.failForLostHeartbeat(taskId, {
      completed_at: '2026-01-01T00:00:05.000Z',
      error_message: 'Executor heartbeat lost',
    });

    expect(result).toBe(completedTask);
    expect(service.repository.update).not.toHaveBeenCalled();
    expect(sessionsPatch).not.toHaveBeenCalled();
  });

  it('does not mark session failed when heartbeat failure loses to an earlier task failure', async () => {
    const taskId = '018f0000-0000-7000-8000-000000000005';
    const failedTask = {
      task_id: taskId,
      session_id: '018f0000-0000-7000-8000-000000000006',
      status: TaskStatus.FAILED,
      created_at: '2026-01-01T00:00:00.000Z',
      completed_at: '2026-01-01T00:00:04.000Z',
      error_message: 'Executor exited with code 1',
    };
    const sessionsPatch = vi.fn();
    const service = Object.create(TasksService.prototype) as TasksService & {
      app: unknown;
      get: ReturnType<typeof vi.fn>;
      repository: { update: ReturnType<typeof vi.fn> };
      id: string;
      emit: ReturnType<typeof vi.fn>;
    };
    service.get = vi.fn().mockResolvedValue(failedTask);
    service.repository = { update: vi.fn() };
    service.id = 'task_id';
    service.emit = vi.fn();
    service.app = {
      service: (name: string) => {
        if (name === 'sessions') {
          return { patch: sessionsPatch };
        }
        throw new Error(`unexpected service ${name}`);
      },
    };

    const result = await service.failForLostHeartbeat(taskId, {
      completed_at: '2026-01-01T00:00:05.000Z',
      error_message: 'Executor heartbeat lost',
    });

    expect(result).toBe(failedTask);
    expect(service.repository.update).not.toHaveBeenCalled();
    expect(sessionsPatch).not.toHaveBeenCalled();
  });

  it('does not let a late terminal executor patch rewrite a heartbeat failure', async () => {
    const taskId = '018f0000-0000-7000-8000-000000000007';
    const failedTask = {
      task_id: taskId,
      session_id: '018f0000-0000-7000-8000-000000000008',
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

  it('supports administrative stopped patches without callbacks or queue draining', async () => {
    const taskId = '018f0000-0000-7000-8000-000000000010';
    const sessionId = '018f0000-0000-7000-8000-000000000011';
    const currentTask = {
      task_id: taskId,
      session_id: sessionId,
      status: TaskStatus.RUNNING,
      created_at: '2026-01-01T00:00:00.000Z',
      started_at: '2026-01-01T00:00:00.000Z',
    };
    const stoppedTask = {
      ...currentTask,
      status: TaskStatus.STOPPED,
      completed_at: '2026-01-01T00:00:05.000Z',
      duration_ms: 5000,
    };
    const sessionsPatch = vi.fn();
    const triggerQueueProcessing = vi.fn();
    const dispatchCompletionCallbacks = vi.fn();
    const service = Object.create(TasksService.prototype) as TasksService & {
      app: unknown;
      get: ReturnType<typeof vi.fn>;
      repository: { update: ReturnType<typeof vi.fn> };
      id: string;
      emit: ReturnType<typeof vi.fn>;
      dispatchCompletionCallbacks: ReturnType<typeof vi.fn>;
    };
    service.get = vi.fn().mockResolvedValue(currentTask);
    service.repository = { update: vi.fn().mockResolvedValue(stoppedTask) };
    service.id = 'task_id';
    service.emit = vi.fn();
    service.dispatchCompletionCallbacks = dispatchCompletionCallbacks;
    service.app = {
      service: (name: string) => {
        if (name === 'sessions') {
          return {
            get: vi.fn().mockResolvedValue({
              session_id: sessionId,
              status: 'running',
              ready_for_prompt: false,
              tasks: [taskId],
            }),
            patch: sessionsPatch,
            triggerQueueProcessing,
          };
        }
        if (name === 'branches') {
          return { get: vi.fn() };
        }
        throw new Error(`unexpected service ${name}`);
      },
    };

    const result = await service.patch(
      taskId,
      {
        status: TaskStatus.STOPPED,
        completed_at: '2026-01-01T00:00:05.000Z',
      },
      {
        suppressTerminalQueueProcessing: true,
        suppressCompletionCallbacks: true,
      }
    );

    expect(result).toMatchObject({ task_id: taskId, status: TaskStatus.STOPPED });
    expect(dispatchCompletionCallbacks).not.toHaveBeenCalled();
    expect(sessionsPatch).not.toHaveBeenCalled();
    expect(triggerQueueProcessing).not.toHaveBeenCalled();
  });

  it('marks directly stopped tasks promptable and triggers queue processing', async () => {
    const taskId = '018f0000-0000-7000-8000-000000000030';
    const sessionId = '018f0000-0000-7000-8000-000000000031';
    const currentTask = {
      task_id: taskId,
      session_id: sessionId,
      status: TaskStatus.RUNNING,
      created_at: '2026-01-01T00:00:00.000Z',
      started_at: '2026-01-01T00:00:00.000Z',
    };
    const stoppedTask = {
      ...currentTask,
      status: TaskStatus.STOPPED,
      completed_at: '2026-01-01T00:00:05.000Z',
      duration_ms: 5000,
    };
    const sessionsPatch = vi.fn().mockResolvedValue({
      session_id: sessionId,
      status: 'idle',
      ready_for_prompt: true,
      tasks: [taskId],
    });
    const triggerQueueProcessing = vi.fn().mockResolvedValue(undefined);
    const service = Object.create(TasksService.prototype) as TasksService & {
      app: unknown;
      get: ReturnType<typeof vi.fn>;
      repository: { update: ReturnType<typeof vi.fn> };
      id: string;
      emit: ReturnType<typeof vi.fn>;
      dispatchCompletionCallbacks: ReturnType<typeof vi.fn>;
    };
    service.get = vi.fn().mockResolvedValue(currentTask);
    service.repository = { update: vi.fn().mockResolvedValue(stoppedTask) };
    service.id = 'task_id';
    service.emit = vi.fn();
    service.dispatchCompletionCallbacks = vi.fn();
    service.app = {
      service: (name: string) => {
        if (name === 'sessions') {
          return {
            get: vi.fn().mockResolvedValue({
              session_id: sessionId,
              status: 'running',
              ready_for_prompt: false,
              tasks: [taskId],
            }),
            patch: sessionsPatch,
            triggerQueueProcessing,
          };
        }
        if (name === 'branches') return { get: vi.fn() };
        throw new Error(`unexpected service ${name}`);
      },
    };

    const result = await service.patch(taskId, {
      status: TaskStatus.STOPPED,
      completed_at: '2026-01-01T00:00:05.000Z',
    });

    expect(result).toMatchObject({ task_id: taskId, status: TaskStatus.STOPPED });
    expect(sessionsPatch).toHaveBeenCalledWith(
      sessionId,
      { status: 'idle', ready_for_prompt: true },
      undefined
    );
    expect(service.dispatchCompletionCallbacks).not.toHaveBeenCalled();
    expect(triggerQueueProcessing).toHaveBeenCalledWith(sessionId, undefined);
  });

  it('ignores late executor attempts to revive a stopped task as awaiting permission', async () => {
    const taskId = '018f0000-0000-7000-8000-000000000022';
    const sessionId = '018f0000-0000-7000-8000-000000000023';
    const stoppedTask = {
      task_id: taskId,
      session_id: sessionId,
      status: TaskStatus.STOPPED,
      created_at: '2026-01-01T00:00:00.000Z',
      started_at: '2026-01-01T00:00:00.000Z',
      completed_at: '2026-01-01T00:00:05.000Z',
    };
    const service = Object.create(TasksService.prototype) as TasksService & {
      app: unknown;
      get: ReturnType<typeof vi.fn>;
      repository: { update: ReturnType<typeof vi.fn> };
      id: string;
      emit: ReturnType<typeof vi.fn>;
    };
    service.get = vi.fn().mockResolvedValue(stoppedTask);
    service.repository = { update: vi.fn() };
    service.id = 'task_id';
    service.emit = vi.fn();
    service.app = {
      service: (_name: string) => {
        throw new Error(`unexpected service ${_name}`);
      },
    };

    const result = await service.patch(taskId, {
      status: TaskStatus.AWAITING_PERMISSION,
      last_executor_heartbeat_at: '2026-01-01T00:00:06.000Z',
    });

    expect(result).toBe(stoppedTask);
    expect(service.repository.update).not.toHaveBeenCalled();
    expect(service.emit).not.toHaveBeenCalled();
  });

  it('ignores late executor attempts to revive a stopped task as running', async () => {
    const taskId = '018f0000-0000-7000-8000-000000000020';
    const sessionId = '018f0000-0000-7000-8000-000000000021';
    const stoppedTask = {
      task_id: taskId,
      session_id: sessionId,
      status: TaskStatus.STOPPED,
      created_at: '2026-01-01T00:00:00.000Z',
      started_at: '2026-01-01T00:00:00.000Z',
      completed_at: '2026-01-01T00:00:05.000Z',
    };
    const service = Object.create(TasksService.prototype) as TasksService & {
      app: unknown;
      get: ReturnType<typeof vi.fn>;
      repository: { update: ReturnType<typeof vi.fn> };
      id: string;
      emit: ReturnType<typeof vi.fn>;
    };
    service.get = vi.fn().mockResolvedValue(stoppedTask);
    service.repository = { update: vi.fn() };
    service.id = 'task_id';
    service.emit = vi.fn();
    service.app = {
      service: (_name: string) => {
        throw new Error(`unexpected service ${_name}`);
      },
    };

    const result = await service.patch(taskId, {
      status: TaskStatus.RUNNING,
      last_executor_heartbeat_at: '2026-01-01T00:00:06.000Z',
    });

    expect(result).toBe(stoppedTask);
    expect(service.repository.update).not.toHaveBeenCalled();
    expect(service.emit).not.toHaveBeenCalled();
  });
});
