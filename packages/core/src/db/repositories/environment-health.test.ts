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

    // Readiness is gated on CONSECUTIVE successes, the same rule the standalone
    // monitor applies: a resuming tunnel can answer one stale 200 while the app
    // behind it is still booting, so the first success must not promote.
    await expect(
      health.commit({
        branchId: branch.branch_id,
        claimToken: claim.claim.claim_token,
        environmentGeneration: claim.claim.environment_generation,
        observation: { status: 'healthy', message: 'HTTP 200', recordWhileStarting: true },
      })
    ).resolves.toMatchObject({ outcome: 'committed', environmentStatus: 'starting' });
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
      });
      // Committing parks the claim in a cooldown; the worker releases it before
      // the next round, so mirror that here rather than fighting the fence.
      await health.release(branchId, claim.claim.claim_token);
    }
    return last as { environmentStatus?: string };
  };

  dbTest(
    'persists timeout after monitor downtime even for an unrecorded network failure',
    async ({ db }) => {
      const branch = await seedStartingBranch(db);
      const branches = new BranchRepository(db);
      const health = new EnvironmentHealthRepository(db);
      await branches.update(branch.branch_id, {
        environment_instance: {
          status: 'starting',
          process: { started_at: '2000-01-01T00:00:00.000Z' },
          startup_deadline_at: '2000-01-01T01:00:00.000Z',
        },
      });
      const claim = await health.claim({
        branchId: branch.branch_id,
        claimToken: 'expired-startup',
        leaseDurationMs: 30_000,
        identity: { instanceId: 'daemon-after-outage', bootId: 'boot-after-outage' },
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
        mutated: true,
        stateChanged: true,
        environmentStatus: 'error',
      });
      await expect(branches.findById(branch.branch_id)).resolves.toMatchObject({
        environment_generation: claim.claim.environment_generation + 1,
        environment_instance: {
          status: 'error',
          last_health_check: { status: 'unhealthy', consecutive: 1 },
        },
      });
    }
  );

  dbTest('rejects a late Start completion after the startup deadline', async ({ db }) => {
    const branch = await seedStartingBranch(db);
    const branches = new BranchRepository(db);
    const health = new EnvironmentHealthRepository(db);
    await branches.update(branch.branch_id, {
      environment_instance: {
        status: 'starting',
        process: { started_at: '2000-01-01T00:00:00.000Z' },
        startup_deadline_at: '2000-01-01T01:00:00.000Z',
      },
    });
    const claim = await health.claim({
      branchId: branch.branch_id,
      claimToken: 'late-start-completion',
      leaseDurationMs: 30_000,
      identity: { instanceId: 'daemon-after-outage', bootId: 'boot-after-outage' },
    });
    if (claim.outcome !== 'claimed') throw new Error('Expected claim');

    await health.commit({
      branchId: branch.branch_id,
      claimToken: claim.claim.claim_token,
      environmentGeneration: claim.claim.environment_generation,
      observation: {
        status: 'unhealthy',
        message: 'Startup deadline expired',
        recordWhileStarting: false,
      },
    });

    // This is the callback shape used by a shell Start that exits after the
    // health monitor has already timed it out. Its old generation must no
    // longer be authorized to publish runtime state or revive the branch.
    await expect(
      branches.update(
        branch.branch_id,
        {
          environment_instance: {
            status: 'running',
            access_urls: [{ name: 'App', url: 'https://late.example.test/' }],
          },
        },
        { expectedEnvironmentGeneration: claim.claim.environment_generation }
      )
    ).rejects.toThrow(/superseded/i);
    const afterTimeout = await branches.findById(branch.branch_id);
    expect(afterTimeout).toMatchObject({
      environment_generation: claim.claim.environment_generation + 1,
      environment_instance: { status: 'error' },
    });
    expect(afterTimeout?.environment_instance?.access_urls).toBeUndefined();
  });

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

  dbTest('does not admit a demoted environment for observation', async ({ db }) => {
    const branch = await seedStartingBranch(db);
    const branches = new BranchRepository(db);
    const health = new EnvironmentHealthRepository(db);
    await branches.update(branch.branch_id, { environment_instance: { status: 'error' } });

    // An errored environment is diagnosed on demand via an explicit status
    // request, which returns an ephemeral observation. It is never claimed for
    // background observation, so it cannot be silently revived.
    const claim = await health.claim({
      branchId: branch.branch_id,
      claimToken: 'demoted',
      leaseDurationMs: 30_000,
      identity: { instanceId: 'daemon-a', bootId: 'boot-a' },
    });

    expect(claim.outcome).not.toBe('claimed');
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
