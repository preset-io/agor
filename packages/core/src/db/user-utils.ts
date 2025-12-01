/**
 * User utility functions
 *
 * Shared logic for creating and managing users without requiring daemon.
 */

import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { generateId } from '../lib/ids';
import type { User, UserID } from '../types';
import type { Database } from './client';
import { insert, select } from './database-wrapper';
import { users } from './schema';

/**
 * Create user input
 */
export interface CreateUserData {
  email: string;
  password: string;
  name?: string;
  role?: 'owner' | 'admin' | 'member' | 'viewer';
  unix_username?: string;
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
  const defaultEmoji = role === 'admin' ? '⭐' : '👤';

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
      // biome-ignore lint/suspicious/noExplicitAny: Database wrapper accepts Date but schema types vary by dialect
      created_at: createdAt as any,
      // biome-ignore lint/suspicious/noExplicitAny: Database wrapper accepts Date but schema types vary by dialect
      updated_at: updatedAt as any,
      data: {
        preferences: {},
      },
    })
    .returning()
    .one();

  // Convert to User type
  const userData = row.data as { avatar?: string; preferences?: Record<string, unknown> };

  return {
    user_id: row.user_id as UserID,
    email: row.email,
    name: row.name ?? undefined,
    emoji: row.emoji ?? undefined,
    role: row.role as 'owner' | 'admin' | 'member' | 'viewer',
    unix_username: row.unix_username ?? undefined,
    avatar: userData.avatar,
    preferences: userData.preferences,
    onboarding_completed: !!row.onboarding_completed,
    created_at: row.created_at,
    updated_at: row.updated_at ?? undefined,
  };
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

  if (!row) {
    return null;
  }

  const userData = row.data as { avatar?: string; preferences?: Record<string, unknown> };

  return {
    user_id: row.user_id as UserID,
    email: row.email,
    name: row.name ?? undefined,
    emoji: row.emoji ?? undefined,
    role: row.role as 'owner' | 'admin' | 'member' | 'viewer',
    unix_username: row.unix_username ?? undefined,
    avatar: userData.avatar,
    preferences: userData.preferences,
    onboarding_completed: !!row.onboarding_completed,
    created_at: row.created_at,
    updated_at: row.updated_at ?? undefined,
  };
}

/**
 * Default admin user credentials
 * Used by both init and user create-admin commands
 */
export const DEFAULT_ADMIN_USER = {
  email: 'admin@agor.live',
  password: 'admin',
  name: 'Admin',
  role: 'admin' as const,
};

/**
 * Create default admin user (admin@agor.live / admin)
 *
 * This is a convenience function for creating the default admin user
 * with hardcoded credentials. Use createUser() if you need custom credentials.
 *
 * @param db - Database instance
 * @returns Created user
 * @throws Error if admin user already exists
 */
export async function createDefaultAdminUser(db: Database): Promise<User> {
  // Check if admin user already exists
  const existing = await getUserByEmail(db, DEFAULT_ADMIN_USER.email);

  if (existing) {
    throw new Error(`Admin user already exists (email: ${DEFAULT_ADMIN_USER.email})`);
  }

  return createUser(db, DEFAULT_ADMIN_USER);
}
