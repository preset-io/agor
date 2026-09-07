// src/types/file.ts

/**
 * Path to a file relative to branch root
 *
 * Examples:
 * - "README.md"
 * - "src/index.ts"
 * - "packages/core/src/types/file.ts"
 */
export type FilePath = string;

/**
 * Working-tree git status for a single file, relative to HEAD.
 *
 * Mirrors the VSCode / IDE source-control vocabulary so the UI can color-code
 * and badge entries consistently:
 * - `added`      — staged new file (index `A`)
 * - `modified`   — content changed (index/worktree `M`/`T`)
 * - `deleted`    — removed from the working tree (index/worktree `D`)
 * - `renamed`    — moved/renamed (index/worktree `R`)
 * - `copied`     — copied from another tracked file (index/worktree `C`)
 * - `untracked`  — new, not yet tracked by git (`??`)
 * - `conflicted` — unmerged / merge conflict (`U`, `AA`, `DD`, …)
 * - `ignored`    — matched by a gitignore rule (`!!`)
 *
 * `undefined` means the file is unchanged relative to HEAD (or status could
 * not be computed, e.g. the branch is not a git repository).
 */
export type GitFileStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'untracked'
  | 'conflicted'
  | 'ignored';

/**
 * File list response (lightweight, for browsing)
 * Returned by GET /file
 */
export interface FileListResponse {
  /** Array of files found in branch */
  files: FileListItem[];

  /** Whether the list was truncated at MAX_FILES limit */
  truncated: boolean;

  /** Total count of files found (may exceed files.length if truncated) */
  totalCount: number;
}

/**
 * File list item (lightweight, for browsing)
 */
export interface FileListItem {
  /**
   * File path relative to branch root (POSIX separators)
   * Examples: "src/index.ts", "README.md", "packages/core/package.json"
   */
  path: FilePath;

  /** Human-readable title (filename or extracted from markdown H1) */
  title: string;

  /** File size in bytes */
  size: number;

  /** Last modified timestamp (ISO 8601) */
  lastModified: string;

  /** Whether file is previewable as text (size < 1MB and text extension) */
  isText: boolean;

  /** Detected MIME type (optional) */
  mimeType?: string;

  /**
   * Working-tree git status relative to HEAD. Omitted when the file is
   * unchanged or status could not be computed (non-git branch, git error).
   */
  gitStatus?: GitFileStatus;
}

/**
 * Full file details (includes content)
 * Returned by GET /file/:path
 */
export interface FileDetail extends FileListItem {
  /** Full file content (UTF-8 text for text files, base64 for binary) */
  content: string;

  /** Content encoding: 'utf-8' for text files, 'base64' for binary files */
  encoding: 'utf-8' | 'base64';

  /**
   * Text content from HEAD used to compare the checked-out file with its
   * committed version. Present only for previewable working-tree changes.
   * Added/untracked files use an empty base; deleted files use empty current
   * `content` and retain their committed text here.
   */
  gitDiff?: FileGitDiff;
}

export interface FileGitDiff {
  /** UTF-8 content of the file at HEAD (or an empty string for a new file). */
  baseContent: string;

  /** Original HEAD path when git reports a rename or copy. */
  basePath?: FilePath;
}
