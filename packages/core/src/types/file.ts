// src/types/file.ts

import type { BranchID } from './id';

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
 * Provider-owned virtual Markdown link prefix naming an authenticated,
 * closed branch-file download. Mirrors `UPLOAD_VIRTUAL_URL_PREFIX`: never
 * dereferenced as a real host, only pattern-matched client-side and
 * rewritten into an authenticated fetch through the `file` service.
 */
export const BRANCH_FILE_VIRTUAL_URL_PREFIX = 'https://agor.live/_branch-files/';

/**
 * Encodes a branch-relative file path for embedding in a virtual Markdown
 * URL. Escapes parentheses in addition to the usual reserved characters so
 * the result can never prematurely close a Markdown link's `(...)` target.
 */
export function encodeBranchFilePath(path: FilePath): string {
  return encodeURIComponent(path).replace(
    /[()]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

/**
 * Decodes a percent-encoded branch file path segment back to its
 * branch-relative path. Throws on malformed percent-encoding.
 */
export function decodeBranchFilePath(encoded: string): FilePath {
  return decodeURIComponent(encoded);
}

/**
 * Escapes Markdown link-label metacharacters (`\`, `[`, `]`) so a filename
 * containing them survives as literal text through the label's `[...]`
 * boundary instead of prematurely closing it. Mirror of
 * `unescapeMarkdownLinkLabel` below — keep both in sync.
 */
function escapeMarkdownLinkLabel(label: string): string {
  return label.replace(/[\\[\]]/g, (char) => `\\${char}`);
}

/**
 * Reverses `escapeMarkdownLinkLabel`: recovers the literal filename from a
 * Markdown link label that may contain `\\`, `\[`, or `\]` escape
 * sequences. Any other backslash sequence is left untouched.
 */
export function unescapeMarkdownLinkLabel(label: string): string {
  return label.replace(/\\([\\[\]])/g, '$1');
}

/** Builds a closed virtual Markdown link naming an authenticated branch-file download. */
export function buildBranchFileMarkdownLink(
  branchId: BranchID,
  path: FilePath,
  displayName?: string
): string {
  const filename = displayName ?? path.split('/').pop() ?? path;
  return `[${escapeMarkdownLinkLabel(filename)}](${BRANCH_FILE_VIRTUAL_URL_PREFIX}${branchId}/${encodeBranchFilePath(path)})`;
}

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
