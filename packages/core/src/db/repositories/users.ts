/**
 * Users Repository
 *
 * Type-safe CRUD operations for users with encrypted per-tool credential management.
 * Credentials live under `data.agentic_tools[toolName][envVarName]`, encrypted at rest;
 * the public DTO (User.agentic_tools) exposes boolean presence flags only.
 */

import type {
  AgenticToolName,
  AgenticToolsConfig,
  EnvVarMetadata,
  StoredAgenticTools,
  User,
  UUID,
} from '@agor/core/types';
import { toAgenticToolsStatus } from '@agor/core/types';
import { eq, like } from 'drizzle-orm';
import { normalizeStoredEnvMap, type RawStoredEnvVar } from '../../config/env-vars';
import { generateId } from '../../lib/ids';
import type { Database } from '../client';
import { deleteFrom, insert, select, update } from '../database-wrapper';
import { decryptApiKey, encryptApiKey } from '../encryption';
import { type UserInsert as SchemaUserInsert, type UserRow, users } from '../schema';
import {
  AmbiguousIdError,
  type BaseRepository,
  EntityNotFoundError,
  RepositoryError,
} from './base';

/**
 * Users repository implementation
 */
export class UsersRepository implements BaseRepository<User, Partial<User>> {
  constructor(private db: Database) {}

  /**
   * Convert database row to User type.
   * Converts the encrypted `agentic_tools` blob to a boolean presence DTO so
   * decrypted credentials never leave this repository.
   */
  private rowToUser(row: UserRow): User {
    return {
      user_id: row.user_id as UUID,
      created_at: new Date(row.created_at),
      updated_at: row.updated_at ? new Date(row.updated_at) : undefined,
      email: row.email,
      name: row.name ?? undefined,
      emoji: row.emoji ?? undefined,
      role: row.role,
      unix_username: row.unix_username ?? undefined,
      onboarding_completed: row.onboarding_completed,
      must_change_password: row.must_change_password,
      avatar: row.data.avatar,
      preferences: row.data.preferences as User['preferences'],
      // Convert encrypted per-tool credential blobs into boolean presence flags.
      agentic_tools: toAgenticToolsStatus(row.data.agentic_tools as StoredAgenticTools | undefined),
      // Convert stored env vars to presence + scope metadata (never exposes secrets).
      // Handles both legacy string form and v0.5 object form via normalizeStoredEnvMap.
      // The schema stores `scope` as a generic string (no SQL CHECK constraint); the
      // normalizer and app-layer validation narrow it to EnvVarScope.
      env_vars: (() => {
        const normalized = normalizeStoredEnvMap(
          row.data.env_vars as Record<string, RawStoredEnvVar> | undefined
        );
        if (Object.keys(normalized).length === 0) return undefined;
        const out: Record<string, EnvVarMetadata> = {};
        for (const [name, entry] of Object.entries(normalized)) {
          out[name] = { set: true, scope: entry.scope, resource_id: entry.resource_id ?? null };
        }
        return out;
      })(),
      default_agentic_config: row.data.default_agentic_config as User['default_agentic_config'],
    };
  }

  /**
   * Convert User to database insert format
   * For updates, this accepts the current user data from the database row
   */
  private userToInsert(
    user: Partial<User> & {
      password?: string;
      agentic_tools_raw?: StoredAgenticTools;
      env_vars_raw?: SchemaUserInsert['data']['env_vars'];
    }
  ): SchemaUserInsert {
    const now = new Date();
    const userId = user.user_id ?? generateId();

    if (!user.email) {
      throw new RepositoryError('User must have an email');
    }

    return {
      user_id: userId,
      created_at: user.created_at ? new Date(user.created_at) : now,
      updated_at: user.updated_at ? new Date(user.updated_at) : now,
      email: user.email,
      password: user.password ?? '', // Password required, but handled by services layer
      name: user.name ?? null,
      emoji: user.emoji ?? null,
      role: user.role ?? 'member',
      unix_username: user.unix_username ?? null,
      onboarding_completed: user.onboarding_completed ?? false,
      data: {
        avatar: user.avatar,
        preferences: user.preferences,
        // Encrypted per-tool credentials. Only forwarded when caller passes the
        // raw shape (internal credential mutators); regular updates leave it undefined,
        // letting the merge in `update()` reuse the existing on-disk blob.
        // Cast: schema declares `opencode: Record<string, never>` (no fields by
        // contract); StoredAgenticTools widens that to string values for shape
        // uniformity. Runtime never writes opencode, so the cast is safe.
        agentic_tools: user.agentic_tools_raw as SchemaUserInsert['data']['agentic_tools'],
        // Same pass-through as agentic_tools: env_vars are encrypted blobs
        // not represented on the public DTO. `update()` threads the raw value
        // from the existing row so a generic field update doesn't wipe them.
        env_vars: user.env_vars_raw,
        default_agentic_config: user.default_agentic_config,
      },
    };
  }

