/**
 * PostgreSQL integration for replica-safe managed-environment observations.
 *
 * Run with AGOR_DB_DIALECT=postgresql and AGOR_TEST_POSTGRES_URL set.
 */
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateId } from '../lib/ids';
import type { BranchID, TenantID } from '../types';
import { createDatabase, type Database } from './client';
import { isPostgresDatabase, update } from './database-wrapper';
import { initializeDatabase } from './migrate';
import {
  BranchRepository,
  EnvironmentHealthDiscoveryRepository,
  EnvironmentHealthRepository,
  RepoRepository,
  UsersRepository,
} from './repositories';
import { branches } from './schema';
import { runWithSystemDatabaseScope, runWithTenantDatabaseScope } from './tenant-scope';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';
let branchUnique = (Date.now() % 1_000_000) + 8_000_000;

async function seedBranch(
  db: Database,
  tenantId: TenantID,
  status: 'starting' | 'running' | 'stopped' = 'running'
) {
  return runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
    const user = await new UsersRepository(scoped).create({
      email: `${tenantId}-${generateId()}@example.com`,
      name: 'Environment health HA',
    });
    const repo = await new RepoRepository(scoped).create({
      repo_id: generateId(),
      slug: `environment-health-${tenantId}-${generateId()}`,
      name: 'Environment health HA',
      repo_type: 'remote',
      remote_url: 'https://example.invalid/environment-health.git',
      local_path: `/tmp/${generateId()}`,
      default_branch: 'main',
    });
    const branch = await new BranchRepository(scoped).create({
      branch_id: generateId() as BranchID,
      repo_id: repo.repo_id,
      name: `environment-health-${generateId()}`,
      ref: 'main',
      branch_unique_id: branchUnique++,
      path: `/tmp/${generateId()}`,
      created_by: user.user_id,
      health_check_url: 'https://example.invalid/health',
      environment_instance: { status },
    });
    return branch;
  });
}

async function expireClaim(db: Database, tenantId: TenantID, branchId: BranchID) {
  await runWithTenantDatabaseScope(db, tenantId, (scoped) =>
    update(scoped, branches)
      .set({ environment_health_claim_expires_at: sql`CURRENT_TIMESTAMP - INTERVAL '1 second'` })
      .where(eq(branches.branch_id, branchId))
      .run()
  );
}

interface TestPostgresClient {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
  begin<T>(callback: (sqlClient: TestPostgresClient) => Promise<T>): Promise<T>;
}

