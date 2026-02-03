/**
 * Git Impersonation Utilities
 *
 * Git operations (clone, worktree add/remove/clean) always run as the daemon user
 * to avoid permission issues with shared directories under /home/agorpg/.agor/.
 *
 * We still use sudo -u to force a fresh group membership read via initgroups(),
 * which ensures the executor process has current worktree groups (agor_wt_*).
 *
 * The daemon process has stale group memberships from startup, so without sudo -u,
 * git operations can't access worktree-owned files.
 */

import type { Database } from '@agor/core/db';
import type { UserID, Worktree } from '@agor/core/types';
import { validateResolvedUnixUser } from '@agor/core/unix';

/**
 * Resolve Unix user for git operations
 *
 * Git operations always run as the daemon user (agorpg) because:
 * 1. Parent directories (/home/agorpg/.agor/worktrees/) are owned by agorpg
 * 2. Running as another user causes permission errors when creating directories
 * 3. We still use sudo -u to get fresh group memberships via initgroups()
 *
 * @param db - Database instance (unused, kept for API compatibility)
 * @param userId - User ID (unused, kept for API compatibility)
 * @returns Daemon username to force fresh group lookup via sudo -u
 */
export async function resolveGitImpersonationForUser(
  db: Database,
  userId: UserID
): Promise<string | undefined> {
  const { getDaemonUser } = await import('@agor/core/config');

  // Always use daemon user for git operations
  const daemonUser = getDaemonUser();

  // Validate user exists
  if (daemonUser) {
    validateResolvedUnixUser('simple', daemonUser);
  }

  return daemonUser;
}

/**
 * Resolve Unix user for git operations on a worktree
 *
 * Uses the worktree creator's unix_username for impersonation.
 *
 * @param db - Database instance for user lookup
 * @param worktree - Worktree to resolve user for
 * @returns Unix username to impersonate, or undefined for no impersonation
 */
export async function resolveGitImpersonationForWorktree(
  db: Database,
  worktree: Worktree
): Promise<string | undefined> {
  return resolveGitImpersonationForUser(db, worktree.created_by);
}
