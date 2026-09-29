import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateId } from '../lib/ids';
import type { BranchID, TenantID } from '../types';
import { createDatabase, type Database } from './client';
import { initializeDatabase } from './migrate';
import {
  BranchRepository,
  EnvironmentSyncRepository,
  RepoRepository,
  UsersRepository,
} from './repositories';
import { runWithTenantDatabaseScope } from './tenant-scope';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';
const revision = 'a'.repeat(40);

describe.skipIf(!postgresUrl || !usesPostgresSchema)(
  'tenant-isolated source Sync (PostgreSQL)',
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

    it('cannot settle another tenant’s claimed revision', async () => {
      const tenantA = `sync-a-${generateId()}` as TenantID;
      const tenantB = `sync-b-${generateId()}` as TenantID;
      const branch = await runWithTenantDatabaseScope(dbA, tenantA, async (scoped) => {
        const user = await new UsersRepository(scoped).create({
          email: `${generateId()}@example.test`,
          name: 'Sync owner',
        });
        const repo = await new RepoRepository(scoped).create({
          slug: `sync-${generateId()}`,
          name: 'Sync',
          repo_type: 'local',
          local_path: `/tmp/${generateId()}`,
          default_branch: 'main',
        });
        return new BranchRepository(scoped).create({
          branch_id: generateId() as BranchID,
          repo_id: repo.repo_id,
          name: `sync-${generateId()}`,
          ref: 'main',
          branch_unique_id: Math.floor(Date.now() % 1_000_000) + 9_500_000,
          path: `/tmp/${generateId()}`,
          created_by: user.user_id,
          environment_instance: { status: 'running' },
        });
      });
      const claim = await runWithTenantDatabaseScope(dbA, tenantA, async (scoped) => {
        const sync = new EnvironmentSyncRepository(scoped);
        await sync.request({
          branchId: branch.branch_id,
          desiredRevision: revision,
          commandBudgetMs: 300_000,
        });
        return sync.claim({
          branchId: branch.branch_id,
          claimToken: 'tenant-a',
          identity: { instanceId: 'a', bootId: 'a' },
        });
      });
      if (claim.outcome !== 'claimed') throw new Error('Expected owner claim');
      const attempt = claim.attempt;
      expect(
        await runWithTenantDatabaseScope(dbB, tenantB, (scoped) =>
          new EnvironmentSyncRepository(scoped).complete({
            branchId: branch.branch_id,
            claimToken: attempt.token,
            appliedRevision: revision,
            environmentGeneration: attempt.environment_generation,
          })
        )
      ).toEqual({ outcome: 'stale' });
      expect(
        await runWithTenantDatabaseScope(dbA, tenantA, (scoped) =>
          new EnvironmentSyncRepository(scoped).complete({
            branchId: branch.branch_id,
            claimToken: attempt.token,
            appliedRevision: revision,
            environmentGeneration: attempt.environment_generation,
          })
        )
      ).toMatchObject({ outcome: 'settled', needs_reconcile: false });
    });
  }
);
