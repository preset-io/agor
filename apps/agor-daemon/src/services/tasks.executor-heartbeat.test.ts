import {
  TaskExecutionRuntimeBackend,
  TaskRuntimeEventKind,
  TaskRuntimePhase,
  TaskStatus,
} from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { TasksService } from './tasks';

describe('TasksService executor heartbeat helpers', () => {
  const installLockedTaskRepo = (service: {
    get: ReturnType<typeof vi.fn>;
    repository: { update: ReturnType<typeof vi.fn> };
    taskRepo?: { updateWithLockedCurrent: ReturnType<typeof vi.fn> };
  }) => {
    service.taskRepo = {
      updateWithLockedCurrent: vi.fn(async (id: string, decide: (current: any) => any) => {
        const before = await service.get(id);
        const decision = decide(before);
        if (decision.action === 'return') {
          return { before, after: decision.task, updated: false };
        }
        const after = await service.repository.update(id, decision.updates);
        return { before, after, updated: true };
      }),
    };
  };

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
    installLockedTaskRepo(service);
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
    installLockedTaskRepo(service);
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
    installLockedTaskRepo(service);
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
    installLockedTaskRepo(service);
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
    installLockedTaskRepo(service);
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
    installLockedTaskRepo(service);
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
    installLockedTaskRepo(service);
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
    installLockedTaskRepo(service);
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

  it('no-ops stale executor heartbeat patches and returns the current task', async () => {
    const taskId = '018f0000-0000-7000-8000-000000000101';
    const currentTask = {
      task_id: taskId,
      session_id: '018f0000-0000-7000-8000-000000000102',
      status: TaskStatus.RUNNING,
      created_at: '2026-01-01T00:00:00.000Z',
      current_execution_attempt: {
        schema_version: 1 as const,
        attempt_id: '018f0000-0000-7000-8000-000000000103',
        executor_instance_id: '018f0000-0000-7000-8000-000000000104',
        runtime_backend: TaskExecutionRuntimeBackend.LOCAL_SUBPROCESS,
        started_at: '2026-01-01T00:00:00.000Z',
      },
    };
    const service = Object.create(TasksService.prototype) as TasksService & {
      get: ReturnType<typeof vi.fn>;
      repository: { update: ReturnType<typeof vi.fn> };
      id: string;
      emit: ReturnType<typeof vi.fn>;
    };
    service.get = vi.fn().mockResolvedValue(currentTask);
    service.repository = { update: vi.fn() };
    installLockedTaskRepo(service);
    service.id = 'task_id';
    service.emit = vi.fn();

    const result = await service.patch(
      taskId,
      { last_executor_heartbeat_at: '2026-01-01T00:00:10.000Z' },
      {
        provider: 'socketio',
        authentication: {
          strategy: 'jwt',
          payload: {
            type: 'executor-session',
            task_id: taskId,
            attempt_id: '018f0000-0000-7000-8000-000000000999',
            executor_instance_id: '018f0000-0000-7000-8000-000000000104',
          },
        },
      } as any
    );

    expect(result).toMatchObject({
      ...currentTask,
      runtime_patch_ignored: true,
    });
    expect(service.repository.update).not.toHaveBeenCalled();
    expect(service.emit).not.toHaveBeenCalled();

    const staleFinal = await service.patch(
      taskId,
      {
        status: TaskStatus.FAILED,
        completed_at: '2026-01-01T00:00:11.000Z',
        error_message: 'stale executor failure',
        raw_sdk_response: { stale: true },
      },
      {
        provider: 'socketio',
        authentication: {
          strategy: 'jwt',
          payload: {
            type: 'executor-session',
            task_id: taskId,
            attempt_id: '018f0000-0000-7000-8000-000000000999',
            executor_instance_id: '018f0000-0000-7000-8000-000000000104',
          },
        },
      } as any
    );

    expect(staleFinal).toMatchObject({
      ...currentTask,
      runtime_patch_ignored: true,
    });
    expect(service.repository.update).not.toHaveBeenCalled();
    expect(service.emit).not.toHaveBeenCalled();
  });

  it('uses preserved socket executor scope fields when JWT payload is absent', async () => {
    const taskId = '018f0000-0000-7000-8000-000000000161';
    const currentTask = {
      task_id: taskId,
      session_id: '018f0000-0000-7000-8000-000000000162',
      status: TaskStatus.RUNNING,
      created_at: '2026-01-01T00:00:00.000Z',
      current_execution_attempt: {
        schema_version: 1 as const,
        attempt_id: '018f0000-0000-7000-8000-000000000163',
        executor_instance_id: '018f0000-0000-7000-8000-000000000164',
        runtime_backend: TaskExecutionRuntimeBackend.COMMAND_TEMPLATE,
        started_at: '2026-01-01T00:00:00.000Z',
      },
    };
    const service = Object.create(TasksService.prototype) as TasksService & {
      get: ReturnType<typeof vi.fn>;
      repository: { update: ReturnType<typeof vi.fn> };
      id: string;
      emit: ReturnType<typeof vi.fn>;
    };
    service.get = vi.fn().mockResolvedValue(currentTask);
    service.repository = { update: vi.fn() };
    installLockedTaskRepo(service);
    service.id = 'task_id';
    service.emit = vi.fn();

    const result = await service.patch(
      taskId,
      { last_executor_heartbeat_at: '2026-01-01T00:00:10.000Z' },
      {
        provider: 'socketio',
        authentication: { strategy: 'jwt' },
        task_id: taskId,
        attempt_id: '018f0000-0000-7000-8000-000000000999',
        executor_instance_id: currentTask.current_execution_attempt.executor_instance_id,
      } as any
    );

    expect(result).toMatchObject({
      ...currentTask,
      runtime_patch_ignored: true,
    });
    expect(service.repository.update).not.toHaveBeenCalled();
    expect(service.emit).not.toHaveBeenCalled();
  });

  it('checks runtime attempt ownership against the locked task row', async () => {
    const taskId = '018f0000-0000-7000-8000-000000000151';
    const staleAttempt = {
      schema_version: 1 as const,
      attempt_id: '018f0000-0000-7000-8000-000000000153',
      executor_instance_id: '018f0000-0000-7000-8000-000000000154',
      runtime_backend: TaskExecutionRuntimeBackend.COMMAND_TEMPLATE,
      started_at: '2026-01-01T00:00:00.000Z',
    };
    const preReadTask = {
      task_id: taskId,
      session_id: '018f0000-0000-7000-8000-000000000152',
      status: TaskStatus.RUNNING,
      created_at: '2026-01-01T00:00:00.000Z',
      current_execution_attempt: staleAttempt,
    };
    const lockedTask = {
      ...preReadTask,
      current_execution_attempt: {
        ...staleAttempt,
        attempt_id: '018f0000-0000-7000-8000-000000000155',
      },
    };
    const service = Object.create(TasksService.prototype) as TasksService & {
      get: ReturnType<typeof vi.fn>;
      repository: { update: ReturnType<typeof vi.fn> };
      taskRepo: { updateWithLockedCurrent: ReturnType<typeof vi.fn> };
      id: string;
      emit: ReturnType<typeof vi.fn>;
    };
    service.get = vi.fn().mockResolvedValue(preReadTask);
    service.repository = { update: vi.fn() };
    service.taskRepo = {
      updateWithLockedCurrent: vi.fn(async (_id: string, decide: (current: any) => any) => {
        const decision = decide(lockedTask);
        if (decision.action === 'return') {
          return { before: lockedTask, after: decision.task, updated: false };
        }
        const after = await service.repository.update(_id, decision.updates);
        return { before: lockedTask, after, updated: true };
      }),
    };
    service.id = 'task_id';
    service.emit = vi.fn();

    const result = await service.patch(
      taskId,
      { last_executor_heartbeat_at: '2026-01-01T00:00:10.000Z' },
      {
        runtimeAttempt: {
          attemptId: staleAttempt.attempt_id,
          executorInstanceId: staleAttempt.executor_instance_id,
        },
      } as any
    );

    expect(result).toMatchObject({
      ...lockedTask,
      runtime_patch_ignored: true,
    });
    expect(service.repository.update).not.toHaveBeenCalled();
    expect(service.emit).not.toHaveBeenCalled();
  });

  it('stamps connected, heartbeat, and terminal attempt fields for current executor patches', async () => {
    const taskId = '018f0000-0000-7000-8000-000000000111';
    const attempt = {
      schema_version: 1 as const,
      attempt_id: '018f0000-0000-7000-8000-000000000113',
      executor_instance_id: '018f0000-0000-7000-8000-000000000114',
      runtime_backend: TaskExecutionRuntimeBackend.COMMAND_TEMPLATE,
      started_at: '2026-01-01T00:00:00.000Z',
    };
    let currentTask: any = {
      task_id: taskId,
      session_id: '018f0000-0000-7000-8000-000000000112',
      status: TaskStatus.RUNNING,
      created_by: 'user-1',
      created_at: '2026-01-01T00:00:00.000Z',
      current_execution_attempt: attempt,
    };
    const session = { session_id: currentTask.session_id, status: 'running', tasks: [taskId] };
    const service = Object.create(TasksService.prototype) as TasksService & {
      app: any;
      get: ReturnType<typeof vi.fn>;
      repository: { update: ReturnType<typeof vi.fn> };
      id: string;
      emit: ReturnType<typeof vi.fn>;
      heartbeatCallbackRunner: { run: ReturnType<typeof vi.fn> };
    };
    service.get = vi.fn().mockImplementation(async () => currentTask);
    service.repository = {
      update: vi.fn().mockImplementation(async (_id, data) => {
        currentTask = { ...currentTask, ...data };
        return currentTask;
      }),
    };
    installLockedTaskRepo(service);
    service.id = 'task_id';
    service.emit = vi.fn();
    service.heartbeatCallbackRunner = { run: vi.fn() };
    service.app = {
      service: (name: string) => {
        if (name === 'sessions') return { get: vi.fn().mockResolvedValue(session), patch: vi.fn() };
        if (name === 'branches') return { get: vi.fn() };
        throw new Error(`unexpected service ${name}`);
      },
    };
    const params = {
      provider: 'socketio',
      authentication: {
        strategy: 'jwt',
        payload: {
          type: 'executor-session',
          task_id: taskId,
          attempt_id: attempt.attempt_id,
          executor_instance_id: attempt.executor_instance_id,
        },
      },
    } as any;

    await service.patch(
      taskId,
      {
        runtime_vitals: {
          schema_version: 1,
          phase: TaskRuntimePhase.EXECUTOR_CONNECTED,
          phase_started_at: '2026-01-01T00:00:01.000Z',
          last_activity_at: '2026-01-01T00:00:01.000Z',
          last_event: {
            kind: TaskRuntimeEventKind.EXECUTOR_CONNECTED,
            at: '2026-01-01T00:00:01.000Z',
            source: 'executor',
            phase: TaskRuntimePhase.EXECUTOR_CONNECTED,
          },
        },
      },
      params
    );
    expect(currentTask.current_execution_attempt.connected_at).toBe('2026-01-01T00:00:01.000Z');

    await service.patch(taskId, { last_executor_heartbeat_at: '2026-01-01T00:00:02.000Z' }, params);
    expect(currentTask.current_execution_attempt.last_heartbeat_at).toBe(
      '2026-01-01T00:00:02.000Z'
    );

    await service.patch(
      taskId,
      { status: TaskStatus.COMPLETED, completed_at: '2026-01-01T00:00:03.000Z' },
      params
    );
    expect(currentTask.current_execution_attempt.terminal_at).toBe('2026-01-01T00:00:03.000Z');
    expect(currentTask.current_execution_attempt.terminal_status).toBe(TaskStatus.COMPLETED);

    const updateCount = service.repository.update.mock.calls.length;
    const late = await service.patch(
      taskId,
      { last_executor_heartbeat_at: '2026-01-01T00:00:04.000Z' },
      params
    );
    expect(late).toMatchObject({
      ...currentTask,
      runtime_patch_ignored: true,
    });
    expect(service.repository.update).toHaveBeenCalledTimes(updateCount);
  });

  it('no-ops stale daemon-owned terminal patches from an earlier attempt', async () => {
    const taskId = '018f0000-0000-7000-8000-000000000121';
    const currentTask = {
      task_id: taskId,
      session_id: '018f0000-0000-7000-8000-000000000122',
      status: TaskStatus.RUNNING,
      created_at: '2026-01-01T00:00:00.000Z',
      current_execution_attempt: {
        schema_version: 1 as const,
        attempt_id: '018f0000-0000-7000-8000-000000000123',
        executor_instance_id: '018f0000-0000-7000-8000-000000000124',
        runtime_backend: TaskExecutionRuntimeBackend.COMMAND_TEMPLATE,
        started_at: '2026-01-01T00:00:00.000Z',
      },
    };
    const service = Object.create(TasksService.prototype) as TasksService & {
      get: ReturnType<typeof vi.fn>;
      repository: { update: ReturnType<typeof vi.fn> };
      id: string;
      emit: ReturnType<typeof vi.fn>;
    };
    service.get = vi.fn().mockResolvedValue(currentTask);
    service.repository = { update: vi.fn() };
    installLockedTaskRepo(service);
    service.id = 'task_id';
    service.emit = vi.fn();

    const result = await service.patch(
      taskId,
      {
        status: TaskStatus.FAILED,
        completed_at: '2026-01-01T00:00:09.000Z',
        error_message: 'stale launcher exit',
      },
      {
        runtimeAttempt: {
          attemptId: '018f0000-0000-7000-8000-000000000999',
          executorInstanceId: '018f0000-0000-7000-8000-000000000124',
        },
      } as any
    );

    expect(result).toMatchObject({
      ...currentTask,
      runtime_patch_ignored: true,
    });
    expect(service.repository.update).not.toHaveBeenCalled();
    expect(service.emit).not.toHaveBeenCalled();
  });

  it('no-ops stale daemon-owned session_md5 sidecar writes', async () => {
    const taskId = '018f0000-0000-7000-8000-000000000131';
    const currentTask = {
      task_id: taskId,
      session_id: '018f0000-0000-7000-8000-000000000132',
      status: TaskStatus.RUNNING,
      created_at: '2026-01-01T00:00:00.000Z',
      current_execution_attempt: {
        schema_version: 1 as const,
        attempt_id: '018f0000-0000-7000-8000-000000000133',
        executor_instance_id: '018f0000-0000-7000-8000-000000000134',
        runtime_backend: TaskExecutionRuntimeBackend.LOCAL_SUBPROCESS,
        started_at: '2026-01-01T00:00:00.000Z',
      },
    };
    const service = Object.create(TasksService.prototype) as TasksService & {
      get: ReturnType<typeof vi.fn>;
      repository: { update: ReturnType<typeof vi.fn> };
      id: string;
      emit: ReturnType<typeof vi.fn>;
    };
    service.get = vi.fn().mockResolvedValue(currentTask);
    service.repository = { update: vi.fn() };
    installLockedTaskRepo(service);
    service.id = 'task_id';
    service.emit = vi.fn();

    const result = await service.patch(taskId, { session_md5: 'stale-hash' }, {
      runtimeAttempt: {
        attemptId: '018f0000-0000-7000-8000-000000000999',
        executorInstanceId: '018f0000-0000-7000-8000-000000000134',
      },
    } as any);

    expect(result).toMatchObject({
      ...currentTask,
      runtime_patch_ignored: true,
    });
    expect(service.repository.update).not.toHaveBeenCalled();
    expect(service.emit).not.toHaveBeenCalled();
  });

  it('no-ops late session_md5 writes after the current attempt is terminal', async () => {
    const taskId = '018f0000-0000-7000-8000-000000000141';
    const currentTask = {
      task_id: taskId,
      session_id: '018f0000-0000-7000-8000-000000000142',
      status: TaskStatus.COMPLETED,
      created_at: '2026-01-01T00:00:00.000Z',
      current_execution_attempt: {
        schema_version: 1 as const,
        attempt_id: '018f0000-0000-7000-8000-000000000143',
        executor_instance_id: '018f0000-0000-7000-8000-000000000144',
        runtime_backend: TaskExecutionRuntimeBackend.LOCAL_SUBPROCESS,
        started_at: '2026-01-01T00:00:00.000Z',
        terminal_at: '2026-01-01T00:00:05.000Z',
        terminal_status: TaskStatus.COMPLETED,
      },
    };
    const service = Object.create(TasksService.prototype) as TasksService & {
      get: ReturnType<typeof vi.fn>;
      repository: { update: ReturnType<typeof vi.fn> };
      id: string;
      emit: ReturnType<typeof vi.fn>;
    };
    service.get = vi.fn().mockResolvedValue(currentTask);
    service.repository = { update: vi.fn() };
    installLockedTaskRepo(service);
    service.id = 'task_id';
    service.emit = vi.fn();

    const result = await service.patch(taskId, { session_md5: 'late-hash' }, {
      runtimeAttempt: {
        attemptId: '018f0000-0000-7000-8000-000000000143',
        executorInstanceId: '018f0000-0000-7000-8000-000000000144',
      },
    } as any);

    expect(result).toMatchObject({
      ...currentTask,
      runtime_patch_ignored: true,
    });
    expect(service.repository.update).not.toHaveBeenCalled();
    expect(service.emit).not.toHaveBeenCalled();
  });
});
