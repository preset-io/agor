/**
 * User utility functions
 *
 * Shared logic for creating and managing users without requiring daemon.
 */

import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { generateId } from '../lib/ids';
import type { InternalUser, User, UserID } from '../types';
import { normalizeRole } from '../types/user';
import type { Database } from './client';
import { insert, select } from './database-wrapper';
import { type UserRow, users } from './schema';

/**
 * Create user input
 */
export interface CreateUserData {
  email: string;
  password: string;
  name?: string;
  role?: 'superadmin' | 'admin' | 'member' | 'viewer';
  unix_username?: string;
  /**
   * Force the user to change their password on first login. Set this for
   * any user whose initial password was generated/printed (e.g. the
   * first-run bootstrap admin) so the cleartext doesn't stay valid.
   */
  must_change_password?: boolean;
}

/**
 * Convert a raw `users` row into the canonical `User` model. Centralized so
 * all callers agree on field handling — JSON-bag fields (avatar, preferences)
 * come from `row.data`, role goes through `normalizeRole`, and nullable DB
 * columns become `undefined` rather than `null`.
 */
export function userRowToUser(row: UserRow): InternalUser {
  const userData = (row.data ?? {}) as {
    avatar_url?: string;
    avatar?: string;
    avatar_source?: string;
    avatar_source_id?: string;
    avatar_synced_at?: string;
    preferences?: Record<string, unknown>;
  };
  return {
    user_id: row.user_id as UserID,
    email: row.email,
    name: row.name ?? undefined,
    emoji: row.emoji ?? undefined,
    role: normalizeRole(row.role ?? undefined),
    unix_username: row.unix_username ?? undefined,
    avatar_url: userData.avatar_url ?? userData.avatar,
    avatar: userData.avatar,
    avatar_source: userData.avatar_source,
    avatar_source_id: userData.avatar_source_id,
    avatar_synced_at: userData.avatar_synced_at,
    preferences: userData.preferences,
    onboarding_completed: !!row.onboarding_completed,
    must_change_password: !!row.must_change_password,
    tokens_valid_after: row.tokens_valid_after ? new Date(row.tokens_valid_after) : undefined,
    created_at: row.created_at,
    updated_at: row.updated_at ?? undefined,
  };
}

/**
 * Create a new user directly in the database
 *
 * This is a standalone utility that can be used by both CLI and daemon.
 * It doesn't require the daemon to be running.
 *
 * @param db - Database instance
 * @param data - User data
 * @returns Created user
 */
export async function createUser(db: Database, data: CreateUserData): Promise<User> {
  // Check if email already exists
  const existing = await select(db).from(users).where(eq(users.email, data.email)).one();

  if (existing) {
    throw new Error(`User with email ${data.email} already exists`);
  }

  // Hash password (12 rounds for security)
  const hashedPassword = await bcrypt.hash(data.password, 12);

  // Create user
  const now = new Date();
  const user_id = generateId() as UserID;

  const role = data.role || 'member';
  const defaultEmoji = role === 'superadmin' || role === 'admin' ? '⭐' : '👤';

  // For PostgreSQL, we need to use ISO strings for timestamps
  // For SQLite, Date objects work because of timestamp_ms mode
  const createdAt = now;
  const updatedAt = now;

  const row = await insert(db, users)
    .values({
      user_id,
      email: data.email,
      password: hashedPassword,
      name: data.name,
      emoji: defaultEmoji,
      role,
      unix_username: data.unix_username ?? null,
      must_change_password: data.must_change_password ?? false,
      created_at: createdAt,
      updated_at: updatedAt,
      data: {
        preferences: {},
      },
    })
    .returning()
    .one();

  return userRowToUser(row);
}

/**
 * Check if a user with the given email exists
 *
 * @param db - Database instance
 * @param email - Email to check
 * @returns True if user exists
 */
export async function userExists(db: Database, email: string): Promise<boolean> {
  const existing = await select(db).from(users).where(eq(users.email, email)).one();
  return !!existing;
}

/**
 * Get user by email
 *
 * @param db - Database instance
 * @param email - Email to look up
 * @returns User or null if not found
 */
export async function getUserByEmail(db: Database, email: string): Promise<User | null> {
  const row = await select(db).from(users).where(eq(users.email, email)).one();
  return row ? userRowToUser(row) : null;
}

/**
 * Development-only admin user credentials.
 *
 * Never use this in production/bootstrap paths. Production first-run setup
 * should use an operator-provided password or a generated one-time credential
 * file (see first-run-bootstrap / daemon setup).
 */
export const DEVELOPMENT_DEFAULT_ADMIN_USER = {
  email: 'admin@agor.live',
  password: 'admin',
  name: 'Admin',
  role: 'superadmin' as const,
  unix_username: 'admin',
};

export const MIN_BOOTSTRAP_ADMIN_PASSWORD_LENGTH = 8;

export function assertUsableBootstrapAdminPassword(
  password: string,
  label: string = 'Bootstrap admin password'
): void {
  if (password === DEVELOPMENT_DEFAULT_ADMIN_USER.password) {
    throw new Error(`${label} must not be the legacy fixed default password.`);
  }
  if (password.length < MIN_BOOTSTRAP_ADMIN_PASSWORD_LENGTH) {
    throw new Error(`${label} must be at least ${MIN_BOOTSTRAP_ADMIN_PASSWORD_LENGTH} characters.`);
  }
}

export interface CreateDefaultAdminUserOptions {
  email?: string;
  password?: string;
  name?: string;
  unix_username?: string;
  /**
   * Explicitly opt into the legacy admin@agor.live/admin credential for
   * development/test ergonomics. Refused when NODE_ENV=production.
   */
  allowDevelopmentDefault?: boolean;
}

/**
 * Create bootstrap admin user.
 *
 * Production callers must pass an explicit password. The fixed
 * admin@agor.live/admin credential is available only behind an explicit
 * development/test gate.
 *
 * @param db - Database instance
 * @param options - Admin identity/password options
 * @returns Created user
 * @throws Error if admin user already exists
 */
export async function createDefaultAdminUser(
  db: Database,
  options: CreateDefaultAdminUserOptions = {}
): Promise<User> {
  const useDevelopmentDefault = options.allowDevelopmentDefault === true;
  if (!options.password && !useDevelopmentDefault) {
    throw new Error(
      'Refusing to create admin with fixed default credentials. Pass an explicit password, or set allowDevelopmentDefault only in development/test.'
    );
  }
  if (options.password && !useDevelopmentDefault) {
    assertUsableBootstrapAdminPassword(options.password);
  }
  if (useDevelopmentDefault && process.env.NODE_ENV === 'production') {
    throw new Error('Refusing development default admin credentials when NODE_ENV=production');
  }

  const adminData = {
    ...DEVELOPMENT_DEFAULT_ADMIN_USER,
    ...options,
    password: options.password ?? DEVELOPMENT_DEFAULT_ADMIN_USER.password,
    role: 'superadmin' as const,
  };

  // Check if admin user already exists
  const existing = await getUserByEmail(db, adminData.email);

  if (existing) {
    throw new Error(`Admin user already exists (email: ${adminData.email})`);
  }

  return createUser(db, {
    email: adminData.email,
    password: adminData.password,
    name: adminData.name,
    role: adminData.role,
    unix_username: adminData.unix_username,
    must_change_password: !useDevelopmentDefault,
  });
}
