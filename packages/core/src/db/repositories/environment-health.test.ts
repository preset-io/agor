import type { BranchID } from '@agor/core/types';
import { describe, expect } from 'vitest';
import { generateId } from '../../lib/ids';
import type { Database } from '../client';
import { dbTest } from '../test-helpers';
import { BranchRepository } from './branches';
import { EnvironmentHealthRepository } from './environment-health';
import { RepoRepository } from './repos';
import { UsersRepository } from './users';

async function seedStartingBranch(db: Database) {
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
    branch_unique_id: 9_900_001,
    path: `/tmp/${generateId()}`,
    created_by: user.user_id,
    health_check_url: 'https://example.invalid/health',
    environment_instance: { status: 'starting' },
  });
}

describe('EnvironmentHealthRepository lifecycle fencing', () => {
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

    // Readiness is gated on CONSECUTIVE successes, the same rule the standalone
    // monitor applies: a resuming tunnel can answer one stale 200 while the app
    // behind it is still booting, so the first success must not promote.
    await expect(
      health.commit({
        branchId: branch.branch_id,
        claimToken: claim.claim.claim_token,
        environmentGeneration: claim.claim.environment_generation,
        observation: { status: 'healthy', message: 'HTTP 200', recordWhileStarting: true },
        probeIntervalMs: 5_000,
      })
    ).resolves.toMatchObject({ outcome: 'committed', environmentStatus: 'starting' });
    await expect(
      health.commit({
        branchId: branch.branch_id,
        claimToken: claim.claim.claim_token,
        environmentGeneration: claim.claim.environment_generation,
        observation: { status: 'healthy', message: 'HTTP 200', recordWhileStarting: true },
        probeIntervalMs: 5_000,
      })
    ).resolves.toMatchObject({ outcome: 'committed', environmentStatus: 'running' });
    await expect(
      health.commit({
        branchId: branch.branch_id,
        claimToken: claim.claim.claim_token,
        environmentGeneration: claim.claim.environment_generation,
        observation: { status: 'unhealthy', message: 'Timeout', recordWhileStarting: false },
        probeIntervalMs: 5_000,
      })
    ).resolves.toMatchObject({ outcome: 'committed', environmentStatus: 'running' });
    expect((await branches.findById(branch.branch_id))?.environment_instance).toMatchObject({
      status: 'running',
      last_health_check: { status: 'unhealthy', message: 'Timeout' },
    });
  });

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
        probeIntervalMs: 5_000,
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
        probeIntervalMs: 5_000,
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
  });
});

describe('EnvironmentHealthRepository shared transition rules', () => {
  /**
   * The distributed monitor must reach the same status as the standalone one.
   * Before these rules were shared it promoted on a SINGLE healthy observation,
   * never demoted a running environment that had gone away, and never
   * re-observed a demoted one — so an environment could sit green while dead,
   * or red forever after recovering.
   */
  const observe = async (
    health: EnvironmentHealthRepository,
    branchId: BranchID,
    status: 'healthy' | 'unhealthy',
    times: number
  ) => {
    let last: unknown;
    for (let i = 0; i < times; i += 1) {
      const claim = await health.claim({
        branchId,
        claimToken: `observation-${status}-${i}`,
        leaseDurationMs: 30_000,
        identity: { instanceId: 'daemon-a', bootId: 'boot-a' },
      });
      if (claim.outcome !== 'claimed') throw new Error(`Expected claim, got ${claim.outcome}`);
      last = await health.commit({
        branchId,
        claimToken: claim.claim.claim_token,
        environmentGeneration: claim.claim.environment_generation,
        observation: {
          status,
          message: status === 'healthy' ? 'HTTP 200' : 'Timeout',
          recordWhileStarting: true,
        },
        probeIntervalMs: 5_000,
      });
      // Committing parks the claim in a cooldown; the worker releases it before
      // the next round, so mirror that here rather than fighting the fence.
      await health.release(branchId, claim.claim.claim_token);
    }
    return last as { environmentStatus?: string };
  };

  dbTest('demotes a running environment that has gone away', async ({ db }) => {
    const branch = await seedStartingBranch(db);
    const branches = new BranchRepository(db);
    const health = new EnvironmentHealthRepository(db);
    await branches.update(branch.branch_id, { environment_instance: { status: 'running' } });

    // Blips must not flap it.
    expect((await observe(health, branch.branch_id, 'unhealthy', 2)).environmentStatus).toBe(
      'running'
    );
    // Sustained unreachability must.
    expect((await observe(health, branch.branch_id, 'unhealthy', 1)).environmentStatus).toBe(
      'error'
    );
  });

  dbTest('keeps observing a demoted environment so it can recover', async ({ db }) => {
    const branch = await seedStartingBranch(db);
    const branches = new BranchRepository(db);
    const health = new EnvironmentHealthRepository(db);
    await branches.update(branch.branch_id, { environment_instance: { status: 'error' } });

    // If `error` were excluded from discovery/claiming, demotion would be a
    // one-way door and this would never come back.
    expect((await observe(health, branch.branch_id, 'healthy', 2)).environmentStatus).toBe(
      'running'
    );
  });

  dbTest('persists the streak so it survives an observation moving daemons', async ({ db }) => {
    const branch = await seedStartingBranch(db);
    const branches = new BranchRepository(db);
    const health = new EnvironmentHealthRepository(db);
    await branches.update(branch.branch_id, { environment_instance: { status: 'running' } });

    await observe(health, branch.branch_id, 'unhealthy', 2);

    // The count lives with the observation, not in the daemon that took it.
    expect((await branches.findById(branch.branch_id))?.environment_instance).toMatchObject({
      status: 'running',
      last_health_check: { status: 'unhealthy', consecutive: 2 },
    });
  });
});
