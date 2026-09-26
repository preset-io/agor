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
import { eq } from 'drizzle-orm';
import { describe, expect } from 'vitest';
import { generateId } from '../../lib/ids';
import { select, update } from '../database-wrapper';
import { branches } from '../schema';
import { dbTest, ensureTestUser } from '../test-helpers';
import { BranchRepository } from './branches';
import { RepoRepository } from './repos';
import { SessionRepository } from './sessions';
import { TaskRepository } from './tasks';

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
    'source provenance is a strict active-attempt CAS, not a materialization edit exemption',
    async ({ db }) => {
      const { branchRepo, branchId } = await seedFailedBranch(db, {
        notes: 'Retained metadata',
        base_source: { name: 'old', remote_url: 'https://example.test/old.git' },
      });
      const provenance = { base_ref: 'refs/heads/main', base_sha: 'a'.repeat(40) };
      await branchRepo.claimForProvisioning(branchId, 'first');
      for (const edit of [
        provenance,
        { base_ref: 'main' },
        { base_sha: provenance.base_sha },
        { base_source: undefined },
      ]) {
        await expect(branchRepo.update(branchId, edit)).rejects.toThrow('materialization inputs');
      }
      for (const extra of [
        { path: '/wrong' },
        { filesystem_status: 'ready' },
        { new_branch: false },
      ]) {
        await expect(
          branchRepo.recordProvisioningProvenance(branchId, { ...provenance, ...extra }, 'first')
        ).rejects.toThrow('Invalid');
      }
      for (const attempt of ['', 'stale']) {
        await expect(
          branchRepo.recordProvisioningProvenance(branchId, provenance, attempt)
        ).rejects.toThrow();
      }
      const resolved = await branchRepo.recordProvisioningProvenance(branchId, provenance, 'first');
      expect(resolved).toMatchObject({
        ...provenance,
        filesystem_status: 'creating',
        notes: 'Retained metadata',
      });
      expect(resolved.base_source).toBeUndefined();
      await branchRepo.acknowledgeProvisioningAttempt(
        branchId,
        { filesystem_status: 'failed' },
        'first'
      );
      await branchRepo.claimForProvisioning(branchId, 'second');
      await expect(
        branchRepo.recordProvisioningProvenance(branchId, provenance, 'first')
      ).rejects.toThrow('not admitted');
      expect(
        (
          await branchRepo.acknowledgeProvisioningAttempt(
            branchId,
            { filesystem_status: 'ready' },
            'first'
          )
        ).applied
      ).toBe(false);
      await branchRepo.recordProvisioningProvenance(branchId, provenance, 'second');
      await branchRepo.acknowledgeProvisioningAttempt(
        branchId,
        { filesystem_status: 'ready' },
        'second'
      );
      await expect(
        branchRepo.recordProvisioningProvenance(branchId, provenance, 'second')
      ).rejects.toThrow('not admitted');
      await branchRepo.update(branchId, { filesystem_status: 'cleaned' });
      await branchRepo.claimForProvisioning(branchId, 'restore', { restore: true });
      await expect(
        branchRepo.recordProvisioningProvenance(branchId, provenance, 'restore')
      ).rejects.toThrow('not admitted');
    }
  );

  dbTest('claimForProvisioning flips failed→creating and clears the error', async ({ db }) => {
    const { branchRepo, branchId } = await seedFailedBranch(db);

    const { claimed, branch } = await branchRepo.claimForProvisioning(branchId, 'attempt-new');

    expect(claimed).toBe(true);
    expect(branch.filesystem_status).toBe('creating');
    expect(branch.error_message ?? undefined).toBeUndefined();

    const reloaded = await branchRepo.findById(branchId);
    expect(reloaded?.filesystem_status).toBe('creating');
    // Assert against the reloaded row, not just the returned object: clearing
    // the error has to reach the column, or the stale failure text keeps
    // showing in the UI while the branch is legitimately provisioning again.
    expect(reloaded?.error_message ?? undefined).toBeUndefined();
  });

  dbTest('claim is a no-op when the branch is not failed (e.g. already ready)', async ({ db }) => {
    const { branchRepo, branchId } = await seedFailedBranch(db, {
      filesystem_status: 'ready',
      error_message: undefined,
    });

    const { claimed, branch } = await branchRepo.claimForProvisioning(branchId, 'attempt-new');

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
        branchRepo.claimForProvisioning(branchId, 'attempt-a'),
        branchRepo.claimForProvisioning(branchId, 'attempt-b'),
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

    const { claimed, branch } = await branchRepo.claimForProvisioning(branchId, 'attempt-new');

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
      await branchRepo.claimForProvisioning(branchId, 'attempt-B');

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
    const { branch: claimed } = await branchRepo.claimForProvisioning(branchId, 'attempt-B');
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
      await branchRepo.claimForProvisioning(branchId, 'attempt-B');

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

  dbTest('terminal acknowledgements cannot mutate branch metadata', async ({ db }) => {
    const { branchRepo, branchId } = await seedFailedBranch(db);
    await branchRepo.claimForProvisioning(branchId, 'attempt-B');
    const before = await branchRepo.findById(branchId);
    for (const extra of [{ name: 'moved' }, { board_id: generateId() }, { archived: true }]) {
      await expect(
        branchRepo.acknowledgeProvisioningAttempt(
          branchId,
          { filesystem_status: 'ready', ...extra },
          'attempt-B'
        )
      ).rejects.toThrow(/terminal outcome/);
      expect(await branchRepo.findById(branchId)).toEqual(before);
    }
  });

  dbTest(
    'provisioning respects maintenance/deletion fences and retains unrelated persisted data',
    async ({ db }) => {
      const { branchRepo, branchId } = await seedFailedBranch(db);
      const row = await select(db).from(branches).where(eq(branches.branch_id, branchId)).one();
      if (!row) throw new Error('Missing fixture');
      const maintenance = {
        branch_id: branchId,
        operation_id: generateId(),
        generation: 1,
        kind: 'cleanup' as const,
      };
      for (const fence of ['maintenance', 'deletion'] as const) {
        await update(db, branches)
          .set({
            deletion_status: fence === 'deletion' ? 'deleting' : null,
            data: { ...row.data, maintenance: fence === 'maintenance' ? maintenance : undefined },
            filesystem_status: 'failed',
          })
          .where(eq(branches.branch_id, branchId))
          .run();
        expect((await branchRepo.claimForProvisioning(branchId, 'attempt-B')).claimed).toBe(false);
        await update(db, branches)
          .set({ filesystem_status: 'creating' })
          .where(eq(branches.branch_id, branchId))
          .run();
        expect(
          (
            await branchRepo.acknowledgeProvisioningAttempt(branchId, {
              filesystem_status: 'ready',
            })
          ).applied
        ).toBe(false);
        expect(
          (await branchRepo.markProvisioningFailedIfCreating(branchId, 'late failure')).changed
        ).toBe(false);
      }
      await update(db, branches)
        .set({
          deletion_status: null,
          filesystem_status: 'failed',
          data: {
            ...row.data,
            maintenance_generation: 7,
            cleanup_last_error: 'retained diagnostic',
          },
        })
        .where(eq(branches.branch_id, branchId))
        .run();
      expect((await branchRepo.claimForProvisioning(branchId, 'attempt-B')).claimed).toBe(true);
      expect(
        (
          await branchRepo.acknowledgeProvisioningAttempt(
            branchId,
            { filesystem_status: 'failed', error_message: 'failed' },
            'attempt-B'
          )
        ).applied
      ).toBe(true);
      const saved = await select(db).from(branches).where(eq(branches.branch_id, branchId)).one();
      expect(saved?.data).toMatchObject({
        maintenance_generation: 7,
        cleanup_last_error: 'retained diagnostic',
      });
    }
  );

  dbTest('archive cannot race an in-flight provisioning attempt', async ({ db }) => {
    const { branchRepo, branchId } = await seedFailedBranch(db);
    await branchRepo.claimForProvisioning(branchId, 'attempt-B');
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
    await branchRepo.claimForProvisioning(branchId, 'attempt-B');

    const result = await branchRepo.acknowledgeProvisioningAttempt(branchId, {
      filesystem_status: 'failed',
      error_message: 'old executor',
    });
    expect(result.applied).toBe(false);
    expect(result.branch.filesystem_status).toBe('creating');
  });
});

