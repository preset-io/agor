import {
  BranchRepository,
  createDatabase,
  type Database,
  generateId,
  initializeDatabase,
  RepoCloneNotReadyError,
  RepoRepository,
  runWithTenantDatabaseScope,
  runWithTenantDatabaseTransaction,
  UsersRepository,
} from '@agor/core/db';
import type { BranchID, TenantID, UUID } from '@agor/core/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';

describe.skipIf(!postgresUrl || !usesPostgresSchema)(
  'repository removal PostgreSQL concurrency',
  () => {
    let dbA: Database;
    let dbB: Database;

    beforeAll(async () => {
      dbA = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      dbB = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      await initializeDatabase(dbA);
    });

    afterAll(async () => {
      await Promise.all(
        [dbA, dbB].map((database) =>
          (database as Database & { $client: { end: () => Promise<void> } }).$client.end()
        )
      );
    });

    it('blocks a branch FK insert after the parent inventory lock and rejects it after delete', async () => {
      const tenantId = `repo-delete-lock-${generateId()}` as TenantID;
      const { ownerId, repo } = await runWithTenantDatabaseScope(dbA, tenantId, async (scoped) => {
        const owner = await new UsersRepository(scoped).create({
          email: `${generateId()}@repo-delete-lock.test`,
          role: 'member',
        });
        const repo = await new RepoRepository(scoped).create({
          repo_id: generateId() as UUID,
          slug: `repo-delete-lock-${generateId()}`,
          name: 'Repository delete lock',
          repo_type: 'remote',
          remote_url: 'https://example.invalid/repo-delete-lock.git',
          local_path: `/tmp/${generateId()}`,
          default_branch: 'main',
        });
        return { ownerId: owner.user_id, repo };
      });

      let reportLocked!: () => void;
      const locked = new Promise<void>((resolve) => {
        reportLocked = resolve;
      });
      let releaseDelete!: () => void;
      const mayDelete = new Promise<void>((resolve) => {
        releaseDelete = resolve;
      });

      const deletion = runWithTenantDatabaseTransaction(dbA, tenantId, async (scoped) => {
        const repoRepository = new RepoRepository(scoped);
        const branchRepository = new BranchRepository(scoped);
        await repoRepository.lockForBranchInventory(repo.repo_id);
        expect(await branchRepository.findAllByRepoId(repo.repo_id)).toEqual([]);
        reportLocked();
        await mayDelete;
        await repoRepository.delete(repo.repo_id);
      });
      await locked;

      let reportInsertStarted!: () => void;
      const insertStarted = new Promise<void>((resolve) => {
        reportInsertStarted = resolve;
      });
      const branchId = generateId() as BranchID;
      const insertion = runWithTenantDatabaseScope(dbB, tenantId, async (scoped) => {
        reportInsertStarted();
        return new BranchRepository(scoped).create({
          branch_id: branchId,
          repo_id: repo.repo_id,
          created_by: ownerId,
          name: 'concurrent-branch',
          ref: 'main',
          branch_unique_id: 9_100_001,
          path: `/tmp/${branchId}`,
        });
      });
      await insertStarted;

      const insertionState = await Promise.race([
        insertion.then(
          () => 'settled' as const,
          () => 'settled' as const
        ),
        new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 200)),
      ]);
      releaseDelete();

      await expect(deletion).resolves.toBeUndefined();
      await expect(insertion).rejects.toThrow();
      expect(insertionState).toBe('blocked');
      await runWithTenantDatabaseScope(dbA, tenantId, async (scoped) => {
        expect(await new RepoRepository(scoped).findById(repo.repo_id)).toBeNull();
        expect(await new BranchRepository(scoped).findById(branchId)).toBeNull();
      });
    }, 10_000);

    it('serializes clone settlement before branch materialization admission', async () => {
      const tenantId = `repo-clone-lock-${generateId()}` as TenantID;
      const { ownerId, repo } = await runWithTenantDatabaseScope(dbA, tenantId, async (scoped) => {
        const owner = await new UsersRepository(scoped).create({
          email: `${generateId()}@repo-clone-lock.test`,
          role: 'member',
        });
        const repo = await new RepoRepository(scoped).create({
          repo_id: generateId() as UUID,
          slug: `repo-clone-lock-${generateId()}`,
          name: 'Repository clone lock',
          repo_type: 'remote',
          remote_url: 'https://example.invalid/repo-clone-lock.git',
          local_path: `/tmp/${generateId()}`,
          clone_status: 'cloning',
        });
        return { ownerId: owner.user_id, repo };
      });

      await expect(
        runWithTenantDatabaseScope(dbB, tenantId, (scoped) =>
          new BranchRepository(scoped).create({
            branch_id: generateId() as BranchID,
            repo_id: repo.repo_id,
            created_by: ownerId,
            name: 'premature-branch',
            ref: 'main',
            branch_unique_id: 9_100_002,
            path: `/tmp/${generateId()}`,
          })
        )
      ).rejects.toBeInstanceOf(RepoCloneNotReadyError);

      let reportLocked!: () => void;
      const locked = new Promise<void>((resolve) => {
        reportLocked = resolve;
      });
      let releaseSettlement!: () => void;
      const maySettle = new Promise<void>((resolve) => {
        releaseSettlement = resolve;
      });

      const settlement = runWithTenantDatabaseTransaction(dbA, tenantId, async (scoped) => {
        const repoRepository = new RepoRepository(scoped);
        await repoRepository.lockForBranchInventory(repo.repo_id);
        reportLocked();
        await maySettle;
        await repoRepository.settleClone({
          repo_id: repo.repo_id,
          clone_status: 'ready',
          default_branch: 'main',
        });
      });
      await locked;

      const branchId = generateId() as BranchID;
      const insertion = runWithTenantDatabaseScope(dbB, tenantId, (scoped) =>
        new BranchRepository(scoped).create({
          branch_id: branchId,
          repo_id: repo.repo_id,
          created_by: ownerId,
          name: 'after-clone-settlement',
          ref: 'main',
          branch_unique_id: 9_100_003,
          path: `/tmp/${branchId}`,
        })
      );

      const insertionState = await Promise.race([
        insertion.then(
          () => 'settled' as const,
          () => 'settled' as const
        ),
        new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 200)),
      ]);
      expect(insertionState).toBe('blocked');

      releaseSettlement();
      await expect(settlement).resolves.toBeUndefined();
      await expect(insertion).resolves.toMatchObject({ branch_id: branchId });
    }, 10_000);
  }
);
