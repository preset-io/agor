import type { Task } from '@agor/core/types';
import { TaskStatus } from '@agor/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const requestExecutorTermination = vi.hoisted(() => vi.fn().mockResolvedValue({}));
const claimExecutorTermination = vi.hoisted(() => vi.fn());
const deferred = vi.hoisted(
  () =>
    ({ work: undefined as (() => Promise<void>) | undefined, schedule: vi.fn() }) as {
      work: (() => Promise<void>) | undefined;
      schedule: ReturnType<typeof vi.fn>;
    }
);
vi.mock('../termination-coordinator.js', () => ({
  claimExecutorTermination,
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

type TasksServicePrivateMethods = {
  deferTenantOrchestration(
    label: string,
    params: Parameters<TasksService['reportTerminationComplete']>[1],
    work: () => Promise<void>
  ): void;
};

describe('TasksService executor termination report', () => {
  beforeEach(() => {
    claimExecutorTermination.mockReset();
    requestExecutorTermination.mockReset().mockResolvedValue({});
    deferred.work = undefined;
    deferred.schedule.mockReset();
  });

  it('redacts caught values from shared deferred orchestration logs', () => {
    const markerSecret = 'TASK-ORCHESTRATION-MARKER-SECRET';
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const service = Object.create(TasksService.prototype) as TasksService;

    (service as unknown as TasksServicePrivateMethods).deferTenantOrchestration(
      'materializeTerminalConsequences',
      { tenant: { tenant_id: 'tenant-a' } } as never,
      async () => undefined
    );
    const onError = deferred.schedule.mock.calls[0]?.[1] as ((error: unknown) => void) | undefined;
    onError?.(new Error(markerSecret));

    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('operation="materializeTerminalConsequences"')
    );
    expect(JSON.stringify(warning.mock.calls)).not.toContain(markerSecret);
    warning.mockRestore();
  });

  it('redacts caught values from deferred termination coordination logs', async () => {
    const markerSecret = 'TASK-TERMINATION-MARKER-SECRET';
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const task = {
      task_id: '018f0000-0000-7000-8000-000000000001',
      session_id: '018f0000-0000-7000-8000-000000000002',
      status: TaskStatus.STOPPING,
      termination_request: {
        cause: 'user_stop',
        requested_at: '2026-07-23T12:00:00.000Z',
        executor_quiesced_at: '2026-07-23T12:00:00.125Z',
      },
    } as Task;
    const service = Object.create(TasksService.prototype) as TasksService;
    Reflect.set(service, 'taskRepo', {
      recordExecutorQuiescence: vi.fn().mockResolvedValue(task),
    });
    Reflect.set(service, 'app', { service: () => ({ emit: vi.fn() }) });

    await service.reportTerminationComplete(
      { task_id: task.task_id, requested_at: task.termination_request!.requested_at },
      { tenant: { tenant_id: 'tenant-a' } } as never
    );
    const onError = deferred.schedule.mock.calls[0]?.[1] as ((error: unknown) => void) | undefined;
    onError?.(new Error(markerSecret));

    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining('operation="request" outcome="failed"')
    );
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain(markerSecret);
    errorLog.mockRestore();
  });

  it('returns STOPPING and defers normal local completion to the release coordinator', async () => {
    const task = {
      task_id: '018f0000-0000-7000-8000-000000000001',
      session_id: '018f0000-0000-7000-8000-000000000002',
      status: TaskStatus.STOPPING,
      termination_request: {
        cause: 'runtime_settlement',
        requested_at: '2026-07-23T12:00:00.000Z',
        executor_quiesced_at: '2026-07-23T12:00:00.000Z',
        executor_settlement: { status: TaskStatus.COMPLETED },
      },
    } as Task;
    const settleExecutorOutcome = vi.fn().mockResolvedValue({ outcome: 'stopping', task });
    const emit = vi.fn();
    const patchSession = vi.fn().mockResolvedValue({});
    const service = Object.create(TasksService.prototype) as TasksService;
    Reflect.set(service, 'taskRepo', { settleExecutorOutcome });
    Reflect.set(service, 'app', {
      service: (name: string) =>
        name === 'tasks' ? { emit } : name === 'sessions' ? { patch: patchSession } : {},
    });

    await expect(
      service.reportExecutorSettlement(
        { task_id: task.task_id, kind: 'quiesced', result: 'success' },
        { tenant: { tenant_id: 'tenant-a' } } as never
      )
    ).resolves.toBe(task);

    expect(patchSession).toHaveBeenCalledWith(
      task.session_id,
      { status: TaskStatus.STOPPING, ready_for_prompt: false },
      expect.objectContaining({ provider: undefined })
    );
    expect(requestExecutorTermination).not.toHaveBeenCalled();
    await deferred.work?.();
    expect(requestExecutorTermination).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: task.task_id,
        cause: 'runtime_settlement',
        params: expect.objectContaining({ provider: undefined }),
      })
    );
  });

  it('redacts caught session projection failures during executor settlement', async () => {
    const markerSecret = 'TASK-SESSION-PROJECTION-MARKER-SECRET';
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const task = {
      task_id: '018f0000-0000-7000-8000-000000000001',
      session_id: '018f0000-0000-7000-8000-000000000002',
      status: TaskStatus.STOPPING,
      termination_request: {
        cause: 'runtime_settlement',
        requested_at: '2026-07-23T12:00:00.000Z',
        executor_quiesced_at: '2026-07-23T12:00:00.000Z',
        executor_settlement: { status: TaskStatus.COMPLETED },
      },
    } as Task;
    const service = Object.create(TasksService.prototype) as TasksService;
    Reflect.set(service, 'taskRepo', {
      settleExecutorOutcome: vi.fn().mockResolvedValue({ outcome: 'stopping', task }),
    });
    Reflect.set(service, 'app', {
      service: (name: string) =>
        name === 'tasks'
          ? { emit: vi.fn() }
          : name === 'sessions'
            ? { patch: vi.fn().mockRejectedValue(new Error(markerSecret)) }
            : {},
    });

    await service.reportExecutorSettlement(
      { task_id: task.task_id, kind: 'quiesced', result: 'success' },
      { tenant: { tenant_id: 'tenant-a' } } as never
    );

    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining(
        'operation="project_stopping_session" outcome="failed" session_id="018f00000000700080000000" error_code="operation_failed"'
      )
    );
    expect(JSON.stringify(warning.mock.calls)).not.toContain(markerSecret);
    warning.mockRestore();
  });

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

  it('claims cleanup failure before deferring containment outside the service transaction', async () => {
    const task = {
      task_id: '018f0000-0000-7000-8000-000000000001',
      session_id: '018f0000-0000-7000-8000-000000000002',
      status: TaskStatus.STOPPING,
      termination_request: {
        cause: 'runtime_cleanup_failed',
        requested_at: '2026-07-23T12:00:00.000Z',
        error_message: 'Runtime cleanup failed.',
      },
    } as Task;
    claimExecutorTermination.mockResolvedValue({ outcome: 'claimed', task });
    const service = Object.create(TasksService.prototype) as TasksService;
    Reflect.set(service, 'app', {});

    await expect(
      service.reportExecutorSettlement(
        {
          task_id: task.task_id,
          kind: 'containment_required',
          error_message: 'Runtime cleanup failed.',
        },
        { tenant: { tenant_id: 'tenant-a' } } as never
      )
    ).resolves.toBe(task);

    expect(claimExecutorTermination).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: task.task_id,
        cause: 'runtime_cleanup_failed',
        errorMessage: 'Runtime cleanup failed.',
      })
    );
    expect(requestExecutorTermination).not.toHaveBeenCalled();

    await deferred.work?.();

    expect(requestExecutorTermination).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: task.task_id,
        cause: 'runtime_cleanup_failed',
        params: expect.objectContaining({ provider: undefined }),
      })
    );
  });
});
