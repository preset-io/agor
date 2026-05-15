/**
 * Persist filesystem-drift state after a spawn-time pre-flight check throws
 * a `MissingPathError` (issue #1109).
 *
 * Lives daemon-side because the work is service-layer DB patching, which we
 * never push into `@agor/core`. The drift detection itself is core
 * (`assertWorktreeFsAvailable`); persisting the result is app glue.
 *
 * Swallows patch failures (non-fatal — the structured error is what the
 * caller cares about; the marker is best-effort UX so the next reader sees
 * the banner without needing to re-spawn).
 */
import type { Application } from '@agor/core/feathers';
import { isMissingPathError } from '@agor/core/fs';
import type { Repo } from '@agor/core/types';

export async function markMissingPathDrift(
  app: Application,
  err: unknown,
  repo: Repo | null,
  logPrefix: string
): Promise<void> {
  if (!isMissingPathError(err)) return;
  const { subject, worktree_id } = err.payload;
  try {
    if (subject === 'worktree' && worktree_id) {
      await app
        .service('worktrees')
        .patch(worktree_id, { filesystem_status: 'missing' }, { provider: undefined });
    } else if (subject === 'repo' && repo) {
      await app
        .service('repos')
        .patch(repo.repo_id, { filesystem_status: 'missing' }, { provider: undefined });
    }
  } catch (patchErr) {
    console.warn(
      `${logPrefix} Failed to mark ${subject} as missing in DB:`,
      patchErr instanceof Error ? patchErr.message : String(patchErr)
    );
  }
}
