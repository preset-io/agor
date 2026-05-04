/**
 * Users Service
 *
 * Handles user authentication and management.
 * Only active when authentication is enabled via config.
 */

import { generateId } from '@agor/core';
import {
  assertV05Scope,
  getEnvVarBlockReason,
  isEnvVarAllowed,
  normalizeStoredEnvMap,
  type StoredEnvVar,
  validateEnvVar,
} from '@agor/core/config';
import {
  compare,
  type Database,
  decryptApiKey,
  deleteFrom,
  encryptApiKey,
  eq,
  hash,
  insert,
  select,
  update,
  users,
} from '@agor/core/db';
import { isLikelyGitToken } from '@agor/core/git';
import type {
  AgenticToolName,
  AgenticToolsConfig,
  AgenticToolsUpdate,
  AuthenticatedParams,
  EnvVarMetadata,
  EnvVarScope,
  Paginated,
  Params,
  StoredAgenticTools,
  User,
  UserID,
  UserRole,
} from '@agor/core/types';
import {
  extractAgenticToolsPublicValues,
  normalizeRole,
  ROLES,
  toAgenticToolsStatus,
} from '@agor/core/types';

/**
 * Apply a per-tool credential patch to the encrypted-at-rest blob.
 *
 * Patch semantics (mirror UpdateUserInput.agentic_tools):
 *   - `string` value → encrypt and set the field
 *   - `null` value   → delete the field
 *   - omitted field  → untouched
 *   - if a tool's bucket becomes empty post-patch, the bucket is removed
 *
 * Returns the next stored shape (caller writes it back to `data.agentic_tools`).
 */
function applyAgenticToolsPatch(
  current: StoredAgenticTools,
  patch: AgenticToolsUpdate
): StoredAgenticTools {
  const next: StoredAgenticTools = { ...current };
  for (const [tool, fields] of Object.entries(patch) as Array<
    [AgenticToolName, Record<string, string | null> | undefined]
  >) {
    if (!fields) continue;
    const bucket: Record<string, string> = { ...((next[tool] as Record<string, string>) ?? {}) };
    for (const [field, value] of Object.entries(fields)) {
      if (value === null || value === undefined) {
        delete bucket[field];
      } else {
        try {
          bucket[field] = encryptApiKey(value);
          console.log(`🔐 Encrypted user agentic_tools.${tool}.${field}`);
        } catch (err) {
          console.error(`Failed to encrypt agentic_tools.${tool}.${field}:`, err);
          throw new Error(`Failed to encrypt agentic_tools.${tool}.${field}`);
        }
      }
    }
    if (Object.keys(bucket).length > 0) {
      (next as Record<string, Record<string, string>>)[tool] = bucket;
    } else {
      delete next[tool];
    }
  }
  return next;
}

/**
 * Create user input
 */
interface CreateUserData {
  email: string;
  password: string;
  name?: string;
  emoji?: string;
  role?: UserRole;
  unix_username?: string;
  must_change_password?: boolean;
}

/**
 * Update user input
 */
interface UpdateUserData {
  email?: string;
  password?: string;
  name?: string;
  emoji?: string;
  role?: UserRole;
  unix_username?: string;
  must_change_password?: boolean;
  avatar?: string;
  preferences?: Record<string, unknown>;
  onboarding_completed?: boolean;
  /**
   * Per-tool credential patch. Each tool's sub-object is a partial patch —
   * `string` sets and encrypts, `null` clears, omitted fields are untouched.
   * Field names are env var names exported into the SDK CLI environment.
   */
  agentic_tools?: AgenticToolsUpdate;
  // Environment variables for update (accepts plaintext, encrypted before storage)
  env_vars?: Record<string, string | null>; // { "GITHUB_TOKEN": "ghp_...", "NPM_TOKEN": null }
  // Per-var scope updates (v0.5: 'global' | 'session'). Applied after env_vars
  // changes in the same PATCH. Scope for a var that doesn't exist is a no-op.
  env_var_scopes?: Record<string, EnvVarScope>;
  // Default agentic tool configurations
  default_agentic_config?: import('@agor/core/types').DefaultAgenticConfig;
}

/**
 * Users Service Methods
 */
export class UsersService {
  constructor(protected db: Database) {}

