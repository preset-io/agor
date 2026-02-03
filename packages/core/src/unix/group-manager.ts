/**
 * Unix Group Management for Worktree and Repo Isolation
 *
 * Provides utilities for managing:
 * - Worktree Unix groups (agor_wt_<short-id>) - for worktree directory access
 * - Repo Unix groups (agor_rp_<short-id>) - for .git/ directory access
 *
 * These functions are designed to be called via `sudo agor admin` commands
 * to perform privileged operations safely.
 *
 * @see context/explorations/unix-user-modes.md
 * @see context/explorations/rbac.md
 */

import { formatShortId } from '../lib/ids.js';
import type { RepoID, UUID, WorktreeID } from '../types/index.js';

/**
 * Generate Unix group name for a worktree
 *
 * Format: agor_wt_<short-id>
 * Example: agor_wt_03b62447
 *
 * @param worktreeId - Full worktree UUID
 * @returns Unix group name (e.g., 'agor_wt_03b62447')
 */
export function generateWorktreeGroupName(worktreeId: WorktreeID): string {
  const shortId = formatShortId(worktreeId as UUID);
  return `agor_wt_${shortId}`;
}

/**
 * Parse worktree ID from Unix group name
 *
 * Extracts the short ID from a group name like 'agor_wt_03b62447'
 *
 * @param groupName - Unix group name
 * @returns Short worktree ID (8 chars) or null if invalid format
 */
export function parseWorktreeGroupName(groupName: string): string | null {
  const match = groupName.match(/^agor_wt_([0-9a-f]{8})$/);
  return match ? match[1] : null;
}

/**
 * Validate Unix group name format
 *
 * @param groupName - Group name to validate
 * @returns true if valid worktree group name
 */
export function isValidWorktreeGroupName(groupName: string): boolean {
  return /^agor_wt_[0-9a-f]{8}$/.test(groupName);
}

// ============================================================
// REPO GROUP UTILITIES
// ============================================================

/**
 * Generate Unix group name for a repo
 *
 * Format: agor_rp_<short-id>
 * Example: agor_rp_03b62447
 *
 * This group controls access to the repo's .git/ directory,
 * which is shared across all worktrees.
 *
 * @param repoId - Full repo UUID
 * @returns Unix group name (e.g., 'agor_rp_03b62447')
 */
export function generateRepoGroupName(repoId: RepoID): string {
  const shortId = formatShortId(repoId as UUID);
  return `agor_rp_${shortId}`;
}

/**
 * Parse repo ID from Unix group name
 *
 * Extracts the short ID from a group name like 'agor_rp_03b62447'
 *
 * @param groupName - Unix group name
 * @returns Short repo ID (8 chars) or null if invalid format
 */
export function parseRepoGroupName(groupName: string): string | null {
  const match = groupName.match(/^agor_rp_([0-9a-f]{8})$/);
  return match ? match[1] : null;
}

/**
 * Validate Unix repo group name format
 *
 * @param groupName - Group name to validate
 * @returns true if valid repo group name
 */
export function isValidRepoGroupName(groupName: string): boolean {
  return /^agor_rp_[0-9a-f]{8}$/.test(groupName);
}

/**
 * The global group for all Agor-managed users
 *
 * Users in this group can be impersonated by the daemon.
 * This provides namespace containment - daemon can only
 * impersonate users it manages.
 */
export const AGOR_USERS_GROUP = 'agor_users';

/**
 * Unix group management commands
 *
 * Commands are returned as shell strings with sudo already included where needed.
 * Privileged commands (groupadd, usermod, etc.) include `sudo -n` for passwordless execution.
 * Read-only commands (getent, id) run without sudo.
 *
 * The executor's runCommand() function executes these strings directly without modification.
 */
