// src/types/repo.ts

import type { RepoEnvironment, RepoEnvironmentConfigV1 } from './branch';
import type { SessionID, UUID } from './id';

/**
 * URL-friendly identifier for repositories and branches
 *
 * Used for:
 * - Repository slugs (e.g., "myapp", "backend-api")
 * - Branch names (e.g., "feat-auth", "fix-cors")
 * - Directory names in ~/.agor/repos/ and ~/.agor/worktrees/
 *
 * Format: lowercase, alphanumeric, hyphens only
 *
 * Examples: "myapp", "backend", "feat-auth-middleware"
 */
export type RepoSlug = string;

/**
 * Branch name (slug-formatted)
 *
 * Becomes both the directory name and (optionally) the branch name.
 */
export type BranchName = string;

/**
 * Git repository registered with Agor
 *
 * Repositories can be:
 * - remote: cloned into ~/.agor/repos/{slug} and managed by Agor
 * - local: referencing a user-managed clone elsewhere on disk
 *
 * Both repository types support the same branch operations.
 */
export type RepoType = 'remote' | 'local';

export interface Repo {
  /** Unique repository identifier (UUIDv7) */
  repo_id: UUID;

  /**
   * URL-friendly slug for the repository
   *
   * Used for:
   * - Directory name: ~/.agor/repos/{slug}
   * - CLI references: agor repo show {slug}
   * - Branch organization
   *
   * Must be unique across all repos.
   */
  slug: RepoSlug;

  /**
   * Human-readable name
   *
   * Defaults to slug but can be customized.
   */
  name: string;

  /**
   * Repository management type
   *
   * - 'remote': cloned and managed by Agor under ~/.agor/repos/{slug}
   * - 'local': references an existing user-managed clone
   */
  repo_type: RepoType;

  /**
   * Git remote URL
   *
   * Examples:
   * - "https://github.com/user/repo.git"
   * - "git@github.com:user/repo.git"
   */
  remote_url?: string;

  /**
   * Local path to repository
   *
   * - Remote repos: ~/.agor/repos/{slug}
   * - Local repos: user-provided absolute path
   */
  local_path: string;

  /**
   * Default branch name
   *
   * Detected from remote or HEAD.
   * Used when creating new branches without explicit ref.
   */
  default_branch?: string;

  /**
   * Environment configuration (v2) — named variants.
   *
   * Defines how to run environments for all branches in this repo.
   * Contains a default variant name and a map of named variants; branches
   * render one variant into their own command fields at creation time and
   * can re-render against a different variant via the admin-only flow.
   *
   * Null when the repo has no environment config. Legacy v1 configs are
   * wrapped as `variants.default` on read.
   *
   * This is the source of truth for backend logic. `environment_config`
   * (below) is a legacy view kept in sync for UI back-compat.
   */
  environment?: RepoEnvironment;

  /**
   * Legacy (v1) environment configuration view.
   *
   * @deprecated Backend code should read/write {@link environment} (v2).
   * This field is kept populated from `environment.variants[default]` for
   * existing UI that reads `environment_config.up_command` etc. New UI
   * should migrate to reading variants directly.
   */
  environment_config?: RepoEnvironmentConfigV1;

  /**
   * Async clone lifecycle status for `repo_type: 'remote'` repos.
   *
   * - `'cloning'`: row was pre-created by the daemon; executor is running `git clone`
   * - `'ready'`: clone finished successfully (executor patched the row)
   * - `'failed'`: clone exited non-zero — see `clone_error` for details
   * - `undefined`: legacy row created before this field existed, or `repo_type: 'local'`
   *
   * Callers that need to know whether a remote clone succeeded should poll
   * `agor_repos_get(repoId)` and treat anything other than `'ready'`/`undefined`
   * as not-yet-usable.
   */
  clone_status?: RepoCloneStatus;

  /**
   * Populated when `clone_status === 'failed'`. Cleared on retry.
   *
   * `category` exists so a UI can suggest the right next step
   * (e.g. `auth_failed` → "configure GITHUB_TOKEN in User Settings → Env Vars").
   */
  clone_error?: RepoCloneError;

  /**
   * Durable server-owned fence for destructive managed-directory cleanup.
   * New branches, tasks, and environment mutations are refused while this is
   * present; an expired attempt may only be replaced by another delete retry.
   */
  deletion_attempt?: RepoDeletionAttempt;

  /** Repository metadata */
  created_at: string;
  last_updated: string;
}

export interface RepoDeletionAttempt {
  attempt_id: UUID;
  started_at: string;
  deadline_at: string;
  cleanup: true;
}

/** Fields owned by daemon orchestration rather than generic Repo CRUD. */
export const REPO_SERVER_MANAGED_FIELDS = [
  'clone_status',
  'clone_error',
  'deletion_attempt',
] as const satisfies ReadonlyArray<keyof Repo>;

export type RepoCloneStatus = 'cloning' | 'ready' | 'failed';

