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

    await expect(
      health.commit({
        branchId: branch.branch_id,
        claimToken: claim.claim.claim_token,
        environmentGeneration: claim.claim.environment_generation,
        observation: { status: 'healthy', message: 'HTTP 200', recordWhileStarting: true },
      })
    ).resolves.toMatchObject({ outcome: 'committed', environmentStatus: 'running' });
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
});
