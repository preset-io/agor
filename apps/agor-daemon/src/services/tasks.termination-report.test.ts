import type { Task } from '@agor/core/types';
import { SessionStatus, TaskStatus } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';

const requestExecutorTermination = vi.hoisted(() => vi.fn().mockResolvedValue({}));
const beginExecutorTermination = vi.hoisted(() => vi.fn());
const deferred = vi.hoisted(
  () =>
    ({ work: undefined as (() => Promise<void>) | undefined, schedule: vi.fn() }) as {
      work: (() => Promise<void>) | undefined;
      schedule: ReturnType<typeof vi.fn>;
    }
);
vi.mock('../termination-coordinator.js', () => ({
  beginExecutorTermination,
  requestExecutorTermination,
}));
vi.mock('../utils/tenant-db-scope.js', () => ({
  deferWithTenantContext: (
    params: unknown,
    work: () => Promise<void>,
    onError?: (error: unknown) => void
  ) => {
    deferred.work = work;
    deferred.schedule(params, onError);
  },
}));

import { TasksService } from './tasks';

describe('TasksService executor termination report', () => {
  it('persists and publishes quiescence before coordinating after the service transaction', async () => {
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
      service.reportTerminationComplete(
        {
          task_id: task.task_id,
          requested_at: requestedAt,
        },
        { tenant: { tenant_id: 'tenant-a' } } as never
      )
    ).resolves.toBe(task);

    expect(recordExecutorQuiescence).toHaveBeenCalledWith({
      task_id: task.task_id,
      requested_at: requestedAt,
    });
    expect(emit).toHaveBeenCalledWith('patched', task, expect.objectContaining({ path: 'tasks' }));
    expect(deferred.schedule).toHaveBeenCalledWith(
      expect.objectContaining({ tenant: { tenant_id: 'tenant-a' } }),
      expect.any(Function)
    );
    expect(requestExecutorTermination).not.toHaveBeenCalled();

    await deferred.work?.();

    expect(requestExecutorTermination).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: task.task_id,
        cause: 'user_stop',
        params: expect.objectContaining({ provider: undefined }),
      })
    );
  });

  it.each([
    {
      name: 'success',
      turn: { outcome: 'success' as const, model: 'provider/model' },
      status: TaskStatus.COMPLETED,
      updates: {
        status: TaskStatus.COMPLETED,
        model: 'provider/model',
      },
    },
    {
      name: 'failure',
      turn: { outcome: 'failure' as const, error_message: 'Provider failed.' },
      status: TaskStatus.FAILED,
      updates: { status: TaskStatus.FAILED, error_message: 'Provider failed.' },
    },
  ])('maps a quiesced $name through the existing task owner', async (scenario) => {
    const task = {
      task_id: '018f0000-0000-7000-8000-000000000001',
      session_id: '018f0000-0000-7000-8000-000000000002',
      status: scenario.status,
    } as Task;
    const updateFromExecutor = vi.fn().mockResolvedValue(task);
    const emit = vi.fn();
    const processCompletionSideEffects = vi.fn().mockResolvedValue(true);
    const service = Object.create(TasksService.prototype) as TasksService;
    Reflect.set(service, 'taskRepo', { updateFromExecutor });
    Reflect.set(service, 'trackTaskCompleted', vi.fn());
    Reflect.set(service, 'processCompletionSideEffects', processCompletionSideEffects);
    Reflect.set(service, 'app', { service: () => ({ emit }) });

    await expect(
      service.reportRunnerResult({
        task_id: task.task_id,
        turn: scenario.turn,
        cleanup: { outcome: 'quiesced' },
      })
    ).resolves.toBe(task);

    expect(updateFromExecutor).toHaveBeenCalledWith(task.task_id, scenario.updates);
    expect(processCompletionSideEffects).toHaveBeenCalledWith(
      task,
      scenario.status,
      expect.objectContaining({ provider: undefined })
    );
    expect(emit).toHaveBeenCalledWith('patched', task, expect.objectContaining({ path: 'tasks' }));
  });

  it('preserves the interaction-timeout session projection without running completion effects', async () => {
    const task = {
      task_id: '018f0000-0000-7000-8000-000000000001',
      session_id: '018f0000-0000-7000-8000-000000000002',
      status: TaskStatus.TIMED_OUT,
      error_message: 'Permission timed out.',
    } as Task;
    const updateFromExecutor = vi.fn().mockResolvedValue(task);
    const sessionPatch = vi.fn().mockResolvedValue({});
    const processCompletionSideEffects = vi.fn();
    const service = Object.create(TasksService.prototype) as TasksService;
    Reflect.set(service, 'taskRepo', { updateFromExecutor });
    Reflect.set(service, 'trackTaskCompleted', vi.fn());
    Reflect.set(service, 'processCompletionSideEffects', processCompletionSideEffects);
    Reflect.set(service, 'app', {
      service: (name: string) => (name === 'tasks' ? { emit: vi.fn() } : { patch: sessionPatch }),
    });

    await expect(
      service.reportRunnerResult({
        task_id: task.task_id,
        turn: { outcome: 'interaction_timeout', error_message: 'Permission timed out.' },
        cleanup: { outcome: 'quiesced' },
      })
    ).resolves.toBe(task);

    expect(updateFromExecutor).toHaveBeenCalledWith(task.task_id, {
      status: TaskStatus.TIMED_OUT,
      error_message: 'Permission timed out.',
    });
    expect(sessionPatch).toHaveBeenCalledWith(
      task.session_id,
      { status: SessionStatus.TIMED_OUT, ready_for_prompt: true },
      expect.objectContaining({ provider: undefined })
    );
    expect(processCompletionSideEffects).not.toHaveBeenCalled();
  });

  it('treats a repeated runner report as an idempotent terminal acknowledgement', async () => {
    const task = {
      task_id: '018f0000-0000-7000-8000-000000000001',
      session_id: '018f0000-0000-7000-8000-000000000002',
      status: TaskStatus.COMPLETED,
    } as Task;
    const processCompletionSideEffects = vi.fn();
    const service = Object.create(TasksService.prototype) as TasksService;
    Reflect.set(service, 'taskRepo', {
      updateFromExecutor: vi.fn().mockRejectedValue(new Error('already terminal')),
      findById: vi.fn().mockResolvedValue(task),
    });
    Reflect.set(service, 'processCompletionSideEffects', processCompletionSideEffects);

    await expect(
      service.reportRunnerResult({
        task_id: task.task_id,
        turn: { outcome: 'success' },
        cleanup: { outcome: 'quiesced' },
      })
    ).resolves.toBe(task);

    expect(processCompletionSideEffects).not.toHaveBeenCalled();
  });

  it('hands unverified cleanup to containment without terminalizing the task', async () => {
    const stopping = {
      task_id: '018f0000-0000-7000-8000-000000000001',
      session_id: '018f0000-0000-7000-8000-000000000002',
      status: TaskStatus.STOPPING,
      termination_request: {
        cause: 'runtime_cleanup_failed',
        requested_at: '2026-07-23T12:00:00.000Z',
      },
    } as Task;
    beginExecutorTermination.mockResolvedValueOnce(stopping);
    const service = Object.create(TasksService.prototype) as TasksService;
    Reflect.set(service, 'taskRepo', { updateFromExecutor: vi.fn() });
    Reflect.set(service, 'app', {});

    await expect(
      service.reportRunnerResult({
        task_id: stopping.task_id,
        turn: { outcome: 'failure', error_message: 'Provider failed.' },
        cleanup: { outcome: 'unverified', reason: 'Server did not exit.' },
      })
    ).resolves.toBe(stopping);

    expect(beginExecutorTermination).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: stopping.task_id,
        cause: 'runtime_cleanup_failed',
        errorMessage:
          'Provider failed. Runtime cleanup could not be verified: Server did not exit.',
      })
    );
  });

  it('turns a quiesced result into evidence for a termination request that won the race', async () => {
    const requestedAt = '2026-07-23T12:00:00.000Z';
    const stopping = {
      task_id: '018f0000-0000-7000-8000-000000000001',
      session_id: '018f0000-0000-7000-8000-000000000002',
      status: TaskStatus.STOPPING,
      termination_request: { cause: 'user_stop', requested_at: requestedAt },
    } as Task;
    const quiesced = {
      ...stopping,
      termination_request: {
        ...stopping.termination_request!,
        executor_quiesced_at: '2026-07-23T12:00:00.125Z',
      },
    } as Task;
    const recordExecutorQuiescence = vi.fn().mockResolvedValue(quiesced);
    const service = Object.create(TasksService.prototype) as TasksService;
    Reflect.set(service, 'taskRepo', {
      updateFromExecutor: vi.fn().mockRejectedValue(new Error('termination-owned')),
      findById: vi.fn().mockResolvedValue(stopping),
      recordExecutorQuiescence,
    });
    Reflect.set(service, 'app', { service: () => ({ emit: vi.fn() }) });

    await expect(
      service.reportRunnerResult({
        task_id: stopping.task_id,
        turn: { outcome: 'failure', error_message: 'Turn aborted.' },
        cleanup: { outcome: 'quiesced' },
      })
    ).resolves.toBe(quiesced);

    expect(recordExecutorQuiescence).toHaveBeenCalledWith({
      task_id: stopping.task_id,
      requested_at: requestedAt,
    });
  });
});