  /**
   * Find all users (supports filtering by email for authentication)
   */
  async find(params?: Params): Promise<Paginated<User>> {
    // Check if filtering by email (for authentication)
    const email = params?.query?.email as string | undefined;
    const includePassword = !!email; // Include password when looking up by email (for authentication)
    const requesterId = (params as AuthenticatedParams | undefined)?.user?.user_id as
      | UserID
      | undefined;

    let rows: (typeof users.$inferSelect)[];
    if (email) {
      // Find by email (for LocalStrategy)
      const row = await select(this.db).from(users).where(eq(users.email, email)).one();
      rows = row ? [row] : [];
    } else {
      // Find all
      rows = await select(this.db).from(users).all();
    }

    const results = rows.map((row) => this.rowToUser(row, includePassword, requesterId));

    return {
      total: results.length,
      limit: results.length,
      skip: 0,
      data: results,
    };
  }

  /**
   * Get user by ID
   */
  async get(id: UserID, params?: Params): Promise<User> {
    const row = await select(this.db).from(users).where(eq(users.user_id, id)).one();

    if (!row) {
      throw new Error(`User not found: ${id}`);
    }

    const requesterId = (params as AuthenticatedParams | undefined)?.user?.user_id as
      | UserID
      | undefined;
    return this.rowToUser(row, false, requesterId);
  }

  /**
   * Create new user
   */
  async create(data: CreateUserData, _params?: Params): Promise<User> {
    // Check if email already exists
    const existing = await select(this.db).from(users).where(eq(users.email, data.email)).one();

    if (existing) {
      throw new Error(`User with email ${data.email} already exists`);
    }

    // Hash password
    const hashedPassword = await hash(data.password, 10);

    // Create user
    const now = new Date();
    const user_id = generateId() as UserID;

    const role = data.role || ROLES.MEMBER;
    const defaultEmoji = role === ROLES.ADMIN ? '⭐' : '👤';

    const row = await insert(this.db, users)
      .values({
        user_id,
        email: data.email,
        password: hashedPassword,
        name: data.name,
        emoji: data.emoji || defaultEmoji,
        role,
        unix_username: data.unix_username,
        must_change_password: data.must_change_password ?? false,
        created_at: now,
        updated_at: now,
        data: {
          preferences: {},
        },
      })
      .returning()
      .one();

    return this.rowToUser(row);
  }

