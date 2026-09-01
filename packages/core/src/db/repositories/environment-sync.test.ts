import type { BranchID, UserID } from '@agor/core/types';
import { describe, expect } from 'vitest';
import { generateId } from '../../lib/ids';
import type { Database } from '../client';
import { dbTest } from '../test-helpers';
import { BranchRepository } from './branches';
import { EnvironmentSyncRepository } from './environment-sync';
import { RepoRepository } from './repos';
import { UsersRepository } from './users';

const REVISION_A = 'a'.repeat(40);
const REVISION_B = 'b'.repeat(40);
let uniqueId = 9_910_000;

async function seedRunningBranch(
  db: Database,
  status: 'starting' | 'running' | 'stopped' = 'running'
) {
  const user = await new UsersRepository(db).create({
    email: `${generateId()}@example.test`,
    name: 'Environment sync owner',
  });
  const repo = await new RepoRepository(db).create({
    slug: `environment-sync-${generateId()}`,
    name: 'Environment sync',
    repo_type: 'local',
    local_path: `/tmp/${generateId()}`,
    default_branch: 'main',
  });
  const branch = await new BranchRepository(db).create({
    branch_id: generateId() as BranchID,
    repo_id: repo.repo_id,
    name: `environment-sync-${generateId()}`,
    ref: 'main',
    branch_unique_id: uniqueId++,
    path: `/tmp/${generateId()}`,
    created_by: user.user_id,
    environment_instance: { status },
  });
  return { branch, user };
}

