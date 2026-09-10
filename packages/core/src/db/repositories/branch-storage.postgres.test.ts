import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateId } from '../../lib/ids';
import { createDatabase, type Database } from '../client';
import { initializeDatabase } from '../migrate';
import { runWithTenantDatabaseScope } from '../tenant-scope';
import { BranchStorageRepository } from './branch-storage';
import { BranchRepository } from './branches';
import { seedEnvironmentCommandBranch } from './environment-commands.test-support';

const url = process.env.AGOR_TEST_POSTGRES_URL;
describe.skipIf(!url || process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'cold storage PostgreSQL/RLS',
  () => {
    let db: Database;
    beforeAll(async () => {
      db = createDatabase({ dialect: 'postgresql', url: url! });
      await initializeDatabase(db);
    });
    afterAll(async () => {
      await (db as Database & { $client: { end(): Promise<void> } }).$client.end();
    });
    it('fences competing operations and hides foreign receipts/admissions even with a known branch ID', async () => {
      const tenantA = `storage-a-${generateId()}`;
      const branch = await runWithTenantDatabaseScope(db, tenantA, async (scoped) => {
        const { branch } = await seedEnvironmentCommandBranch(scoped);
        return new BranchRepository(scoped).update(branch.branch_id, { storage_mode: 'clone' });
      });
      const results = await Promise.allSettled(
        Array.from({ length: 2 }, () =>
          runWithTenantDatabaseScope(db, tenantA, (scoped) =>
            new BranchStorageRepository(scoped).beginCooling(branch.branch_id)
          )
        )
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      await runWithTenantDatabaseScope(db, `storage-b-${generateId()}`, async (scoped) => {
        const storage = new BranchStorageRepository(scoped);
        await expect(storage.get(branch.branch_id)).rejects.toThrow('not found');
        await expect(storage.admitFilesystem(branch.branch_id)).rejects.toThrow('not found');
        await expect(storage.beginCooling(branch.branch_id)).rejects.toThrow('not found');
        expect(await new BranchRepository(scoped).findById(branch.branch_id)).toBeNull();
      });
    });
  }
);
