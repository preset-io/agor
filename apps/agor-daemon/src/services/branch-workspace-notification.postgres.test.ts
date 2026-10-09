import {
  BranchMaintenanceRepository,
  BranchRepository,
  BranchWorkspaceOperationRepository,
  createDatabase,
  createTenantScopedDatabaseProxy,
  type Database,
  generateId,
  initializeDatabase,
  runWithTenantDatabaseScope,
  UsersRepository,
} from '@agor/core/db';
import type { TenantID } from '@agor/core/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedEnvironmentCommandBranch } from '../../../../packages/core/src/db/repositories/environment-commands.test-support';
import { BranchWorkspaceNotificationService } from './branch-workspace-notification';

const url = process.env.AGOR_TEST_POSTGRES_URL;
describe.skipIf(!url || process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'workspace notification tenant boundary',
  () => {
    let db: Database;
    beforeAll(async () => {
      db = createDatabase({ dialect: 'postgresql', url: url! });
      await initializeDatabase(db);
    });
    afterAll(async () => {
      if (db) await (db as Database & { $client: { end(): Promise<void> } }).$client.end();
    });
    it('cannot dismiss another tenant’s notification even with its owner and operation IDs', async () => {
      const tenantA = `dismiss-a-${generateId()}` as TenantID;
      const tenantB = `dismiss-b-${generateId()}` as TenantID;
      const { branch, user, claim } = await runWithTenantDatabaseScope(
        db,
        tenantB,
        async (scoped) => {
          const { branch, user } = await seedEnvironmentCommandBranch(scoped);
          const { claim } = await new BranchMaintenanceRepository(scoped).claim(
            branch.branch_id,
            'cleanup',
            user.user_id
          );
          const operations = new BranchWorkspaceOperationRepository(scoped);
          await operations.prepare(
            claim,
            {
              operation_id: claim.operation_id,
              action: 'clean',
              filesystem_action: 'cleaned',
              status: 'accepted',
              requested_by: user.user_id,
              requested_at: new Date().toISOString(),
              deadline_at: new Date(Date.now() + 60_000).toISOString(),
            },
            { repo_id: branch.repo_id, path: branch.path, repo_path: '/tmp/environment-test' }
          );
          await operations.failBeforeExecution(claim);
          return { branch, user, claim };
        }
      );
      await runWithTenantDatabaseScope(db, tenantA, async (scoped) => {
        const localUser = await new UsersRepository(scoped).create({
          email: `${generateId()}@example.test`,
        });
        await expect(
          new BranchWorkspaceNotificationService(
            createTenantScopedDatabaseProxy(db, { requireScope: true })
          ).create(
            { operation_id: claim.operation_id },
            {
              user: localUser,
              tenant: { tenant_id: tenantA, source: 'explicit' },
              route: { id: branch.branch_id },
            }
          )
        ).rejects.toThrow('Branch not found');
        await expect(
          new BranchWorkspaceNotificationService(
            createTenantScopedDatabaseProxy(db, { requireScope: true })
          ).create(
            { operation_id: claim.operation_id },
            {
              user,
              tenant: { tenant_id: tenantA, source: 'explicit' },
              route: { id: branch.branch_id },
            }
          )
        ).rejects.toThrow(/Authentication required|Branch not found/);
      });
      await runWithTenantDatabaseScope(db, tenantB, async (scoped) => {
        expect(
          (await new BranchRepository(scoped).findById(branch.branch_id))?.workspace_operation
            ?.operation_id
        ).toBe(claim.operation_id);
        const result = await new BranchWorkspaceNotificationService(
          createTenantScopedDatabaseProxy(db, { requireScope: true })
        ).create(
          { operation_id: claim.operation_id },
          {
            user,
            tenant: { tenant_id: tenantB, source: 'explicit' },
            route: { id: branch.branch_id },
          }
        );
        expect(result.workspace_operation).toBeUndefined();
      });
    });
  }
);
