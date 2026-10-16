import { expect, it } from 'vitest';
import { generateId } from '../lib/ids';
import { createDatabase } from './client';
import { runMigrations } from './migrate';
import {
  BranchMaintenanceDiscoveryRepository,
  BranchMaintenanceRepository,
} from './repositories/branch-maintenance';
import { BranchRepository } from './repositories/branches';
import { seedEnvironmentCommandBranch } from './repositories/environment-commands.test-support';
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
          maintenance.forceReleaseFailedDeletion(seeded.branch.branch_id, 'forged release')
        ).rejects.toThrow('not found');
      });

      await runWithTenantDatabaseScope(db, tenantA, async (scoped) => {
        expect(await new BranchRepository(scoped).findById(seeded.branch.branch_id)).toMatchObject({
          deletion_status: 'deleting',
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
        const retry = await maintenance.claim(seeded.branch.branch_id, 'delete');
        expect(retry).toMatchObject({ acquired: true });
        expect(retry.claim.generation).toBe(seeded.claim.generation + 1);
      });
    } finally {
      await (db as typeof db & { $client: { end(): Promise<void> } }).$client.end();
    }
  },
  60_000
);
