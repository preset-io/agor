/**
 * Git Impersonation Utilities
 *
 * Git operations (clone, worktree add/remove/clean) always run as the daemon
 * user. We may wrap them in `sudo -u` to force a fresh group membership read
 * via `initgroups()` so the daemon can see `agor_wt_*` groups added at
 * runtime — but only when supplemental groups actually exist.
 *
 * In the open-access default (`worktree_rbac: false`, `unix_user_mode:
 * simple`) no supplemental groups are ever created, so wrapping in sudo is
 * pure overhead AND breaks for users who never configured passwordless
 * sudoers (#1140). Return undefined in that case so callers spawn directly.
 */

import type { Database } from '@agor/core/db';
import type { UserID, Worktree } from '@agor/core/types';
import { validateResolvedUnixUser } from '@agor/core/unix';

/**
 * Resolve Unix user for git operations.
 *
 * Returns the daemon user when group refresh via `sudo -u` is needed
 * (RBAC enabled or non-simple unix_user_mode). Returns `undefined` when
 * no supplemental groups exist, signalling callers to skip sudo entirely.
 *
 * @param db - Database instance (unused, kept for API compatibility)
 * @param userId - User ID (unused, kept for API compatibility)
 * @returns Daemon username when sudo wrap is needed, otherwise undefined
 */
export async function resolveGitImpersonationForUser(
  _db: Database,
  _userId: UserID
): Promise<string | undefined> {
  const { getDaemonUser, isUnixGroupRefreshNeeded } = await import('@agor/core/config');

  // No supplemental groups → no need for sudo. Avoids requiring sudoers
  // for users on the default open-access setup. (#1140)
  if (!isUnixGroupRefreshNeeded()) {
    return undefined;
  }

  const daemonUser = getDaemonUser();
  if (daemonUser) {
    validateResolvedUnixUser('simple', daemonUser);
  }
  return daemonUser;
}

/**
 * Resolve Unix user for git operations on a worktree.
 *
 * @see resolveGitImpersonationForUser
 */
export async function resolveGitImpersonationForWorktree(
  db: Database,
  worktree: Worktree
): Promise<string | undefined> {
  return resolveGitImpersonationForUser(db, worktree.created_by);
}
