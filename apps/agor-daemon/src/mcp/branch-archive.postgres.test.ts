import {
  BranchRepository,
  branches,
  createDatabase,
  type Database,
  eq,
  generateId,
  initializeDatabase,
  runWithTenantDatabaseScope,
  select,
  UserApiKeysRepository,
} from '@agor/core/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedEnvironmentCommandBranch } from '../../../../packages/core/src/db/repositories/environment-commands.test-support';
import { archiveMcpFixture } from '../../test/branch-archive-fixture';

const url = process.env.AGOR_TEST_POSTGRES_URL;
describe.skipIf(!url || process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'authenticated MCP archive RLS',
  () => {
    let db: Database;
    beforeAll(async () => {
      db = createDatabase({ dialect: 'postgresql', url: url! });
      await initializeDatabase(db);
    });
    afterAll(async () => {
      if (db) await (db as Database & { $client: { end(): Promise<void> } }).$client.end();
    });
    it('denies every foreign archive action before mutation, then permits owner Preserve', async () => {
      const tenantA = `archive-a-${generateId()}`;
      const tenantB = `archive-b-${generateId()}`;
      async function seed(tenant: string) {
        return runWithTenantDatabaseScope(db, tenant, async (scoped) => {
          const data = await seedEnvironmentCommandBranch(scoped);
          const { rawKey } = await new UserApiKeysRepository(scoped).create(
            data.user.user_id,
            'archive fixture'
          );
          return { ...data, rawKey };
        });
      }
      const owner = await seed(tenantA);
      const other = await seed(tenantB);
      const fixture = await archiveMcpFixture(db, true);
      try {
        for (const filesystemAction of [undefined, 'preserved', 'cleaned', 'deleted']) {
          const response = await fixture.call(
            other.rawKey,
            'agor_branches_archive',
            {
              branchId: owner.branch.branch_id,
              ...(filesystemAction ? { filesystemAction } : {}),
            },
            true,
            tenantB
          );
          expect(response.status).toBe(200);
          expect(response.result?.isError).toBe(true);
          expect(JSON.parse(response.result!.content[0]!.text)).toMatchObject({
            error: expect.stringMatching(/Branch.*not found/i),
            tool: 'agor_branches_archive',
          });
          await runWithTenantDatabaseScope(db, tenantA, async (scoped) => {
            // Public Branch projections intentionally hide the private claim.
            const row = await select(scoped)
              .from(branches)
              .where(eq(branches.branch_id, owner.branch.branch_id))
              .one();
            expect(row).toBeDefined();
            expect(row!.data.workspace_operation).toBeUndefined();
            expect(row!.data.maintenance).toBeUndefined();
          });
        }
        const mismatchedKey = await fixture.call(
          owner.rawKey,
          'agor_branches_archive',
          { branchId: owner.branch.branch_id },
          false,
          tenantB
        );
        expect(mismatchedKey.status).toBe(401);
        await runWithTenantDatabaseScope(db, tenantA, async (scoped) => {
          expect(await new BranchRepository(scoped).findById(owner.branch.branch_id)).toMatchObject(
            { archived: false, filesystem_status: 'ready' }
          );
        });
        const accepted = await fixture.call(
          owner.rawKey,
          'agor_branches_archive',
          { branchId: owner.branch.branch_id, filesystemAction: 'preserved' },
          true,
          tenantA
        );
        expect(accepted.result?.isError, JSON.stringify(accepted)).not.toBe(true);
        expect(accepted.error).toBeUndefined();
        await runWithTenantDatabaseScope(db, tenantA, async (scoped) => {
          expect(await new BranchRepository(scoped).findById(owner.branch.branch_id)).toMatchObject(
            {
              archived: true,
              filesystem_status: 'ready',
              workspace_operation: { status: 'succeeded' },
            }
          );
        });
        await runWithTenantDatabaseScope(db, tenantB, async (scoped) => {
          expect(await new BranchRepository(scoped).findById(other.branch.branch_id)).toMatchObject(
            { archived: false, filesystem_status: 'ready' }
          );
        });
      } finally {
        await fixture.close();
      }
    });
  }
);
