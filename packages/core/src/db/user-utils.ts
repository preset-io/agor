/**
 * User utility functions
 *
 * Shared logic for creating and managing users without requiring daemon.
 */

import { and, eq } from 'drizzle-orm';
import {
  assertSecurePassword,
  PasswordPolicyError,
  PasswordValidationCode,
} from '../config/password-policy';
import { generateId } from '../lib/ids';
import type { InternalUser, User, UserID } from '../types';
import { normalizeRole } from '../types/user';
import type { Database } from './client';
import { insert, isPostgresDatabase, select } from './database-wrapper';
import { hashLocalPassword } from './password-credentials';
import { type UserRow, users } from './schema';
import { getCurrentTenantId } from './tenant-scope';

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

function currentUserTenantPredicate(db: Database) {
  const tenantId = getCurrentTenantId();
  return isPostgresDatabase(db) && tenantId
    ? eq((users as never as { tenant_id: never }).tenant_id, tenantId)
    : undefined;
}

function userEmailPredicate(db: Database, email: string) {
  const tenantPredicate = currentUserTenantPredicate(db);
  const emailPredicate = eq(users.email, email);
  return tenantPredicate ? and(emailPredicate, tenantPredicate) : emailPredicate;
}

function currentTenantInsertValues(db: Database): { tenant_id?: string } {
  const tenantId = getCurrentTenantId();
  return isPostgresDatabase(db) && tenantId ? { tenant_id: String(tenantId) } : {};
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
    credential_generation: row.credential_generation,
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
async function persistUser(db: Database, data: CreateUserData): Promise<User> {
  // Check if email already exists
  const existing = await select(db).from(users).where(userEmailPredicate(db, data.email)).one();

  if (existing) {
    throw new Error(`User with email ${data.email} already exists`);
  }

  const hashedPassword = await hashLocalPassword(data.password);

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
      ...currentTenantInsertValues(db),
    })
    .returning()
    .one();

  return userRowToUser(row);
}

/**
 * Create a user with an assigned local password.
 *
 * This direct database seam is used by `agor init` and bootstrap tooling, so
 * it enforces the same canonical policy as the daemon UsersService. The only
 * weak credential exception is private to the bootstrap-specific helper below.
 */
export async function createUser(db: Database, data: CreateUserData): Promise<User> {
  assertSecurePassword(data.password, { email: data.email });
  return persistUser(db, data);
}

/**
 * Check if a user with the given email exists
 *
 * @param db - Database instance
 * @param email - Email to check
 * @returns True if user exists
 */
export async function userExists(db: Database, email: string): Promise<boolean> {
  const existing = await select(db).from(users).where(userEmailPredicate(db, email)).one();
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
  const row = await select(db).from(users).where(userEmailPredicate(db, email)).one();
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

export function assertUsableBootstrapAdminPassword(
  password: string,
  label: string = 'Bootstrap admin password'
): void {
  if (password === DEVELOPMENT_DEFAULT_ADMIN_USER.password) {
    throw new PasswordPolicyError(
      PasswordValidationCode.CONTEXT_SPECIFIC,
      `${label} must not be the legacy fixed default password.`
    );
  }
  try {
    assertSecurePassword(password, { email: DEVELOPMENT_DEFAULT_ADMIN_USER.email });
  } catch (error) {
    if (error instanceof PasswordPolicyError && error.message.startsWith('Password ')) {
      throw new PasswordPolicyError(
        error.code,
        `${label}${error.message.slice('Password'.length)}`
      );
    }
    throw error;
  }
}

export interface CreateDefaultAdminUserOptions {
  email?: string;
  password?: string;
  name?: string;
  unix_username?: string;
}

export const ALLOW_DEVELOPMENT_DEFAULT_ADMIN_ENV = 'AGOR_ALLOW_DEVELOPMENT_DEFAULT_ADMIN';

export function isDevelopmentDefaultAdminEnvironment(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return (
    (env.NODE_ENV === 'development' || env.NODE_ENV === 'test') &&
    env[ALLOW_DEVELOPMENT_DEFAULT_ADMIN_ENV] === 'true' &&
    env.AGOR_ADMIN_PASSWORD === DEVELOPMENT_DEFAULT_ADMIN_USER.password
  );
}

export function assertDevelopmentDefaultAdminEnvironment(
  env: NodeJS.ProcessEnv = process.env
): void {
  if (env.NODE_ENV !== 'development' && env.NODE_ENV !== 'test') {
    throw new Error('Development default admin requires NODE_ENV=development or NODE_ENV=test.');
  }
  if (env[ALLOW_DEVELOPMENT_DEFAULT_ADMIN_ENV] !== 'true') {
    throw new Error(`${ALLOW_DEVELOPMENT_DEFAULT_ADMIN_ENV}=true is required.`);
  }
  if (env.AGOR_ADMIN_PASSWORD !== DEVELOPMENT_DEFAULT_ADMIN_USER.password) {
    throw new Error(
      `AGOR_ADMIN_PASSWORD=${DEVELOPMENT_DEFAULT_ADMIN_USER.password} is required for the development default admin.`
    );
  }
}

/**
 * Create bootstrap admin user.
 *
 * Callers must pass an explicit secure password. The fixed development
 * credential is deliberately unavailable through this general helper; the
 * bootstrap-only `createDevelopmentDefaultAdminUser` owns that exception.
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
  if (!options.password) {
    throw new Error(
      'Refusing to create admin with fixed default credentials. Pass an explicit secure password.'
    );
  }
  assertUsableBootstrapAdminPassword(options.password);

  const adminData = {
    ...DEVELOPMENT_DEFAULT_ADMIN_USER,
    ...options,
    password: options.password,
    role: 'superadmin' as const,
  };

  // Check if admin user already exists
  const existing = await getUserByEmail(db, adminData.email);

  if (existing) {
    throw new Error(`Admin user already exists (email: ${adminData.email})`);
  }

  const data: CreateUserData = {
    email: adminData.email,
    password: adminData.password,
    name: adminData.name,
    role: adminData.role,
    unix_username: adminData.unix_username,
    must_change_password: true,
  };

  return createUser(db, data);
}

/**
 * Create the exact development bootstrap identity behind all three explicit
 * environment gates. No caller-controlled boolean can weaken this boundary.
 */
export async function createDevelopmentDefaultAdminUser(db: Database): Promise<User> {
  assertDevelopmentDefaultAdminEnvironment();

  const existing = await getUserByEmail(db, DEVELOPMENT_DEFAULT_ADMIN_USER.email);
  if (existing) {
    throw new Error(`Admin user already exists (email: ${DEVELOPMENT_DEFAULT_ADMIN_USER.email})`);
  }

  return persistUser(db, {
    ...DEVELOPMENT_DEFAULT_ADMIN_USER,
    role: 'superadmin',
    must_change_password: false,
  });
}