  /**
   * Resolve short ID to full ID
   */
  private async resolveId(id: string): Promise<string> {
    // If already a full UUID, return as-is
    if (id.length === 36 && id.includes('-')) {
      return id;
    }

    // Short ID - need to resolve
    const normalized = id.replace(/-/g, '').toLowerCase();
    const pattern = `${normalized}%`;

    const results = await select(this.db).from(users).where(like(users.user_id, pattern)).all();

    if (results.length === 0) {
      throw new EntityNotFoundError('User', id);
    }

    if (results.length > 1) {
      throw new AmbiguousIdError(
        'User',
        id,
        results.map((r: UserRow) => r.user_id)
      );
    }

    return results[0].user_id;
  }

  /**
   * Check if unix_username is already taken by another user
   */
  private async isUnixUsernameTaken(
    unixUsername: string,
    excludeUserId?: string
  ): Promise<boolean> {
    const result = await select(this.db)
      .from(users)
      .where(eq(users.unix_username, unixUsername))
      .one();

    if (!result) {
      return false;
    }

    // If excluding a user ID (for updates), check if it's a different user
    if (excludeUserId && result.user_id === excludeUserId) {
      return false;
    }

    return true;
  }

  /**
   * Create a new user
   */
  async create(data: Partial<User>): Promise<User> {
    // Validate unix_username uniqueness if provided
    if (data.unix_username) {
      const isTaken = await this.isUnixUsernameTaken(data.unix_username);
      if (isTaken) {
        throw new RepositoryError(
          `Unix username "${data.unix_username}" is already in use by another user`
        );
      }
    }

    const insertData = this.userToInsert(data);

    await insert(this.db, users).values(insertData).run();

    const row = await select(this.db)
      .from(users)
      .where(eq(users.user_id, insertData.user_id))
      .one();

    if (!row) {
      throw new RepositoryError('Failed to retrieve created user');
    }

    return this.rowToUser(row as UserRow);
  }

