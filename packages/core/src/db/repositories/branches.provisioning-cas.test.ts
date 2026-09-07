/**
 * Atomic compare-and-swap for provisioning state transitions.
 *
 * The retry/repair design leans on the state transition itself being the lock:
 * `failed → creating` (claim for retry) and `creating → failed` (interrupted
 * safety net) must each apply only when the row is still in the "from" state,
 * under a row lock, so two racing callers can never both act. These tests pin
 * that contract against a real database. Privacy: generic placeholder names.
 */
import type { UUID } from '@agor/core/types';
import { describe, expect } from 'vitest';
import { generateId } from '../../lib/ids';
import { dbTest, ensureTestUser } from '../test-helpers';
import { BranchRepository } from './branches';
import { RepoRepository } from './repos';

// `db` is `any` because dbTest hands us a loosely-typed Database fixture.
async function seedFailedBranch(
  db: any,
  over: Record<string, unknown> = {}
): Promise<{ branchRepo: BranchRepository; branchId: UUID }> {
  const repoRepo = new RepoRepository(db);
  const branchRepo = new BranchRepository(db);
  // `BranchRepository.create` requires the primary owner to be a real user in
  // this tenant, so the owner principal has to exist before the branch does.
  const owner = await ensureTestUser(db);
  const repo = await repoRepo.create({
    repo_id: generateId(),
    slug: `repo-${generateId()}`,
    name: 'Test Repo',
    repo_type: 'local' as const,
    local_path: '/tmp/base',
    default_branch: 'main',
  });
  const branch = await branchRepo.create({
    branch_id: generateId(),
    repo_id: repo.repo_id,
    name: 'feature',
    ref: 'feature',
    branch_unique_id: Math.floor(Math.random() * 1_000_000),
    path: '/tmp/base/feature',
    base_ref: 'main',
    new_branch: true,
    created_by: owner as UUID,
    filesystem_status: 'failed',
    error_message: 'boom',
    ...over,
  });
  return { branchRepo, branchId: branch.branch_id as UUID };
}

