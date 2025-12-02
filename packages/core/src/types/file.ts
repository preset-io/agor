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
 * File list item (lightweight, for browsing)
 * Returned by GET /file
 */
export interface FileListItem {
  /**
   * File path relative to worktree root
   * Examples: "src/index.ts", "README.md", "packages/core/package.json"
   */
  path: FilePath;

  /** Human-readable title (extracted from first H1 for markdown or filename) */
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
  /** Full file content (UTF-8 text) */
  content: string;
}