export type RepoCloneErrorCategory =
  | 'auth_failed'
  | 'not_found'
  | 'network'
  | 'git_unavailable'
  | 'unknown';

export interface RepoCloneError {
  exit_code: number;
  category: RepoCloneErrorCategory;
  /** Short, user-facing first-line message (stderr excerpt or wrapper message). */
  message: string;
}

/** Exact result accepted from the executor that owns one repository clone. */
export type RepoCloneSettlement =
  | {
      repo_id: UUID;
      clone_status: 'ready';
      default_branch: string;
      environment?: RepoEnvironment;
    }
  | {
      repo_id: UUID;
      clone_status: 'failed';
      clone_error: RepoCloneError;
    };

/**
 * Return a safe, actionable remediation hint for a remote-clone failure.
 *
 * This deliberately lives with the browser-safe repository types so every
 * client (CLI, UI, and API consumers) uses the same category semantics
 * without importing the Node-only Git implementation.
 */
export function getRepoCloneErrorHint(error?: {
  category?: RepoCloneErrorCategory;
  message?: string;
}): string {
  if (!error) return '';

  if (error.category === 'git_unavailable') {
    return ' — Git is unavailable to the Agor executor. Install Git there, ensure it is executable on PATH, and retry';
  }

  if (error.category === 'auth_failed') {
    return ' — configure GITHUB_TOKEN in User Settings → Env Vars for private repos';
  }

  if (error.category === 'not_found') {
    return ' — verify the repository URL and default branch, and confirm the repository is accessible';
  }

  if (error.category === 'network') {
    const message = error.message?.toLowerCase() ?? '';
    if (/(certificate|ssl|tls|ca cert|cafile|capath|ca bundle|issuer)/.test(message)) {
      return (
        ' — Git could not verify the server certificate. Install/enable the operating system CA trust store ' +
        "or configure Git's approved CA bundle for your proxy; do not disable SSL verification"
      );
    }
    return ' — check DNS, firewall, proxy, and network access for the daemon/executor, then retry';
  }

  return '';
}

/**
 * Return shape of `reposService.cloneRepository` (and the REST + MCP layers
 * that wrap it).
 *
 * - `'pending'`: row pre-created with `clone_status: 'cloning'`. Callers should
 *   poll `agor_repos_get(repo_id)` or listen for `repos.patched` until
 *   `clone_status` is `'ready'` or `'failed'`.
 * - `'exists'`: no-op — a row with the requested slug is already registered.
 *   `repo_id` is included so callers can fetch the existing row.
 */
export interface CloneRepositoryResult {
  status: 'pending' | 'exists';
  slug: string;
  repo_id?: string;
}

/**
 * Request shape for creating/cloning a remote repository from the UI.
 *
 * The UI validates and fills in `slug` and `default_branch` before dispatching,
 * so these are required here. Lower-level service calls (e.g. the MCP
 * `agor_repos_create_remote` tool and `reposService.cloneRepository`) accept
 * a looser shape where slug is optional and derived server-side.
 */
export interface CreateRepoRequest {
  url: string;
  slug: string;
  default_branch: string;
}

/**
 * Request shape for registering an existing local git clone with Agor.
 *
 * Slug is optional — if omitted, the daemon derives it from the directory name.
 */
export interface CreateLocalRepoRequest {
  path: string;
  slug?: string;
}

/**
 * Git branch configuration
 *
 * Branches are working directories for specific branches,
 * allowing multiple branches to be checked out simultaneously.
 *
 * Structure: ~/.agor/worktrees/{repo-slug}/{name}/
 */
export interface BranchConfig {
  /**
   * Branch name (slug format)
   *
   * Used for:
   * - Directory name: ~/.agor/worktrees/{repo-slug}/{name}
   * - Default branch name (if creating new branch)
   * - CLI references
   *
   * Examples: "main", "feat-auth", "exp-rewrite"
   */
  name: BranchName;

  /**
   * Absolute path to branch directory
   *
   * Example: "/Users/max/.agor/worktrees/myapp/feat-auth"
   */
  path: string;

  /**
   * Git ref (branch/tag/commit) checked out in this branch
   *
   * Examples: "feat-auth", "main", "v1.2.3", "a1b2c3d"
   */
  ref: string;

  /**
   * Whether this ref is a new branch created by Agor
   *
   * true:  Branch was created during branch creation
   * false: Branch existed before (tracked from remote or local)
   */
  new_branch: boolean;

  /**
   * Remote tracking branch (if any)
   *
   * Examples: "origin/feat-auth", "upstream/main"
   */
  tracking_branch?: string;

  /**
   * Sessions using this branch
   *
   * Multiple sessions can share a branch (same working directory).
   * Useful for:
   * - Continuing work across sessions
   * - Fork/spawn relationships on same branch
   */
  sessions: SessionID[];

  /**
   * Last git commit SHA in this branch
   *
   * Updated when sessions complete tasks.
   */
  last_commit_sha?: string;

  /** Branch metadata */
  created_at: string;
  last_used: string;
}
