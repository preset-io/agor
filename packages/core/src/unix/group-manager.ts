/**
 * Unix Group Management for Worktree Isolation
 *
 * Provides utilities for managing worktree Unix groups (agor_wt_<short-id>).
 * These functions are designed to be called via `sudo agor admin` commands
 * to perform privileged operations safely.
 *
 * @see context/explorations/unix-user-modes.md
 * @see context/explorations/rbac.md
 */

import { formatShortId } from '../lib/ids.js';
import type { UUID, WorktreeID } from '../types/index.js';

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

/**
 * Unix group management commands (to be executed via sudo)
 *
 * These are shell command strings that should be executed with elevated privileges.
 * The daemon should call these via `sudo agor admin <command>` to maintain security.
 */
export const UnixGroupCommands = {
  /**
   * Create a new Unix group
   *
   * @param groupName - Name of the group to create
   * @returns Command string
   */
  createGroup: (groupName: string) => `groupadd ${groupName}`,

  /**
   * Delete a Unix group
   *
   * @param groupName - Name of the group to delete
   * @returns Command string
   */
  deleteGroup: (groupName: string) => `groupdel ${groupName}`,

  /**
   * Add user to a Unix group
   *
   * @param username - Unix username to add
   * @param groupName - Group to add user to
   * @returns Command string
   */
  addUserToGroup: (username: string, groupName: string) => `usermod -aG ${groupName} ${username}`,

  /**
   * Remove user from a Unix group
   *
   * @param username - Unix username to remove
   * @param groupName - Group to remove user from
   * @returns Command string
   */
  removeUserFromGroup: (username: string, groupName: string) =>
    `gpasswd -d ${username} ${groupName}`,

  /**
   * Check if a group exists
   *
   * @param groupName - Group name to check
   * @returns Command string (exits 0 if exists, 1 if not)
   */
  groupExists: (groupName: string) => `getent group ${groupName} > /dev/null`,

  /**
   * Check if a user is in a group
   *
   * @param username - Unix username
   * @param groupName - Group name
   * @returns Command string (exits 0 if member, 1 if not)
   */
  isUserInGroup: (username: string, groupName: string) =>
    `id -nG ${username} | grep -qw ${groupName}`,

  /**
   * List all members of a group
   *
   * @param groupName - Group name
   * @returns Command string (outputs comma-separated usernames)
   */
  listGroupMembers: (groupName: string) => `getent group ${groupName} | cut -d: -f4`,

  /**
   * Set directory group ownership and permissions
   *
   * @param path - Directory path
   * @param groupName - Group to own the directory
   * @param permissions - Permissions mode (e.g., '2775' for group-writable with setgid)
   * @returns Command string
   */
  setDirectoryGroup: (path: string, groupName: string, permissions: string) =>
    `chgrp -R ${groupName} "${path}" && chmod -R ${permissions} "${path}"`,
} as const;

/**
 * Permission modes for worktree directories
 *
 * These map to the 'others_fs_access' RBAC setting.
 */
export const WorktreePermissionModes = {
  /** No access for non-owners (permission denied) */
  none: '2750', // drwxr-s--- (group read/execute only, setgid)

  /** Read-only access for non-owners */
  read: '2755', // drwxr-sr-x (group + others read/execute, setgid)

  /** Read-write access for non-owners */
  write: '2777', // drwxrwsrwx (full access, setgid)
} as const;

/**
 * Get permission mode for a worktree based on others_fs_access setting
 *
 * @param othersAccess - Access level ('none' | 'read' | 'write')
 * @returns Permission mode string (e.g., '2755')
 */
export function getWorktreePermissionMode(
  othersAccess: 'none' | 'read' | 'write' = 'read'
): string {
  return WorktreePermissionModes[othersAccess];
}