export const UnixGroupCommands = {
  /**
   * Create a new Unix group
   *
   * @param groupName - Name of the group to create
   * @returns Command string with sudo
   */
  createGroup: (groupName: string) => `sudo -n groupadd ${groupName}`,

  /**
   * Delete a Unix group
   *
   * @param groupName - Name of the group to delete
   * @returns Command string with sudo
   */
  deleteGroup: (groupName: string) => `sudo -n groupdel ${groupName}`,

  /**
   * Add user to a Unix group
   *
   * @param username - Unix username to add
   * @param groupName - Group to add user to
   * @returns Command string with sudo
   */
  addUserToGroup: (username: string, groupName: string) =>
    `sudo -n usermod -aG ${groupName} ${username}`,

  /**
   * Remove user from a Unix group
   *
   * @param username - Unix username to remove
   * @param groupName - Group to remove user from
   * @returns Command string with sudo
   */
  removeUserFromGroup: (username: string, groupName: string) =>
    `sudo -n gpasswd -d ${username} ${groupName}`,

  /**
   * Check if a group exists (read-only, no sudo needed)
   *
   * @param groupName - Group name to check
   * @returns Command string (exits 0 if exists, 1 if not)
   */
  groupExists: (groupName: string) => `getent group ${groupName} > /dev/null`,

  /**
   * Check if a user is in a group (read-only, no sudo needed)
   *
   * @param username - Unix username
   * @param groupName - Group name
   * @returns Command string (exits 0 if member, 1 if not)
   */
  isUserInGroup: (username: string, groupName: string) =>
    `id -nG ${username} | grep -qw ${groupName}`,

  /**
   * List all members of a group (read-only, no sudo needed)
   *
   * @param groupName - Group name
   * @returns Command string (outputs comma-separated usernames)
   */
  listGroupMembers: (groupName: string) => `getent group ${groupName} | cut -d: -f4`,

  /**
   * Set directory group ownership and permissions
   *
   * Returns an array of commands to be executed sequentially.
   * Each command includes `sudo -n` for privileged execution.
   *
   * Uses ACLs (Access Control Lists) for permission management. ACLs provide
   * DEFAULT permissions that automatically apply to all new files and directories,
   * regardless of the creating process's umask. This ensures group write access
   * is always preserved.
   *
   * The permissions parameter controls "others" access:
   * - '2770' → others get no access (o::---)
   * - '2775' → others get read/execute (o::r-x)
   * - '2777' → others get full access (o::rwx)
   *
   * @param path - Directory path
   * @param groupName - Group to own the directory
   * @param permissions - Permissions mode (e.g., '2770' for no others access)
   * @returns Array of command strings with sudo to execute sequentially
   */
  setDirectoryGroup: (path: string, groupName: string, permissions: string): string[] => {
    // Determine "others" ACL based on permissions mode
    // 2770 = no others, 2775 = others r-X, 2777 = others rwX
    // Using capital X means: execute only on directories, not files
    const othersDigit = permissions.charAt(3); // Last digit is "others"
    let othersAcl: string;
    switch (othersDigit) {
      case '7':
        othersAcl = 'o::rwX';
        break;
      case '5':
        othersAcl = 'o::rX';
        break;
      default:
        othersAcl = 'o::---';
    }

    return [
      // Set primary group ownership (visible in ls -la)
      `sudo -n chgrp -R ${groupName} "${path}"`,
      // Set setgid bit on directories only (new files inherit group ownership)
      // Note: find runs without sudo (just traversing), chmod inside -exec uses sudo
      `find "${path}" -type d -exec sudo -n chmod g+s {} +`,
      // ACL: owner gets full access
      `sudo -n setfacl -R -m u::rwX "${path}"`,
      // ACL: group gets full access (rwX = rw for files, rwx for dirs)
      `sudo -n setfacl -R -m g:${groupName}:rwX "${path}"`,
      // ACL: set "others" access based on permissions mode
      `sudo -n setfacl -R -m ${othersAcl} "${path}"`,
      // ACL: set mask to allow group permissions (critical for effective permissions)
      `sudo -n setfacl -R -m m::rwX "${path}"`,
      // DEFAULT ACLs for new files/dirs (inherit these permissions)
      // IMPORTANT: Include m::rwX to ensure mask allows group access on new files
      `sudo -n setfacl -R -d -m u::rwX,g:${groupName}:rwX,${othersAcl},m::rwX "${path}"`,
    ];
  },
} as const;

/**
 * Permission modes for worktree directories
 *
 * These map to the 'others_fs_access' RBAC setting.
 *
 * IMPORTANT: The GROUP always gets full access (7 = rwx) because owners
 * access files through their group membership. The 'others_fs_access' setting
 * controls what OTHERS (non-owners) get:
 * - 'none'  → others get 0 (---)
 * - 'read'  → others get 5 (r-x)
 * - 'write' → others get 7 (rwx)
 *
 * The setgid bit (2) ensures new files inherit the group.
 */
export const WorktreePermissionModes = {
  /** No access for non-owners (permission denied) */
  none: '2770', // drwxrws--- (owner + group full access, others nothing, setgid)

  /** Read-only access for non-owners */
  read: '2775', // drwxrwsr-x (owner + group full access, others read/execute, setgid)

  /** Read-write access for non-owners */
  write: '2777', // drwxrwsrwx (full access for everyone, setgid)
} as const;

/**
 * Get permission mode for a worktree based on others_fs_access setting
 *
 * @param othersAccess - Access level ('none' | 'read' | 'write')
 * @returns Permission mode string (e.g., '2775')
 */
export function getWorktreePermissionMode(
  othersAccess: 'none' | 'read' | 'write' = 'read'
): string {
  return WorktreePermissionModes[othersAccess];
}

/**
 * Permission mode for repo .git directories
 *
 * The .git directory is shared across all worktrees in a repo.
 * Users who have access to ANY worktree in the repo get added
 * to the repo group to enable git operations (commit, push, etc).
 *
 * Mode: 2770 (drwxrws---)
 * - Owner: full access (rwx)
 * - Group: full access (rwx) + setgid
 * - Others: no access (---)
 *
 * The setgid bit ensures new files (objects, refs) inherit the group.
 */
export const REPO_GIT_PERMISSION_MODE = '2770';
