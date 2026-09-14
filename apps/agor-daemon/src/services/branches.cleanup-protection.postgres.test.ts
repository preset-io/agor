import {
  BranchRepository,
  createDatabase,
  type Database,
  generateId,
  initializeDatabase,
  runWithTenantDatabaseScope,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedEnvironmentCommandBranch } from '../../../../packages/core/src/db/repositories/environment-commands.test-support';
import { BranchesService } from './branches';

const url = process.env.AGOR_TEST_POSTGRES_URL;
const app = { get: () => ({}) } as unknown as Application;

describe.skipIf(!url || process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'cleanup protection tenant boundary',
  () => {
    let db: Database;
    beforeAll(async () => {
      db = createDatabase({ dialect: 'postgresql', url: url! });
      await initializeDatabase(db);
    });
    afterAll(async () => {
      if (db) await (db as Database & { $client: { end(): Promise<void> } }).$client.end();
    });

    it('refuses a foreign branch even with its owner identity, without changing protection', async () => {
      const tenantA = `cleanup-a-${generateId()}`;
      const tenantB = `cleanup-b-${generateId()}`;
      const { branch, user } = await runWithTenantDatabaseScope(db, tenantB, (scoped) =>
        seedEnvironmentCommandBranch(scoped)
      );
      await runWithTenantDatabaseScope(db, tenantA, async (scoped) => {
        const service = new BranchesService(scoped, app);
        await expect(
          service.patch(branch.branch_id, { cleanup_protected: true }, { user })
        ).rejects.toThrow(/not found/i);
        await expect(
          service.update(branch.branch_id, { cleanup_protected: true }, { user })
        ).rejects.toThrow(/not found/i);
        expect(await new BranchRepository(scoped).findById(branch.branch_id)).toBeNull();
      });
      await runWithTenantDatabaseScope(db, tenantB, async (scoped) => {
        expect(
          (await new BranchRepository(scoped).findById(branch.branch_id))?.cleanup_protected
        ).toBe(false);
        await expect(
          new BranchesService(scoped, app).patch(
            branch.branch_id,
            { cleanup_protected: true },
            { user }
          )
        ).resolves.toMatchObject({ cleanup_protected: true });
      });
    });
  }
);
