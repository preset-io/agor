import type {
  AgenticToolName,
  CodexApprovalPolicy,
  CodexNetworkAccess,
  CodexSandboxMode,
} from './agentic-tool';
import type { UserID } from './id';
import type { EffortLevel, PermissionMode } from './session';

/**
 * User role types
 * - superadmin: Full system access including branch RBAC bypass (requires allow_superadmin=true in config)
 * - admin: Can manage most resources (MCP servers, config, users), no branch RBAC bypass
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
 * Display metadata for each role. Ordered from most → least privileged so UI
 * dropdowns can render directly from this list without re-sorting.
 *
 * This is the single source of truth for role labels and descriptions —
 * dropdowns, CLI prompts, and any other surface listing roles should map
 * over this array instead of hard-coding role strings.
 */
export interface RoleOption {
  value: UserRole;
  label: string;
  description: string;
}

export const ROLE_OPTIONS: readonly RoleOption[] = [
  {
    value: ROLES.SUPERADMIN,
    label: 'Superadmin',
    description: 'Full system access + branch RBAC bypass',
  },
  {
    value: ROLES.ADMIN,
    label: 'Admin',
    description: 'Manage resources (users, MCP servers, config)',
  },
  { value: ROLES.MEMBER, label: 'Member', description: 'Standard user' },
  { value: ROLES.VIEWER, label: 'Viewer', description: 'Read-only access' },
] as const;

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
  /** Claude Code advisor model (e.g., 'opus', 'sonnet', 'fable'); unset means no session override */
  advisorModel?: string;
}

/**
 * Default agentic tool configuration per tool
 */
export interface DefaultAgenticToolConfig {
  /** Default model configuration */
  modelConfig?: DefaultModelConfig;
  /** Default permission mode (Claude/Gemini unified mode) */
  permissionMode?: PermissionMode;
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
  'claude-code-cli'?: DefaultAgenticToolConfig;
  codex?: DefaultAgenticToolConfig;
  gemini?: DefaultAgenticToolConfig;
  opencode?: DefaultAgenticToolConfig;
  copilot?: DefaultAgenticToolConfig;
  cursor?: DefaultAgenticToolConfig;
}

export type UserAgenticDefaultSelections = Partial<
  Record<AgenticToolName, import('./agentic-tool-preset').UserAgenticDefaultSelection>
>;

/**
 * Per-tool credential field shapes.
 *
 * Field names equal the env var names exported into the SDK CLI's environment.
 * Storage values are encrypted at rest; the public DTO (User.agentic_tools)
 * exposes the same field names with `boolean` presence flags.
 */
export interface ClaudeCodeConfig {
  ANTHROPIC_API_KEY?: string;
  CLAUDE_CODE_OAUTH_TOKEN?: string;
  ANTHROPIC_AUTH_TOKEN?: string;
  ANTHROPIC_BASE_URL?: string;
}

export interface CodexConfig {
  OPENAI_API_KEY?: string;
  OPENAI_BASE_URL?: string;
}

export type AgenticAuthMethod = 'api_key' | 'subscription';
export type AgenticAuthMethods = Partial<Record<'claude-code' | 'codex', AgenticAuthMethod>>;

export interface GeminiConfig {
  GEMINI_API_KEY?: string;
}

export interface CopilotConfig {
  COPILOT_GITHUB_TOKEN?: string;
}

export interface CursorConfig {
  CURSOR_API_KEY?: string;
}

/**
 * Per-tool credential map. Each tool's config is independent and
 * scoped to its own SDK at session-spawn time.
 */
export interface AgenticToolsConfig {
  'claude-code'?: ClaudeCodeConfig;
  // claude-code-cli wraps the `claude` shell binary. Same Anthropic env vars
  // apply as the SDK path (ANTHROPIC_API_KEY, OAuth token, base URL); the
  // subscription path doesn't use env vars at all — it reads
  // ~/.claude/.credentials.json managed by `claude auth login`.
  'claude-code-cli'?: ClaudeCodeConfig;
  codex?: CodexConfig;
  gemini?: GeminiConfig;
  copilot?: CopilotConfig;
  cursor?: CursorConfig;
  opencode?: Record<string, never>;
}

