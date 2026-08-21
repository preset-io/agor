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
  InternalUser,
  StoredAgenticTools,
  User,
  UserID,
  UUID,
} from '@agor/core/types';
import { toAgenticToolsStatus } from '@agor/core/types';
import { eq, like, sql } from 'drizzle-orm';
import { normalizeStoredEnvMap, type RawStoredEnvVar } from '../../config/env-vars';
import { generateId, shortId } from '../../lib/ids';
import { isValidExecutionHomeKey } from '../../types/user';
import type { Database } from '../client';
import { deleteFrom, insert, lockRowForUpdate, select, update } from '../database-wrapper';
import { decryptApiKey, encryptApiKey } from '../encryption';
import { type UserInsert as SchemaUserInsert, type UserRow, users } from '../schema';
import { isExecutionHomeKeyAvailable } from '../user-execution-home';
import {
  type BaseRepository,
  EntityNotFoundError,
  RESOLVE_SHORT_ID_FETCH_LIMIT,
  RepositoryError,
  resolveByShortIdPrefix,
} from './base';

/**
 * Users repository implementation
 *
 * Security boundary: this is a persistence primitive for trusted bootstrap,
 * external-identity provisioning, and background jobs. It intentionally has
 * no actor context. Request-driven REST, Socket.IO, MCP, and CLI mutations must
 * go through the daemon UsersService, which enforces actor/target role
 * authority before calling the database.
 */
const USER_DATA_UPDATE_FIELDS = [
  'avatar_url',
  'avatar',
  'avatar_source',
  'avatar_source_id',
  'avatar_synced_at',
  'preferences',
  'agentic_auth_methods',
  'default_agentic_config',
  'primary_agentic_tool',
  'primary_teammate_id',
  'default_agentic_selection',
  'default_mcp_server_ids',
] as const satisfies ReadonlyArray<keyof User>;

type UsersRepositoryMutableField =
  | 'email'
  | 'name'
  | 'emoji'
  | 'role'
  | 'unix_username'
  | 'filesystem_home'
  | 'onboarding_completed'
  | 'must_change_password'
  | (typeof USER_DATA_UPDATE_FIELDS)[number];

/** Explicit credential-free input accepted when creating a persistence projection. */
export type UsersRepositoryCreate = Pick<User, 'email'> &
  Partial<Pick<User, 'user_id' | 'created_at' | 'updated_at' | UsersRepositoryMutableField>>;

/** Fields the generic persistence boundary can actually mutate. */
export type UsersRepositoryUpdate = Partial<Pick<User, UsersRepositoryMutableField>>;

