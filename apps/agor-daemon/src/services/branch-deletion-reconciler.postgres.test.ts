import { spawn } from 'node:child_process';
import {
  BranchMaintenanceRepository,
  BranchRepository,
  branches,
  createDatabase,
  createTenantScopedDatabaseProxy,
  eq,
  generateId,
  initializeDatabase,
  runWithTenantDatabaseScope,
  update,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import { expect, it, vi } from 'vitest';
import { seedEnvironmentCommandBranch } from '../../../../packages/core/src/db/repositories/environment-commands.test-support';
import * as tracking from '../executor-tracking';
import {
  BranchDeletionReconciler,
  INTERRUPTED_DELETION_SUMMARY,
} from './branch-deletion-reconciler';

const url = process.env.AGOR_TEST_POSTGRES_URL;

it.skipIf(!url || process.env.AGOR_DB_DIALECT !== 'postgresql' || process.platform !== 'linux')(
  'the executor host releases a failed deletion after a foreign-namespace replica marks it stale',
  async () => {
    const raw = createDatabase({ dialect: 'postgresql', url: url! });
    const db = createTenantScopedDatabaseProxy(raw, { requireScope: true });
    const child = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
    try {
      await initializeDatabase(raw);
      const tenant = `deletion-reconcile-${generateId()}`;
      const identity = tracking.captureLocalProcessGroupIdentity(child.pid!)!;
      expect(identity).toBeDefined();
      const { branch, claim, invocation } = await runWithTenantDatabaseScope(
        db,
        tenant,
        async (tx) => {
          const { branch } = await seedEnvironmentCommandBranch(tx);
          const maintenance = new BranchMaintenanceRepository(tx);
          const { claim } = await maintenance.claim(branch.branch_id, 'delete');
          const invocation = await maintenance.beginExecution(claim);
          await maintenance.recordExecutionProcess(claim, invocation, identity);
          await maintenance.claimExecution(claim, invocation);
          await maintenance.withExecution(claim, invocation, async (scoped, row) => {
            await update(scoped, branches)
              .set({
                data: {
                  ...row.data,
                  maintenance: {
                    ...row.data.maintenance!,
                    execution_heartbeat_at: '2000-01-01T00:00:00.000Z',
                  },
                },
              })
              .where(eq(branches.branch_id, branch.branch_id))
              .run();
          });
          return { branch, claim, invocation };
        }
      );
      const app = { service: () => ({ emit: vi.fn() }) } as unknown as Application;
      // Both replicas use real cross-tenant discovery/RLS. Only the first
      // replica's host observation differs; it cannot inspect this PID namespace.
      const verify = tracking.verifyRecordedProcessGroupAbsent;
      vi.spyOn(tracking, 'verifyRecordedProcessGroupAbsent').mockImplementationOnce((recorded) =>
        verify({ ...recorded, pid_namespace: 'foreign-namespace' })
      );
      await new BranchDeletionReconciler(db, app).checkOnce();
      vi.restoreAllMocks();
      await runWithTenantDatabaseScope(db, tenant, async (tx) => {
        expect(await new BranchRepository(tx).findById(branch.branch_id)).toMatchObject({
          deletion_status: 'deletion_failed',
        });
        expect(
          (await new BranchMaintenanceRepository(tx).claim(branch.branch_id, 'delete')).acquired
        ).toBe(false);
      });

      // Even after stale marking, a live group must remain fenced.
      const host = new BranchDeletionReconciler(db, app);
      await host.checkOnce();
      await runWithTenantDatabaseScope(db, tenant, async (tx) => {
        expect(
          (await new BranchMaintenanceRepository(tx).claim(branch.branch_id, 'delete')).acquired
        ).toBe(false);
      });
      const exited = new Promise((resolve) => child.once('exit', resolve));
      process.kill(-child.pid!, 'SIGKILL');
      await exited;
      await host.checkOnce();
      await runWithTenantDatabaseScope(db, tenant, async (tx) => {
        expect(await new BranchRepository(tx).findById(branch.branch_id)).toMatchObject({
          deletion_status: 'deletion_failed',
          deletion_error: INTERRUPTED_DELETION_SUMMARY,
        });
        const maintenance = new BranchMaintenanceRepository(tx);
        const retry = await maintenance.claim(branch.branch_id, 'delete');
        expect(retry.acquired).toBe(true);
        expect(retry.claim.generation).toBe(claim.generation + 1);
        await expect(maintenance.heartbeatExecution(claim, invocation)).rejects.toThrow(
          'ownership changed'
        );
      });
    } finally {
      vi.restoreAllMocks();
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {}
      await (raw as typeof raw & { $client: { end(): Promise<void> } }).$client.end();
    }
  },
  60_000
);
