/** PostgreSQL coverage for branch filesystem lifecycle compare-and-set updates. */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateId } from '../lib/ids';
import type { BranchID, TenantID } from '../types';
import { createDatabase, type Database } from './client';
import { lockRowForUpdate, txAsDb, update } from './database-wrapper';
import { initializeDatabase } from './migrate';
import {
  BranchFilesystemStatusConflictError,
  BranchRepository,
  RepoRepository,
  UsersRepository,
} from './repositories';
import { branches } from './schema';
import { runWithTenantDatabaseScope } from './tenant-scope';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';

describe.skipIf(!postgresUrl || !usesPostgresSchema)(
  'branch filesystem lifecycle CAS (PostgreSQL)',
  () => {
    let dbA: Database;
    let dbB: Database;

    beforeAll(async () => {
      dbA = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      dbB = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      await initializeDatabase(dbA);
    });

    afterAll(async () => {
      await Promise.all([
        (dbA as Database & { $client: { end: () => Promise<void> } }).$client.end(),
        (dbB as Database & { $client: { end: () => Promise<void> } }).$client.end(),
      ]);
    });

    it('re-reads the locked status and rejects unarchive after deletion starts', async () => {
      const tenantId = `branch-lifecycle-${generateId()}` as TenantID;
      const branch = await runWithTenantDatabaseScope(dbA, tenantId, async (scoped) => {
        const user = await new UsersRepository(scoped).create({
          email: `${generateId()}@example.com`,
          name: 'Branch lifecycle CAS',
        });
        const repo = await new RepoRepository(scoped).create({
          repo_id: generateId(),
          slug: `branch-lifecycle-${generateId()}`,
          name: 'Branch lifecycle CAS',
          repo_type: 'remote',
          remote_url: 'https://example.invalid/repo.git',
          local_path: `/tmp/${generateId()}`,
          default_branch: 'main',
        });
        return new BranchRepository(scoped).create({
          branch_id: generateId() as BranchID,
          repo_id: repo.repo_id,
          name: `branch-lifecycle-${generateId()}`,
          ref: 'main',
          branch_unique_id: Date.now() % 2_000_000_000,
          path: `/tmp/${generateId()}`,
          created_by: user.user_id,
          archived: true,
          filesystem_status: 'delete_failed',
        });
      });

      let releaseDeletion!: () => void;
      let reportLockHeld!: () => void;
      const deletionMayCommit = new Promise<void>((resolve) => {
        releaseDeletion = resolve;
      });
      const lockHeld = new Promise<void>((resolve) => {
        reportLockHeld = resolve;
      });

      const deletionTransition = runWithTenantDatabaseScope(dbA, tenantId, (scoped) =>
        scoped.transaction(async (tx) => {
          await lockRowForUpdate(
            txAsDb(tx),
            scoped,
            branches,
            eq(branches.branch_id, branch.branch_id)
          );
          reportLockHeld();
          await deletionMayCommit;
          await update(txAsDb(tx), branches)
            .set({ filesystem_status: 'deleting' })
            .where(eq(branches.branch_id, branch.branch_id))
            .run();
        })
      );

      await lockHeld;
      const unarchiveTransition = runWithTenantDatabaseScope(dbB, tenantId, (scoped) =>
        new BranchRepository(scoped).update(
          branch.branch_id,
          { archived: false, filesystem_status: undefined },
          { rejectFilesystemStatuses: ['deleting'] }
        )
      );
      const unarchiveAssertion = expect(unarchiveTransition).rejects.toBeInstanceOf(
        BranchFilesystemStatusConflictError
      );

      releaseDeletion();
      await deletionTransition;
      await unarchiveAssertion;

      await expect(
        runWithTenantDatabaseScope(dbA, tenantId, (scoped) =>
          new BranchRepository(scoped).findById(branch.branch_id)
        )
      ).resolves.toMatchObject({ archived: true, filesystem_status: 'deleting' });
    });
  }
);