/** Union of all valid env-var-named fields across all tool configs. */
export type AgenticToolConfigField =
  | keyof ClaudeCodeConfig
  | keyof CodexConfig
  | keyof GeminiConfig
  | keyof CopilotConfig
  | keyof CursorConfig;

/**
 * Public DTO shape: per-tool credential presence flags.
 *
 * Flips every field of every tool config from `string` (encrypted) to `boolean`
 * (set/unset). Used by `User.agentic_tools` and the user-facing API responses
 * — the daemon never returns decrypted credential values to clients.
 */
export type AgenticToolsStatus = {
  [Tool in keyof AgenticToolsConfig]?: AgenticToolsConfig[Tool] extends infer Cfg
    ? { [Field in keyof Cfg]?: boolean }
    : never;
};

/**
 * Encrypted-at-rest projection of `AgenticToolsConfig` — the on-disk shape of
 * `users.data.agentic_tools`. Each field's `string` (plaintext) is replaced
 * with the encrypted ciphertext bytes (also a string at the storage layer).
 *
 * Lives next to `AgenticToolsConfig` so the canonical type, the public DTO,
 * and the storage projection move together. Imported by the repo (writer/
 * decryptor), the env resolver (reader), and the daemon users service
 * (patcher) — keeping the alias single-source avoids the historical drift
 * across these three call sites.
 */
export type StoredAgenticTools = {
  [Tool in keyof AgenticToolsConfig]?: Record<string, string>;
};

/**
 * Project the encrypted-at-rest blob to the boolean presence DTO returned to
 * clients. Empty buckets are dropped so the API response stays compact.
 */
export function toAgenticToolsStatus(
  stored: StoredAgenticTools | undefined
): AgenticToolsStatus | undefined {
  if (!stored) return undefined;
  const out: Record<string, Record<string, boolean>> = {};
  for (const [tool, fields] of Object.entries(stored)) {
    if (!fields) continue;
    const flags: Record<string, boolean> = {};
    for (const [field, value] of Object.entries(fields)) {
      if (value) flags[field] = true;
    }
    if (Object.keys(flags).length > 0) {
      out[tool] = flags;
    }
  }
  return Object.keys(out).length > 0 ? (out as AgenticToolsStatus) : undefined;
}

/**
 * Update DTO shape: per-tool credential patch payload.
 *
 * String values set the field (plaintext, encrypted before storage); `null`
 * clears the field. Omitted fields are untouched. Used by PATCH /users/:id.
 */
export type AgenticToolsUpdate = {
  [Tool in keyof AgenticToolsConfig]?: AgenticToolsConfig[Tool] extends infer Cfg
    ? { [Field in keyof Cfg]?: string | null }
    : never;
};

/**
 * Per-tool whitelist of fields whose plaintext is safe to echo back to the
 * field's owner.
 *
 * Base URLs are config (not credentials) — the user benefits from seeing the
 * exact value they configured (e.g. distinguishing
 * `https://gateway.example.com/v1` from `https://gateway.example.com`). API
 * keys, OAuth tokens, and auth tokens are NEVER on this list and never
 * decrypted on read.
 *
 * Even for whitelisted fields, the daemon only returns the plaintext to the
 * field's *owner* — never to other users (base URLs can leak internal
 * hostnames) and never to admins viewing someone else's profile.
 */
export const AGENTIC_TOOLS_PUBLIC_FIELDS: {
  readonly [Tool in keyof AgenticToolsConfig]?: ReadonlyArray<
    keyof NonNullable<AgenticToolsConfig[Tool]> & string
  >;
} = {
  'claude-code': ['ANTHROPIC_BASE_URL'],
  'claude-code-cli': ['ANTHROPIC_BASE_URL'],
  codex: ['OPENAI_BASE_URL'],
} as const;

