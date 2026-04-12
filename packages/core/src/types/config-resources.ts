// src/types/config-resources.ts
//
// Serializable config types for the `resources:` section of config.yml.
// Composed from existing canonical types using Pick<> — never disconnected.

import type { AgenticToolName } from './agentic-tool';
import type { Repo } from './repo';
import type { PermissionMode } from './session';
import type { User } from './user';
import type { Worktree } from './worktree';

// ---------------------------------------------------------------------------
// Repo config: identity + clone info
// ---------------------------------------------------------------------------

export type ResourceRepoConfig = Pick<
  Repo,
  'repo_id' | 'slug' | 'remote_url' | 'repo_type' | 'default_branch'
> & {
  /**
   * Shallow clone for faster boot (--depth=1)
   * @todo Not yet applied during sync — parsed and validated but not wired into provisioning logic.
   */
  shallow?: boolean;
};

// ---------------------------------------------------------------------------
// Worktree config: identity + git ref + permissions
// ---------------------------------------------------------------------------

export type ResourceWorktreeConfig = Pick<
  Worktree,
  'worktree_id' | 'name' | 'ref' | 'ref_type' | 'others_can' | 'mcp_server_ids'
> & {
  /** Repo slug reference — resolved to repo_id during sync */
  repo: string;
  /**
   * Mount filesystem read-only
   * @todo Not yet applied during sync — parsed and validated but not wired into provisioning logic.
   */
  readonly?: boolean;
  /**
   * Enforced agent settings for all sessions on this worktree
   * @todo Not yet applied during sync — parsed and validated but not wired into provisioning logic.
   */
  agent?: EnforcedAgentConfig;
};

// ---------------------------------------------------------------------------
// User config: identity + role
// ---------------------------------------------------------------------------

export type ResourceUserConfig = Pick<User, 'user_id' | 'email' | 'name' | 'role'> & {
  /** Unix username for process impersonation */
  unix_username?: string;
  /** Password: Handlebars template '{{env.VAR}}', literal string, or omit to auto-generate */
  password?: string;
};

// ---------------------------------------------------------------------------
// Enforced agent config (composed from existing union types)
// ---------------------------------------------------------------------------

export interface EnforcedAgentConfig {
  /** Which agentic coding tool to use */
  agentic_tool?: AgenticToolName;
  /** Permission/approval mode (enforced, not overridable) */
  permission_mode?: PermissionMode;
  /** Model identifier (e.g., 'claude-sonnet-4-5-20250514') */
  model?: string;
  /** MCP server IDs to attach to every session */
  mcp_server_ids?: string[];
}

// ---------------------------------------------------------------------------
// Top-level resources config
// ---------------------------------------------------------------------------

export interface DaemonResourcesConfig {
  repos?: ResourceRepoConfig[];
  worktrees?: ResourceWorktreeConfig[];
  users?: ResourceUserConfig[];
}