  /**
   * Update user
   */
  async patch(id: UserID, data: UpdateUserData, params?: Params): Promise<User> {
    const now = new Date();
    const updates: Record<string, unknown> = { updated_at: now };

    // Handle password separately (needs hashing)
    if (data.password) {
      updates.password = await hash(data.password, 10);
      // Auto-clear must_change_password when password is changed,
      // UNLESS explicitly set in the same request (admin reset + force change scenario)
      // e.g., `user update --password newpass --force-password-change` should keep flag true
      updates.must_change_password = data.must_change_password ?? false;
    } else if (data.must_change_password !== undefined) {
      // Handle must_change_password flag when set WITHOUT password change (admin toggle)
      updates.must_change_password = data.must_change_password;
    }

    // Update other fields
    if (data.email) updates.email = data.email;
    if (data.name) updates.name = data.name;
    if (data.emoji !== undefined) updates.emoji = data.emoji;
    if (data.role) updates.role = data.role;
    if (data.unix_username !== undefined) updates.unix_username = data.unix_username;
    if (data.onboarding_completed !== undefined)
      updates.onboarding_completed = data.onboarding_completed;

    // Update data blob
    if (
      data.avatar ||
      data.preferences ||
      data.agentic_tools ||
      data.env_vars ||
      data.env_var_scopes ||
      data.default_agentic_config
    ) {
      const current = await this.get(id);
      const currentRow = await select(this.db).from(users).where(eq(users.user_id, id)).one();
      const currentData = currentRow?.data as {
        avatar?: string;
        preferences?: Record<string, unknown>;
        agentic_tools?: StoredAgenticTools;
        env_vars?: Record<string, string | StoredEnvVar>;
        default_agentic_config?: import('@agor/core/types').DefaultAgenticConfig;
      };

      // Handle per-tool credential patches (encrypt-on-write, drop-on-null).
      const nextAgenticTools: StoredAgenticTools = data.agentic_tools
        ? applyAgenticToolsPatch(currentData?.agentic_tools ?? {}, data.agentic_tools)
        : (currentData?.agentic_tools ?? {});

      // Handle env vars (encrypt before storage).
      //
      // Stored shape is `Record<name, StoredEnvVar>` where StoredEnvVar carries
      // scope metadata (v0.5 env-var-access). We tolerate legacy plain-string
      // values on read and promote them to the object shape on any write.
      const normalizedExisting = normalizeStoredEnvMap(currentData?.env_vars);
      const nextEnvVars: Record<string, StoredEnvVar> = { ...normalizedExisting };

      if (data.env_vars) {
        for (const [key, value] of Object.entries(data.env_vars)) {
          // Validate variable name
          if (!isEnvVarAllowed(key)) {
            const reason = getEnvVarBlockReason(key);
            throw new Error(`Cannot set environment variable "${key}": ${reason}`);
          }

          // Git tokens are embedded into a git-credentials file and a clone URL
          // at runtime. Reject at ingest anything that doesn't match the
          // `isLikelyGitToken` shape so shell metacharacters / whitespace cannot
          // smuggle in even if the credential-file path later regresses.
          if ((key === 'GITHUB_TOKEN' || key === 'GH_TOKEN') && value) {
            if (!isLikelyGitToken(value)) {
              throw new Error(
                `Invalid ${key}: must match [A-Za-z0-9_-]{20,255}. ` +
                  `GitHub / GitLab tokens should not contain spaces, newlines, or special characters.`
              );
            }
          }

          if (value === null || value === undefined) {
            // Clear variable
            delete nextEnvVars[key];
            console.log(`🗑️  Cleared user env var: ${key}`);
          } else {
            // Validate and encrypt
            const errors = validateEnvVar(key, value);
            if (errors.length > 0) {
              const message = errors.map((e) => e.message).join('; ');
              throw new Error(`Invalid environment variable: ${message}`);
            }

            try {
              const prior = nextEnvVars[key];
              nextEnvVars[key] = {
                value_encrypted: encryptApiKey(value),
                // Preserve existing scope if we're just rotating the value;
                // default to 'global' for brand-new vars.
                scope: prior?.scope ?? 'global',
                resource_id: prior?.resource_id ?? null,
                extra_config: prior?.extra_config ?? null,
              };
              console.log(`🔐 Encrypted user env var: ${key}`);
            } catch (err) {
              console.error(`Failed to encrypt env var ${key}:`, err);
              throw new Error(`Failed to encrypt environment variable: ${key}`);
            }
          }
        }
      }

      // Apply per-var scope updates. Scopes are validated in the app layer
      // (no SQL CHECK constraint) so new scope values don't require a migration.
      if (data.env_var_scopes) {
        for (const [key, scope] of Object.entries(data.env_var_scopes)) {
          assertV05Scope(scope);
          const existing = nextEnvVars[key];
          if (!existing) {
            // Scope update for a non-existent var — ignore silently; the UI
            // should have created the var first.
            console.warn(`[users] Ignoring scope update for unknown env var: ${key}`);
            continue;
          }
          nextEnvVars[key] = { ...existing, scope };
          console.log(`🔧 Updated scope for env var ${key}: ${scope}`);
        }
      }

      updates.data = {
        avatar: data.avatar ?? current.avatar,
        preferences: data.preferences ?? current.preferences,
        agentic_tools: Object.keys(nextAgenticTools).length > 0 ? nextAgenticTools : undefined,
        env_vars: Object.keys(nextEnvVars).length > 0 ? nextEnvVars : undefined,
        default_agentic_config: data.default_agentic_config ?? current.default_agentic_config,
      };
    }

    const row = await update(this.db, users)
      .set(updates)
      .where(eq(users.user_id, id))
      .returning()
      .one();

    if (!row) {
      throw new Error(`User not found: ${id}`);
    }

    const requesterId = (params as AuthenticatedParams | undefined)?.user?.user_id as
      | UserID
      | undefined;
    return this.rowToUser(row, false, requesterId);
  }

  /**
   * Delete user
   */
  async remove(id: UserID, _params?: Params): Promise<User> {
    const user = await this.get(id);

    await deleteFrom(this.db, users).where(eq(users.user_id, id)).run();

    return user;
  }

