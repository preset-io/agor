/**
 * Startup filesystem reconciliation (issue #1109).
 *
 * Iterates every repo + worktree in the database and checks whether its
 * recorded `local_path` / `path` still exists on disk. Drift gets persisted
 * as `filesystem_status: 'missing'` so the UI can surface a Reclone / Delete
 * banner BEFORE the user tries to open a terminal or run a prompt.
 *
 * Why this matters: in K8s where `$HOME` is an `emptyDir` but Postgres lives
 * on a persistent volume, a pod redeploy leaves the DB pointing at paths
 * that no longer exist. Without this pass, the user only discovers the
 * problem when they hit "Open Terminal" and the executor dies with a
 * misleading `spawn /usr/local/bin/node ENOENT`.
 *
 * Idempotent and lossy in one direction only: it writes `'missing'` when
 * the FS is gone, and it clears `'missing'` back to `'ready'` when the FS
 * has reappeared (e.g. operator restored from backup). It NEVER deletes any
 * rows — recovery is gated on an explicit user action (recreate or remove).
 *
 * Skips in-flight rows (`creating` / `cloning`) and archive states
 * (`preserved` / `cleaned` / `deleted`) — those have their own lifecycle and
 * a missing path is expected/intentional for them.
 */
import type { Database } from '@agor/core/db';
import { RepoRepository, WorktreeRepository } from '@agor/core/db';
import { detectRepoFsDrift, detectWorktreeFsDrift } from '@agor/core/fs';
import type { Repo, Worktree } from '@agor/core/types';

export interface ReconciliationStats {
  worktrees_checked: number;
  worktrees_marked_missing: number;
  worktrees_restored: number;
  repos_checked: number;
  repos_marked_missing: number;
  repos_restored: number;
}

const WORKTREE_FS_RECONCILIATION_SKIP_STATES = new Set<NonNullable<Worktree['filesystem_status']>>([
  'creating',
  'preserved',
  'cleaned',
  'deleted',
]);

export async function reconcileFilesystemStatus(db: Database): Promise<ReconciliationStats> {
  const stats: ReconciliationStats = {
    worktrees_checked: 0,
    worktrees_marked_missing: 0,
    worktrees_restored: 0,
    repos_checked: 0,
    repos_marked_missing: 0,
    repos_restored: 0,
  };

  const repoRepo = new RepoRepository(db);
  const worktreeRepo = new WorktreeRepository(db);

  // Reconcile repos first — a missing repo cascades drift detection downward,
  // but we still want to record per-worktree status so the UI can offer the
  // right recovery action at the row the user is looking at.
  const repos = await repoRepo.findAll();
  for (const repo of repos) {
    stats.repos_checked++;
    const status = await reconcileRepo(repo, repoRepo);
    if (status === 'newly_missing') stats.repos_marked_missing++;
    else if (status === 'restored') stats.repos_restored++;
  }

  const worktreesList = await worktreeRepo.findAll({ includeArchived: false });
  for (const worktree of worktreesList) {
    stats.worktrees_checked++;
    const status = await reconcileWorktree(worktree, worktreeRepo);
    if (status === 'newly_missing') stats.worktrees_marked_missing++;
    else if (status === 'restored') stats.worktrees_restored++;
  }

  return stats;
}

type ReconcileOutcome = 'ok' | 'newly_missing' | 'restored' | 'skipped';

async function reconcileRepo(repo: Repo, repoRepo: RepoRepository): Promise<ReconcileOutcome> {
  // Don't touch repos still being cloned — their executor controls clone_status,
  // and stamping filesystem_status while clone is racing would be confusing.
  if (repo.clone_status === 'cloning') {
    return 'skipped';
  }

  const drift = detectRepoFsDrift(repo);
  const wasMissing = repo.filesystem_status === 'missing';

  if (drift && !wasMissing) {
    await repoRepo.update(repo.repo_id, { filesystem_status: 'missing' });
    console.warn(
      `[fs-reconciliation] Repo ${repo.slug} (${repo.repo_id.slice(0, 8)}) marked 'missing': ${drift.path}`
    );
    return 'newly_missing';
  }
  if (!drift && wasMissing) {
    await repoRepo.update(repo.repo_id, { filesystem_status: 'ready' });
    console.log(
      `[fs-reconciliation] Repo ${repo.slug} (${repo.repo_id.slice(0, 8)}) restored: ${repo.local_path}`
    );
    return 'restored';
  }
  return 'ok';
}

async function reconcileWorktree(
  worktree: Worktree,
  worktreeRepo: WorktreeRepository
): Promise<ReconcileOutcome> {
  if (
    worktree.filesystem_status &&
    WORKTREE_FS_RECONCILIATION_SKIP_STATES.has(worktree.filesystem_status)
  ) {
    return 'skipped';
  }

  // Reconciliation runs the worktree pass independently of the repo pass;
  // both call sites use `detectWorktreeFsDrift` / `detectRepoFsDrift` from
  // `@agor/core/fs` to keep the predicate honest in exactly one place.
  // (We don't pass `repo` here because repo drift is handled in its own pass
  // — checking parent-repo presence again would be a wasted lookup per
  // worktree.)
  const drift = detectWorktreeFsDrift({ worktree });
  const wasMissing = worktree.filesystem_status === 'missing';

  if (drift && !wasMissing) {
    await worktreeRepo.update(worktree.worktree_id, { filesystem_status: 'missing' });
    console.warn(
      `[fs-reconciliation] Worktree ${worktree.name} (${worktree.worktree_id.slice(0, 8)}) marked 'missing': ${drift.path}`
    );
    return 'newly_missing';
  }
  if (!drift && wasMissing) {
    await worktreeRepo.update(worktree.worktree_id, { filesystem_status: 'ready' });
    console.log(
      `[fs-reconciliation] Worktree ${worktree.name} (${worktree.worktree_id.slice(0, 8)}) restored: ${worktree.path}`
    );
    return 'restored';
  }
  return 'ok';
}
