/**
 * Spawn-time pre-flight check (issue #1109).
 *
 * Before the daemon spawns anything that takes a worktree path as `cwd`
 * (terminal / AI executor / git op), call `assertWorktreeFsAvailable` so we
 * fail with a clear, structured `MissingPathError` instead of letting the
 * child process die with `chdir(2) failed: No such file or directory` (or
 * the even-more-misleading `spawn /usr/local/bin/node ENOENT`, which reports
 * against the executable path despite the cwd being the real culprit).
 *
 * Typical K8s failure mode: pod redeploy with `$HOME` as `emptyDir` but
 * Postgres on a persistent volume — DB has a worktree row, the directory is
 * gone.
 */
import { existsSync } from 'node:fs';

import type { Repo } from '../types/repo';
import type { Worktree } from '../types/worktree';
import { MissingPathError } from './missing-path-error';

export interface AssertWorktreeFsAvailableInput {
  worktree: Pick<Worktree, 'worktree_id' | 'repo_id' | 'path' | 'name'>;
  /** Parent repo if known. When provided, the repo's own `local_path` is also
   * checked — if it's gone too, the thrown error points at the repo first
   * (recovery requires re-cloning the repo before recreating worktrees). */
  repo?: Pick<Repo, 'repo_id' | 'local_path' | 'name' | 'slug'> | null;
}

/**
 * Throws `MissingPathError` if either the worktree's path or its parent
 * repo's path is missing on disk. Repo-missing takes precedence because
 * recovery requires re-cloning the repo first.
 *
 * Returns `void` on success; the caller proceeds to spawn.
 */
export function assertWorktreeFsAvailable({
  worktree,
  repo,
}: AssertWorktreeFsAvailableInput): void {
  if (repo && repo.local_path && !existsSync(repo.local_path)) {
    throw new MissingPathError(
      `Repository ${repo.slug || repo.name || repo.repo_id.slice(0, 8)} is registered ` +
        `in the database but its directory ${repo.local_path} no longer exists on disk. ` +
        `This typically happens in Kubernetes when $HOME is ephemeral but the database ` +
        `persists across restarts. Reclone the repository or delete the database record ` +
        `to recover.`,
      {
        code: 'REPO_PATH_MISSING',
        subject: 'repo',
        path: repo.local_path,
        action: 'reclone_or_delete',
        repo_id: repo.repo_id,
        worktree_id: worktree.worktree_id,
      }
    );
  }

  if (!existsSync(worktree.path)) {
    throw new MissingPathError(
      `Worktree ${worktree.name || worktree.worktree_id.slice(0, 8)} is registered ` +
        `in the database but its directory ${worktree.path} no longer exists on disk. ` +
        `This typically happens in Kubernetes when $HOME is ephemeral but the database ` +
        `persists across restarts. Recreate the worktree or delete the database record ` +
        `to recover.`,
      {
        code: 'WORKTREE_PATH_MISSING',
        subject: 'worktree',
        path: worktree.path,
        action: 'reclone_or_delete',
        worktree_id: worktree.worktree_id,
        repo_id: worktree.repo_id,
      }
    );
  }
}

/**
 * Non-throwing variant used by the startup reconciliation pass.
 *
 * Returns the first missing-path payload it would have thrown, or `null` if
 * everything is on disk. Callers persist the result onto the row's
 * `filesystem_status` so the UI can surface the drift before the user
 * triggers a spawn.
 */
export function detectWorktreeFsDrift({
  worktree,
  repo,
}: AssertWorktreeFsAvailableInput): { subject: 'worktree' | 'repo'; path: string } | null {
  const repoDrift = repo ? detectRepoFsDrift(repo) : null;
  if (repoDrift) {
    return { subject: 'repo', path: repoDrift.path };
  }
  if (!existsSync(worktree.path)) {
    return { subject: 'worktree', path: worktree.path };
  }
  return null;
}

/**
 * Pure predicate for repo-level FS drift. Returns `{ path }` of the missing
 * directory, or `null` when the repo is present on disk.
 *
 * Used by the startup reconciliation pass to mark `Repo.filesystem_status`
 * independently of any worktree context, and composed inside
 * `detectWorktreeFsDrift` so both call sites resolve drift the same way.
 */
export function detectRepoFsDrift(repo: Pick<Repo, 'local_path'>): { path: string } | null {
  if (!repo.local_path) return null;
  return existsSync(repo.local_path) ? null : { path: repo.local_path };
}
