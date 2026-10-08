import { getCurrentTenantId } from '@agor/core/db';
import { TaskStatus } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';

const requestTermination = vi.hoisted(() => vi.fn());
vi.mock('../termination-coordinator.js', () => ({
  requestExecutorTermination: requestTermination,
}));

import { TaskRuntimeReconciler } from './task-runtime-reconciler.js';

describe('remote pre-connect startup policy', () => {
  it.each([false, true])(
    'warns without automatic containment even with a cleanup helper (%s)',
    async (configured) => {
      requestTermination.mockClear();
      const task = {
        task_id: 'task-a',
        session_id: 'session-a',
        status: TaskStatus.DISPATCHING,
        executor_mode: 'templated',
      };
      const warning = vi.fn().mockResolvedValue(task);
      const get = vi.fn(async () => {
        expect(getCurrentTenantId()).toBe('tenant-a');
        return task;
      });
      const reconciler = new TaskRuntimeReconciler({
        app: {
          get: () => ({
            execution: { executor_cleanup_command_template: configured ? 'helper' : undefined },
          }),
          service: () => ({ get, recordExecutorStartupWarning: warning }),
        } as never,
        db: {} as never,
        config: { interval_ms: 1000 } as never,
        workIdentity: { instanceId: 'test', bootId: 'test' },
      });
      // Bounded routing fixture: discovery already proved the startup deadline.
      Reflect.set(reconciler, 'discoverCandidates', async () => [
        {
          task_id: task.task_id,
          tenant_id: 'tenant-a',
          kind: 'dispatch_timeout',
        },
      ]);
      Reflect.set(
        reconciler,
        'runInFreshTenantWriteDatabase',
        async (tenant: string, work: () => Promise<unknown>) => {
          expect(tenant).toBe('tenant-a');
          expect(getCurrentTenantId()).toBe(tenant);
          return work();
        }
      );
      expect(await reconciler.checkOnce()).toMatchObject({ processed: 1, failures: 0 });
      expect(warning).toHaveBeenCalledWith(
        task.task_id,
        expect.stringContaining('still waiting'),
        expect.objectContaining({ tenant: expect.objectContaining({ tenant_id: 'tenant-a' }) })
      );
      expect(requestTermination).not.toHaveBeenCalled();
    }
  );
});