  /**
   * Find user by ID (supports short ID resolution)
   */
  async findById(id: string): Promise<User | null> {
    try {
      const fullId = await this.resolveId(id);

      const result = await select(this.db).from(users).where(eq(users.user_id, fullId)).one();

      if (!result) {
        return null;
      }

      return this.rowToUser(result as UserRow);
    } catch (error) {
      if (error instanceof EntityNotFoundError) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Find user by email
   */
  async findByEmail(email: string): Promise<User | null> {
    const result = await select(this.db).from(users).where(eq(users.email, email)).one();

    if (!result) {
      return null;
    }

    return this.rowToUser(result as UserRow);
  }

  /**
   * Find all users
   */
  async findAll(): Promise<User[]> {
    const results = await select(this.db).from(users).all();

    return results.map((row: UserRow) => this.rowToUser(row));
  }

  /**
   * Update user by ID
   */
  async update(id: string, updates: Partial<User>): Promise<User> {
    const fullId = await this.resolveId(id);

    // Get current user
    const current = await this.findById(fullId);
    if (!current) {
      throw new EntityNotFoundError('User', id);
    }

    // Validate unix_username uniqueness if being changed
    if (updates.unix_username && updates.unix_username !== current.unix_username) {
      const isTaken = await this.isUnixUsernameTaken(updates.unix_username, fullId);
      if (isTaken) {
        throw new RepositoryError(
          `Unix username "${updates.unix_username}" is already in use by another user`
        );
      }
    }

    // Merge updates. Preserve the encrypted agentic_tools and env_vars blobs
    // from the raw row so a generic field update (name, preferences, etc.)
    // doesn't nuke stored credentials — the boolean projection on `current`
    // can't round-trip back to encrypted bytes.
    const rawRow = await this.getRawRow(fullId);
    const merged = { ...current, ...updates } as Partial<User> & {
      agentic_tools_raw?: StoredAgenticTools;
      env_vars_raw?: SchemaUserInsert['data']['env_vars'];
    };
    if (rawRow?.data.agentic_tools) {
      merged.agentic_tools_raw = rawRow.data.agentic_tools as StoredAgenticTools;
    }
    if (rawRow?.data.env_vars) {
      merged.env_vars_raw = rawRow.data.env_vars;
    }
    const insertData = this.userToInsert(merged);

    // Update database
    await update(this.db, users)
      .set({
        ...insertData,
        updated_at: new Date(),
      })
      .where(eq(users.user_id, fullId))
      .run();

    const row = await select(this.db).from(users).where(eq(users.user_id, fullId)).one();

    if (!row) {
      throw new RepositoryError('Failed to retrieve updated user');
    }

    return this.rowToUser(row as UserRow);
  }

  /**
   * Delete user by ID
   */
  async delete(id: string): Promise<void> {
    const fullId = await this.resolveId(id);

    await deleteFrom(this.db, users).where(eq(users.user_id, fullId)).run();
  }

  /**
   * Get raw database row (internal use only - includes encrypted keys)
   */
  private async getRawRow(id: string): Promise<UserRow | null> {
    try {
      const fullId = await this.resolveId(id);

      const result = await select(this.db).from(users).where(eq(users.user_id, fullId)).one();

      return result as UserRow | null;
    } catch (error) {
      if (error instanceof EntityNotFoundError) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Get the full decrypted credential bag for a single agentic tool.
   *
   * Returns `null` when the user has no stored config for that tool.
   * Fields that fail to decrypt are dropped from the returned object and
   * logged — callers see "missing field" rather than a thrown error so a
   * single corrupt value doesn't poison an entire SDK spawn.
   */
  async getToolConfig<T extends AgenticToolName>(
    userId: string,
    tool: T
  ): Promise<AgenticToolsConfig[T] | null> {
    const row = await this.getRawRow(userId);
    if (!row) return null;

    const stored = row.data.agentic_tools as StoredAgenticTools | undefined;
    const fields = stored?.[tool];
    if (!fields || Object.keys(fields).length === 0) return null;

    const out: Record<string, string> = {};
    for (const [field, encrypted] of Object.entries(fields)) {
      if (!encrypted) continue;
      try {
        out[field] = decryptApiKey(encrypted);
      } catch (error) {
        console.error(
          `[users] Failed to decrypt ${tool}.${field} for user ${userId.substring(0, 8)}: ${
            (error as Error).message
          }`
        );
      }
    }

    return Object.keys(out).length > 0 ? (out as AgenticToolsConfig[T]) : null;
  }

  /**
   * Get a single decrypted credential field for a tool.
   *
   * Returns `null` when the field is unset OR when decryption fails (logged).
   * Throws only on storage-layer errors, not on missing/corrupt values.
   */
  async getToolConfigField<T extends AgenticToolName>(
    userId: string,
    tool: T,
    field: keyof NonNullable<AgenticToolsConfig[T]> & string
  ): Promise<string | null> {
    const row = await this.getRawRow(userId);
    if (!row) return null;

    const stored = row.data.agentic_tools as StoredAgenticTools | undefined;
    const encrypted = stored?.[tool]?.[field];
    if (!encrypted) return null;

    try {
      return decryptApiKey(encrypted);
    } catch (error) {
      console.error(
        `[users] Failed to decrypt ${tool}.${field} for user ${userId.substring(0, 8)}: ${
          (error as Error).message
        }`
      );
      return null;
    }
  }

  /**
   * Set (encrypt + persist) a single credential field for a tool.
   *
   * Field names are env-var-shaped (e.g. ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL)
   * and are stored encrypted regardless of whether the value is a secret —
   * keeping the on-disk shape uniform avoids decrypt-vs-plain branching at
   * read time. UI controls own the text-vs-password rendering distinction.
   */
  async setToolConfigField<T extends AgenticToolName>(
    userId: string,
    tool: T,
    field: keyof NonNullable<AgenticToolsConfig[T]> & string,
    value: string
  ): Promise<void> {
    const fullId = await this.resolveId(userId);
    const row = await this.getRawRow(fullId);

    if (!row) {
      throw new EntityNotFoundError('User', userId);
    }

    const stored = (row.data.agentic_tools as StoredAgenticTools | undefined) ?? {};
    const next: StoredAgenticTools = {
      ...stored,
      [tool]: {
        ...(stored[tool] ?? {}),
        [field]: encryptApiKey(value),
      },
    };

    // Patch ONLY the agentic_tools sub-blob — preserve siblings (env_vars,
    // preferences, default_agentic_config, etc.). Routing through
    // userToInsert would lose any data subfield it doesn't explicitly
    // forward (e.g. env_vars), which is how a credential write would
    // otherwise nuke unrelated user state.
    await update(this.db, users)
      .set({
        data: { ...row.data, agentic_tools: next },
        updated_at: new Date(),
      })
      .where(eq(users.user_id, fullId))
      .run();
  }

  /**
   * Delete a single credential field for a tool.
   *
   * If the tool's bucket becomes empty after the delete, the bucket itself is
   * removed so `data.agentic_tools` doesn't accumulate empty objects.
   */
  async deleteToolConfigField<T extends AgenticToolName>(
    userId: string,
    tool: T,
    field: keyof NonNullable<AgenticToolsConfig[T]> & string
  ): Promise<void> {
    const fullId = await this.resolveId(userId);
    const row = await this.getRawRow(fullId);

    if (!row) {
      throw new EntityNotFoundError('User', userId);
    }

    const stored = (row.data.agentic_tools as StoredAgenticTools | undefined) ?? {};
    const toolFields = { ...(stored[tool] ?? {}) } as Record<string, string>;
    delete toolFields[field];

    const next: StoredAgenticTools = { ...stored };
    if (Object.keys(toolFields).length > 0) {
      next[tool] = toolFields;
    } else {
      delete next[tool];
    }

    // Patch only agentic_tools — see setToolConfigField for rationale.
    await update(this.db, users)
      .set({
        data: { ...row.data, agentic_tools: next },
        updated_at: new Date(),
      })
      .where(eq(users.user_id, fullId))
      .run();
  }
}
