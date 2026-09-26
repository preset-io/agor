/**
 * User API Keys Repository
 *
 * Type-safe CRUD operations for user API keys with bcrypt hashing.
 * Raw keys are returned only at creation time and never stored.
 */

import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { and, eq, ne } from 'drizzle-orm';
import { generateId } from '../../lib/ids';
import {
  isUserApiKeySource,
  PERSONAL_API_KEY_PREFIX,
  type UserApiKeySource,
} from '../../types/user-api-key';
import type { Database } from '../client';
import { deleteFrom, insert, select, update } from '../database-wrapper';
import { userApiKeys } from '../schema';
import { enqueueTenantDatabasePostCommitCallback } from '../tenant-context';

const KEY_PREFIX = PERSONAL_API_KEY_PREFIX;
const KEY_PREFIX_LENGTH = 12;
const KEY_RANDOM_BYTES = 32;
const BCRYPT_ROUNDS = 10;

function toSource(value: unknown): UserApiKeySource {
  return isUserApiKeySource(value) ? value : 'manual';
}

export interface UserApiKeyRow {
  id: string;
  user_id: string;
  name: string;
  prefix: string;
  key_hash: string;
  source?: string;
  created_at: number | Date;
  last_used_at: number | Date | null;
}

export interface UserApiKeyPublic {
  id: string;
  name: string;
  prefix: string;
  source: UserApiKeySource;
  created_at: Date;
  last_used_at?: Date;
}

export class UserApiKeysRepository {
  constructor(private db: Database) {}

  /** Generate a new API key and return { rawKey, id, prefix, keyHash } */
  async generateKey(): Promise<{
    rawKey: string;
    id: string;
    prefix: string;
    keyHash: string;
  }> {
    const id = generateId();
    const randomPart = randomBytes(KEY_RANDOM_BYTES).toString('base64url');
    const rawKey = `${KEY_PREFIX}${randomPart}`;
    const prefix = rawKey.substring(0, KEY_PREFIX_LENGTH);
    const keyHash = await bcrypt.hash(rawKey, BCRYPT_ROUNDS);
    return { rawKey, id, prefix, keyHash };
  }

  /** Create a new API key for a user. Returns the raw key (shown once) + metadata. */
  async create(
    userId: string,
    name: string,
    source: UserApiKeySource = 'manual'
  ): Promise<{ rawKey: string; key: UserApiKeyPublic }> {
    const { rawKey, id, prefix, keyHash } = await this.generateKey();
    const now = new Date();
    await insert(this.db, userApiKeys)
      .values({
        id,
        user_id: userId,
        name,
        prefix,
        key_hash: keyHash,
        source,
        created_at: now,
      })
      .run();
    return {
      rawKey,
      key: { id, name, prefix, source, created_at: now },
    };
  }

  /**
   * Remove a user's `cli_login` keys with exactly this machine name that are
   * OLDER than `keepId`. Used when `agor login` runs again on the same machine
   * so each machine has one CLI key. Never touches manual keys.
   *
   * Only strictly older keys are removed (ids are time-ordered UUIDv7s,
   * compared bytewise here rather than by database collation), so two
   * overlapping logins for the same machine can never delete each other's key:
   * the newer one survives.
   */
  async deleteReplacedCliKeys(userId: string, name: string, keepId: string): Promise<number> {
    const candidates = await select(this.db, { id: userApiKeys.id })
      .from(userApiKeys)
      .where(
        and(
          eq(userApiKeys.user_id, userId),
          eq(userApiKeys.name, name),
          eq(userApiKeys.source, 'cli_login'),
          ne(userApiKeys.id, keepId)
        )
      )
      .all();
    const replaced = (candidates as Array<{ id: string }>).filter((row) => row.id < keepId);
    for (const row of replaced) {
      await this.delete(row.id, userId);
    }
    return replaced.length;
  }

  /** List all API keys for a user (never returns hashes) */
  async listByUser(userId: string): Promise<UserApiKeyPublic[]> {
    const rows = await select(this.db)
      .from(userApiKeys)
      .where(eq(userApiKeys.user_id, userId))
      .all();
    return rows.map((r: typeof userApiKeys.$inferSelect) => ({
      id: r.id,
      name: r.name,
      prefix: r.prefix,
      source: toSource(r.source),
      created_at: new Date(r.created_at),
      last_used_at: r.last_used_at ? new Date(r.last_used_at) : undefined,
    }));
  }

  /** Find a key by prefix (for auth lookup). Returns rows with hash for verification. */
  async findByPrefix(prefix: string): Promise<UserApiKeyRow[]> {
    return select(this.db).from(userApiKeys).where(eq(userApiKeys.prefix, prefix)).all();
  }

  /** Verify a raw API key against stored hashes. Returns the matching row or null. */
  async verifyKey(rawKey: string): Promise<UserApiKeyRow | null> {
    const prefix = rawKey.substring(0, KEY_PREFIX_LENGTH);
    const candidates = await this.findByPrefix(prefix);
    for (const candidate of candidates) {
      if (await bcrypt.compare(rawKey, candidate.key_hash)) {
        return candidate;
      }
    }
    return null;
  }

  /** Update last_used_at timestamp.
   *
   * In Postgres tenant-scoped requests, the ambient database handle points at the
   * request transaction. Updating the API-key row inside that transaction can
   * hold a row lock for the full duration of slow downstream work (for example
   * leaderboard analytics scans). If a transaction is active, defer this
   * best-effort write until after commit and perform the actual UPDATE directly
   * so it cannot re-enqueue itself.
   */
  async updateLastUsed(id: string): Promise<void> {
    if (enqueueTenantDatabasePostCommitCallback(() => this.updateLastUsedNow(id))) {
      return;
    }

    await this.updateLastUsedNow(id);
  }

  private async updateLastUsedNow(id: string): Promise<void> {
    await update(this.db, userApiKeys)
      .set({ last_used_at: new Date() })
      .where(eq(userApiKeys.id, id))
      .run();
  }

  /** Update key name */
  async updateName(id: string, userId: string, name: string): Promise<void> {
    await update(this.db, userApiKeys)
      .set({ name })
      .where(and(eq(userApiKeys.id, id), eq(userApiKeys.user_id, userId)))
      .run();
  }

  /** Delete a key */
  async delete(id: string, userId: string): Promise<void> {
    await deleteFrom(this.db, userApiKeys)
      .where(and(eq(userApiKeys.id, id), eq(userApiKeys.user_id, userId)))
      .run();
  }

  /** Delete all keys for a user */
  async deleteAllForUser(userId: string): Promise<void> {
    await deleteFrom(this.db, userApiKeys).where(eq(userApiKeys.user_id, userId)).run();
  }
}