  /**
   * Find user by email (for authentication)
   */
  async findByEmail(email: string): Promise<User | null> {
    const row = await select(this.db).from(users).where(eq(users.email, email)).one();

    return row ? this.rowToUser(row) : null;
  }

  /**
   * Verify password
   */
  async verifyPassword(user: User, password: string): Promise<boolean> {
    // Need to fetch password from database (not in User type)
    const row = await select(this.db).from(users).where(eq(users.user_id, user.user_id)).one();

    if (!row) return false;

    return compare(password, row.password);
  }

  /**
   * Get a single decrypted credential field scoped to a specific agentic tool.
   *
   * Replaces the legacy flat-namespace `getApiKey(userId, 'ANTHROPIC_API_KEY')`
   * call site with `(userId, 'claude-code', 'ANTHROPIC_API_KEY')` so an
   * Anthropic key stored on the user can no longer leak into a Codex spawn.
   */
  async getToolConfigField<T extends AgenticToolName>(
    userId: UserID,
    tool: T,
    field: keyof AgenticToolsConfig[T] & string
  ): Promise<string | undefined> {
    const row = await select(this.db).from(users).where(eq(users.user_id, userId)).one();
    if (!row) return undefined;

    const data = row.data as { agentic_tools?: StoredAgenticTools };
    const encrypted = data.agentic_tools?.[tool]?.[field];
    if (!encrypted) return undefined;

    try {
      return decryptApiKey(encrypted);
    } catch (err) {
      console.error(`Failed to decrypt agentic_tools.${tool}.${field} for user ${userId}:`, err);
      return undefined;
    }
  }

  /**
   * Get the full decrypted credential bag for one tool. Used when spawning an
   * SDK so the executor environment receives only that tool's env vars.
   * Returns `null` if the user has no stored config for the tool.
   */
  async getToolConfig<T extends AgenticToolName>(
    userId: UserID,
    tool: T
  ): Promise<AgenticToolsConfig[T] | null> {
    const row = await select(this.db).from(users).where(eq(users.user_id, userId)).one();
    if (!row) return null;

    const data = row.data as { agentic_tools?: StoredAgenticTools };
    const fields = data.agentic_tools?.[tool];
    if (!fields || Object.keys(fields).length === 0) return null;

    const out: Record<string, string> = {};
    for (const [field, encrypted] of Object.entries(fields)) {
      if (!encrypted) continue;
      try {
        out[field] = decryptApiKey(encrypted);
      } catch (err) {
        console.error(`Failed to decrypt agentic_tools.${tool}.${field} for user ${userId}:`, err);
      }
    }

    return Object.keys(out).length > 0 ? (out as AgenticToolsConfig[T]) : null;
  }

  /**
   * Get decrypted environment variables for a user (ALL scopes).
   *
   * Used by code paths that don't yet care about scope (legacy callers, terminal
   * sessions in some modes). For session spawning, prefer the scope-aware
   * `resolveUserEnvironment(userId, db, { sessionId })` in core/config.
   */
  async getEnvironmentVariables(userId: UserID): Promise<Record<string, string>> {
    const row = await select(this.db).from(users).where(eq(users.user_id, userId)).one();

    if (!row) return {};

    const data = row.data as { env_vars?: Record<string, string | StoredEnvVar> };
    const stored = normalizeStoredEnvMap(data.env_vars);

    const decryptedVars: Record<string, string> = {};
    for (const [key, entry] of Object.entries(stored)) {
      try {
        decryptedVars[key] = decryptApiKey(entry.value_encrypted);
      } catch (err) {
        console.error(`Failed to decrypt env var ${key} for user ${userId}:`, err);
        // Skip this variable (don't crash)
      }
    }

    return decryptedVars;
  }

