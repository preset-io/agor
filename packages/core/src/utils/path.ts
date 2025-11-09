/**
 * Path expansion utilities
 *
 * Provides helpers for expanding tilde (~) to home directory in file paths.
 * Handles both regular paths and file:// URL prefixes.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Expand tilde (~) to home directory in file paths
 *
 * Handles both regular paths and file:// URLs. Remote database URLs
 * (e.g., libsql://) are returned unchanged.
 *
 * @param path - Path that may contain tilde
 * @returns Expanded path with home directory
 *
 * @example
 * ```typescript
 * expandPath('~/foo') → '/Users/username/foo'
 * expandPath('file:~/foo') → 'file:/Users/username/foo'
 * expandPath('/absolute/path') → '/absolute/path'
 * expandPath('libsql://turso.io') → 'libsql://turso.io' (unchanged)
 * ```
 */
export function expandPath(path: string): string {
  // Handle file:~/ prefix
  if (path.startsWith('file:~/')) {
    return `file:${join(homedir(), path.slice(7))}`;
  }

  // Handle ~/ prefix
  if (path.startsWith('~/')) {
    return join(homedir(), path.slice(2));
  }

  // Return unchanged for absolute paths or remote URLs
  return path;
}

/**
 * Extract file path from database URL
 *
 * Removes file: prefix and expands tilde. Useful for filesystem operations
 * on local database files (e.g., creating parent directories, checking existence).
 *
 * @param dbUrl - Database URL (e.g., 'file:~/.agor/agor.db' or '~/.agor/agor.db')
 * @returns Expanded file path (e.g., '/Users/username/.agor/agor.db')
 *
 * @example
 * ```typescript
 * extractDbFilePath('file:~/.agor/agor.db') → '/Users/username/.agor/agor.db'
 * extractDbFilePath('~/.agor/agor.db') → '/Users/username/.agor/agor.db'
 * extractDbFilePath('file:/absolute/path/db.db') → '/absolute/path/db.db'
 * ```
 */
export function extractDbFilePath(dbUrl: string): string {
  // Expand first (handles file:~/ case)
  const expanded = expandPath(dbUrl);

  // Remove file: prefix if present
  const withoutPrefix = expanded.startsWith('file:') ? expanded.slice(5) : expanded;

  // Defensive: expand again if tilde somehow remains
  return withoutPrefix.startsWith('~/') ? join(homedir(), withoutPrefix.slice(2)) : withoutPrefix;
}