describe('BranchRepository provisioning CAS', () => {
  dbTest(
    'claimFailedForProvisioningRetry flips failed→creating and clears the error',
    async ({ db }) => {
      const { branchRepo, branchId } = await seedFailedBranch(db);

      const { claimed, branch } = await branchRepo.claimFailedForProvisioningRetry(
        branchId,
        'attempt-new'
      );

      expect(claimed).toBe(true);
      expect(branch.filesystem_status).toBe('creating');
      expect(branch.error_message ?? undefined).toBeUndefined();

      const reloaded = await branchRepo.findById(branchId);
      expect(reloaded?.filesystem_status).toBe('creating');
      // Assert against the reloaded row, not just the returned object: clearing
      // the error has to reach the column, or the stale failure text keeps
      // showing in the UI while the branch is legitimately provisioning again.
      expect(reloaded?.error_message ?? undefined).toBeUndefined();
    }
  );

  dbTest('claim is a no-op when the branch is not failed (e.g. already ready)', async ({ db }) => {
    const { branchRepo, branchId } = await seedFailedBranch(db, {
      filesystem_status: 'ready',
      error_message: undefined,
    });

    const { claimed, branch } = await branchRepo.claimFailedForProvisioningRetry(
      branchId,
      'attempt-new'
    );

    expect(claimed).toBe(false);
    expect(branch.filesystem_status).toBe('ready');
  });

  dbTest(
    'two concurrent claims: exactly one wins (double-click cannot double-dispatch)',
    async ({ db }) => {
      const { branchRepo, branchId } = await seedFailedBranch(db);

      // Postgres serializes via the row lock (loser observes `claimed: false`).
      // SQLite serializes via its global write lock (loser may reject with
      // SQLITE_BUSY). Either way the CAS guarantees at most one WINNER, so a
      // double-click / concurrent retry can never dispatch two materializers.
      const settled = await Promise.allSettled([
        branchRepo.claimFailedForProvisioningRetry(branchId, 'attempt-a'),
        branchRepo.claimFailedForProvisioningRetry(branchId, 'attempt-b'),
      ]);

      const winners = settled.filter((r) => r.status === 'fulfilled' && r.value.claimed);
      expect(winners).toHaveLength(1);

      // Whatever happened to the loser, the row is now exactly `creating`.
      const reloaded = await branchRepo.findById(branchId);
      expect(reloaded?.filesystem_status).toBe('creating');
    }
  );

  dbTest(
    'markProvisioningFailedIfCreating flips creating→failed with a message',
    async ({ db }) => {
      const { branchRepo, branchId } = await seedFailedBranch(db, {
        filesystem_status: 'creating',
        error_message: undefined,
      });

      const { changed, branch } = await branchRepo.markProvisioningFailedIfCreating(
        branchId,
        'interrupted'
      );

      expect(changed).toBe(true);
      expect(branch.filesystem_status).toBe('failed');
      expect(branch.error_message).toBe('interrupted');
    }
  );

  dbTest('markProvisioningFailedIfCreating never clobbers a ready branch', async ({ db }) => {
    const { branchRepo, branchId } = await seedFailedBranch(db, {
      filesystem_status: 'ready',
      error_message: undefined,
    });

    const { changed, branch } = await branchRepo.markProvisioningFailedIfCreating(
      branchId,
      'interrupted'
    );

    expect(changed).toBe(false);
    expect(branch.filesystem_status).toBe('ready');
  });

  // ---- attempt fence -------------------------------------------------------
  //
  // Status alone is a claim lock, not an attempt fence: it says a
  // materialization is in flight, not which one. These pin the generation
  // check that stops a superseded attempt from writing over a newer one.

  dbTest('claim stamps the new generation onto the row', async ({ db }) => {
    const { branchRepo, branchId } = await seedFailedBranch(db, {
      provisioning_attempt_id: 'attempt-old',
    });

    const { claimed, branch } = await branchRepo.claimFailedForProvisioningRetry(
      branchId,
      'attempt-new'
    );

    expect(claimed).toBe(true);
    expect(branch.provisioning_attempt_id).toBe('attempt-new');
    const reloaded = await branchRepo.findById(branchId);
    expect(reloaded?.provisioning_attempt_id).toBe('attempt-new');
  });

  dbTest(
    "a superseded attempt's late onExit cannot fail the attempt that replaced it",
    async ({ db }) => {
      // Attempt A failed → user retried → attempt B now owns `creating`.
      const { branchRepo, branchId } = await seedFailedBranch(db, {
        provisioning_attempt_id: 'attempt-A',
      });
      await branchRepo.claimFailedForProvisioningRetry(branchId, 'attempt-B');

      // Now A's delayed onExit fires, still carrying its own generation.
      const { changed, branch } = await branchRepo.markProvisioningFailedIfCreating(
        branchId,
        'attempt A exited non-zero',
        'attempt-A'
      );

      expect(changed).toBe(false);
      expect(branch.filesystem_status).toBe('creating');
      expect(branch.provisioning_attempt_id).toBe('attempt-B');
      expect(branch.error_message ?? undefined).toBeUndefined();
    }
  );

  dbTest("the current attempt's own onExit still applies", async ({ db }) => {
    const { branchRepo, branchId } = await seedFailedBranch(db);
    const { branch: claimed } = await branchRepo.claimFailedForProvisioningRetry(
      branchId,
      'attempt-B'
    );
    expect(claimed.filesystem_status).toBe('creating');

    const { changed, branch } = await branchRepo.markProvisioningFailedIfCreating(
      branchId,
      'attempt B exited non-zero',
      'attempt-B'
    );

    expect(changed).toBe(true);
    expect(branch.filesystem_status).toBe('failed');
    expect(branch.error_message).toBe('attempt B exited non-zero');
  });

  dbTest('an unfenced caller (startup watchdog) still transitions', async ({ db }) => {
    // The watchdog runs when no attempt can still be live, so it deliberately
    // targets whatever generation currently owns the row.
    const { branchRepo, branchId } = await seedFailedBranch(db, {
      filesystem_status: 'creating',
      error_message: undefined,
      provisioning_attempt_id: 'attempt-from-a-dead-daemon',
    });

    const { changed, branch } = await branchRepo.markProvisioningFailedIfCreating(
      branchId,
      'interrupted by restart'
    );

    expect(changed).toBe(true);
    expect(branch.filesystem_status).toBe('failed');
  });

  dbTest(
    'terminal acknowledgement applies only to its current creating generation',
    async ({ db }) => {
      const { branchRepo, branchId } = await seedFailedBranch(db);
      await branchRepo.claimFailedForProvisioningRetry(branchId, 'attempt-B');

      const stale = await branchRepo.acknowledgeProvisioningAttempt(
        branchId,
        { filesystem_status: 'ready' },
        'attempt-A'
      );
      expect(stale.applied).toBe(false);
      expect(stale.branch.filesystem_status).toBe('creating');

      const current = await branchRepo.acknowledgeProvisioningAttempt(
        branchId,
        { filesystem_status: 'ready' },
        'attempt-B'
      );
      expect(current.applied).toBe(true);
      expect(current.branch.filesystem_status).toBe('ready');
    }
  );

  dbTest('archive cannot race an in-flight provisioning attempt', async ({ db }) => {
    const { branchRepo, branchId } = await seedFailedBranch(db);
    await branchRepo.claimFailedForProvisioningRetry(branchId, 'attempt-B');
    await expect(
      branchRepo.update(branchId, { archived: true, filesystem_status: 'preserved' })
    ).rejects.toThrow(/provisioning is in progress/i);

    const result = await branchRepo.acknowledgeProvisioningAttempt(
      branchId,
      { filesystem_status: 'ready' },
      'attempt-B'
    );
    expect(result.applied).toBe(true);
    expect(result.branch.archived).toBe(false);
    expect(result.branch.filesystem_status).toBe('ready');
  });

  dbTest('legacy acknowledgements cannot overwrite a generated attempt', async ({ db }) => {
    const { branchRepo, branchId } = await seedFailedBranch(db);
    await branchRepo.claimFailedForProvisioningRetry(branchId, 'attempt-B');

    const result = await branchRepo.acknowledgeProvisioningAttempt(branchId, {
      filesystem_status: 'failed',
      error_message: 'old executor',
    });
    expect(result.applied).toBe(false);
    expect(result.branch.filesystem_status).toBe('creating');
  });
});
