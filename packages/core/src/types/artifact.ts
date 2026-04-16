/**
 * Artifact Type Definitions
 *
 * Artifacts are board-scoped, DB-backed live web applications rendered via Sandpack.
 * The filesystem folder is a transient staging area; on publish, the daemon serializes
 * folder contents into the DB `files` column. Serving reads from DB only.
 */

import type { SandpackTemplate } from './board';
import type { ArtifactID, BoardID, WorktreeID } from './id';

/**
 * Build status for artifacts
 */
export type ArtifactBuildStatus = 'unknown' | 'checking' | 'success' | 'error';

/**
 * Artifact - Live web application rendered via Sandpack on the board canvas
 *
 * Artifacts are board-scoped, DB-backed objects. The `files` column holds the
 * serialized source code. `worktree_id` and `path` are provenance only.
 */
export interface Artifact {
  artifact_id: ArtifactID;

  /** Worktree provenance (nullable — survives worktree deletion via SET NULL) */
  worktree_id: WorktreeID | null;

  /** Board this artifact is displayed on */
  board_id: BoardID;

  /** Display name */
  name: string;

  /** Optional description */
  description?: string;

  /** Provenance path — where files were read from (nullable) */
  path: string | null;

  /** Sandpack template */
  template: SandpackTemplate;

  /** Current build status */
  build_status: ArtifactBuildStatus;

  /** Last build error messages (if build_status === 'error') */
  build_errors?: string[];

  /** Content hash for cache invalidation (MD5 of sorted file contents) */
  content_hash?: string;

  /** Serialized file contents: path -> code. Null for legacy records not yet re-published. */
  files?: Record<string, string>;

  /** NPM dependencies from manifest */
  dependencies?: Record<string, string>;

  /** Entry file from manifest */
  entry?: string;

  /** Use self-hosted Sandpack bundler */
  use_local_bundler?: boolean;

  /** Whether this artifact is visible to all board viewers */
  public: boolean;

  /** User who created this artifact */
  created_by?: string;

  created_at: string;
  updated_at: string;

  /** Whether this artifact is archived */
  archived: boolean;
  archived_at?: string;
}

/**
 * The sandpack.json manifest format
 * Maps directly to SandpackProvider props
 */
export interface SandpackManifest {
  template: SandpackTemplate;
  /** NPM dependencies beyond template defaults */
  dependencies?: Record<string, string>;
  /** Entry file path */
  entry?: string;
  /**
   * Opt into the daemon's self-hosted Sandpack bundler instead of CodeSandbox's
   * default hosted bundler. Stores intent rather than a concrete URL so the
   * artifact keeps working if the daemon's origin changes. Resolved to the
   * daemon's selfHostedBundlerURL at payload read time. If the local bundler
   * is not available at read time, falls back silently to the hosted bundler.
   */
  use_local_bundler?: boolean;
}

/**
 * Artifact payload served to frontend via REST
 * Contains everything needed to render the Sandpack preview
 */
export interface ArtifactPayload {
  artifact_id: ArtifactID;
  name: string;
  description?: string;
  template: SandpackTemplate;
  /** File map: path -> code content */
  files: Record<string, string>;
  dependencies?: Record<string, string>;
  entry?: string;
  content_hash: string;
  /** Env vars referenced in agor.config.js that the requesting user hasn't configured */
  missing_env_vars?: string[];
  /** Custom Sandpack bundler URL. Set when self-hosted bundler is available or specified in manifest. */
  bundlerURL?: string;
}

/**
 * Console log entry from Sandpack runtime (captured in browser, sent to daemon)
 */
export interface ArtifactConsoleEntry {
  timestamp: number;
  level: 'log' | 'warn' | 'error' | 'info';
  message: string;
}

/**
 * Sandpack bundler/runtime error captured from the browser iframe.
 * These errors (e.g. "Could not find module './data'") happen inside
 * Sandpack's bundler before any user JS executes, so they never reach
 * console.error and are invisible to console_logs.
 */
export interface SandpackError {
  message: string;
  title?: string;
  path?: string;
  line?: number;
  column?: number;
}

/**
 * Full artifact status returned to agents via MCP
 */
export interface ArtifactStatus {
  artifact_id: ArtifactID;
  /** Reflects file validation AND Sandpack runtime state.
   *  If Sandpack reports an error, this is overridden to 'error'
   *  even if file validation passed. */
  build_status: ArtifactBuildStatus;
  build_errors?: string[];
  /** Sandpack bundler/runtime error from the browser iframe (null = no error) */
  sandpack_error?: SandpackError | null;
  /** Sandpack bundler status: 'idle', 'running', 'timeout', etc. */
  sandpack_status?: string;
  console_logs: ArtifactConsoleEntry[];
  content_hash?: string;
}