dbTest(
  'restore claims active stale and archived terminal records, clears columns and fences interrupted generations',
  async ({ db }) => {
    const { branchRepo, branchId } = await seedFailedBranch(db, {
      archived: true,
      archived_at: new Date().toISOString(),
      filesystem_status: 'cleaned',
    });
    const original = (await branchRepo.findById(branchId))!;
    await branchRepo.update(branchId, { archived_by: original.created_by });
    const claims = await Promise.all(
      ['one', 'two'].map((attempt) =>
        branchRepo.claimForProvisioning(branchId, attempt, { restore: true, archived: true })
      )
    );
    expect(claims.filter((claim) => claim.claimed)).toHaveLength(1);
    const winner = claims.find((claim) => claim.claimed)!.branch;
    expect(winner).toMatchObject({
      archived: false,
      filesystem_status: 'creating',
      provisioning_operation: 'restore',
    });
    expect(winner.archived_at).toBeUndefined();
    expect(winner.archived_by).toBeUndefined();
    await expect(branchRepo.update(branchId, { path: '/wrong' })).rejects.toThrow(
      'materialization inputs'
    );
    expect(
      (await branchRepo.claimForProvisioning(branchId, 'takeover', { restore: true })).claimed
    ).toBe(false);
    await branchRepo.markProvisioningFailedIfCreating(
      branchId,
      'Interrupted',
      winner.provisioning_attempt_id
    );
    const retry = await branchRepo.claimForProvisioning(branchId, 'retry', { restore: true });
    expect(retry.claimed).toBe(true);
    expect(
      (
        await branchRepo.acknowledgeProvisioningAttempt(
          branchId,
          { filesystem_status: 'ready' },
          winner.provisioning_attempt_id
        )
      ).applied
    ).toBe(false);
    expect(
      (
        await branchRepo.markProvisioningFailedIfCreating(
          branchId,
          'late exit',
          winner.provisioning_attempt_id
        )
      ).changed
    ).toBe(false);
    expect(
      (
        await branchRepo.acknowledgeProvisioningAttempt(
          branchId,
          { filesystem_status: 'ready' },
          'retry'
        )
      ).applied
    ).toBe(true);
    for (const status of ['cleaned', 'preserved', 'deleted'] as const) {
      await branchRepo.update(branchId, { filesystem_status: status });
      const admitted = await branchRepo.claimForProvisioning(branchId, status, { restore: true });
      expect(admitted.claimed).toBe(true);
      await branchRepo.acknowledgeProvisioningAttempt(
        branchId,
        { filesystem_status: 'ready' },
        status
      );
    }
  }
);