  /**
   * Convert database row to User type
   *
   * @param row - Database row
   * @param includePassword - Include password field (for authentication only)
   * @param requesterId - Authenticated user making the request. When equal to
   *   the row's `user_id`, the returned DTO includes `agentic_tools_public_values`
   *   (decrypted plaintext for the whitelisted non-secret fields like
   *   `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL`). For any other requester —
   *   including admins viewing someone else's profile — public values are
   *   omitted, since base URLs can leak internal hostnames.
   */
  private rowToUser(
    row: typeof users.$inferSelect,
    includePassword = false,
    requesterId?: UserID
  ): User & { password?: string } {
    const data = row.data as {
      avatar?: string;
      preferences?: Record<string, unknown>;
      agentic_tools?: StoredAgenticTools; // Encrypted per-tool credential blobs
      env_vars?: Record<string, string | StoredEnvVar>; // Encrypted env vars (legacy + v0.5 shape)
      default_agentic_config?: import('@agor/core/types').DefaultAgenticConfig;
    };

    const normalizedEnvVars = normalizeStoredEnvMap(data.env_vars);
    const envVarMetadata: Record<string, EnvVarMetadata> | undefined =
      Object.keys(normalizedEnvVars).length > 0
        ? Object.fromEntries(
            Object.entries(normalizedEnvVars).map(([name, entry]) => [
              name,
              { set: true, scope: entry.scope, resource_id: entry.resource_id ?? null },
            ])
          )
        : undefined;

    const user: User & { password?: string } = {
      user_id: row.user_id as UserID,
      email: row.email,
      name: row.name ?? undefined,
      emoji: row.emoji ?? undefined,
      role: normalizeRole(row.role ?? undefined),
      unix_username: row.unix_username ?? undefined,
      avatar: data.avatar,
      preferences: data.preferences,
      onboarding_completed: !!row.onboarding_completed,
      must_change_password: !!row.must_change_password,
      created_at: row.created_at,
      updated_at: row.updated_at ?? undefined,
      // Per-tool credential presence (boolean only — never expose decrypted values).
      agentic_tools: toAgenticToolsStatus(data.agentic_tools),
      // Self-only: return plaintext for whitelisted non-secret fields
      // (base URLs) so the UI can render the saved value back. Field-level
      // secrets are NEVER on the whitelist; see `AGENTIC_TOOLS_PUBLIC_FIELDS`.
      agentic_tools_public_values:
        requesterId === row.user_id
          ? extractAgenticToolsPublicValues(data.agentic_tools, decryptApiKey)
          : undefined,
      // Return env var metadata (presence + scope), NOT actual values
      env_vars: envVarMetadata,
      // Return default agentic config
      default_agentic_config: data.default_agentic_config,
    };

    // Include password for authentication (FeathersJS LocalStrategy needs this)
    if (includePassword) {
      user.password = row.password;
    }

    return user;
  }
}

/**
 * User service with password field for authentication
 * This version includes the password field for FeathersJS local strategy
 */
interface UserWithPassword extends User {
  password: string;
}

/**
 * Users service with authentication support
 */
class UsersServiceWithAuth extends UsersService {
  /**
   * Override get to include password for authentication
   * (FeathersJS LocalStrategy needs this)
   */
  async getWithPassword(id: UserID): Promise<UserWithPassword> {
    const row = await select(this.db).from(users).where(eq(users.user_id, id)).one();

    if (!row) {
      throw new Error(`User not found: ${id}`);
    }

    const data = row.data as {
      avatar?: string;
      preferences?: Record<string, unknown>;
      agentic_tools?: StoredAgenticTools;
      env_vars?: Record<string, string | StoredEnvVar>;
    };

    const normalizedEnvVars = normalizeStoredEnvMap(data.env_vars);
    const envVarMetadata: Record<string, EnvVarMetadata> | undefined =
      Object.keys(normalizedEnvVars).length > 0
        ? Object.fromEntries(
            Object.entries(normalizedEnvVars).map(([name, entry]) => [
              name,
              { set: true, scope: entry.scope, resource_id: entry.resource_id ?? null },
            ])
          )
        : undefined;

    return {
      user_id: row.user_id as UserID,
      email: row.email,
      password: row.password, // Include for authentication
      name: row.name ?? undefined,
      emoji: row.emoji ?? undefined,
      role: normalizeRole(row.role ?? undefined),
      avatar: data.avatar,
      preferences: data.preferences,
      onboarding_completed: !!row.onboarding_completed,
      must_change_password: !!row.must_change_password,
      created_at: row.created_at,
      updated_at: row.updated_at ?? undefined,
      agentic_tools: toAgenticToolsStatus(data.agentic_tools),
      env_vars: envVarMetadata,
    };
  }
}

/**
 * Create users service
 */
export function createUsersService(db: Database): UsersServiceWithAuth {
  return new UsersServiceWithAuth(db);
}
