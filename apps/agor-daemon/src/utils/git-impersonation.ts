/**
 * Git Impersonation Utilities
 *
 * Git operations (clone, branch add/remove/clean) always run as the daemon
 * user. We may wrap them in `sudo -u` to force a fresh group membership read
 * via `initgroups()` so the daemon can see `agor_wt_*` groups added at
 * runtime — but only when supplemental groups actually exist.
 *
 * In simple Unix mode no supplemental branch groups are created, even when
 * app-level `branch_rbac` is enabled, so wrapping in sudo is pure overhead
 * AND breaks for users who never configured passwordless sudoers (#1140).
 * Return undefined in that case so callers spawn directly.
 *
 * The gate lives HERE on purpose: every caller that resolves impersonation
 * needs the same check, and dropping it at a call site is exactly how the
 * sister bug (#1143, `git.branch.remove`) regressed after #1141 added
 * inline `rbacEnabled ? ... : undefined` boilerplate at only two of three
 * caller paths. Callers can spawn directly with the result; no extra gating
 * required.
 */

import type { Database } from '@agor/core/db';
import type { Branch, UserID } from '@agor/core/types';

/**
 * Resolve the configured daemon user for `sudo -u` group-refresh wrapping,
 * or `undefined` when no wrap is needed.
 *
 * This is the core primitive: pure config lookup, no user/db state. Used
 * both by git-execute spawn paths (via `resolveGitImpersonationForUser`)
 * and by short-lived executor git probes. Keeping a
 * single source of truth prevents the drift that caused #1143 — the same
 * stale gate copy-pasted across files.
 *
 * Dynamic config import is intentional: `loadConfigSync` reads from disk
 * and we don't want to pay that cost at module-load time.
 *
 * Note: existence-validation of the returned daemon user (e.g. via
 * `validateResolvedUnixUser`) is the responsibility of strict/insulated
 * impersonation paths, which know the active mode. This primitive only
 * answers "do we need a wrap, and if so, as whom?" — it does not vouch
 * for the resolved user.
 */
export async function resolveDaemonUserForGroupRefresh(): Promise<string | undefined> {
  const { getDaemonUser, isUnixGroupRefreshNeeded } = await import('@agor/core/config');

  // No supplemental groups → no need for sudo. Avoids requiring sudoers
  // for users on the default open-access setup. (#1140, #1143)
  if (!isUnixGroupRefreshNeeded()) {
    return undefined;
  }

  return getDaemonUser();
}

/**
 * Resolve Unix user for git operations.
 *
 * Returns the daemon user when group refresh via `sudo -u` is needed
 * (non-simple unix_user_mode — see `isUnixGroupRefreshNeeded`). Returns
 * `undefined` in simple mode so callers spawn directly without sudo wrap
 * (#1140), regardless of app-level branch RBAC.
 *
 * @param db - Database instance (unused today, kept on the signature for
 *             the planned per-user resolution refactor)
 * @param userId - User ID, optional. Reserved for per-user impersonation in
 *                 strict mode. Optional today because the resolver is the
 *                 sole gate; callers without an authenticated user (service
 *                 accounts, etc.) can still call us — we'll correctly fall
 *                 through to the daemon-user / undefined branches.
 * @returns Daemon username when sudo wrap is needed, otherwise undefined
 */
export async function resolveGitImpersonationForUser(
  _db: Database,
  _userId: UserID | undefined
): Promise<string | undefined> {
  return resolveDaemonUserForGroupRefresh();
}

/**
 * Resolve Unix user for git operations on a branch.
 *
 * @see resolveGitImpersonationForUser
 */
export async function resolveGitImpersonationForBranch(
  db: Database,
  branch: Branch
): Promise<string | undefined> {
  return resolveGitImpersonationForUser(db, branch.created_by);
}
