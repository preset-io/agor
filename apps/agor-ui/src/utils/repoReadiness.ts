import type { Repo } from '@agor-live/client';

/**
 * Legacy/local repository rows may not have clone_status. Explicit remote
 * lifecycle states are ready only after materialization completes.
 */
export function isRepoReadyForBranchCreation(repo: Repo | undefined): boolean {
  return !!repo && (repo.clone_status === undefined || repo.clone_status === 'ready');
}

export function getRepoBranchCreationBlockReason(repo: Repo | undefined): string | undefined {
  if (!repo) return undefined;

  if (repo.clone_status === 'cloning') {
    return 'Repository clone is still in progress. Wait for it to finish before creating a branch.';
  }

  if (repo.clone_status === 'failed') {
    const category = repo.clone_error?.category ? ` (${repo.clone_error.category})` : '';
    const detail = repo.clone_error?.message
      ? ` ${repo.clone_error.message}`
      : ' The repository checkout is unavailable or incomplete.';
    return `Repository clone failed${category}.${detail} Retry the clone before creating a branch.`;
  }

  return undefined;
}
