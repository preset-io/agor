import { spawn } from 'node:child_process';
import {
  BranchMaintenanceRepository,
  BranchRepository,
  createTenantScopedDatabaseProxy,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { BranchMaintenanceExecutionProcess } from '@agor/core/types';
import { describe, expect, vi } from 'vitest';
import { seedEnvironmentCommandBranch } from '../../../../packages/core/src/db/repositories/environment-commands.test-support';
import { ownedDbTest as test } from '../../../../packages/core/src/db/test-helpers';
import { captureLocalProcessGroupIdentity } from '../executor-tracking';
import {
  BranchDeletionReconciler,
  INTERRUPTED_DELETION_SUMMARY,
  releaseDeletionIfExecutorAbsent,
} from './branch-deletion-reconciler';

test('existing-loop observer marks stale deletion failed but cannot dispatch or release an unknown invocation', async ({
  db,
}) => {
  const { branch } = await seedEnvironmentCommandBranch(db);
  const maintenance = new BranchMaintenanceRepository(db);
  const { claim } = await maintenance.claim(branch.branch_id, 'delete');
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    vi.setSystemTime(new Date('2026-09-15T00:00:00Z'));
    const invocation = await maintenance.beginExecution(claim);
    await maintenance.claimExecution(claim, invocation);
    const emit = vi.fn();
    const observer = new BranchDeletionReconciler(
      createTenantScopedDatabaseProxy(db, { requireScope: true }),
      { service: () => ({ emit }) } as unknown as Application,
      'default'
    );
    await observer.checkOnce();
    expect((await new BranchRepository(db).findById(branch.branch_id))?.deletion_status).toBe(
      'deleting'
    );
    vi.setSystemTime(new Date('2026-09-15T00:03:00Z'));
    await observer.checkOnce();
    expect((await new BranchRepository(db).findById(branch.branch_id))?.deletion_status).toBe(
      'deletion_failed'
    );
    expect((await maintenance.claim(branch.branch_id, 'delete')).acquired).toBe(false);
    await expect(maintenance.beginExecution(claim)).rejects.toThrow();
  } finally {
    vi.useRealTimers();
  }
});

describe.runIf(process.platform === 'linux')('verified local executor exit', () => {
  async function seedRecordedDeletion(
    db: Parameters<Parameters<typeof test>[1]>[0]['db'],
    identity: BranchMaintenanceExecutionProcess
  ) {
    const { branch } = await seedEnvironmentCommandBranch(db);
    const maintenance = new BranchMaintenanceRepository(db);
    const { claim } = await maintenance.claim(branch.branch_id, 'delete');
    const invocation = await maintenance.beginExecution(claim);
    expect(await maintenance.recordExecutionProcess(claim, invocation, identity)).toBe(true);
    await maintenance.claimExecution(claim, invocation);
    const observer = new BranchDeletionReconciler(
      createTenantScopedDatabaseProxy(db, { requireScope: true }),
      { service: () => ({ emit: vi.fn() }) } as unknown as Application,
      'default'
    );
    return { branch, maintenance, claim, invocation, observer };
  }

  test('releases a deletion only after its recorded process group is gone', async ({ db }) => {
    const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
    try {
      const identity = captureLocalProcessGroupIdentity(child.pid!)!;
      const { branch, maintenance, claim, invocation, observer } = await seedRecordedDeletion(
        db,
        identity
      );
      await observer.checkOnce();
      expect(await new BranchRepository(db).findById(branch.branch_id)).toMatchObject({
        deletion_status: 'deleting',
      });
      const exited = new Promise((resolve) => child.once('exit', resolve));
      process.kill(-child.pid!, 'SIGKILL');
      await exited;
      await observer.checkOnce();
      expect(await new BranchRepository(db).findById(branch.branch_id)).toMatchObject({
        deletion_status: 'deletion_failed',
        deletion_error: INTERRUPTED_DELETION_SUMMARY,
      });
      await expect(maintenance.heartbeatExecution(claim, invocation)).rejects.toThrow(
        'ownership changed'
      );
      expect((await maintenance.claim(branch.branch_id, 'delete')).acquired).toBe(true);
    } finally {
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {}
    }
  });

  for (const other of ['pid_namespace', 'boot_id'] as const) {
    test(`never releases an executor recorded under another ${other}`, async ({ db }) => {
      const local = captureLocalProcessGroupIdentity(process.pid)!;
      // An absent PGID here says nothing about a group in another namespace.
      const identity = { ...local, pid: 2 ** 22 + 17, [other]: 'elsewhere' };
      const { branch, maintenance, observer } = await seedRecordedDeletion(db, identity);
      await observer.checkOnce();
      expect(
        await releaseDeletionIfExecutorAbsent(
          createTenantScopedDatabaseProxy(db, { requireScope: true }),
          { service: () => ({ emit: vi.fn() }) } as unknown as Application,
          'default',
          branch.branch_id,
          'released'
        )
      ).toBe(false);
      expect((await new BranchRepository(db).findById(branch.branch_id))?.deletion_status).toBe(
        'deleting'
      );
      expect((await maintenance.claim(branch.branch_id, 'delete')).acquired).toBe(false);
    });
  }
});
