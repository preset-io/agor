/**
 * PostgreSQL integration for replica-safe, tenant-scoped source reconciliation.
 *
 * Run with AGOR_DB_DIALECT=postgresql and AGOR_TEST_POSTGRES_URL set.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateId } from '../lib/ids';
import type { BranchID, TenantID, UserID } from '../types';
import { createDatabase, type Database } from './client';
import { isPostgresDatabase } from './database-wrapper';
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
let branchUnique = (Date.now() % 1_000_000) + 9_000_000;
const REVISION_A = 'a'.repeat(40);

async function seedRunningBranch(db: Database, tenantId: TenantID) {
  return runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
    const user = await new UsersRepository(scoped).create({
      email: `${tenantId}-${generateId()}@example.com`,
      name: 'Environment sync HA',
    });
    const repo = await new RepoRepository(scoped).create({
      repo_id: generateId(),
      slug: `environment-sync-${tenantId}-${generateId()}`,
      name: 'Environment sync HA',
      repo_type: 'remote',
      remote_url: 'https://example.invalid/environment-sync.git',
      local_path: `/tmp/${generateId()}`,
      default_branch: 'main',
    });
    const branch = await new BranchRepository(scoped).create({
      branch_id: generateId() as BranchID,
      repo_id: repo.repo_id,
      name: `environment-sync-${generateId()}`,
      ref: 'main',
      branch_unique_id: branchUnique++,
      path: `/tmp/${generateId()}`,
      created_by: user.user_id,
      environment_instance: { status: 'running' },
    });
    return { branch, user };
  });
}

describe.skipIf(!postgresUrl || !usesPostgresSchema)(
  'environment source sync HA coordination (PostgreSQL)',
  () => {
    let dbA: Database;
    let dbB: Database;

    beforeAll(async () => {
      dbA = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      dbB = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      await initializeDatabase(dbA);
      if (!isPostgresDatabase(dbA) || !isPostgresDatabase(dbB)) {
        throw new Error('PostgreSQL test requires PostgreSQL');
      }
    });

    afterAll(async () => {
      await Promise.all([
        (dbA as Database & { $client: { end: () => Promise<void> } }).$client.end(),
        (dbB as Database & { $client: { end: () => Promise<void> } }).$client.end(),
      ]);
    });

    it('admits exactly one sync attempt across two daemon connections', async () => {
      const tenantId = `env-sync-owner-${generateId()}` as TenantID;
      const { branch, user } = await seedRunningBranch(dbA, tenantId);
      await runWithTenantDatabaseScope(dbA, tenantId, (scoped) =>
        new EnvironmentSyncRepository(scoped).request({
          branchId: branch.branch_id,
          desiredRevision: REVISION_A,
          requestedByUserId: user.user_id as UserID,
        })
      );

      const claims = await Promise.all([
        runWithTenantDatabaseScope(dbA, tenantId, (scoped) =>
          new EnvironmentSyncRepository(scoped).claim({
            branchId: branch.branch_id,
            claimToken: 'daemon-a',
            leaseDurationMs: 60_000,
            identity: { instanceId: 'daemon-a', bootId: 'boot-a' },
          })
        ),
        runWithTenantDatabaseScope(dbB, tenantId, (scoped) =>
          new EnvironmentSyncRepository(scoped).claim({
            branchId: branch.branch_id,
            claimToken: 'daemon-b',
            leaseDurationMs: 60_000,
            identity: { instanceId: 'daemon-b', bootId: 'boot-b' },
          })
        ),
      ]);

      expect(claims.filter((claim) => claim.outcome === 'claimed')).toHaveLength(1);
      expect(claims.filter((claim) => claim.outcome === 'held')).toHaveLength(1);
      const winner = claims.find((claim) => claim.outcome === 'claimed');
      if (winner?.outcome !== 'claimed') throw new Error('Expected one winner');
      await expect(
        runWithTenantDatabaseScope(dbB, tenantId, (scoped) =>
          new EnvironmentSyncRepository(scoped).complete({
            branchId: branch.branch_id,
            claimToken: winner.attempt.token,
            appliedRevision: REVISION_A,
            environmentGeneration: winner.attempt.environment_generation,
          })
        )
      ).resolves.toMatchObject({
        outcome: 'settled',
        applied_revision: REVISION_A,
        needs_reconcile: false,
      });
    });

    it('does not let desired state or claims cross a tenant boundary', async () => {
      const tenantA = `env-sync-a-${generateId()}` as TenantID;
      const tenantB = `env-sync-b-${generateId()}` as TenantID;
      const { branch, user } = await seedRunningBranch(dbA, tenantA);

      await expect(
        runWithTenantDatabaseScope(dbB, tenantB, (scoped) =>
          new EnvironmentSyncRepository(scoped).request({
            branchId: branch.branch_id,
            desiredRevision: REVISION_A,
            requestedByUserId: user.user_id as UserID,
          })
        )
      ).rejects.toThrow();
      await expect(
        runWithTenantDatabaseScope(dbB, tenantB, (scoped) =>
          new EnvironmentSyncRepository(scoped).claim({
            branchId: branch.branch_id,
            claimToken: 'wrong-tenant',
            leaseDurationMs: 60_000,
            identity: { instanceId: 'daemon-b', bootId: 'boot-b' },
          })
        )
      ).resolves.toEqual({ outcome: 'unavailable' });

      const current = await runWithTenantDatabaseScope(dbA, tenantA, (scoped) =>
        new BranchRepository(scoped).findById(branch.branch_id)
      );
      expect(current?.environment_instance?.source_sync).toBeUndefined();
    });
  }
);
