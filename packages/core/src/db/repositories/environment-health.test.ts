import type { BranchID } from '@agor/core/types';
import { describe, expect } from 'vitest';
import { generateId } from '../../lib/ids';
import type { Database } from '../client';
import { dbTest } from '../test-helpers';
import { BranchRepository } from './branches';
import { EnvironmentHealthRepository } from './environment-health';
import { RepoRepository } from './repos';
import { UsersRepository } from './users';

let branchUniqueId = 9_900_001;

async function seedStartingBranch(
  db: Database,
  status: 'stopped' | 'starting' | 'running' | 'stopping' | 'error' = 'starting',
  archived = false
) {
  const user = await new UsersRepository(db).create({
    email: `${generateId()}@example.com`,
    name: 'Environment health fence',
  });
  const repo = await new RepoRepository(db).create({
    repo_id: generateId(),
    slug: `environment-health-${generateId()}`,
    name: 'Environment health fence',
    repo_type: 'remote',
    remote_url: 'https://example.invalid/environment-health.git',
    local_path: `/tmp/${generateId()}`,
    default_branch: 'main',
  });
  return new BranchRepository(db).create({
    branch_id: generateId() as BranchID,
    repo_id: repo.repo_id,
    name: `environment-health-${generateId()}`,
    ref: 'main',
    branch_unique_id: branchUniqueId++,
    path: `/tmp/${generateId()}`,
    created_by: user.user_id,
    health_check_url: 'https://example.invalid/health',
    archived,
    environment_instance: { status },
  });
}

