/**
 * Path expansion utilities
 *
 * Provides helpers for expanding tilde (~) to home directory in file paths.
 * Handles both regular paths and file:// URL prefixes.
 */

import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Whether `child` is the same path as, or lexically below, `parent`. */
export function filesystemPathContains(parent: string, child: string): boolean {
  const pathFromParent = relative(resolve(parent), resolve(child));
  return (
    pathFromParent === '' ||
    (pathFromParent !== '..' &&
      !pathFromParent.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromParent))
  );
}

/** Whether either filesystem path is the same as, or contains, the other. */
export function filesystemPathsOverlap(left: string, right: string): boolean {
  return filesystemPathContains(left, right) || filesystemPathContains(right, left);
}

/**
 * Find an equal/ancestor overlap without comparing every pair.
 *
 * Paths are ordered as directory prefixes (the trailing separator matters for
 * names such as `/repo` and `/repo-old`) and then walked with an ancestor
 * stack. The optional predicate lets callers limit the overlap to the
 * resource being operated on while still considering every metadata owner.
 */
export function findFilesystemPathOverlap<T>(
  values: readonly T[],
  getPath: (value: T) => string,
  shouldCompare: (left: T, right: T) => boolean = () => true
): readonly [T, T] | undefined {
  const ordered = values
    .map((value) => {
      const path = resolve(getPath(value));
      return { value, path, sortKey: path.endsWith(sep) ? path : `${path}${sep}` };
    })
    .sort((left, right) =>
      left.sortKey < right.sortKey ? -1 : left.sortKey > right.sortKey ? 1 : 0
    );
  const ancestors: typeof ordered = [];

  for (const current of ordered) {
    while (
      ancestors.length > 0 &&
      !filesystemPathContains(ancestors[ancestors.length - 1].path, current.path)
    ) {
      ancestors.pop();
    }
    for (const ancestor of ancestors) {
      if (shouldCompare(ancestor.value, current.value)) {
        return [ancestor.value, current.value] as const;
      }
    }
    ancestors.push(current);
  }

  return undefined;
}

/**
 * Whether two slash-delimited managed slugs own equal or nested namespaces.
 * This intentionally treats legacy `org` as an ancestor of `org/repo`.
 */
export function managedSlugNamespacesOverlap(left: string, right: string): boolean {
  const leftSegments = left.split('/');
  const rightSegments = right.split('/');
  const sharedLength = Math.min(leftSegments.length, rightSegments.length);
  for (let index = 0; index < sharedLength; index += 1) {
    if (leftSegments[index] !== rightSegments[index]) return false;
  }
  return true;
}

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