/**
 * Owner-visible plaintext values for the fields listed in
 * `AGENTIC_TOOLS_PUBLIC_FIELDS`. Sibling map to `AgenticToolsStatus` —
 * presence remains the source of truth; this just lets the UI render the
 * saved value back without forcing a clear-and-retype.
 *
 * Always undefined / partial when the requester is not the field's owner.
 */
export type AgenticToolsPublicValues = {
  [Tool in keyof AgenticToolsConfig]?: AgenticToolsConfig[Tool] extends infer Cfg
    ? { [Field in keyof Cfg]?: string }
    : never;
};

/**
 * Decrypt the whitelisted public fields from the on-disk encrypted blob.
 * Returns undefined when no public fields are populated, so the API response
 * stays compact.
 *
 * The caller is responsible for the self-only authorization check — this
 * helper assumes the requester is already authorized to see the values.
 */
export function extractAgenticToolsPublicValues(
  stored: StoredAgenticTools | undefined,
  decrypt: (ciphertext: string) => string
): AgenticToolsPublicValues | undefined {
  if (!stored) return undefined;
  const out: Record<string, Record<string, string>> = {};
  for (const [tool, fields] of Object.entries(stored) as Array<
    [keyof AgenticToolsConfig, Record<string, string> | undefined]
  >) {
    if (!fields) continue;
    const whitelist = AGENTIC_TOOLS_PUBLIC_FIELDS[tool];
    if (!whitelist || whitelist.length === 0) continue;
    const plaintext: Record<string, string> = {};
    for (const field of whitelist) {
      const ciphertext = fields[field as string];
      if (!ciphertext) continue;
      try {
        plaintext[field as string] = decrypt(ciphertext);
      } catch {
        // Silently skip undecryptable values; the boolean status flag will
        // still indicate presence so the user can clear and re-set.
      }
    }
    if (Object.keys(plaintext).length > 0) {
      out[tool] = plaintext;
    }
  }
  return Object.keys(out).length > 0 ? (out as AgenticToolsPublicValues) : undefined;
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
  path?: 'teammate' | 'own-repo';
  /** The repo ID associated with this onboarding (framework repo or user's repo) */
  repoId?: string;
  /** The branch ID created during onboarding */
  branchId?: string;
  /** The board ID created for this user */
  boardId?: string;
  /** Teammate display name captured during onboarding identity step */
  teammateDisplayName?: string;
  /** @deprecated Use teammateDisplayName. Read for pre-rename preferences compatibility only. */
  assistantDisplayName?: string;
  /** Teammate emoji captured during onboarding identity step */
  teammateEmoji?: string;
  /** @deprecated Use teammateEmoji. Read for pre-rename preferences compatibility only. */
  assistantEmoji?: string;
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
  /** Whether to render Slack-synced avatar_url when available. Undefined defaults to true. */
  use_slack_avatar?: boolean;
  // Future preferences can be added here
  [key: string]: unknown;
}

