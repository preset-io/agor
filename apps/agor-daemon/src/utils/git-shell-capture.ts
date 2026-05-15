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
 * Gating uses the shared `resolveDaemonUserForGroupRefresh` primitive from
 * `git-impersonation.ts` so there is one source of truth (#1143 hoisted
 * the gate into that primitive).
 */

import { runAsUser } from '@agor/core/unix';
import { resolveDaemonUserForGroupRefresh } from './git-impersonation.js';

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
  const daemonUser = await resolveDaemonUserForGroupRefresh();
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
