// src/types/repo.ts
import type { SessionID, UUID } from './id';
import type { RepoEnvironmentConfig } from './worktree';

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
   * Environment configuration template (optional)
   *
   * Defines how to run environments for all worktrees in this repo.
   * Each worktree creates an instance with specific variable values.
   */
  environment_config?: RepoEnvironmentConfig;

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

  /** Repository metadata */
  created_at: string;
  last_updated: string;
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
