// src/types/repo.ts
import type { SessionID, UUID } from './id';
import type { RepoEnvironment, RepoEnvironmentConfigV1 } from './worktree';

/**
 * URL-friendly identifier for repositories and worktrees
 *
 * Used for:
 * - Repository slugs (e.g., "myapp", "backend-api")
 * - Worktree names (e.g., "feat-auth", "fix-cors")
 * - Directory names in ~/.agor/repos/ and ~/.agor/worktrees/
 *
 * Format: lowercase, alphanumeric, hyphens only
 *
 * Examples: "myapp", "backend", "feat-auth-middleware"
 */
export type RepoSlug = string;

/**
 * Worktree name (slug-formatted)
 *
 * Becomes both the directory name and (optionally) the branch name.
 */
export type WorktreeName = string;

/**
 * Git repository registered with Agor
 *
 * Repositories can be:
 * - remote: cloned into ~/.agor/repos/{slug} and managed by Agor
 * - local: referencing a user-managed clone elsewhere on disk
 *
 * Both repository types support the same worktree operations.
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
   * - Worktree organization
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
   * Used when creating new worktrees without explicit ref.
   */
  default_branch?: string;

  /**
   * Environment configuration (v2) — named variants.
   *
   * Defines how to run environments for all worktrees in this repo.
   * Contains a default variant name and a map of named variants; worktrees
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
   * Unix group for .git/ directory access
   *
   * Format: agor_rp_<short-id> (e.g., 'agor_rp_03b62447')
   *
   * This group is created when worktree RBAC is enabled and controls access
   * to the shared .git/ directory. Users who have access to ANY worktree
   * in this repo get added to this group, enabling git operations
   * (commit, push, etc) by granting read/write access to .git/.
   */
  unix_group?: string;

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
   * (e.g. `auth_failed` → "configure GITHUB_TOKEN in Settings → API Keys").
   */
  clone_error?: RepoCloneError;

  /** Repository metadata */
  created_at: string;
  last_updated: string;
}

export type RepoCloneStatus = 'cloning' | 'ready' | 'failed';

export type RepoCloneErrorCategory = 'auth_failed' | 'not_found' | 'network' | 'unknown';

export interface RepoCloneError {
  exit_code: number;
  category: RepoCloneErrorCategory;
  /** Short, user-facing first-line message (stderr excerpt or wrapper message). */
  message: string;
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
 * Git worktree configuration
 *
 * Worktrees are working directories for specific branches,
 * allowing multiple branches to be checked out simultaneously.
 *
 * Structure: ~/.agor/worktrees/{repo-slug}/{name}/
 */
export interface WorktreeConfig {
  /**
   * Worktree name (slug format)
   *
   * Used for:
   * - Directory name: ~/.agor/worktrees/{repo-slug}/{name}
   * - Default branch name (if creating new branch)
   * - CLI references
   *
   * Examples: "main", "feat-auth", "exp-rewrite"
   */
  name: WorktreeName;

  /**
   * Absolute path to worktree directory
   *
   * Example: "/Users/max/.agor/worktrees/myapp/feat-auth"
   */
  path: string;

  /**
   * Git ref (branch/tag/commit) checked out in this worktree
   *
   * Examples: "feat-auth", "main", "v1.2.3", "a1b2c3d"
   */
  ref: string;

  /**
   * Whether this ref is a new branch created by Agor
   *
   * true:  Branch was created during worktree creation
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
   * Sessions using this worktree
   *
   * Multiple sessions can share a worktree (same working directory).
   * Useful for:
   * - Continuing work across sessions
   * - Fork/spawn relationships on same branch
   */
  sessions: SessionID[];

  /**
   * Last git commit SHA in this worktree
   *
   * Updated when sessions complete tasks.
   */
  last_commit_sha?: string;

  /** Worktree metadata */
  created_at: string;
  last_used: string;
}
