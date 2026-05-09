/**
 * Git Shell Capture - Get git state via shell commands with fresh group memberships
 *
 * The daemon process has stale Unix group memberships from startup (groups added
 * after daemon start are missing). This means in-process simple-git calls fail
 * for repos whose ACLs rely on recently-added groups.
 *
 * When supplemental groups exist (RBAC enabled, or `unix_user_mode` insulated/
 * strict), we wrap git commands in `sudo -u <daemonUser>` so sudo calls
 * initgroups() and gets fresh group memberships from /etc/group. In the open-
 * access default (no RBAC, simple mode) no such groups exist, so we run the
 * git command directly — this avoids requiring sudoers config (#1140).
 *
 * @see git-impersonation.ts for the same pattern used in git clone/worktree operations
 */

import { runAsUser, validateResolvedUnixUser } from '@agor/core/unix';

/**
 * Resolve and validate the daemon user for sudo -u impersonation.
 *
 * Returns `undefined` when no supplemental groups exist (no RBAC, simple
 * unix mode), so `runAsUser` runs the command directly without sudo. This
 * matches the gating in {@link ../utils/git-impersonation.ts} and avoids
 * the "user not in sudoers" failure on default open-access setups (#1140).
 *
 * @returns Validated daemon username, or undefined if no group refresh is needed
 */
async function resolveValidatedDaemonUser(): Promise<string | undefined> {
  const { getDaemonUser, isUnixGroupRefreshNeeded } = await import('@agor/core/config');
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
 * Capture git SHA and branch ref via shell commands
 *
 * Resolves the daemon user from config, validates it, then uses sudo -u
 * to get fresh Unix group memberships. Falls back to direct shell execution
 * when no daemon user is configured.
 *
 * @param worktreePath - Path to the git worktree
 * @returns Object with sha (includes -dirty suffix) and ref (branch name)
 */
export async function captureGitStateViaShell(
  worktreePath: string
): Promise<{ sha: string; ref: string }> {
  const daemonUser = await resolveValidatedDaemonUser();
  const runOpts = { asUser: daemonUser, timeout: 10000 };

  let sha = 'unknown';
  let ref = 'unknown';

  try {
    // Get current HEAD SHA
    const rawSha = runAsUser(`git -C ${escapeForShell(worktreePath)} rev-parse HEAD`, runOpts);
    sha = rawSha.trim();
  } catch (error) {
    console.warn(`[git-shell-capture] Failed to get SHA for ${worktreePath}:`, error);
    return { sha, ref };
  }

  try {
    // Get current branch name
    const rawRef = runAsUser(
      `git -C ${escapeForShell(worktreePath)} rev-parse --abbrev-ref HEAD`,
      runOpts
    );
    ref = rawRef.trim();
  } catch (error) {
    console.warn(`[git-shell-capture] Failed to get branch for ${worktreePath}:`, error);
  }

  try {
    // Check if working directory is dirty
    const status = runAsUser(`git -C ${escapeForShell(worktreePath)} status --porcelain`, runOpts);
    if (status.trim().length > 0) {
      sha = `${sha}-dirty`;
    }
  } catch (error) {
    console.warn(`[git-shell-capture] Failed to check dirty state for ${worktreePath}:`, error);
    // If we can't check dirty state, still return the SHA without -dirty suffix
  }

  return { sha, ref };
}

/**
 * Escape a path for use in a shell command (wraps in single quotes)
 */
function escapeForShell(path: string): string {
  return `'${path.replace(/'/g, "'\\''")}'`;
}
