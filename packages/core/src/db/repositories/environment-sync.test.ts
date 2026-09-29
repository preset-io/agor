import type { BranchID } from '@agor/core/types';
import { describe, expect } from 'vitest';
import { generateId } from '../../lib/ids';
import type { Database } from '../client';
import { dbTest } from '../test-helpers';
import { BranchRepository } from './branches';
import { EnvironmentHealthRepository } from './environment-health';
import { EnvironmentSyncRepository } from './environment-sync';
import { RepoRepository } from './repos';
import { UsersRepository } from './users';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
let uniqueId = 9_970_000;

async function runningBranch(db: Database) {
  const user = await new UsersRepository(db).create({
    email: `${generateId()}@example.test`,
    name: 'Environment sync owner',
  });
  const repo = await new RepoRepository(db).create({
    slug: `sync-${generateId()}`,
    name: 'Sync',
    repo_type: 'local',
    local_path: `/tmp/${generateId()}`,
    default_branch: 'main',
  });
  const branch = await new BranchRepository(db).create({
    branch_id: generateId() as BranchID,
    repo_id: repo.repo_id,
    name: `sync-${generateId()}`,
    ref: 'main',
    branch_unique_id: uniqueId++,
    path: `/tmp/${generateId()}`,
    created_by: user.user_id,
    environment_instance: { status: 'running' },
  });
  return { branch, user };
}

describe('EnvironmentSyncRepository', () => {
  dbTest('rejects a request after the environment stops', async ({ db }) => {
    const { branch, user } = await runningBranch(db);
    await new BranchRepository(db).update(branch.branch_id, {
      environment_instance: { status: 'stopped' },
    });
    await expect(
      new EnvironmentSyncRepository(db).request({
        branchId: branch.branch_id,
        desiredRevision: A,
        requestedByUserId: user.user_id,
        commandBudgetMs: 300_000,
      })
    ).rejects.toThrow(/not ready/);
  });
  dbTest('only one worker claims an exact pending revision', async ({ db }) => {
    const { branch, user } = await runningBranch(db);
    const sync = new EnvironmentSyncRepository(db);
    await sync.request({
      branchId: branch.branch_id,
      desiredRevision: A,
      requestedByUserId: user.user_id,
      commandBudgetMs: 300_000,
    });
    const claims = await Promise.all([
      sync.claim({
        branchId: branch.branch_id,
        claimToken: 'one',
        identity: { instanceId: 'a', bootId: 'a' },
      }),
      sync.claim({
        branchId: branch.branch_id,
        claimToken: 'two',
        identity: { instanceId: 'b', bootId: 'b' },
      }),
    ]);
    expect(claims.filter((claim) => claim.outcome === 'claimed')).toHaveLength(1);
    expect(claims.filter((claim) => claim.outcome === 'held')).toHaveLength(1);
  });

  dbTest('an old acknowledgement never claims a newer requested revision', async ({ db }) => {
    const { branch, user } = await runningBranch(db);
    const sync = new EnvironmentSyncRepository(db);
    const request = (revision: string) =>
      sync.request({
        branchId: branch.branch_id,
        desiredRevision: revision,
        requestedByUserId: user.user_id,
        commandBudgetMs: 300_000,
      });
    await request(A);
    const claim = await sync.claim({
      branchId: branch.branch_id,
      claimToken: 'old',
      identity: { instanceId: 'a', bootId: 'a' },
    });
    if (claim.outcome !== 'claimed') throw new Error('Expected claim');
    await request(B);
    const settled = await sync.complete({
      branchId: branch.branch_id,
      claimToken: claim.attempt.token,
      appliedRevision: A,
      environmentGeneration: claim.attempt.environment_generation,
    });
    expect(settled).toMatchObject({
      outcome: 'settled',
      desired_revision: B,
      applied_revision: A,
      needs_reconcile: true,
    });
    const next = await sync.claim({
      branchId: branch.branch_id,
      claimToken: 'new',
      identity: { instanceId: 'b', bootId: 'b' },
    });
    expect(next).toMatchObject({ outcome: 'claimed', attempt: { revision: B } });
  });

  dbTest('a stale or wrong-generation result cannot overwrite the environment', async ({ db }) => {
    const { branch, user } = await runningBranch(db);
    const sync = new EnvironmentSyncRepository(db);
    await sync.request({
      branchId: branch.branch_id,
      desiredRevision: A,
      requestedByUserId: user.user_id,
      commandBudgetMs: 300_000,
    });
    const claim = await sync.claim({
      branchId: branch.branch_id,
      claimToken: 'current',
      identity: { instanceId: 'a', bootId: 'a' },
    });
    if (claim.outcome !== 'claimed') throw new Error('Expected claim');
    expect(
      await sync.complete({
        branchId: branch.branch_id,
        claimToken: 'wrong',
        appliedRevision: A,
        environmentGeneration: claim.attempt.environment_generation,
      })
    ).toEqual({ outcome: 'stale' });
    expect(
      await sync.complete({
        branchId: branch.branch_id,
        claimToken: claim.attempt.token,
        appliedRevision: A,
        environmentGeneration: claim.attempt.environment_generation + 1,
      })
    ).toEqual({ outcome: 'stale' });
    expect(
      await sync.complete({
        branchId: branch.branch_id,
        claimToken: claim.attempt.token,
        appliedRevision: A,
        environmentGeneration: claim.attempt.environment_generation,
      })
    ).toMatchObject({ outcome: 'settled', needs_reconcile: false });
  });

  dbTest(
    'health observations are held while Sync owns expected restart downtime',
    async ({ db }) => {
      const { branch, user } = await runningBranch(db);
      const sync = new EnvironmentSyncRepository(db);
      await sync.request({
        branchId: branch.branch_id,
        desiredRevision: A,
        requestedByUserId: user.user_id,
        commandBudgetMs: 300_000,
      });
      const claimed = await sync.claim({
        branchId: branch.branch_id,
        claimToken: 'sync',
        identity: { instanceId: 'a', bootId: 'a' },
      });
      expect(claimed.outcome).toBe('claimed');
      const health = await new EnvironmentHealthRepository(db).claim({
        branchId: branch.branch_id,
        claimToken: 'health',
        leaseDurationMs: 30_000,
        identity: { instanceId: 'h', bootId: 'h' },
      });
      expect(health.outcome).toBe('not_due');
    }
  );
});
