/**
 * Symlink Management Utilities
 *
 * Provides utilities for managing branch symlinks in user home directories.
 * Each user gets symlinks at ~/agor/worktrees/<branch-name> pointing to actual branch paths.
 *
 * @see context/guides/rbac-and-unix-isolation.md
 */

import { AGOR_BRANCHES_DIR, AGOR_HOME_BASE } from './user-manager.js';

/**
 * Get the symlink path for a branch in a user's home
 *
 * @param username - Unix username
 * @param branchName - Branch name/slug
 * @param homeBase - Base directory for homes (default: /home)
 * @returns Full symlink path (e.g., /home/alice/agor/worktrees/my-feature)
 */
export function getBranchSymlinkPath(
  username: string,
  branchName: string,
  homeBase: string = AGOR_HOME_BASE
): string {
  return `${homeBase}/${username}/${AGOR_BRANCHES_DIR}/${branchName}`;
}

/**
 * Symlink management commands (to be executed via sudo)
 *
 * These commands manage symlinks in user home directories.
 * All paths should be absolute to avoid ambiguity.
 */
export const SymlinkCommands = {
  /**
   * Check if a symlink exists
   *
   * @param linkPath - Path to check
   * @returns Command string (exits 0 if symlink exists)
   */
  symlinkExists: (linkPath: string) => `test -L "${linkPath}"`,

  /**
   * Check if a path exists (file, directory, or symlink)
   *
   * @param path - Path to check
   * @returns Command string (exits 0 if exists)
   */
  pathExists: (path: string) => `test -e "${path}"`,

  /**
   * Create a symlink
   *
   * @param target - Target path (the actual branch directory)
   * @param linkPath - Symlink path (in user's ~/agor/worktrees/)
   * @returns Command string
   */
  createSymlink: (target: string, linkPath: string) => `ln -s "${target}" "${linkPath}"`,

  /**
   * Create a symlink, replacing if exists
   *
   * @param target - Target path
   * @param linkPath - Symlink path
   * @returns Command string
   */
  createOrReplaceSymlink: (target: string, linkPath: string) => `ln -sfn "${target}" "${linkPath}"`,

  /**
   * Remove a symlink
   *
   * @param linkPath - Symlink path to remove
   * @returns Command string
   */
  removeSymlink: (linkPath: string) => `rm -f "${linkPath}"`,

  /**
   * Get symlink target
   *
   * @param linkPath - Symlink path
   * @returns Command string (outputs target path)
   */
  readSymlink: (linkPath: string) => `readlink "${linkPath}"`,

  /**
   * List all symlinks in a directory
   *
   * @param dirPath - Directory to list
   * @returns Command string (outputs symlink names, one per line)
   */
  listSymlinks: (dirPath: string) => `find "${dirPath}" -maxdepth 1 -type l -printf '%f\\n'`,

  /**
   * Create symlink with proper ownership
   *
   * Creates parent directories if needed, sets ownership on the symlink.
   * Note: Symlink ownership doesn't affect access (target permissions matter),
   * but it's good practice for cleanup/auditing.
   *
   * Returns an array of commands to be executed sequentially.
   * Each command should be run with sudo separately (no sh -c wrapper needed).
   *
   * @param target - Target path (actual branch)
   * @param linkPath - Symlink path
   * @param username - Owner of the symlink
   * @returns Array of command strings to execute sequentially
   */
  createSymlinkWithOwnership: (target: string, linkPath: string, username: string): string[] => {
    const parentDir = linkPath.substring(0, linkPath.lastIndexOf('/'));
    return [
      `mkdir -p "${parentDir}"`,
      `chown "${username}:${username}" "${parentDir}"`,
      `ln -sfn "${target}" "${linkPath}"`,
      `chown -h "${username}:${username}" "${linkPath}"`,
    ];
  },

  /**
   * Remove all symlinks in a directory
   *
   * @param dirPath - Directory to clean
   * @returns Command string
   */
  removeAllSymlinks: (dirPath: string) => `find "${dirPath}" -maxdepth 1 -type l -delete`,

  /**
   * Remove broken symlinks in a directory
   *
   * @param dirPath - Directory to clean
   * @returns Command string
   */
  removeBrokenSymlinks: (dirPath: string) =>
    `find "${dirPath}" -maxdepth 1 -type l ! -exec test -e {} \\; -delete`,
} as const;

/**
 * Branch symlink info
 */
export interface BranchSymlinkInfo {
  /** Symlink path in user's home */
  linkPath: string;
  /** Target branch path */
  targetPath: string;
  /** Branch name/slug */
  branchName: string;
}

/**
 * Build symlink info for a branch
 *
 * @param username - Unix username
 * @param branchName - Branch name/slug
 * @param branchPath - Actual branch filesystem path
 * @param homeBase - Home directory base
 * @returns Symlink info object
 */
export function buildSymlinkInfo(
  username: string,
  branchName: string,
  branchPath: string,
  homeBase: string = AGOR_HOME_BASE
): BranchSymlinkInfo {
  return {
    linkPath: getBranchSymlinkPath(username, branchName, homeBase),
    targetPath: branchPath,
    branchName,
  };
}
