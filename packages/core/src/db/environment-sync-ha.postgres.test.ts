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
  EnvironmentHealthRepository,
  EnvironmentSyncRepository,
  RepoRepository,
  UsersRepository,
} from './repositories';
import { runWithTenantDatabaseScope } from './tenant-scope';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';
let branchUnique = (Date.now() % 1_000_000) + 9_000_000;
const REVISION_A = 'a'.repeat(40);
const REVISION_B = 'b'.repeat(40);

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
      health_check_url: 'https://example.invalid/health',
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

    it('keeps a requested remote revision separate from the observed branch commit', async () => {
      const tenantId = `env-sync-observed-${generateId()}` as TenantID;
      const { branch, user } = await seedRunningBranch(dbA, tenantId);

      await runWithTenantDatabaseScope(dbA, tenantId, async (scoped) => {
        const branchesRepo = new BranchRepository(scoped);
        await branchesRepo.update(branch.branch_id, { last_commit_sha: REVISION_A });
        await new EnvironmentSyncRepository(scoped).request({
          branchId: branch.branch_id,
          desiredRevision: REVISION_B,
          requestedByUserId: user.user_id as UserID,
        });

        await expect(branchesRepo.findById(branch.branch_id)).resolves.toMatchObject({
          last_commit_sha: REVISION_A,
          environment_instance: {
            source_sync: { desired_revision: REVISION_B },
          },
        });
      });
    });

    it('fences health observations across a successful Sync on two daemon connections', async () => {
      const tenantId = `env-sync-health-success-${generateId()}` as TenantID;
      const { branch } = await seedRunningBranch(dbA, tenantId);
      await runWithTenantDatabaseScope(dbA, tenantId, (scoped) =>
        new EnvironmentSyncRepository(scoped).request({
          branchId: branch.branch_id,
          desiredRevision: REVISION_A,
        })
      );

      const beforeSync = await runWithTenantDatabaseScope(dbA, tenantId, (scoped) =>
        new EnvironmentHealthRepository(scoped).claim({
          branchId: branch.branch_id,
          claimToken: 'health-before-sync',
          leaseDurationMs: 60_000,
          identity: { instanceId: 'health-a', bootId: 'health-boot-a' },
        })
      );
      if (beforeSync.outcome !== 'claimed') throw new Error('Expected pre-Sync health claim');
      const syncClaim = await runWithTenantDatabaseScope(dbB, tenantId, (scoped) =>
        new EnvironmentSyncRepository(scoped).claim({
          branchId: branch.branch_id,
          claimToken: 'sync-on-daemon-b',
          leaseDurationMs: 60_000,
          identity: { instanceId: 'sync-b', bootId: 'sync-boot-b' },
        })
      );
      if (syncClaim.outcome !== 'claimed') throw new Error('Expected Sync claim');

      await expect(
        runWithTenantDatabaseScope(dbA, tenantId, (scoped) =>
          new EnvironmentHealthRepository(scoped).commit({
            branchId: branch.branch_id,
            claimToken: beforeSync.claim.claim_token,
            environmentGeneration: beforeSync.claim.environment_generation,
            observation: {
              status: 'unhealthy',
              message: 'Late pre-Sync failure',
              recordWhileStarting: true,
            },
          })
        )
      ).resolves.toEqual({ outcome: 'stale' });

      const duringSync = await runWithTenantDatabaseScope(dbA, tenantId, (scoped) =>
        new EnvironmentHealthRepository(scoped).claim({
          branchId: branch.branch_id,
          claimToken: 'health-during-sync',
          leaseDurationMs: 60_000,
          identity: { instanceId: 'health-a', bootId: 'health-boot-a' },
        })
      );
      if (duringSync.outcome !== 'claimed') throw new Error('Expected in-Sync health claim');
      await expect(
        runWithTenantDatabaseScope(dbB, tenantId, (scoped) =>
          new EnvironmentSyncRepository(scoped).complete({
            branchId: branch.branch_id,
            claimToken: syncClaim.attempt.token,
            appliedRevision: REVISION_A,
            environmentGeneration: syncClaim.attempt.environment_generation,
          })
        )
      ).resolves.toMatchObject({ outcome: 'settled', applied_revision: REVISION_A });
      await expect(
        runWithTenantDatabaseScope(dbA, tenantId, (scoped) =>
          new EnvironmentHealthRepository(scoped).commit({
            branchId: branch.branch_id,
            claimToken: duringSync.claim.claim_token,
            environmentGeneration: duringSync.claim.environment_generation,
            observation: {
              status: 'unhealthy',
              message: 'Late in-Sync failure',
              recordWhileStarting: true,
            },
          })
        )
      ).resolves.toEqual({ outcome: 'stale' });

      const freshHealth = await runWithTenantDatabaseScope(dbA, tenantId, (scoped) =>
        new EnvironmentHealthRepository(scoped).claim({
          branchId: branch.branch_id,
          claimToken: 'health-after-sync',
          leaseDurationMs: 60_000,
          identity: { instanceId: 'health-a', bootId: 'health-boot-a' },
        })
      );
      if (freshHealth.outcome !== 'claimed') throw new Error('Expected post-Sync health claim');
      await expect(
        runWithTenantDatabaseScope(dbA, tenantId, (scoped) =>
          new EnvironmentHealthRepository(scoped).commit({
            branchId: branch.branch_id,
            claimToken: freshHealth.claim.claim_token,
            environmentGeneration: freshHealth.claim.environment_generation,
            observation: {
              status: 'unhealthy',
              message: 'Fresh post-Sync failure',
              recordWhileStarting: true,
            },
          })
        )
      ).resolves.toMatchObject({ outcome: 'committed', environmentStatus: 'running' });
    });

    it('keeps cross-tenant settlements from clearing health ownership', async () => {
      const tenantA = `env-sync-settle-a-${generateId()}` as TenantID;
      const tenantB = `env-sync-settle-b-${generateId()}` as TenantID;
      const { branch } = await seedRunningBranch(dbA, tenantA);
      await runWithTenantDatabaseScope(dbA, tenantA, (scoped) =>
        new EnvironmentSyncRepository(scoped).request({
          branchId: branch.branch_id,
          desiredRevision: REVISION_A,
        })
      );
      const syncClaim = await runWithTenantDatabaseScope(dbA, tenantA, (scoped) =>
        new EnvironmentSyncRepository(scoped).claim({
          branchId: branch.branch_id,
          claimToken: 'tenant-a-sync',
          leaseDurationMs: 60_000,
          identity: { instanceId: 'sync-a', bootId: 'sync-boot-a' },
        })
      );
      if (syncClaim.outcome !== 'claimed') throw new Error('Expected tenant A Sync claim');
      const healthClaim = await runWithTenantDatabaseScope(dbA, tenantA, (scoped) =>
        new EnvironmentHealthRepository(scoped).claim({
          branchId: branch.branch_id,
          claimToken: 'tenant-a-health',
          leaseDurationMs: 60_000,
          identity: { instanceId: 'health-a', bootId: 'health-boot-a' },
        })
      );
      if (healthClaim.outcome !== 'claimed') throw new Error('Expected tenant A health claim');

      await expect(
        runWithTenantDatabaseScope(dbB, tenantB, (scoped) =>
          new EnvironmentSyncRepository(scoped).complete({
            branchId: branch.branch_id,
            claimToken: syncClaim.attempt.token,
            appliedRevision: REVISION_A,
            environmentGeneration: syncClaim.attempt.environment_generation,
          })
        )
      ).resolves.toEqual({ outcome: 'stale' });
      await expect(
        runWithTenantDatabaseScope(dbB, tenantB, (scoped) =>
          new EnvironmentSyncRepository(scoped).fail({
            branchId: branch.branch_id,
            claimToken: syncClaim.attempt.token,
            revision: REVISION_A,
            environmentGeneration: syncClaim.attempt.environment_generation,
            message: 'Wrong tenant must not settle',
          })
        )
      ).resolves.toEqual({ outcome: 'stale' });
      await expect(
        runWithTenantDatabaseScope(dbA, tenantA, (scoped) =>
          new EnvironmentHealthRepository(scoped).claimIsCurrent({
            branchId: branch.branch_id,
            claimToken: healthClaim.claim.claim_token,
            environmentGeneration: healthClaim.claim.environment_generation,
          })
        )
      ).resolves.toBe(true);

      await expect(
        runWithTenantDatabaseScope(dbB, tenantA, (scoped) =>
          new EnvironmentSyncRepository(scoped).fail({
            branchId: branch.branch_id,
            claimToken: syncClaim.attempt.token,
            revision: REVISION_A,
            environmentGeneration: syncClaim.attempt.environment_generation,
            message: 'Expected provider failure',
          })
        )
      ).resolves.toMatchObject({ outcome: 'settled', needs_reconcile: true });
      await expect(
        runWithTenantDatabaseScope(dbA, tenantA, (scoped) =>
          new EnvironmentHealthRepository(scoped).commit({
            branchId: branch.branch_id,
            claimToken: healthClaim.claim.claim_token,
            environmentGeneration: healthClaim.claim.environment_generation,
            observation: {
              status: 'unhealthy',
              message: 'Late expected-downtime failure',
              recordWhileStarting: true,
            },
          })
        )
      ).resolves.toEqual({ outcome: 'stale' });

      const current = await runWithTenantDatabaseScope(dbA, tenantA, (scoped) =>
        new BranchRepository(scoped).findById(branch.branch_id)
      );
      expect(current?.environment_instance).toMatchObject({
        status: 'running',
        source_sync: { desired_revision: REVISION_A, failure_count: 1 },
      });
      expect(current?.environment_instance?.last_health_check).toBeUndefined();
    });
  }
);