describe('EnvironmentSyncRepository desired/applied reconciliation', () => {
  dbTest(
    'admits exactly one cross-caller claim for the current desired revision',
    async ({ db }) => {
      const { branch, user } = await seedRunningBranch(db);
      const sync = new EnvironmentSyncRepository(db);
      await sync.request({
        branchId: branch.branch_id,
        desiredRevision: REVISION_A,
        requestedByUserId: user.user_id as UserID,
      });

      const claims = await Promise.all([
        sync.claim({
          branchId: branch.branch_id,
          claimToken: 'claim-a',
          leaseDurationMs: 60_000,
          identity: { instanceId: 'daemon-a', bootId: 'boot-a' },
        }),
        sync.claim({
          branchId: branch.branch_id,
          claimToken: 'claim-b',
          leaseDurationMs: 60_000,
          identity: { instanceId: 'daemon-b', bootId: 'boot-b' },
        }),
      ]);

      expect(claims.filter((claim) => claim.outcome === 'claimed')).toHaveLength(1);
      expect(claims.filter((claim) => claim.outcome === 'held')).toHaveLength(1);
    }
  );

  dbTest(
    'never mistakes an older acknowledgement for the newest desired revision',
    async ({ db }) => {
      const { branch, user } = await seedRunningBranch(db);
      const secondUser = await new UsersRepository(db).create({
        email: `${generateId()}@example.test`,
        name: 'Newer sync requester',
      });
      const sync = new EnvironmentSyncRepository(db);
      await sync.request({
        branchId: branch.branch_id,
        desiredRevision: REVISION_A,
        requestedByUserId: user.user_id as UserID,
      });
      const first = await sync.claim({
        branchId: branch.branch_id,
        claimToken: 'revision-a',
        leaseDurationMs: 60_000,
        identity: { instanceId: 'daemon-a', bootId: 'boot-a' },
      });
      if (first.outcome !== 'claimed') throw new Error('Expected first claim');
      expect(first.attempt.requested_by_user_id).toBe(user.user_id);

      // A second task commits while A is already in flight.
      await sync.request({
        branchId: branch.branch_id,
        desiredRevision: REVISION_B,
        requestedByUserId: secondUser.user_id as UserID,
      });
      await expect(
        sync.complete({
          branchId: branch.branch_id,
          claimToken: first.attempt.token,
          appliedRevision: REVISION_A,
          environmentGeneration: first.attempt.environment_generation,
        })
      ).resolves.toMatchObject({
        outcome: 'settled',
        desired_revision: REVISION_B,
        applied_revision: REVISION_A,
        needs_reconcile: true,
      });

      const second = await sync.claim({
        branchId: branch.branch_id,
        claimToken: 'revision-b',
        leaseDurationMs: 60_000,
        identity: { instanceId: 'daemon-b', bootId: 'boot-b' },
      });
      expect(second).toMatchObject({
        outcome: 'claimed',
        attempt: { revision: REVISION_B, requested_by_user_id: secondUser.user_id },
      });
    }
  );

  dbTest('retains a task revision during startup and claims it once running', async ({ db }) => {
    const { branch, user } = await seedRunningBranch(db, 'starting');
    const branches = new BranchRepository(db);
    const sync = new EnvironmentSyncRepository(db);
    await sync.request({
      branchId: branch.branch_id,
      desiredRevision: REVISION_A,
      requestedByUserId: user.user_id as UserID,
    });

    await expect(
      sync.claim({
        branchId: branch.branch_id,
        claimToken: 'while-starting',
        leaseDurationMs: 60_000,
        identity: { instanceId: 'daemon-a', bootId: 'boot-a' },
      })
    ).resolves.toEqual({ outcome: 'unavailable' });

    await branches.update(branch.branch_id, { environment_instance: { status: 'running' } });
    await expect(
      sync.claim({
        branchId: branch.branch_id,
        claimToken: 'after-readiness',
        leaseDurationMs: 60_000,
        identity: { instanceId: 'daemon-b', bootId: 'boot-b' },
      })
    ).resolves.toMatchObject({
      outcome: 'claimed',
      attempt: {
        revision: REVISION_A,
        requested_by_user_id: user.user_id,
      },
    });
  });

  dbTest(
    'does not back off a newer desired revision when the old attempt fails',
    async ({ db }) => {
      const { branch } = await seedRunningBranch(db);
      const branches = new BranchRepository(db);
      const sync = new EnvironmentSyncRepository(db);
      await sync.request({ branchId: branch.branch_id, desiredRevision: REVISION_A });
      const claim = await sync.claim({
        branchId: branch.branch_id,
        claimToken: 'old-revision',
        leaseDurationMs: 60_000,
        identity: { instanceId: 'daemon-a', bootId: 'boot-a' },
      });
      if (claim.outcome !== 'claimed') throw new Error('Expected claim');

      await sync.request({ branchId: branch.branch_id, desiredRevision: REVISION_B });
      await expect(
        sync.fail({
          branchId: branch.branch_id,
          claimToken: claim.attempt.token,
          revision: REVISION_A,
          environmentGeneration: claim.attempt.environment_generation,
          message: 'old attempt failed',
        })
      ).resolves.toMatchObject({ outcome: 'settled', needs_reconcile: true });

      const current = await branches.findById(branch.branch_id);
      expect(current?.environment_instance?.source_sync).toMatchObject({
        desired_revision: REVISION_B,
      });
      expect(current?.environment_instance?.source_sync?.active_attempt).toBeUndefined();
      expect(current?.environment_instance?.source_sync?.retry_not_before_at).toBeUndefined();
      expect(current?.environment_instance?.source_sync?.last_error).toBeUndefined();
    }
  );

  dbTest('fences a completion across stop and restart lifecycle generations', async ({ db }) => {
    const { branch } = await seedRunningBranch(db);
    const branches = new BranchRepository(db);
    const sync = new EnvironmentSyncRepository(db);
    await sync.request({ branchId: branch.branch_id, desiredRevision: REVISION_A });
    const claim = await sync.claim({
      branchId: branch.branch_id,
      claimToken: 'before-stop',
      leaseDurationMs: 60_000,
      identity: { instanceId: 'daemon-a', bootId: 'boot-a' },
    });
    if (claim.outcome !== 'claimed') throw new Error('Expected claim');

    await branches.update(branch.branch_id, { environment_instance: { status: 'stopping' } });
    await branches.update(branch.branch_id, { environment_instance: { status: 'running' } });
    await expect(
      sync.complete({
        branchId: branch.branch_id,
        claimToken: claim.attempt.token,
        appliedRevision: REVISION_A,
        environmentGeneration: claim.attempt.environment_generation,
      })
    ).resolves.toEqual({ outcome: 'stale' });

    const retry = await sync.claim({
      branchId: branch.branch_id,
      claimToken: 'after-restart',
      leaseDurationMs: 60_000,
      identity: { instanceId: 'daemon-b', bootId: 'boot-b' },
    });
    expect(retry).toMatchObject({ outcome: 'claimed', attempt: { revision: REVISION_A } });
  });

  dbTest('records a bounded retry without demoting the running environment', async ({ db }) => {
    const { branch } = await seedRunningBranch(db);
    const branches = new BranchRepository(db);
    const sync = new EnvironmentSyncRepository(db);
    await sync.request({ branchId: branch.branch_id, desiredRevision: REVISION_A });
    const claim = await sync.claim({
      branchId: branch.branch_id,
      claimToken: 'failed-attempt',
      leaseDurationMs: 60_000,
      identity: { instanceId: 'daemon-a', bootId: 'boot-a' },
    });
    if (claim.outcome !== 'claimed') throw new Error('Expected claim');

    await expect(
      sync.fail({
        branchId: branch.branch_id,
        claimToken: claim.attempt.token,
        revision: REVISION_A,
        environmentGeneration: claim.attempt.environment_generation,
        message: `push failed\n${'x'.repeat(3_000)}`,
      })
    ).resolves.toMatchObject({ outcome: 'settled', needs_reconcile: true });
    const current = await branches.findById(branch.branch_id);
    expect(current?.environment_instance).toMatchObject({
      status: 'running',
      source_sync: {
        desired_revision: REVISION_A,
        failure_count: 1,
        retry_not_before_at: expect.any(String),
        last_error: { revision: REVISION_A },
      },
      last_command: { action: 'sync', status: 'failed' },
    });
    expect(
      current?.environment_instance?.source_sync?.last_error?.message.length
    ).toBeLessThanOrEqual(2_048);
    await expect(
      sync.claim({
        branchId: branch.branch_id,
        claimToken: 'too-soon',
        leaseDurationMs: 60_000,
        identity: { instanceId: 'daemon-b', bootId: 'boot-b' },
      })
    ).resolves.toMatchObject({ outcome: 'not_due' });
  });

  dbTest('rejects abbreviated, dirty, and unknown revisions', async ({ db }) => {
    const { branch } = await seedRunningBranch(db);
    const sync = new EnvironmentSyncRepository(db);
    for (const revision of ['abc1234', `${REVISION_A}-dirty`, 'unknown']) {
      await expect(
        sync.request({ branchId: branch.branch_id, desiredRevision: revision })
      ).rejects.toThrow(/full lowercase Git/);
    }
  });
});