describe.skipIf(!postgresUrl || !usesPostgresSchema)(
  'environment health HA coordination (PostgreSQL)',
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

    it('admits exactly one lifecycle boundary across two daemon connections', async () => {
      const tenantId = `env-lifecycle-${generateId()}` as TenantID;
      const branch = await seedBranch(dbA, tenantId, 'stopped');
      const claim = (db: Database) =>
        runWithTenantDatabaseScope(db, tenantId, (scoped) =>
          new BranchRepository(scoped).update(
            branch.branch_id,
            { environment_instance: { status: 'starting' } },
            {
              invalidateEnvironmentObservation: true,
              expectedEnvironmentGeneration: branch.environment_generation,
              expectedEnvironmentStatus: 'stopped',
            }
          )
        );

      const results = await Promise.allSettled([claim(dbA), claim(dbB)]);

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
      await expect(
        runWithTenantDatabaseScope(dbA, tenantId, (scoped) =>
          new BranchRepository(scoped).findById(branch.branch_id)
        )
      ).resolves.toMatchObject({
        environment_generation: 1,
        environment_instance: { status: 'starting' },
      });
    });

    it('does not let a lifecycle generation cross a tenant boundary', async () => {
      const tenantA = `env-lifecycle-a-${generateId()}` as TenantID;
      const tenantB = `env-lifecycle-b-${generateId()}` as TenantID;
      await seedBranch(dbA, tenantA, 'stopped');
      const branchB = await seedBranch(dbA, tenantB, 'stopped');

      await expect(
        runWithTenantDatabaseScope(dbA, tenantA, (scoped) =>
          new BranchRepository(scoped).update(
            branchB.branch_id,
            { environment_instance: { status: 'starting' } },
            {
              invalidateEnvironmentObservation: true,
              expectedEnvironmentGeneration: branchB.environment_generation,
              expectedEnvironmentStatus: 'stopped',
            }
          )
        )
      ).rejects.toThrow();
      await expect(
        runWithTenantDatabaseScope(dbB, tenantB, (scoped) =>
          new BranchRepository(scoped).findById(branchB.branch_id)
        )
      ).resolves.toMatchObject({
        environment_generation: 0,
        environment_instance: { status: 'stopped' },
      });
    });

    it('elects one owner, renews only the current token, takes over, and fences stale results', async () => {
      const tenantId = `env-owner-${generateId()}` as TenantID;
      const branch = await seedBranch(dbA, tenantId);
      const attempts = await Promise.all(
        Array.from({ length: 5 }, (_, index) =>
          runWithTenantDatabaseScope(index % 2 ? dbA : dbB, tenantId, (scoped) =>
            new EnvironmentHealthRepository(scoped).claim({
              branchId: branch.branch_id,
              claimToken: `owner-${index}`,
              leaseDurationMs: 30_000,
              identity: { instanceId: `daemon-${index}`, bootId: `boot-${index}` },
            })
          )
        )
      );
      const winner = attempts.find((attempt) => attempt.outcome === 'claimed');
      expect(attempts.filter((attempt) => attempt.outcome === 'claimed')).toHaveLength(1);
      if (winner?.outcome !== 'claimed') throw new Error('No observation winner');

      await runWithTenantDatabaseScope(dbA, tenantId, async (scoped) => {
        const health = new EnvironmentHealthRepository(scoped);
        expect(
          await health.renew({
            branchId: branch.branch_id,
            claimToken: winner.claim.claim_token,
            environmentGeneration: winner.claim.environment_generation,
            leaseDurationMs: 30_000,
          })
        ).not.toBeNull();
        expect(
          await health.claimIsCurrent({
            branchId: branch.branch_id,
            claimToken: winner.claim.claim_token,
            environmentGeneration: winner.claim.environment_generation,
          })
        ).toBe(true);
        expect(
          await health.renew({
            branchId: branch.branch_id,
            claimToken: 'not-the-current-token',
            environmentGeneration: winner.claim.environment_generation,
            leaseDurationMs: 30_000,
          })
        ).toBeNull();
        expect(
          await health.claimIsCurrent({
            branchId: branch.branch_id,
            claimToken: 'not-the-current-token',
            environmentGeneration: winner.claim.environment_generation,
          })
        ).toBe(false);
      });

      await expireClaim(dbA, tenantId, branch.branch_id);
      const takeover = await runWithTenantDatabaseScope(dbB, tenantId, (scoped) =>
        new EnvironmentHealthRepository(scoped).claim({
          branchId: branch.branch_id,
          claimToken: 'takeover',
          leaseDurationMs: 30_000,
          identity: { instanceId: 'daemon-new', bootId: 'boot-new' },
        })
      );
      expect(takeover.outcome).toBe('claimed');
      await runWithTenantDatabaseScope(dbA, tenantId, async (scoped) => {
        const health = new EnvironmentHealthRepository(scoped);
        expect(
          await health.commit({
            branchId: branch.branch_id,
            claimToken: winner.claim.claim_token,
            environmentGeneration: winner.claim.environment_generation,
            observation: {
              status: 'unhealthy',
              message: 'stale',
              recordWhileStarting: true,
            },
            probeIntervalMs: 5_000,
          })
        ).toEqual({ outcome: 'stale' });
        expect(await health.release(branch.branch_id, winner.claim.claim_token)).toBe(false);
      });
    });

    it('uses post-lock database time to reject a commit that expires while waiting', async () => {
      const tenantId = `env-lock-time-${generateId()}` as TenantID;
      const branch = await seedBranch(dbA, tenantId);
      const claim = await runWithTenantDatabaseScope(dbA, tenantId, (scoped) =>
        new EnvironmentHealthRepository(scoped).claim({
          branchId: branch.branch_id,
          claimToken: 'expires-behind-lock',
          leaseDurationMs: 300,
          identity: { instanceId: 'daemon-a', bootId: 'boot-a' },
        })
      );
      if (claim.outcome !== 'claimed') throw new Error('Expected claim');

      let lockedResolve: (() => void) | undefined;
      let unlockResolve: (() => void) | undefined;
      const locked = new Promise<void>((resolve) => {
        lockedResolve = resolve;
      });
      const unlock = new Promise<void>((resolve) => {
        unlockResolve = resolve;
      });
      const client = (dbB as unknown as { $client: TestPostgresClient }).$client;
      const lockWork = client.begin(async (sqlClient) => {
        await sqlClient`SELECT set_config('agor.tenant_id', ${tenantId}, true)`;
        await sqlClient`SELECT branch_id FROM branches WHERE branch_id = ${branch.branch_id} FOR UPDATE`;
        lockedResolve?.();
        await unlock;
      });
      await locked;

      const waitingCommit = runWithTenantDatabaseScope(dbA, tenantId, (scoped) =>
        new EnvironmentHealthRepository(scoped).commit({
          branchId: branch.branch_id,
          claimToken: claim.claim.claim_token,
          environmentGeneration: claim.claim.environment_generation,
          observation: {
            status: 'healthy',
            message: 'must expire behind lock',
            recordWhileStarting: true,
          },
          probeIntervalMs: 5_000,
        })
      );
      await new Promise((resolve) => setTimeout(resolve, 400));
      unlockResolve?.();
      await lockWork;

      await expect(waitingCommit).resolves.toEqual({ outcome: 'stale' });
    });

    it('fences lifecycle changes and preserves starting/running health semantics', async () => {
      const tenantId = `env-lifecycle-${generateId()}` as TenantID;
      const branch = await seedBranch(dbA, tenantId, 'starting');
      await runWithTenantDatabaseScope(dbA, tenantId, async (scoped) => {
        const health = new EnvironmentHealthRepository(scoped);
        const unrecorded = await health.claim({
          branchId: branch.branch_id,
          claimToken: 'starting-network-failure',
          leaseDurationMs: 30_000,
          identity: { instanceId: 'daemon-a', bootId: 'boot-a' },
        });
        if (unrecorded.outcome !== 'claimed') throw new Error('Expected startup failure claim');
        expect(
          await health.commit({
            branchId: branch.branch_id,
            claimToken: unrecorded.claim.claim_token,
            environmentGeneration: unrecorded.claim.environment_generation,
            observation: {
              status: 'unhealthy',
              message: 'Health endpoint unreachable',
              recordWhileStarting: false,
            },
          })
        ).toEqual({
          outcome: 'committed',
          mutated: false,
          stateChanged: false,
          environmentStatus: 'starting',
        });
        expect(
          (await new BranchRepository(scoped).findById(branch.branch_id))?.environment_instance
            ?.last_health_check
        ).toBeUndefined();
        expect(await health.release(branch.branch_id, unrecorded.claim.claim_token)).toBe(true);

        const first = await health.claim({
          branchId: branch.branch_id,
          claimToken: 'starting-owner',
          leaseDurationMs: 30_000,
          identity: { instanceId: 'daemon-a', bootId: 'boot-a' },
        });
        if (first.outcome !== 'claimed') throw new Error('Expected claim');
        // Readiness needs CONSECUTIVE successes: a resuming tunnel can answer
        // one stale 200 while the app behind it is still booting, so the first
        // healthy observation records but must not promote.
        expect(
          await health.commit({
            branchId: branch.branch_id,
            claimToken: first.claim.claim_token,
            environmentGeneration: first.claim.environment_generation,
            observation: {
              status: 'healthy',
              message: 'HTTP 200',
              recordWhileStarting: true,
            },
            probeIntervalMs: 5_000,
          })
        ).toMatchObject({ outcome: 'committed', environmentStatus: 'starting' });
        expect(
          await health.commit({
            branchId: branch.branch_id,
            claimToken: first.claim.claim_token,
            environmentGeneration: first.claim.environment_generation,
            observation: {
              status: 'healthy',
              message: 'HTTP 200',
              recordWhileStarting: true,
            },
            probeIntervalMs: 5_000,
          })
        ).toMatchObject({ outcome: 'committed', environmentStatus: 'running' });

        const running = await new BranchRepository(scoped).findById(branch.branch_id);
        expect(running?.environment_instance).toMatchObject({
          status: 'running',
          last_health_check: { status: 'healthy', message: 'HTTP 200' },
        });
        expect(await health.release(branch.branch_id, first.claim.claim_token)).toBe(true);
        const second = await health.claim({
          branchId: branch.branch_id,
          claimToken: 'running-owner',
          leaseDurationMs: 30_000,
          identity: { instanceId: 'daemon-a', bootId: 'boot-a' },
        });
        if (second.outcome !== 'claimed') throw new Error('Expected second claim');
        await health.commit({
          branchId: branch.branch_id,
          claimToken: second.claim.claim_token,
          environmentGeneration: second.claim.environment_generation,
          observation: {
            status: 'unhealthy',
            message: 'Timeout',
            recordWhileStarting: false,
          },
          probeIntervalMs: 5_000,
        });
        expect(
          (await new BranchRepository(scoped).findById(branch.branch_id))?.environment_instance
        ).toMatchObject({ status: 'running', last_health_check: { status: 'unhealthy' } });
        expect(await health.release(branch.branch_id, second.claim.claim_token)).toBe(true);

        const stale = await health.claim({
          branchId: branch.branch_id,
          claimToken: 'before-stop',
          leaseDurationMs: 30_000,
          identity: { instanceId: 'daemon-a', bootId: 'boot-a' },
        });
        if (stale.outcome !== 'claimed') throw new Error('Expected stale claim setup');
        await new BranchRepository(scoped).update(branch.branch_id, {
          environment_instance: { status: 'stopped' },
        });
        expect(
          await health.commit({
            branchId: branch.branch_id,
            claimToken: stale.claim.claim_token,
            environmentGeneration: stale.claim.environment_generation,
            observation: {
              status: 'healthy',
              message: 'late HTTP 200',
              recordWhileStarting: true,
            },
            probeIntervalMs: 5_000,
          })
        ).toEqual({ outcome: 'stale' });
        await new BranchRepository(scoped).update(branch.branch_id, {
          environment_instance: { status: 'starting' },
        });
        expect(
          await health.claim({
            branchId: branch.branch_id,
            claimToken: 'fresh-restart',
            leaseDurationMs: 30_000,
            identity: { instanceId: 'daemon-b', bootId: 'boot-b' },
          })
        ).toMatchObject({ outcome: 'claimed' });
      });
    });

    it('limits discovery to active rows and tenant scopes block cross-tenant reads and mutations', async () => {
      const tenantA = `env-a-${generateId()}` as TenantID;
      const tenantB = `env-b-${generateId()}` as TenantID;
      const active = await seedBranch(dbA, tenantA, 'running');
      const stopped = await seedBranch(dbA, tenantA, 'stopped');
      const archived = await seedBranch(dbA, tenantB, 'running');
      await runWithTenantDatabaseScope(dbA, tenantB, (scoped) =>
        new BranchRepository(scoped).update(archived.branch_id, { archived: true })
      );

      const refs = await runWithSystemDatabaseScope(
        dbA,
        'environment health discovery test',
        (systemDb) =>
          new EnvironmentHealthDiscoveryRepository(systemDb).findActiveRefs({ limit: 1_000 }),
        { capability: 'environment_health_discovery' }
      );
      expect(refs).toContainEqual({ branch_id: active.branch_id, tenant_id: tenantA });
      expect(refs.some((ref) => ref.branch_id === stopped.branch_id)).toBe(false);
      expect(refs.some((ref) => ref.branch_id === archived.branch_id)).toBe(false);

      await runWithTenantDatabaseScope(dbB, tenantB, async (scoped) => {
        expect(await new BranchRepository(scoped).findById(active.branch_id)).toBeNull();
        expect(
          await new EnvironmentHealthRepository(scoped).claim({
            branchId: active.branch_id,
            claimToken: 'cross-tenant',
            leaseDurationMs: 30_000,
            identity: { instanceId: 'daemon-b', bootId: 'boot-b' },
          })
        ).toEqual({ outcome: 'unavailable' });
        expect(
          await new EnvironmentHealthRepository(scoped).commit({
            branchId: active.branch_id,
            claimToken: 'cross-tenant',
            environmentGeneration: 0,
            observation: {
              status: 'healthy',
              message: 'must not cross tenants',
              recordWhileStarting: true,
            },
            probeIntervalMs: 5_000,
          })
        ).toEqual({ outcome: 'stale' });
      });

      await runWithTenantDatabaseScope(dbA, tenantA, async (scoped) => {
        await new BranchRepository(scoped).delete(active.branch_id);
        expect(
          await new EnvironmentHealthRepository(scoped).claim({
            branchId: active.branch_id,
            claimToken: 'deleted',
            leaseDurationMs: 30_000,
            identity: { instanceId: 'daemon-a', bootId: 'boot-a' },
          })
        ).toEqual({ outcome: 'unavailable' });
      });
    });
  }
);
