import { TaskStatus } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { TasksService } from './tasks';

function completionHarness(input: {
  currentTask: Record<string, unknown>;
  resultTask: Record<string, unknown>;
  sessionTasks?: string[];
  sessionReadFails?: boolean;
}) {
  const sessionsPatch = vi.fn().mockResolvedValue({ session_id: input.resultTask.session_id });
  const triggerQueueProcessing = vi.fn().mockResolvedValue(undefined);
  const service = Object.create(TasksService.prototype) as TasksService & {
    app: unknown;
    get: ReturnType<typeof vi.fn>;
    repository: { update: ReturnType<typeof vi.fn> };
    id: string;
    emit: ReturnType<typeof vi.fn>;
  };
  service.get = vi.fn().mockResolvedValue(input.currentTask);
  service.repository = { update: vi.fn().mockResolvedValue(input.resultTask) };
  service.id = 'task_id';
  service.emit = vi.fn();
  (service as unknown as { taskRepo: { settleTermination: ReturnType<typeof vi.fn> } }).taskRepo = {
    settleTermination: vi
      .fn()
      .mockResolvedValue({ outcome: 'transitioned', task: input.resultTask }),
  };
  service.app = {
    service: (name: string) => {
      if (name === 'tasks') return { emit: vi.fn() };
      if (name === 'branches') return { get: vi.fn() };
      if (name === 'sessions') {
        return {
          get: input.sessionReadFails
            ? vi.fn().mockRejectedValue(new Error('transient read'))
            : vi.fn().mockResolvedValue({
                session_id: input.resultTask.session_id,
                status: 'running',
                ready_for_prompt: false,
                tasks: input.sessionTasks ?? [input.resultTask.task_id as string],
              }),
          patch: sessionsPatch,
          triggerQueueProcessing,
        };
      }
      throw new Error(`unexpected service ${name}`);
    },
  };
  return { service, sessionsPatch, triggerQueueProcessing };
}

describe('TasksService executor heartbeat helpers', () => {
  it('does not let an executor terminal patch bypass coordinator-owned stopping', async () => {
    const stoppingTask = {
      task_id: '018f0000-0000-7000-8000-000000000000',
      session_id: '018f0000-0000-7000-8000-000000000010',
      status: TaskStatus.STOPPING,
      created_at: '2026-01-01T00:00:00.000Z',
      termination_request: {
        cause: 'user_stop',
        requested_at: '2026-01-01T00:00:01.000Z',
      },
    };
    const service = Object.create(TasksService.prototype) as TasksService & {
      get: ReturnType<typeof vi.fn>;
      repository: { update: ReturnType<typeof vi.fn> };
    };
    service.get = vi.fn().mockResolvedValue(stoppingTask);
    service.repository = { update: vi.fn() };

    await expect(
      service.patch(stoppingTask.task_id, { status: TaskStatus.STOPPED }, { provider: 'socketio' })
    ).resolves.toBe(stoppingTask);
    expect(service.repository.update).not.toHaveBeenCalled();
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

  it.each([
    TaskStatus.COMPLETED,
    TaskStatus.STOPPED,
  ])('does not let a terminal %s task enter an executor awaiting state', async (terminalStatus) => {
    const taskId = '018f0000-0000-7000-8000-000000000009';
    const terminalTask = {
      task_id: taskId,
      session_id: '018f0000-0000-7000-8000-000000000010',
      status: terminalStatus,
      created_at: '2026-01-01T00:00:00.000Z',
      completed_at: '2026-01-01T00:00:05.000Z',
      executor_connected_at: '2026-01-01T00:00:01.000Z',
    };
    const service = Object.create(TasksService.prototype) as TasksService & {
      get: ReturnType<typeof vi.fn>;
      repository: { update: ReturnType<typeof vi.fn> };
      id: string;
      emit: ReturnType<typeof vi.fn>;
    };
    service.get = vi.fn().mockResolvedValue(terminalTask);
    service.repository = { update: vi.fn() };
    service.id = 'task_id';
    service.emit = vi.fn();

    for (const status of [TaskStatus.AWAITING_PERMISSION, TaskStatus.AWAITING_INPUT]) {
      await expect(service.patch(taskId, { status })).resolves.toBe(terminalTask);
    }

    expect(service.repository.update).not.toHaveBeenCalled();
    expect(service.emit).not.toHaveBeenCalled();
  });

  it('falls back to the canonical session projection when completion context cannot load', async () => {
    const taskId = '018f0000-0000-7000-8000-000000000010';
    const sessionId = '018f0000-0000-7000-8000-000000000011';
    const failedTask = {
      task_id: taskId,
      session_id: sessionId,
      status: TaskStatus.FAILED,
      created_at: '2026-01-01T00:00:00.000Z',
      completed_at: '2026-01-01T00:00:05.000Z',
      termination_request: {
        cause: 'heartbeat_lost',
        requested_at: '2026-01-01T00:00:04.000Z',
      },
    };
    const { service, sessionsPatch } = completionHarness({
      currentTask: failedTask,
      resultTask: failedTask,
      sessionReadFails: true,
    });

    await service.settleTermination({ taskId, outcome: 'verified_absent' });

    expect(sessionsPatch).toHaveBeenCalledWith(
      sessionId,
      { status: 'failed', ready_for_prompt: true },
      expect.objectContaining({ provider: undefined, suppressTerminalQueueProcessing: true })
    );
  });

  it('settles a stopped active task ahead of queued work and triggers queue processing', async () => {
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
      termination_request: {
        cause: 'user_stop',
        requested_at: '2026-01-01T00:00:04.000Z',
      },
    };
    const { service, sessionsPatch, triggerQueueProcessing } = completionHarness({
      currentTask,
      resultTask: stoppedTask,
      sessionTasks: [taskId, '018f0000-0000-7000-8000-000000000032'],
    });

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
