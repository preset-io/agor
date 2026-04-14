/**
 * Unix System Queries
 *
 * Read-only queries against the OS for Unix user/group state.
 * These are shared between CLI admin commands and the daemon service.
 *
 * Also includes pure logic helpers for worktree directory decisions.
 *
 * @see context/guides/rbac-and-unix-isolation.md
 */

import { execSync } from 'node:child_process';
import { UnixGroupCommands } from './group-manager.js';
import { UnixUserCommands } from './user-manager.js';

// ============================================================
// USER QUERIES
// ============================================================

// Note: userExists is exported from user-manager.ts as unixUserExists()

/**
 * Get all groups a Unix user belongs to
 *
 * @param username - Unix username
 * @returns Array of group names (empty if user doesn't exist)
 */
export function getUserGroups(username: string): string[] {
  try {
    const output = execSync(UnixUserCommands.getUserGroups(username), {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    return output.trim().split(/\s+/).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * List all agor_* users on the system (auto-generated format: agor_<8-hex>)
 *
 * @returns Array of matching usernames
 */
export function listAgorUsers(): string[] {
  try {
    const output = execSync("getent passwd | grep '^agor_' | cut -d: -f1", {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    return output
      .trim()
      .split('\n')
      .filter((u) => u && /^agor_[0-9a-f]{8}$/.test(u));
  } catch {
    return [];
  }
}

// ============================================================
// GROUP QUERIES
// ============================================================

/**
 * Check if a Unix group exists on the system
 *
 * @param groupName - Group name to check
 * @returns true if group exists
 */
export function groupExists(groupName: string): boolean {
  try {
    execSync(UnixGroupCommands.groupExists(groupName), { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a Unix user is a member of a group
 *
 * @param username - Unix username
 * @param groupName - Group name
 * @returns true if user is in group
 */
export function isUserInGroup(username: string, groupName: string): boolean {
  try {
    execSync(UnixGroupCommands.isUserInGroup(username, groupName), { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get members of a Unix group from the system
 *
 * @param groupName - Group name
 * @returns Array of usernames in the group (empty if group doesn't exist)
 */
export function getGroupMembers(groupName: string): string[] {
  try {
    const output = execSync(UnixGroupCommands.listGroupMembers(groupName), {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    return output.trim().split(',').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * List all agor_wt_* (worktree) groups on the system
 *
 * @returns Array of matching group names
 */
export function listWorktreeGroups(): string[] {
  try {
    const output = execSync("getent group | grep '^agor_wt_' | cut -d: -f1", {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    return output
      .trim()
      .split('\n')
      .filter((g) => g && /^agor_wt_[0-9a-f]{8}$/.test(g));
  } catch {
    return [];
  }
}

/**
 * List all agor_rp_* (repo) groups on the system
 *
 * @returns Array of matching group names
 */
export function listRepoGroups(): string[] {
  try {
    const output = execSync("getent group | grep '^agor_rp_' | cut -d: -f1", {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    return output
      .trim()
      .split('\n')
      .filter((g) => g && /^agor_rp_[0-9a-f]{8}$/.test(g));
  } catch {
    return [];
  }
}

// ============================================================
// PURE LOGIC HELPERS
// ============================================================

/**
 * Determine what action to take for a worktree directory based on archive state.
 *
 * @param dirExists - Whether the directory currently exists on disk
 * @param archived - Whether the worktree is archived
 * @param filesystemStatus - The worktree's filesystem_status field
 * @returns Action to take:
 *   - 'sync': Directory exists, apply permissions
 *   - 'create': Directory missing, non-archived — create it
 *   - 'skip': Skip this worktree (archived+deleted, creating, failed, etc.)
 */
export function getWorktreeDirectoryAction(
  dirExists: boolean,
  archived: boolean,
  filesystemStatus: string | null | undefined
): 'sync' | 'create' | 'skip' {
  // Creating or failed worktrees — not ready, skip
  if (filesystemStatus === 'creating' || filesystemStatus === 'failed') {
    return 'skip';
  }

  // Archived + deleted — directory was intentionally removed
  if (archived && filesystemStatus === 'deleted') {
    return 'skip';
  }

  // Directory exists — always sync permissions regardless of archive state
  if (dirExists) {
    return 'sync';
  }

  // Directory missing + not archived — create it
  if (!archived) {
    return 'create';
  }

  // Directory missing + archived (preserved or cleaned) — skip
  // The directory was expected to exist but doesn't — log info but don't create
  return 'skip';
}
