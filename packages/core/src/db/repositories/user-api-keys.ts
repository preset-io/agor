/**
 * User API Keys Repository
 *
 * Type-safe CRUD operations for user API keys with bcrypt hashing.
 * Raw keys are returned only at creation time and never stored.
 */

import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { and, eq } from 'drizzle-orm';
import { generateId } from '../../lib/ids';
import type { Database } from '../client';
import { deleteFrom, insert, select, update } from '../database-wrapper';
import { userApiKeys } from '../schema';

const KEY_PREFIX = 'agor_sk_';
const KEY_PREFIX_LENGTH = 12;
const KEY_RANDOM_BYTES = 32;
const BCRYPT_ROUNDS = 10;

export interface UserApiKeyRow {
  id: string;
  user_id: string;
  name: string;
  prefix: string;
  key_hash: string;
  created_at: number | Date;
  last_used_at: number | Date | null;
}

export interface UserApiKeyPublic {
  id: string;
  name: string;
  prefix: string;
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
  async create(userId: string, name: string): Promise<{ rawKey: string; key: UserApiKeyPublic }> {
    const { rawKey, id, prefix, keyHash } = await this.generateKey();
    const now = new Date();
    await insert(this.db, userApiKeys)
      .values({
        id,
        user_id: userId,
        name,
        prefix,
        key_hash: keyHash,
        created_at: now,
      })
      .run();
    return {
      rawKey,
      key: { id, name, prefix, created_at: now },
    };
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

  /** Update last_used_at timestamp */
  async updateLastUsed(id: string): Promise<void> {
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