describe('EnvironmentHealthRepository lifecycle fencing', () => {
  dbTest('admits only non-archived starting and running environments', async ({ db }) => {
    const health = new EnvironmentHealthRepository(db);
    for (const status of ['starting', 'running'] as const) {
      const branch = await seedStartingBranch(db, status);
      const result = await health.claim({
        branchId: branch.branch_id,
        claimToken: `active-${status}`,
        leaseDurationMs: 30_000,
        identity: { instanceId: 'daemon-a', bootId: 'boot-a' },
      });
      expect(result).toMatchObject({ outcome: 'claimed' });
      if (result.outcome === 'claimed') {
        await health.release(branch.branch_id, result.claim.claim_token);
      }
    }

    for (const status of ['stopped', 'stopping', 'error'] as const) {
      const branch = await seedStartingBranch(db, status);
      await expect(
        health.claim({
          branchId: branch.branch_id,
          claimToken: `inactive-${status}`,
          leaseDurationMs: 30_000,
          identity: { instanceId: 'daemon-a', bootId: 'boot-a' },
        })
      ).resolves.toEqual({ outcome: 'unavailable' });
    }

    const archived = await seedStartingBranch(db, 'running', true);
    await expect(
      health.claim({
        branchId: archived.branch_id,
        claimToken: 'archived',
        leaseDurationMs: 30_000,
        identity: { instanceId: 'daemon-a', bootId: 'boot-a' },
      })
    ).resolves.toEqual({ outcome: 'unavailable' });

    const deleted = await seedStartingBranch(db, 'running');
    await new BranchRepository(db).delete(deleted.branch_id);
    await expect(
      health.claim({
        branchId: deleted.branch_id,
        claimToken: 'deleted',
        leaseDurationMs: 30_000,
        identity: { instanceId: 'daemon-a', bootId: 'boot-a' },
      })
    ).resolves.toEqual({ outcome: 'unavailable' });
  });

  dbTest('promotes healthy startup and records unhealthy running observations', async ({ db }) => {
    const branch = await seedStartingBranch(db);
    const branches = new BranchRepository(db);
    const health = new EnvironmentHealthRepository(db);
    const claim = await health.claim({
      branchId: branch.branch_id,
      claimToken: 'current-observation',
      leaseDurationMs: 30_000,
      identity: { instanceId: 'daemon-a', bootId: 'boot-a' },
    });
    if (claim.outcome !== 'claimed') throw new Error('Expected claim');

    await expect(
      health.commit({
        branchId: branch.branch_id,
        claimToken: claim.claim.claim_token,
        environmentGeneration: claim.claim.environment_generation,
        observation: { status: 'healthy', message: 'HTTP 200', recordWhileStarting: true },
      })
    ).resolves.toEqual({
      outcome: 'committed',
      mutated: true,
      stateChanged: true,
      environmentStatus: 'running',
    });
    await expect(
      health.commit({
        branchId: branch.branch_id,
        claimToken: claim.claim.claim_token,
        environmentGeneration: claim.claim.environment_generation,
        observation: { status: 'unhealthy', message: 'Timeout', recordWhileStarting: false },
      })
    ).resolves.toMatchObject({ outcome: 'committed', environmentStatus: 'running' });
    expect((await branches.findById(branch.branch_id))?.environment_instance).toMatchObject({
      status: 'running',
      last_health_check: { status: 'unhealthy', message: 'Timeout' },
    });
  });

  dbTest(
    'accepts an unrecorded startup observation without mutating branch state',
    async ({ db }) => {
      const branch = await seedStartingBranch(db);
      const branches = new BranchRepository(db);
      const health = new EnvironmentHealthRepository(db);
      const claim = await health.claim({
        branchId: branch.branch_id,
        claimToken: 'startup-network-failure',
        leaseDurationMs: 30_000,
        identity: { instanceId: 'daemon-a', bootId: 'boot-a' },
      });
      if (claim.outcome !== 'claimed') throw new Error('Expected claim');

      await expect(
        health.commit({
          branchId: branch.branch_id,
          claimToken: claim.claim.claim_token,
          environmentGeneration: claim.claim.environment_generation,
          observation: {
            status: 'unhealthy',
            message: 'Health endpoint unreachable',
            recordWhileStarting: false,
          },
        })
      ).resolves.toEqual({
        outcome: 'committed',
        mutated: false,
        stateChanged: false,
        environmentStatus: 'starting',
      });
      expect(await branches.findById(branch.branch_id)).toMatchObject({
        updated_at: branch.updated_at,
        environment_instance: { status: 'starting' },
      });
      expect(
        (await branches.findById(branch.branch_id))?.environment_instance?.last_health_check
      ).toBeUndefined();
    }
  );

  dbTest(
    'persists repeated healthy and unhealthy observation times without state churn',
    async ({ db }) => {
      const branches = new BranchRepository(db);
      const health = new EnvironmentHealthRepository(db);

      for (const observation of [
        { status: 'healthy' as const, message: 'HTTP 200' },
        { status: 'unhealthy' as const, message: 'HTTP 503 Service Unavailable' },
      ]) {
        const seeded = await seedStartingBranch(db, 'running');
        await branches.update(seeded.branch_id, {
          environment_instance: {
            status: 'running',
            last_health_check: {
              timestamp: '2026-01-01T00:00:00.000Z',
              ...observation,
            },
          },
        });
        const before = await branches.findById(seeded.branch_id);
        const claim = await health.claim({
          branchId: seeded.branch_id,
          claimToken: `repeated-${observation.status}`,
          leaseDurationMs: 30_000,
          identity: { instanceId: 'daemon-a', bootId: 'boot-a' },
        });
        if (claim.outcome !== 'claimed') throw new Error('Expected claim');

        await expect(
          health.commit({
            branchId: seeded.branch_id,
            claimToken: claim.claim.claim_token,
            environmentGeneration: claim.claim.environment_generation,
            observation: { ...observation, recordWhileStarting: true },
          })
        ).resolves.toEqual({
          outcome: 'committed',
          mutated: true,
          stateChanged: false,
          environmentStatus: 'running',
        });
        const after = await branches.findById(seeded.branch_id);
        expect(after?.updated_at).toBe(before?.updated_at);
        expect(after?.environment_instance?.last_health_check).toMatchObject(observation);
        expect(after?.environment_instance?.last_health_check?.timestamp).not.toBe(
          '2026-01-01T00:00:00.000Z'
        );
      }
    }
  );

  dbTest('invalidates an in-flight result across stop and restart', async ({ db }) => {
    const branch = await seedStartingBranch(db);
    const branches = new BranchRepository(db);
    const health = new EnvironmentHealthRepository(db);
    const old = await health.claim({
      branchId: branch.branch_id,
      claimToken: 'old-observation',
      leaseDurationMs: 30_000,
      identity: { instanceId: 'daemon-a', bootId: 'boot-a' },
    });
    if (old.outcome !== 'claimed') throw new Error('Expected initial claim');

    await branches.update(branch.branch_id, { environment_instance: { status: 'stopped' } });
    await branches.update(branch.branch_id, { environment_instance: { status: 'starting' } });

    await expect(
      health.commit({
        branchId: branch.branch_id,
        claimToken: old.claim.claim_token,
        environmentGeneration: old.claim.environment_generation,
        observation: { status: 'healthy', message: 'late HTTP 200', recordWhileStarting: true },
      })
    ).resolves.toEqual({ outcome: 'stale' });
    expect((await branches.findById(branch.branch_id))?.environment_instance).toMatchObject({
      status: 'starting',
    });

    await expect(
      health.claim({
        branchId: branch.branch_id,
        claimToken: 'new-observation',
        leaseDurationMs: 30_000,
        identity: { instanceId: 'daemon-b', bootId: 'boot-b' },
      })
    ).resolves.toMatchObject({
      outcome: 'claimed',
      claim: { environment_generation: old.claim.environment_generation + 2 },
    });
  });

  dbTest('invalidates an in-flight result for a starting to starting retry', async ({ db }) => {
    const branch = await seedStartingBranch(db);
    const branches = new BranchRepository(db);
    const health = new EnvironmentHealthRepository(db);
    const old = await health.claim({
      branchId: branch.branch_id,
      claimToken: 'old-start-attempt',
      leaseDurationMs: 30_000,
      identity: { instanceId: 'daemon-a', bootId: 'boot-a' },
    });
    if (old.outcome !== 'claimed') throw new Error('Expected initial claim');

    await branches.update(
      branch.branch_id,
      {
        environment_instance: {
          status: 'starting',
          process: { started_at: '2026-08-09T18:00:00.000Z' },
        },
      },
      { invalidateEnvironmentObservation: true }
    );

    await expect(
      health.commit({
        branchId: branch.branch_id,
        claimToken: old.claim.claim_token,
        environmentGeneration: old.claim.environment_generation,
        observation: { status: 'healthy', message: 'late HTTP 200', recordWhileStarting: true },
      })
    ).resolves.toEqual({ outcome: 'stale' });
    await expect(
      health.claim({
        branchId: branch.branch_id,
        claimToken: 'new-start-attempt',
        leaseDurationMs: 30_000,
        identity: { instanceId: 'daemon-b', bootId: 'boot-b' },
      })
    ).resolves.toMatchObject({
      outcome: 'claimed',
      claim: { environment_generation: old.claim.environment_generation + 1 },
    });
  });

  dbTest(
    'invalidates an in-flight result when a Start publishes a new health URL',
    async ({ db }) => {
      const branch = await seedStartingBranch(db);
      const branches = new BranchRepository(db);
      const health = new EnvironmentHealthRepository(db);
      const old = await health.claim({
        branchId: branch.branch_id,
        claimToken: 'before-runtime-health-url',
        leaseDurationMs: 30_000,
        identity: { instanceId: 'daemon-a', bootId: 'boot-a' },
      });
      if (old.outcome !== 'claimed') throw new Error('Expected initial claim');

      await branches.update(branch.branch_id, {
        environment_instance: {
          status: 'starting',
          health_url: 'https://space-3000.app.github.dev/health',
        },
      });

      await expect(
        health.commit({
          branchId: branch.branch_id,
          claimToken: old.claim.claim_token,
          environmentGeneration: old.claim.environment_generation,
          observation: {
            status: 'healthy',
            message: 'late old HTTP 200',
            recordWhileStarting: true,
          },
        })
      ).resolves.toEqual({ outcome: 'stale' });
      await expect(
        health.claim({
          branchId: branch.branch_id,
          claimToken: 'after-runtime-health-url',
          leaseDurationMs: 30_000,
          identity: { instanceId: 'daemon-b', bootId: 'boot-b' },
        })
      ).resolves.toMatchObject({
        outcome: 'claimed',
        claim: { environment_generation: old.claim.environment_generation + 1 },
      });
    }
  );

  dbTest('invalidates an in-flight result when the branch is archived', async ({ db }) => {
    const branch = await seedStartingBranch(db, 'running');
    const branches = new BranchRepository(db);
    const health = new EnvironmentHealthRepository(db);
    const claim = await health.claim({
      branchId: branch.branch_id,
      claimToken: 'before-archive',
      leaseDurationMs: 30_000,
      identity: { instanceId: 'daemon-a', bootId: 'boot-a' },
    });
    if (claim.outcome !== 'claimed') throw new Error('Expected initial claim');

    await branches.update(branch.branch_id, { archived: true });

    await expect(
      health.commit({
        branchId: branch.branch_id,
        claimToken: claim.claim.claim_token,
        environmentGeneration: claim.claim.environment_generation,
        observation: { status: 'healthy', message: 'late HTTP 200', recordWhileStarting: true },
      })
    ).resolves.toEqual({ outcome: 'stale' });
    expect(await branches.findById(branch.branch_id)).toMatchObject({
      archived: true,
      environment_instance: { status: 'running' },
    });
  });

  dbTest('enforces a durable cooldown after a completed observation', async ({ db }) => {
    const branch = await seedStartingBranch(db);
    const health = new EnvironmentHealthRepository(db);
    const first = await health.claim({
      branchId: branch.branch_id,
      claimToken: 'first-periodic-observation',
      leaseDurationMs: 30_000,
      identity: { instanceId: 'daemon-a', bootId: 'boot-a' },
    });
    if (first.outcome !== 'claimed') throw new Error('Expected initial claim');

    await expect(health.release(branch.branch_id, first.claim.claim_token, 30_000)).resolves.toBe(
      true
    );
    await expect(
      health.claim({
        branchId: branch.branch_id,
        claimToken: 'too-early-observation',
        leaseDurationMs: 30_000,
        identity: { instanceId: 'daemon-b', bootId: 'boot-b' },
      })
    ).resolves.toMatchObject({ outcome: 'not_due' });

    const explicit = await health.claim({
      branchId: branch.branch_id,
      claimToken: 'explicit-observation',
      leaseDurationMs: 30_000,
      identity: { instanceId: 'daemon-b', bootId: 'boot-b' },
      ignoreCooldown: true,
    });
    expect(explicit).toMatchObject({ outcome: 'claimed' });
  });
});
