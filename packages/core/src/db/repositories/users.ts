/**
 * Users Repository
 *
 * Type-safe CRUD operations for users with encrypted API key management.
 */

import type { User, UUID } from '@agor/core/types';
import { eq, like } from 'drizzle-orm';
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
   * Convert database row to User type
   * Note: Converts encrypted API keys (strings) to boolean flags for API exposure
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
      avatar: row.data.avatar,
      preferences: row.data.preferences as User['preferences'],
      // Convert encrypted keys to boolean flags (true = key exists, false/undefined = no key)
      api_keys: row.data.api_keys
        ? {
            ANTHROPIC_API_KEY: !!row.data.api_keys.ANTHROPIC_API_KEY,
            OPENAI_API_KEY: !!row.data.api_keys.OPENAI_API_KEY,
            GEMINI_API_KEY: !!row.data.api_keys.GEMINI_API_KEY,
          }
        : undefined,
      // Convert encrypted env vars to boolean flags
      env_vars: row.data.env_vars
        ? (Object.fromEntries(
            Object.entries(row.data.env_vars).map(([k, v]) => [k, !!v])
          ) as Record<string, boolean>)
        : undefined,
      default_agentic_config: row.data.default_agentic_config as User['default_agentic_config'],
    };
  }

  /**
   * Convert User to database insert format
   * For updates, this accepts the current user data from the database row
   */
  private userToInsert(
    user: Partial<User> & { password?: string; api_keys_raw?: Record<string, string> }
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
        // Use raw API keys if provided (for internal operations like setApiKey)
        api_keys: user.api_keys_raw,
        env_vars: undefined, // Not implemented yet
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

    // Merge updates
    const merged = { ...current, ...updates };
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
   * Get decrypted API key for a user and service
   *
   * @param userId - User ID
   * @param service - Service name ('anthropic', 'openai', 'gemini')
   * @returns Decrypted API key or null if not found
   */
  async getApiKey(
    userId: string,
    service: 'anthropic' | 'openai' | 'gemini'
  ): Promise<string | null> {
    const row = await this.getRawRow(userId);
    if (!row || !row.data.api_keys) {
      return null;
    }

    // Map service name to env var name
    const keyMap = {
      anthropic: 'ANTHROPIC_API_KEY',
      openai: 'OPENAI_API_KEY',
      gemini: 'GEMINI_API_KEY',
    } as const;

    const encryptedKey = row.data.api_keys[keyMap[service]];
    if (!encryptedKey) {
      return null;
    }

    // Decrypt the API key
    try {
      return decryptApiKey(encryptedKey);
    } catch (error) {
      throw new RepositoryError(`Failed to decrypt API key for service ${service}`, error);
    }
  }

  /**
   * Set encrypted API key for a user and service
   *
   * @param userId - User ID
   * @param service - Service name ('anthropic', 'openai', 'gemini')
   * @param apiKey - Plaintext API key to encrypt and store
   */
  async setApiKey(
    userId: string,
    service: 'anthropic' | 'openai' | 'gemini',
    apiKey: string
  ): Promise<void> {
    const fullId = await this.resolveId(userId);
    const row = await this.getRawRow(fullId);

    if (!row) {
      throw new EntityNotFoundError('User', userId);
    }

    // Map service name to env var name
    const keyMap = {
      anthropic: 'ANTHROPIC_API_KEY',
      openai: 'OPENAI_API_KEY',
      gemini: 'GEMINI_API_KEY',
    } as const;

    // Encrypt the API key
    const encryptedKey = encryptApiKey(apiKey);

    // Update user's api_keys in database
    const updatedApiKeys = {
      ...(row.data.api_keys || {}),
      [keyMap[service]]: encryptedKey,
    };

    // Build update object with raw encrypted keys
    const user = this.rowToUser(row);
    const updateData = {
      ...user,
      api_keys_raw: updatedApiKeys,
    };

    const insertData = this.userToInsert(updateData);

    await update(this.db, users)
      .set({
        ...insertData,
        updated_at: new Date(),
      })
      .where(eq(users.user_id, fullId))
      .run();
  }

  /**
   * Delete API key for a user and service
   *
   * @param userId - User ID
   * @param service - Service name ('anthropic', 'openai', 'gemini')
   */
  async deleteApiKey(userId: string, service: 'anthropic' | 'openai' | 'gemini'): Promise<void> {
    const fullId = await this.resolveId(userId);
    const row = await this.getRawRow(fullId);

    if (!row) {
      throw new EntityNotFoundError('User', userId);
    }

    // Map service name to env var name
    const keyMap = {
      anthropic: 'ANTHROPIC_API_KEY',
      openai: 'OPENAI_API_KEY',
      gemini: 'GEMINI_API_KEY',
    } as const;

    // Remove the key
    const updatedApiKeys = { ...(row.data.api_keys || {}) };
    delete updatedApiKeys[keyMap[service]];

    // Build update object with raw encrypted keys
    const user = this.rowToUser(row);
    const updateData = {
      ...user,
      api_keys_raw: updatedApiKeys,
    };

    const insertData = this.userToInsert(updateData);

    await update(this.db, users)
      .set({
        ...insertData,
        updated_at: new Date(),
      })
      .where(eq(users.user_id, fullId))
      .run();
  }
}