dbTest(
  'recovery excludes unfinished tasks and fences new producer admission while creating',
  async ({ db }) => {
    const { branchRepo, branchId } = await seedFailedBranch(db, { filesystem_status: 'ready' });
    const owner = (await branchRepo.findById(branchId))!.created_by;
    const sessions = new SessionRepository(db);
    const session = await sessions.create({
      branch_id: branchId,
      created_by: owner,
      agentic_tool: 'codex',
    });
    const tasks = new TaskRepository(db);
    const task = await tasks.create({
      session_id: session.session_id,
      created_by: owner,
      status: 'queued',
    });
    await branchRepo.update(branchId, { filesystem_status: 'cleaned' });
    await expect(
      branchRepo.claimForProvisioning(branchId, 'busy', { restore: true })
    ).rejects.toThrow('unfinished tasks');
    await tasks.update(task.task_id, { status: 'stopped' });
    expect(
      (await branchRepo.claimForProvisioning(branchId, 'idle', { restore: true })).claimed
    ).toBe(true);
    await expect(
      tasks.create({ session_id: session.session_id, created_by: owner, status: 'queued' })
    ).rejects.toThrow('provisioning');
    await expect(
      sessions.create({ branch_id: branchId, created_by: owner, agentic_tool: 'codex' })
    ).rejects.toThrow('provisioning');
  }
);

dbTest(
  'materialization fences filesystem inputs without blocking teammate metadata bootstrap',
  async ({ db }) => {
    const { branchRepo, branchId } = await seedFailedBranch(db, {
      filesystem_status: 'creating',
      provisioning_operation: 'create',
      custom_context: { teammate: { kind: 'teammate', displayName: 'Fixture', localHome: true } },
    });
    await expect(
      branchRepo.update(branchId, {
        custom_context: { teammate: { kind: 'teammate', displayName: 'Updated fixture' } },
      })
    ).resolves.toBeTruthy();
    await expect(
      branchRepo.update(branchId, {
        custom_context: {
          teammate: { kind: 'teammate', displayName: 'Fixture', localHome: false },
        },
      })
    ).rejects.toThrow('materialization inputs');
  }
);
