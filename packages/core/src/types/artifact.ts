/**
 * Artifact Type Definitions
 *
 * Artifacts are live web applications rendered via Sandpack on the board canvas.
 * Code lives on the filesystem at {worktree_path}/.agor/artifacts/{artifact_id}/
 * with a sandpack.json manifest that maps directly to Sandpack React component props.
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
 * Artifacts are filesystem-backed Sandpack applications managed by agents.
 * Code lives at {worktree_path}/.agor/artifacts/{artifact_id}/ with a sandpack.json manifest.
 */
export interface Artifact {
  artifact_id: ArtifactID;

  /** Worktree this artifact belongs to (filesystem location) */
  worktree_id: WorktreeID;

  /** Board this artifact is displayed on */
  board_id: BoardID;

  /** Display name */
  name: string;

  /** Optional description */
  description?: string;

  /** Relative path within worktree (always .agor/artifacts/{artifact_id}) */
  path: string;

  /** Sandpack template */
  template: SandpackTemplate;

  /** Current build status */
  build_status: ArtifactBuildStatus;

  /** Last build error messages (if build_status === 'error') */
  build_errors?: string[];

  /** Content hash for cache invalidation (MD5 of sorted file contents) */
  content_hash?: string;

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
 * Full artifact status returned to agents via MCP
 */
export interface ArtifactStatus {
  artifact_id: ArtifactID;
  build_status: ArtifactBuildStatus;
  build_errors?: string[];
  console_logs: ArtifactConsoleEntry[];
  content_hash?: string;
}
