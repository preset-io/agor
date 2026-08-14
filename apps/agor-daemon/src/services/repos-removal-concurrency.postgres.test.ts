import {
  BranchRepository,
  createDatabase,
  type Database,
  generateId,
  initializeDatabase,
  RepoRepository,
  runWithTenantDatabaseScope,
  runWithTenantDatabaseTransaction,
} from '@agor/core/db';
import type {
  BranchFilesystemOperationID,
  BranchID,
  RepoFilesystemOperationID,
  TenantID,
  UUID,
} from '@agor/core/types';
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
      const repo = await runWithTenantDatabaseScope(dbA, tenantId, (scoped) =>
        new RepoRepository(scoped).create({
          repo_id: generateId() as UUID,
          slug: `repo-delete-lock-${generateId()}`,
          name: 'Repository delete lock',
          repo_type: 'remote',
          remote_url: 'https://example.invalid/repo-delete-lock.git',
          local_path: `/tmp/${generateId()}`,
          default_branch: 'main',
        })
      );

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
          created_by: generateId() as UUID,
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

    it('rejects branch insertion throughout the filesystem pre-delete window', async () => {
      const tenantId = `repo-delete-reservation-${generateId()}` as TenantID;
      const repo = await runWithTenantDatabaseScope(dbA, tenantId, (scoped) =>
        new RepoRepository(scoped).create({
          repo_id: generateId() as UUID,
          slug: `repo-delete-reservation-${generateId()}`,
          name: 'Repository delete reservation',
          repo_type: 'remote',
          remote_url: 'https://example.invalid/repo-delete-reservation.git',
          local_path: `/tmp/${generateId()}`,
          default_branch: 'main',
          clone_status: 'ready',
        })
      );
      const operationId = generateId() as RepoFilesystemOperationID;
      await runWithTenantDatabaseScope(dbA, tenantId, async (scoped) => {
        const claimed = await new RepoRepository(scoped).claimFilesystemDeletion(
          repo.repo_id,
          operationId,
          'deleted'
        );
        expect(claimed).toMatchObject({
          filesystem_status: 'deleting',
          filesystem_operation_id: operationId,
        });
      });

      const branchId = generateId() as BranchID;
      await expect(
        runWithTenantDatabaseScope(dbB, tenantId, (scoped) =>
          new BranchRepository(scoped).create({
            branch_id: branchId,
            repo_id: repo.repo_id,
            created_by: generateId() as UUID,
            name: 'too-late',
            ref: 'main',
            branch_unique_id: 9_100_002,
            path: `/tmp/${branchId}`,
          })
        )
      ).rejects.toThrow(/repository deletion/);

      await runWithTenantDatabaseScope(dbA, tenantId, async (scoped) => {
        expect(await new BranchRepository(scoped).findById(branchId)).toBeNull();
      });
    }, 10_000);

    it('serializes unarchive materialization before repository deletion and makes deletion lose', async () => {
      const tenantId = `repo-delete-unarchive-${generateId()}` as TenantID;
      const repo = await runWithTenantDatabaseScope(dbA, tenantId, (scoped) =>
        new RepoRepository(scoped).create({
          repo_id: generateId() as UUID,
          slug: `repo-delete-unarchive-${generateId()}`,
          name: 'Repository delete versus unarchive',
          repo_type: 'remote',
          remote_url: 'https://example.invalid/repo-delete-unarchive.git',
          local_path: `/tmp/${generateId()}`,
          default_branch: 'main',
          clone_status: 'ready',
        })
      );
      const branchId = generateId() as BranchID;
      await runWithTenantDatabaseScope(dbA, tenantId, (scoped) =>
        new BranchRepository(scoped).create({
          branch_id: branchId,
          repo_id: repo.repo_id,
          created_by: generateId() as UUID,
          name: 'archived-branch',
          ref: 'main',
          branch_unique_id: 9_100_003,
          path: `/tmp/${branchId}`,
          archived: true,
          filesystem_status: 'deleted',
        })
      );

      let reportReserved!: () => void;
      const reserved = new Promise<void>((resolve) => {
        reportReserved = resolve;
      });
      let releaseUnarchive!: () => void;
      const mayCommit = new Promise<void>((resolve) => {
        releaseUnarchive = resolve;
      });
      const branchOperationId = generateId() as BranchFilesystemOperationID;
      const unarchive = runWithTenantDatabaseTransaction(dbA, tenantId, async (scoped) => {
        const updated = await new BranchRepository(scoped).update(
          branchId,
          {
            archived: false,
            filesystem_status: 'creating',
            filesystem_operation_id: branchOperationId,
          },
          {
            expectedFilesystemLifecycle: {
              archived: true,
              filesystemStatuses: ['deleted'],
              operationId: null,
            },
            reserveParentRepoForMaterialization: true,
          }
        );
        reportReserved();
        await mayCommit;
        return updated;
      });
      await reserved;

      const deletion = runWithTenantDatabaseScope(dbB, tenantId, (scoped) =>
        new RepoRepository(scoped).claimFilesystemDeletion(
          repo.repo_id,
          generateId() as RepoFilesystemOperationID,
          'deleted'
        )
      );
      const deletionState = await Promise.race([
        deletion.then(
          () => 'settled' as const,
          () => 'settled' as const
        ),
        new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 200)),
      ]);
      releaseUnarchive();

      await expect(unarchive).resolves.toMatchObject({
        archived: false,
        filesystem_status: 'creating',
        filesystem_operation_id: branchOperationId,
      });
      await expect(deletion).rejects.toThrow(/in-flight branch filesystem operation/i);
      expect(deletionState).toBe('blocked');
    }, 10_000);

    it('rejects unarchive materialization after repository deletion is reserved', async () => {
      const tenantId = `repo-delete-wins-unarchive-${generateId()}` as TenantID;
      const repo = await runWithTenantDatabaseScope(dbA, tenantId, (scoped) =>
        new RepoRepository(scoped).create({
          repo_id: generateId() as UUID,
          slug: `repo-delete-wins-unarchive-${generateId()}`,
          name: 'Repository deletion wins versus unarchive',
          repo_type: 'remote',
          remote_url: 'https://example.invalid/repo-delete-wins.git',
          local_path: `/tmp/${generateId()}`,
          default_branch: 'main',
          clone_status: 'ready',
        })
      );
      const branchId = generateId() as BranchID;
      await runWithTenantDatabaseScope(dbA, tenantId, (scoped) =>
        new BranchRepository(scoped).create({
          branch_id: branchId,
          repo_id: repo.repo_id,
          created_by: generateId() as UUID,
          name: 'archived-branch',
          ref: 'main',
          branch_unique_id: 9_100_004,
          path: `/tmp/${branchId}`,
          archived: true,
          filesystem_status: 'deleted',
        })
      );
      await runWithTenantDatabaseScope(dbA, tenantId, (scoped) =>
        new RepoRepository(scoped).claimFilesystemDeletion(
          repo.repo_id,
          generateId() as RepoFilesystemOperationID,
          'deleted'
        )
      );

      await expect(
        runWithTenantDatabaseScope(dbB, tenantId, (scoped) =>
          new BranchRepository(scoped).update(
            branchId,
            { archived: false, filesystem_status: 'creating' },
            { reserveParentRepoForMaterialization: true }
          )
        )
      ).rejects.toThrow(/deletion must be completed or recovered/i);
    }, 10_000);
  }
);
