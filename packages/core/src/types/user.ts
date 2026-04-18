import type { CodexApprovalPolicy, CodexNetworkAccess, CodexSandboxMode } from './agentic-tool';
import type { UserID } from './id';
import type { EffortLevel, PermissionMode } from './session';

/**
 * User role types
 * - superadmin: Full system access including worktree RBAC bypass (requires allow_superadmin=true in config)
 * - admin: Can manage most resources (MCP servers, config, users), no worktree RBAC bypass
 * - member: Standard user access, can create and manage own sessions
 * - viewer: Read-only access
 *
 * Note: 'owner' is a deprecated alias for 'superadmin' kept for backwards compatibility.
 */
export type UserRole = 'superadmin' | 'admin' | 'member' | 'viewer';

/**
 * Role constants to avoid string literals throughout the codebase.
 */
export const ROLES = {
  SUPERADMIN: 'superadmin',
  ADMIN: 'admin',
  MEMBER: 'member',
  VIEWER: 'viewer',
} as const satisfies Record<string, UserRole>;

/**
 * Role rank used for minimum-role comparisons.
 * Higher rank = more privileges. 'owner' is a deprecated alias for superadmin.
 */
const ROLE_RANK: Record<string, number> = {
  [ROLES.VIEWER]: 0,
  [ROLES.MEMBER]: 1,
  [ROLES.ADMIN]: 2,
  [ROLES.SUPERADMIN]: 3,
  owner: 3,
};

/**
 * Normalize legacy role values.
 * Converts deprecated 'owner' to 'superadmin' for backwards compatibility.
 */
export function normalizeRole(role: string | undefined): UserRole {
  if (role === 'owner') return ROLES.SUPERADMIN;
  return (role as UserRole) || ROLES.MEMBER;
}

/**
 * Check whether a user's role meets or exceeds a minimum required role.
 * Shared by backend hooks and frontend permission checks.
 */
export function hasMinimumRole(userRole: string | undefined, minimumRole: UserRole): boolean {
  const normalized = normalizeRole(userRole);
  return (ROLE_RANK[normalized] ?? 0) >= ROLE_RANK[minimumRole];
}

/**
 * Model configuration for session creation
 */
export interface DefaultModelConfig {
  /** Model selection mode: alias or exact */
  mode?: 'alias' | 'exact';
  /** Model identifier (alias or exact ID) */
  model?: string;
  /** Effort level for reasoning depth */
  effort?: EffortLevel;
}

/**
 * Default agentic tool configuration per tool
 */
export interface DefaultAgenticToolConfig {
  /** Default model configuration */
  modelConfig?: DefaultModelConfig;
  /** Default permission mode (Claude/Gemini unified mode) */
  permissionMode?: PermissionMode;
  /** Default MCP server IDs to attach */
  mcpServerIds?: string[];
  /** Codex-specific: sandbox mode */
  codexSandboxMode?: CodexSandboxMode;
  /** Codex-specific: approval policy */
  codexApprovalPolicy?: CodexApprovalPolicy;
  /** Codex-specific: network access */
  codexNetworkAccess?: CodexNetworkAccess;
}

/**
 * Default agentic configuration per tool
 */
export interface DefaultAgenticConfig {
  'claude-code'?: DefaultAgenticToolConfig;
  codex?: DefaultAgenticToolConfig;
  gemini?: DefaultAgenticToolConfig;
  opencode?: DefaultAgenticToolConfig;
  copilot?: DefaultAgenticToolConfig;
}

/**
 * Available task completion chime sounds
 */
export type ChimeSound =
  | 'gentle-chime'
  | 'notification-bell'
  | '8bit-coin'
  | 'retro-coin'
  | 'power-up'
  | 'you-got-mail'
  | 'success-tone';

/**
 * Audio preferences for task completion notifications
 */
export interface AudioPreferences {
  /** Enable/disable task completion chimes */
  enabled: boolean;
  /** Selected chime sound */
  chime: ChimeSound;
  /** Volume level (0.0 to 1.0) */
  volume: number;
  /** Minimum task duration in seconds to play chime (0 = always play) */
  minDurationSeconds: number;
}

/**
 * Event stream preferences for debugging WebSocket events
 */
export interface EventStreamPreferences {
  /** Enable/disable event stream feature visibility in navbar */
  enabled: boolean;
}

/**
 * Per-user onboarding state (stored in user.preferences)
 */
export interface OnboardingState {
  /** Which path the user took */
  path?: 'assistant' | 'own-repo' | 'persisted-agent';
  /** The worktree ID created during onboarding */
  worktreeId?: string;
  /** The board ID created for this user */
  boardId?: string;
}

/**
 * User preferences structure
 */
export interface UserPreferences {
  audio?: AudioPreferences;
  eventStream?: EventStreamPreferences;
  onboarding?: OnboardingState;
  /** The user's personal/main board ID (created during onboarding or later) */
  mainBoardId?: string;
  // Future preferences can be added here
  [key: string]: unknown;
}

