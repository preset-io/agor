import type { Task } from '@agor/core/types';
import { TaskStatus } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';

const requestExecutorTermination = vi.hoisted(() => vi.fn().mockResolvedValue({}));
const withFreshTenantWriteDatabase = vi.hoisted(() =>
  vi.fn(async (work: () => Promise<unknown>) => work())
);
const createFreshTenantWriteDatabaseRunner = vi.hoisted(() =>
  vi.fn(() => withFreshTenantWriteDatabase)
);
const deferred = vi.hoisted(
  () =>
    ({ work: undefined as (() => Promise<void>) | undefined, schedule: vi.fn() }) as {
      work: (() => Promise<void>) | undefined;
      schedule: ReturnType<typeof vi.fn>;
    }
);
vi.mock('../termination-coordinator.js', () => ({
  beginExecutorTermination: vi.fn(),
  requestExecutorTermination,
}));
vi.mock('../utils/tenant-db-scope.js', () => ({
  createFreshTenantWriteDatabaseRunner,
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
    Reflect.set(service, 'db', {});

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
    expect(createFreshTenantWriteDatabaseRunner).toHaveBeenCalledWith({}, 'tenant-a');
    expect(withFreshTenantWriteDatabase).toHaveBeenCalledOnce();
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
        runInFreshTenantWriteDatabase: withFreshTenantWriteDatabase,
      })
    );
  });
});
