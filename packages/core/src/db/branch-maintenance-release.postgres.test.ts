import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { generateId } from '../lib/ids';
import type { BranchMaintenanceClaim } from '../types';
import { createDatabase } from './client';
import { select, update } from './database-wrapper';
import { runMigrations } from './migrate';
import {
  BranchMaintenanceDiscoveryRepository,
  BranchMaintenanceRepository,
} from './repositories/branch-maintenance';
import { BranchRepository } from './repositories/branches';
import { seedEnvironmentCommandBranch } from './repositories/environment-commands.test-support';
import { branches } from './schema';
import { runWithSystemDatabaseScope, runWithTenantDatabaseScope } from './tenant-scope';

const url = process.env.AGOR_TEST_POSTGRES_URL;
const executionProcess = { pid: 4242, boot_id: 'boot-fixture', pid_namespace: 'pid:[1]' };

it.skipIf(!url || process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'verified-exit release, administrator release and process discovery stay tenant-fenced',
  async () => {
    const db = createDatabase({ dialect: 'postgresql', url: url! });
    try {
      await runMigrations(db, { allowOfflineCutover: true });
      const tenantA = `release-a-${generateId()}`;
      const tenantB = `release-b-${generateId()}`;
      const seeded = await runWithTenantDatabaseScope(db, tenantA, async (scoped) => {
        const { branch } = await seedEnvironmentCommandBranch(scoped);
        const maintenance = new BranchMaintenanceRepository(scoped);
        const { claim } = await maintenance.claim(branch.branch_id, 'delete');
        const invocation = await maintenance.beginExecution(claim);
        expect(await maintenance.recordExecutionProcess(claim, invocation, executionProcess)).toBe(
          true
        );
        await maintenance.claimExecution(claim, invocation);
        return { branch, claim, invocation };
      });

      // Cross-tenant discovery (PostgreSQL RLS policy) sees the deleting row.
      const systemRefs = await runWithSystemDatabaseScope(
        db,
        'fixture discovery',
        (scoped) => new BranchMaintenanceDiscoveryRepository(scoped).findExecutionProcessRefs({}),
        { capability: 'branch_maintenance_discovery' }
      );
      expect(systemRefs).toContainEqual({ tenant_id: tenantA, branch_id: seeded.branch.branch_id });

      // A different replica can mark the heartbeat stale before the executor
      // host is available. Keep the invocation discoverable after that write.
      await runWithTenantDatabaseScope(db, tenantA, async (scoped) => {
        const maintenance = new BranchMaintenanceRepository(scoped);
        await maintenance.withExecution(seeded.claim, seeded.invocation, async (tx, row) => {
          await update(tx, branches)
            .set({
              data: {
                ...row.data,
                maintenance: {
                  ...row.data.maintenance!,
                  execution_heartbeat_at: '2000-01-01T00:00:00.000Z',
                },
              },
            })
            .where(eq(branches.branch_id, seeded.branch.branch_id))
            .run();
        });
        expect(await maintenance.markStaleDeletion(seeded.claim, 120_000)).toBe(true);
      });
      const discover = () =>
        runWithSystemDatabaseScope(
          db,
          'fixture recorded deletion discovery',
          (scoped) => new BranchMaintenanceDiscoveryRepository(scoped).findExecutionProcessRefs({}),
          { capability: 'branch_maintenance_discovery' }
        );
      expect(await discover()).toEqual(systemRefs);
      const readGlobalRows = () =>
        runWithSystemDatabaseScope(
          db,
          'fixture failed deletion policy boundary',
          (scoped) => select(scoped).from(branches).all(),
          { capability: 'branch_maintenance_discovery' }
        );
      const data = await runWithTenantDatabaseScope(db, tenantA, async (scoped) => {
        const row = await select(scoped)
          .from(branches)
          .where(eq(branches.branch_id, seeded.branch.branch_id))
          .one();
        return row!.data;
      });
      // A failed branch alone is not a routing capability. In particular,
      // legacy/remote invocations and other maintenance must remain hidden.
      const excluded: Array<BranchMaintenanceClaim | undefined> = [
        { ...data.maintenance!, execution_process: undefined },
        { ...data.maintenance!, execution_id: undefined },
        { ...data.maintenance!, kind: 'cleanup' },
        undefined,
      ];
      for (const maintenance of excluded) {
        await runWithTenantDatabaseScope(db, tenantA, (scoped) =>
          update(scoped, branches)
            .set({ data: { ...data, maintenance } })
            .where(eq(branches.branch_id, seeded.branch.branch_id))
            .run()
        );
        expect(await readGlobalRows()).toEqual([]);
      }
      await runWithTenantDatabaseScope(db, tenantA, (scoped) =>
        update(scoped, branches)
          .set({ data })
          .where(eq(branches.branch_id, seeded.branch.branch_id))
          .run()
      );
      expect(await discover()).toEqual(systemRefs);
      // Without the named capability, the failed row is not visible at all.
      expect(
        await runWithSystemDatabaseScope(db, 'fixture without discovery capability', (scoped) =>
          select(scoped).from(branches).all()
        )
      ).toEqual([]);

      await runWithTenantDatabaseScope(db, tenantB, async (scoped) => {
        const maintenance = new BranchMaintenanceRepository(scoped);
        expect(
          await new BranchMaintenanceDiscoveryRepository(scoped).findExecutionProcessRefs({
            tenantId: tenantB,
          })
        ).toEqual([]);
        await expect(
          maintenance.recordExecutionProcess(seeded.claim, seeded.invocation, executionProcess)
        ).rejects.toThrow('not found');
        expect(
          await maintenance.releaseVerifiedExitedDeletion(
            seeded.branch.branch_id,
            seeded.invocation,
            'forged release'
          )
        ).toBe(false);
        await expect(
          maintenance.forceReleaseFailedDeletion(seeded.branch.branch_id, 'forged release', {
            execution_id: seeded.invocation,
            execution_process: executionProcess,
          })
        ).rejects.toThrow('not found');
      });

      await runWithTenantDatabaseScope(db, tenantA, async (scoped) => {
        expect(await new BranchRepository(scoped).findById(seeded.branch.branch_id)).toMatchObject({
          deletion_status: 'deletion_failed',
        });
        const maintenance = new BranchMaintenanceRepository(scoped);
        expect(
          await maintenance.releaseVerifiedExitedDeletion(
            seeded.branch.branch_id,
            seeded.invocation,
            'Exited'
          )
        ).toBe(true);
        expect(await new BranchRepository(scoped).findById(seeded.branch.branch_id)).toMatchObject({
          deletion_status: 'deletion_failed',
          deletion_error: 'Exited',
        });
      });
      // Check the policy itself, not just the repository's additional filters:
      // settled failures no longer expose any branch row to global discovery.
      expect(await readGlobalRows()).toEqual([]);
      await runWithTenantDatabaseScope(db, tenantA, async (scoped) => {
        const maintenance = new BranchMaintenanceRepository(scoped);
        const retry = await maintenance.claim(seeded.branch.branch_id, 'delete');
        expect(retry).toMatchObject({ acquired: true });
        expect(retry.claim.generation).toBe(seeded.claim.generation + 1);
        const invocation = await maintenance.beginExecution(retry.claim);
        await maintenance.recordExecutionProcess(retry.claim, invocation, executionProcess);
        await maintenance.claimExecution(retry.claim, invocation);
        await maintenance.withExecution(retry.claim, invocation, async (tx, row) => {
          await update(tx, branches)
            .set({
              data: {
                ...row.data,
                maintenance: {
                  ...row.data.maintenance!,
                  execution_heartbeat_at: '2000-01-01T00:00:00.000Z',
                },
              },
            })
            .where(eq(branches.branch_id, seeded.branch.branch_id))
            .run();
        });
        expect(await maintenance.markStaleDeletion(retry.claim, 120_000)).toBe(true);
        for (const expected of [
          { execution_id: seeded.invocation, execution_process: executionProcess },
          { execution_id: invocation },
        ]) {
          await expect(
            maintenance.forceReleaseFailedDeletion(
              seeded.branch.branch_id,
              'Stale administrator snapshot',
              expected
            )
          ).rejects.toThrow('invocation changed');
        }
        expect((await maintenance.claim(seeded.branch.branch_id, 'delete')).acquired).toBe(false);
        await maintenance.forceReleaseFailedDeletion(
          seeded.branch.branch_id,
          'Administrator release',
          {
            execution_id: invocation,
            execution_process: executionProcess,
          }
        );
        expect((await maintenance.claim(seeded.branch.branch_id, 'delete')).acquired).toBe(true);
      });
    } finally {
      await (db as typeof db & { $client: { end(): Promise<void> } }).$client.end();
    }
  },
  60_000
);