export class UsersRepository
  implements BaseRepository<InternalUser, UsersRepositoryCreate, UsersRepositoryUpdate>
{
  constructor(private db: Database) {}

  private async readDiscoveryAuthorityProjection(
    userId: UserID | string,
    lock: boolean
  ): Promise<{ user_id: UserID; role: string; updated_at: Date } | null> {
    const where = eq(users.user_id, userId);
    if (lock) await lockRowForUpdate(this.db, this.db, users, where);
    const row = await select(this.db, {
      user_id: users.user_id,
      role: users.role,
      updated_at: users.updated_at,
      created_at: users.created_at,
    })
      .from(users)
      .where(where)
      .one();
    return row
      ? {
          user_id: row.user_id as UserID,
          role: row.role,
          updated_at: new Date(row.updated_at ?? row.created_at),
        }
      : null;
  }

  /** Nonsecret role/version snapshot captured before an outbound MCP probe. */
  async getDiscoveryAuthorityProjection(
    userId: UserID | string
  ): Promise<{ user_id: UserID; role: string; updated_at: Date } | null> {
    try {
      return await this.readDiscoveryAuthorityProjection(userId, false);
    } catch (error) {
      throw new RepositoryError(
        `Failed to read user discovery authority: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /** Transactional counterpart used immediately before capability persistence. */
  async getDiscoveryAuthorityProjectionForUpdate(
    userId: UserID | string
  ): Promise<{ user_id: UserID; role: string; updated_at: Date } | null> {
    try {
      return await this.readDiscoveryAuthorityProjection(userId, true);
    } catch (error) {
      throw new RepositoryError(
        `Failed to lock user discovery authority: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Explicit nonsecret principal projection for user-targeted invalidations.
   * Tenant scoping is supplied by the repository's current database unit of
   * work; callers never need to hydrate user preferences or credentials merely
   * to name a realtime room.
   */
  async listUserIds(): Promise<UserID[]> {
    try {
      const rows = await select(this.db, { user_id: users.user_id }).from(users).all();
      return rows.map((row: { user_id: string }) => row.user_id as UserID);
    } catch (error) {
      throw new RepositoryError(
        `Failed to list user IDs: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Lock and reload only the caller identity fields used by a write
   * authorizer. Role changes use the same users row, so a concurrent demotion
   * is ordered either before this read (and is observed) or after the guarded
   * mutation commits.
   */
  async getWriteAuthorityProjectionForUpdate(
    userId: UserID | string
  ): Promise<{ user_id: UserID; role: string } | null> {
    try {
      const where = eq(users.user_id, userId);
      await lockRowForUpdate(this.db, this.db, users, where);
      const row = await select(this.db, { user_id: users.user_id, role: users.role })
        .from(users)
        .where(where)
        .one();
      return row ? { user_id: row.user_id as UserID, role: row.role } : null;
    } catch (error) {
      throw new RepositoryError(
        `Failed to read user write authority: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Convert database row to User type.
   * Converts the encrypted `agentic_tools` blob to a boolean presence DTO so
   * decrypted credentials never leave this repository.
   */
  private rowToUser(row: UserRow): InternalUser {
    const legacyDefaultMcpServerIds = Object.values(
      (row.data.default_agentic_config ?? {}) as Record<string, { mcpServerIds?: unknown }>
    ).flatMap((config) =>
      Array.isArray(config?.mcpServerIds)
        ? config.mcpServerIds.filter((id): id is string => typeof id === 'string')
        : []
    );
    return {
      user_id: row.user_id as UUID,
      created_at: new Date(row.created_at),
      updated_at: row.updated_at ? new Date(row.updated_at) : undefined,
      email: row.email,
      name: row.name ?? undefined,
      emoji: row.emoji ?? undefined,
      role: row.role,
      unix_username: row.unix_username ?? undefined,
      filesystem_home: row.filesystem_home ?? undefined,
      onboarding_completed: row.onboarding_completed,
      must_change_password: row.must_change_password,
      credential_generation: row.credential_generation,
      tokens_valid_after: row.tokens_valid_after ? new Date(row.tokens_valid_after) : undefined,
      avatar_url: row.data.avatar_url ?? row.data.avatar,
      avatar: row.data.avatar,
      avatar_source: row.data.avatar_source,
      avatar_source_id: row.data.avatar_source_id,
      avatar_synced_at: row.data.avatar_synced_at,
      preferences: row.data.preferences as User['preferences'],
      // Convert encrypted per-tool credential blobs into boolean presence flags.
      agentic_tools: toAgenticToolsStatus(row.data.agentic_tools as StoredAgenticTools | undefined),
      agentic_auth_methods: row.data.agentic_auth_methods,
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
      primary_agentic_tool: row.data.primary_agentic_tool,
      primary_teammate_id: row.data.primary_teammate_id,
      default_agentic_selection: row.data.default_agentic_selection,
      default_mcp_server_ids: row.data.default_mcp_server_ids ?? [
        ...new Set(legacyDefaultMcpServerIds),
      ],
    };
  }

  /**
   * Convert User to database insert format
   * For updates, this accepts the current user data from the database row
   */
  private userToInsert(
    user: Partial<InternalUser> & {
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
      // Repository-created projections/background fixtures intentionally have
      // no usable local credential. Password assignment must go through
      // createUser or the daemon UsersService.
      password: '',
      name: user.name ?? null,
      emoji: user.emoji ?? null,
      role: user.role ?? 'member',
      unix_username: user.unix_username ?? null,
      filesystem_home: user.filesystem_home ?? null,
      onboarding_completed: user.onboarding_completed ?? false,
      must_change_password: user.must_change_password ?? false,
      credential_generation: user.credential_generation ?? 0,
      tokens_valid_after: user.tokens_valid_after ? new Date(user.tokens_valid_after) : null,
      data: {
        avatar_url: user.avatar_url,
        avatar: user.avatar,
        avatar_source: user.avatar_source,
        avatar_source_id: user.avatar_source_id,
        avatar_synced_at: user.avatar_synced_at,
        preferences: user.preferences,
        // Encrypted per-tool credentials. Only forwarded when caller passes the
        // raw shape (internal credential mutators); regular updates leave it undefined,
        // letting the merge in `update()` reuse the existing on-disk blob.
        // Cast: schema declares `opencode: Record<string, never>` (no fields by
        // contract); StoredAgenticTools widens that to string values for shape
        // uniformity. Runtime never writes opencode, so the cast is safe.
        agentic_tools: user.agentic_tools_raw as SchemaUserInsert['data']['agentic_tools'],
        agentic_auth_methods: user.agentic_auth_methods,
        // Same pass-through as agentic_tools: env_vars are encrypted blobs
        // not represented on the public DTO. `update()` threads the raw value
        // from the existing row so a generic field update doesn't wipe them.
        env_vars: user.env_vars_raw,
        default_agentic_config: user.default_agentic_config,
        primary_agentic_tool: user.primary_agentic_tool,
        primary_teammate_id: user.primary_teammate_id,
        default_agentic_selection: user.default_agentic_selection,
        default_mcp_server_ids: user.default_mcp_server_ids,
      },
    };
  }

  /**
   * Resolve short ID to full ID via the centralized helper.
   */
  private async resolveId(id: string): Promise<string> {
    return resolveByShortIdPrefix(id, 'User', async (pattern) => {
      const rows = await select(this.db, { user_id: users.user_id })
        .from(users)
        .where(like(users.user_id, pattern))
        .limit(RESOLVE_SHORT_ID_FETCH_LIMIT)
        .all();
      return rows.map((r: UserRow) => r.user_id);
    });
  }

  /**
   * Create a new user
   */
  async create(data: UsersRepositoryCreate): Promise<InternalUser> {
    if (
      Object.hasOwn(data as object, 'password') ||
      Object.hasOwn(data as object, 'password_hash') ||
      Object.hasOwn(data as object, 'passwordHash') ||
      Object.hasOwn(data as object, 'credential_generation') ||
      Object.hasOwn(data as object, 'tokens_valid_after')
    ) {
      throw new RepositoryError(
        'UsersRepository does not accept password credential fields; use an authoritative password-write service'
      );
    }
    if (data.unix_username !== undefined && !isValidExecutionHomeKey(data.unix_username)) {
      throw new RepositoryError('Invalid execution home key format');
    }
    // Validate unix_username uniqueness if provided
    if (data.unix_username) {
      if (!(await isExecutionHomeKeyAvailable(this.db, data.unix_username))) {
        throw new RepositoryError(
          `Execution home key "${data.unix_username}" is already in use by another user`
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
  async findById(id: string): Promise<InternalUser | null> {
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
  async findByEmail(email: string): Promise<InternalUser | null> {
    const result = await select(this.db).from(users).where(eq(users.email, email)).one();

    if (!result) {
      return null;
    }

    return this.rowToUser(result as UserRow);
  }

  /**
   * Find user by email for external identity providers.
   *
   * Agor intentionally keeps exact/case-sensitive email lookup semantics for
   * auth paths because the schema historically allowed case-distinct emails.
   * External providers such as Slack and GitHub treat email addresses as a
   * canonical identity hint, so their alignment path needs a case-insensitive
   * match. Prefer an exact match when present; otherwise return a
   * case-insensitive match only when it is unambiguous.
   */
  async findByEmailForAlignment(email: string): Promise<InternalUser | null> {
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail) return null;

    const exact = await this.findByEmail(normalizedEmail);
    if (exact) return exact;

    const results = await select(this.db)
      .from(users)
      .where(sql`LOWER(${users.email}) = ${normalizedEmail}`)
      .all();

    if (results.length !== 1) {
      if (results.length > 1) {
        console.warn(
          `[users] Ambiguous case-insensitive email alignment for ${normalizedEmail}: ${results
            .map((row: unknown) => {
              const userRow = row as UserRow;
              return `${shortId(userRow.user_id)}:${userRow.email}`;
            })
            .join(', ')}`
        );
      }
      return null;
    }

    return this.rowToUser(results[0] as UserRow);
  }

  /**
   * Find all users
   */
  async findAll(): Promise<InternalUser[]> {
    const results = await select(this.db).from(users).all();

    return results.map((row: UserRow) => this.rowToUser(row));
  }

  /**
   * Update user by ID
   */
  async update(id: string, updates: UsersRepositoryUpdate): Promise<InternalUser> {
    if (
      Object.hasOwn(updates as object, 'password') ||
      Object.hasOwn(updates as object, 'password_hash') ||
      Object.hasOwn(updates as object, 'passwordHash') ||
      Object.hasOwn(updates as object, 'credential_generation') ||
      Object.hasOwn(updates as object, 'tokens_valid_after')
    ) {
      throw new RepositoryError(
        'UsersRepository cannot update password credential fields; use an authoritative password-write service'
      );
    }
    const fullId = await this.resolveId(id);

    // Get current user
    const current = await this.findById(fullId);
    if (!current) {
      throw new EntityNotFoundError('User', id);
    }

    if (updates.unix_username !== undefined && !isValidExecutionHomeKey(updates.unix_username)) {
      throw new RepositoryError('Invalid execution home key format');
    }

    // Validate unix_username uniqueness if being changed
    if (updates.unix_username && updates.unix_username !== current.unix_username) {
      if (!(await isExecutionHomeKeyAvailable(this.db, updates.unix_username, fullId))) {
        throw new RepositoryError(
          `Execution home key "${updates.unix_username}" is already in use by another user`
        );
      }
    }

    const rawRow = await this.getRawRow(fullId);
    if (!rawRow) {
      throw new EntityNotFoundError('User', id);
    }
    const insertData = this.userToInsert({ ...current, ...updates });

    // This explicit allowlist is also a concurrency boundary. Generic profile
    // updates write only fields the caller actually supplied. They must never
    // round-trip password authority or unrelated profile fields from the stale
    // snapshot above. JSON updates merge into the latest raw blob so opaque
    // keys (external identities and forward-compatible data) also survive.
    const mutableUserData: Partial<SchemaUserInsert> = {};
    if (Object.hasOwn(updates, 'email')) mutableUserData.email = insertData.email;
    if (Object.hasOwn(updates, 'name')) mutableUserData.name = insertData.name;
    if (Object.hasOwn(updates, 'emoji')) mutableUserData.emoji = insertData.emoji;
    if (Object.hasOwn(updates, 'role')) mutableUserData.role = insertData.role;
    if (Object.hasOwn(updates, 'unix_username')) {
      mutableUserData.unix_username = insertData.unix_username;
    }
    if (Object.hasOwn(updates, 'filesystem_home')) {
      mutableUserData.filesystem_home = insertData.filesystem_home;
    }
    if (Object.hasOwn(updates, 'onboarding_completed')) {
      mutableUserData.onboarding_completed = insertData.onboarding_completed;
    }
    if (Object.hasOwn(updates, 'must_change_password')) {
      mutableUserData.must_change_password = insertData.must_change_password;
    }

    let dataChanged = false;
    const nextData = { ...rawRow.data } as Record<string, unknown>;
    for (const field of USER_DATA_UPDATE_FIELDS) {
      if (!Object.hasOwn(updates, field)) continue;
      dataChanged = true;
      const value = updates[field];
      if (value === undefined) delete nextData[field];
      else nextData[field] = value;
    }
    if (dataChanged) {
      mutableUserData.data = nextData as SchemaUserInsert['data'];
    }

    // Update database
    await update(this.db, users)
      .set({
        ...mutableUserData,
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
          `[users] Failed to decrypt ${tool}.${field} for user ${shortId(userId)}: ${
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
        `[users] Failed to decrypt ${tool}.${field} for user ${shortId(userId)}: ${
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