/** Stable external identity link stored with a local user. */
export interface UserExternalIdentity {
  /** SHA-256 of provider + issuer + subject; stable lookup key. */
  key: string;
  /** Stable provider label configured for the external launch provider. */
  provider: string;
  /** Trusted issuer that produced the launch assertion. */
  issuer: string;
  /** Subject from the trusted issuer; not an email address. */
  subject: string;
  email?: string;
  name?: string;
  last_login_at: string;
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
  /**
   * Preferred image avatar URL for this user.
   *
   * Stored in `users.data.avatar_url`. `avatar` is retained as a legacy alias
   * for older launch-auth/MCP callers and should be treated as a fallback.
   */
  avatar_url?: string;
  avatar?: string;
  avatar_source?: 'manual' | 'slack' | 'launch-auth' | string;
  avatar_source_id?: string;
  avatar_synced_at?: string;
  preferences?: UserPreferences;
  onboarding_completed: boolean;
  /** Force password change on next login (admin-settable, auto-cleared on password change) */
  must_change_password: boolean;
  created_at: Date;
  updated_at?: Date;
  // Unix username for process impersonation (optional, unique, admin-managed)
  unix_username?: string;
  /**
   * Per-tool credential & auth status (boolean only, never exposes actual values).
   *
   * Mirrors `AgenticToolsConfig` field-for-field with each value flipped from
   * encrypted-string to `boolean` for presence checking.
   */
  agentic_tools?: AgenticToolsStatus;
  /** Explicit authentication method; inactive credentials remain stored but are never resolved. */
  agentic_auth_methods?: AgenticAuthMethods;
  /**
   * Plaintext values for fields listed in `AGENTIC_TOOLS_PUBLIC_FIELDS` —
   * only populated when the requester is the field's owner. Lets the UI
   * render the saved value (e.g. the user's custom `OPENAI_BASE_URL`) back
   * without forcing a clear-and-retype. Never contains API keys or tokens.
   */
  agentic_tools_public_values?: AgenticToolsPublicValues;
  // Environment variable status with scope (never exposes actual values).
  // Map from env var name → presence/scope metadata. For v0.5 the only validated
  // scope values are 'global' and 'session'; other values are reserved for v1 and
  // tolerated on read but not yet exposed by the UI.
  env_vars?: Record<string, EnvVarMetadata>;
  // Default agentic tool configuration (prepopulates session creation forms)
  default_agentic_config?: DefaultAgenticConfig;
  default_agentic_selection?: UserAgenticDefaultSelections;
  // Default MCP selection, independent of the selected agentic tool.
  default_mcp_server_ids?: string[];
}

/**
 * Backend/internal user shape with auth invalidation metadata.
 *
 * Public user DTOs returned to browser clients intentionally omit this marker;
 * auth services use it while validating or issuing browser tokens.
 */
export type UserAuthMetadata = object & {
  /** Tokens issued at or before this timestamp are no longer valid. */
  tokens_valid_after?: Date;
  /** Backend-only tenant id used while issuing/validating runtime tokens. */
  tenant_id?: string;
};

export type InternalUser = User & UserAuthMetadata;

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

export interface UserAvatarSettings {
  enabled: boolean;
  provider: 'slack' | null;
  gateway_channel_id: string | null;
  last_sync_at?: string;
  last_sync_result?: UserAvatarSyncResult;
}

export interface UserAvatarSyncResult {
  ok: boolean;
  mode: 'bulk' | 'single';
  gateway_channel_id: string | null;
  started_at: string;
  finished_at: string;
  matched: number;
  updated: number;
  skipped: number;
  failed: number;
  failures: Array<{ user_id?: string; email?: string; reason: string }>;
}

export interface UserAvatarSyncRequest {
  gateway_channel_id?: string;
  user_id?: string;
}

/**
 * Create user input (password required, not stored in User type)
 */
export interface CreateUserInput extends Partial<Omit<BaseUserFields, 'role'>> {
  email: string;
  password: string;
  role?: UserRole; // Optional, defaults to 'member' if not provided
  unix_username?: string;
  avatar_url?: string;
  avatar?: string;
  avatar_source?: string;
  avatar_source_id?: string;
  avatar_synced_at?: string;
  /** Force user to change password on first login (admin-only) */
  must_change_password?: boolean;
}

/**
 * Update user input
 */
export interface UpdateUserInput extends Partial<BaseUserFields> {
  password?: string;
  avatar_url?: string | null;
  avatar?: string;
  avatar_source?: string | null;
  avatar_source_id?: string | null;
  avatar_synced_at?: string | null;
  preferences?: UserPreferences;
  onboarding_completed?: boolean;
  unix_username?: string;
  /** Force user to change password on next login (admin-only) */
  must_change_password?: boolean;
  /**
   * Per-tool credential updates (accepts plaintext, encrypted before storage).
   *
   * Each tool's sub-object is a partial patch — only fields you include are
   * touched; `null` clears the field, a string sets it. Field names = env var names.
   */
  agentic_tools?: AgenticToolsUpdate;
  agentic_auth_methods?: AgenticAuthMethods;
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
  default_agentic_selection?: UserAgenticDefaultSelections;
  // Default MCP selection, independent of the selected agentic tool.
  default_mcp_server_ids?: string[];
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
