import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateId } from '../../lib/ids';
import type { BranchID, TenantID } from '../../types';
import { createDatabase, type Database } from '../client';
import { executeRaw } from '../database-wrapper';
import { initializeDatabase } from '../migrate';
import { createTenantScopedDatabaseProxy, runWithTenantDatabaseScope } from '../tenant-scope';
import { BranchRepository } from './branches';
import { RepoRepository } from './repos';
import { UsersRepository } from './users';

const url = process.env.AGOR_TEST_POSTGRES_URL;
describe.skipIf(!url || process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'provisioning across database connections under RLS',
  () => {
    let first: Database;
    let second: Database;
    beforeAll(async () => {
      first = createDatabase({ dialect: 'postgresql', url: url! });
      second = createDatabase({ dialect: 'postgresql', url: url! });
      await initializeDatabase(first);
      const result = await executeRaw(
        first,
        sql`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
      );
      expect(
        (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows)[0]
      ).toMatchObject({ rolsuper: false, rolbypassrls: false });
    }, 60_000);
    afterAll(async () => {
      for (const db of [first, second])
        await (db as Database & { $client: { end: () => Promise<void> } }).$client.end();
    });
    it('admits only one retry, fences stale outcomes and denies a foreign tenant', async () => {
      const a = `provision-a-${generateId()}` as TenantID;
      const b = `provision-b-${generateId()}` as TenantID;
      const one = createTenantScopedDatabaseProxy(first, { requireScope: true });
      const two = createTenantScopedDatabaseProxy(second, { requireScope: true });
      const branch = await runWithTenantDatabaseScope(one, a, async () => {
        const user = await new UsersRepository(one).create({
          email: 'owner@example.test',
          role: 'member',
        });
        const repo = await new RepoRepository(one).create({
          name: 'Fictional repo',
          slug: 'fictional/repo',
          repo_type: 'local',
          local_path: '/fictional/repo',
          default_branch: 'main',
        });
        return new BranchRepository(one).create({
          branch_id: generateId() as BranchID,
          repo_id: repo.repo_id,
          created_by: user.user_id,
          name: 'Fictional branch',
          ref: 'main',
          path: '/fictional/branch',
          branch_unique_id: 1,
          filesystem_status: 'failed',
          provisioning_attempt_id: 'old',
          provisioning_operation: 'restore',
        });
      });
      const claims = await Promise.all(
        [one, two].map((db, i) =>
          runWithTenantDatabaseScope(db, a, () =>
            new BranchRepository(db).claimFailedForProvisioningRetry(branch.branch_id, `new-${i}`)
          )
        )
      );
      expect(claims.filter((claim) => claim.claimed)).toHaveLength(1);
      const attempt = claims.find((claim) => claim.claimed)!.branch.provisioning_attempt_id;
      expect(claims.every((claim) => claim.branch.provisioning_operation === 'restore')).toBe(true);
      const stale = await runWithTenantDatabaseScope(two, a, () =>
        new BranchRepository(two).acknowledgeProvisioningAttempt(
          branch.branch_id,
          { filesystem_status: 'ready' },
          'old'
        )
      );
      expect(stale.applied).toBe(false);
      await runWithTenantDatabaseScope(two, b, async () => {
        expect(await new BranchRepository(two).findById(branch.branch_id)).toBeNull();
        await expect(
          new BranchRepository(two).acknowledgeProvisioningAttempt(
            branch.branch_id,
            { filesystem_status: 'ready' },
            attempt
          )
        ).rejects.toThrow();
      });
      const outcomes = await Promise.all(
        [one, two].map((db, i) =>
          runWithTenantDatabaseScope(db, a, () =>
            new BranchRepository(db).acknowledgeProvisioningAttempt(
              branch.branch_id,
              { filesystem_status: i === 0 ? 'ready' : 'failed' },
              attempt
            )
          )
        )
      );
      expect(outcomes.filter((outcome) => outcome.applied)).toHaveLength(1);
      const winner = outcomes.find((outcome) => outcome.applied)!.branch.filesystem_status;
      expect(outcomes.every((outcome) => outcome.branch.filesystem_status === winner)).toBe(true);
    });
  }
);