/**
 * Base user fields shared across User, CreateUserInput, and UpdateUserInput
 */
export interface BaseUserFields {
  email: string;
  name?: string;
  emoji?: string;
  role: UserRole;
}

/**
 * User type - Authentication and authorization
 */
export interface User extends BaseUserFields {
  user_id: UserID;
  avatar?: string;
  preferences?: UserPreferences;
  onboarding_completed: boolean;
  /** Force password change on next login (admin-settable, auto-cleared on password change) */
  must_change_password: boolean;
  created_at: Date;
  updated_at?: Date;
  // Unix username for process impersonation (optional, unique, admin-managed)
  unix_username?: string;
  // API key status (boolean only, never exposes actual keys)
  api_keys?: {
    ANTHROPIC_API_KEY?: boolean; // true = key is set, false/undefined = not set
    OPENAI_API_KEY?: boolean;
    GEMINI_API_KEY?: boolean;
    COPILOT_GITHUB_TOKEN?: boolean;
  };
  // Environment variable status with scope (never exposes actual values).
  // Map from env var name → presence/scope metadata. For v0.5 the only validated
  // scope values are 'global' and 'session'; other values are reserved for v1 and
  // tolerated on read but not yet exposed by the UI.
  env_vars?: Record<string, EnvVarMetadata>;
  // Default agentic tool configuration (prepopulates session creation forms)
  default_agentic_config?: DefaultAgenticConfig;
}

/**
 * Env var scope values.
 *
 * v0.5 only validates 'global' and 'session'. Other values (repo, mcp_server,
 * artifact_feature, executor) are *reserved* — present in the type for forward
 * compatibility but not yet selectable in the UI or resolved by the daemon.
 *
 * See `context/explorations/env-var-access.md`.
 */
export type EnvVarScope =
  | 'global'
  | 'session'
  | 'repo'
  | 'mcp_server'
  | 'artifact_feature'
  | 'executor';

/** Scope values that v0.5 actually validates/uses. */
export const ENV_VAR_SCOPES_V05: readonly EnvVarScope[] = ['global', 'session'] as const;

/** Public-facing env var metadata (no secret value, just presence + scope). */
export interface EnvVarMetadata {
  /** true once a value has been set (kept for backward compat with `Record<string, boolean>` callers). */
  set: true;
  scope: EnvVarScope;
  /** Reserved for v1 scopes (repo id, mcp server id, etc.). Always null in v0.5. */
  resource_id?: string | null;
}

/**
 * User API Key - Public DTO for programmatic access keys.
 * key_hash is internal to the DB layer and never exposed.
 */
export interface UserApiKey {
  id: string;
  user_id: UserID;
  name: string;
  prefix: string;
  created_at: Date;
  last_used_at?: Date;
}

/**
 * Create user input (password required, not stored in User type)
 */
export interface CreateUserInput extends Partial<Omit<BaseUserFields, 'role'>> {
  email: string;
  password: string;
  role?: UserRole; // Optional, defaults to 'member' if not provided
  unix_username?: string;
  /** Force user to change password on first login (admin-only) */
  must_change_password?: boolean;
}

/**
 * Update user input
 */
export interface UpdateUserInput extends Partial<BaseUserFields> {
  password?: string;
  avatar?: string;
  preferences?: UserPreferences;
  onboarding_completed?: boolean;
  unix_username?: string;
  /** Force user to change password on next login (admin-only) */
  must_change_password?: boolean;
  // API keys for update (accepts plaintext, encrypted before storage)
  api_keys?: {
    ANTHROPIC_API_KEY?: string | null; // string = set key, null = clear key
    OPENAI_API_KEY?: string | null;
    GEMINI_API_KEY?: string | null;
    COPILOT_GITHUB_TOKEN?: string | null;
  };
  // Environment variables for update (accepts plaintext, encrypted before storage).
  // `null` clears the variable. A plain `string` creates/updates the value and leaves
  // the existing scope in place (defaults to 'global' for new vars).
  env_vars?: Record<string, string | null>; // { "GITHUB_TOKEN": "ghp_...", "NPM_TOKEN": null }
  /**
   * Per-var scope updates, applied on top of any `env_vars` changes in the same PATCH.
   * Only 'global' and 'session' are accepted in v0.5; other values reject with a 400.
   * Setting the scope for a variable that doesn't exist is a no-op.
   */
  env_var_scopes?: Record<string, EnvVarScope>;
  // Default agentic tool configuration
  default_agentic_config?: DefaultAgenticConfig;
}

/**
 * Session-scope env var selection (many-to-many row).
 *
 * v0.5: env vars are still keyed by name inside `users.data.env_vars` (no `env_vars.id`
 * yet — see `context/explorations/env-var-access.md`), so selections reference vars by
 * `env_var_name` scoped implicitly via `session.created_by`. When v1 promotes env vars
 * to their own table this becomes `env_var_id`.
 */
export interface SessionEnvSelection {
  session_id: string;
  env_var_name: string;
  created_at: Date;
}
