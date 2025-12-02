// src/types/file.ts

/**
 * Path to a file relative to worktree root
 *
 * Examples:
 * - "README.md"
 * - "src/index.ts"
 * - "packages/core/src/types/file.ts"
 */
export type FilePath = string;

/**
 * File list response (lightweight, for browsing)
 * Returned by GET /file
 */
export interface FileListResponse {
  /** Array of files found in worktree */
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
   * File path relative to worktree root (POSIX separators)
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
}
