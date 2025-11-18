/**
 * User Utilities Tests
 *
 * Tests for standalone user management functions that work without the daemon.
 */

import bcrypt from 'bcryptjs';
import { describe, expect, it } from 'vitest';
import { generateId } from '../lib/ids';
import { dbTest } from './test-helpers';
import {
  type CreateUserData,
  createDefaultAdminUser,
  createUser,
  DEFAULT_ADMIN_USER,
  getUserByEmail,
  userExists,
} from './user-utils';

/**
 * Create test user data
 */
function createUserData(overrides?: Partial<CreateUserData>): CreateUserData {
  return {
    email: overrides?.email ?? `test-${generateId().slice(0, 8)}@example.com`,
    password: overrides?.password ?? 'password123',
    name: overrides?.name,
    role: overrides?.role,
  };
}

// ============================================================================
// createUser
// ============================================================================

describe('createUser', () => {
  dbTest('should create user with all required fields', async ({ db }) => {
    const data = createUserData({
      email: 'test@example.com',
      password: 'securepass123',
      name: 'Test User',
      role: 'member',
    });

    const user = await createUser(db, data);

    expect(user.user_id).toBeDefined();
    expect(user.user_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(user.email).toBe('test@example.com');
    expect(user.name).toBe('Test User');
    expect(user.role).toBe('member');
    expect(user.emoji).toBe('👤'); // Default emoji for member
    expect(user.onboarding_completed).toBe(false);
    expect(user.created_at).toBeInstanceOf(Date);
    expect(user.updated_at).toBeInstanceOf(Date);
    expect(user.preferences).toEqual({});
  });

  dbTest('should create user with minimal required fields', async ({ db }) => {
    const data = createUserData({
      email: 'minimal@example.com',
      password: 'pass123',
    });

    const user = await createUser(db, data);

    expect(user.email).toBe('minimal@example.com');
    expect(user.name).toBeUndefined();
    expect(user.role).toBe('member'); // Default role
    expect(user.emoji).toBe('👤'); // Default emoji
    expect(user.avatar).toBeUndefined();
    expect(user.preferences).toEqual({});
  });

  dbTest('should hash password using bcrypt', async ({ db }) => {
    const data = createUserData({
      email: 'hash@example.com',
      password: 'plaintext',
    });

    await createUser(db, data);

    // Verify password is hashed by checking it's not stored in plain text
    const result = await (db as any).query.users.findFirst({
      where: (users: any, { eq }: any) => eq(users.email, 'hash@example.com'),
    });

    expect(result?.password).toBeDefined();
    expect(result?.password).not.toBe('plaintext');
    expect(result?.password).toMatch(/^\$2[aby]\$\d{2}\$/); // bcrypt hash pattern

    // Verify password can be verified
    const isValid = await bcrypt.compare('plaintext', result!.password);
    expect(isValid).toBe(true);
  });

  dbTest('should set admin emoji for admin role', async ({ db }) => {
    const data = createUserData({
      email: 'admin@example.com',
      password: 'adminpass',
      role: 'admin',
    });

    const user = await createUser(db, data);

    expect(user.role).toBe('admin');
    expect(user.emoji).toBe('⭐'); // Admin emoji
  });

  dbTest('should set member emoji for non-admin roles', async ({ db }) => {
    const roles = ['owner', 'member', 'viewer'] as const;

    for (const role of roles) {
      const data = createUserData({
        email: `${role}@example.com`,
        password: 'pass123',
        role,
      });

      const user = await createUser(db, data);

      expect(user.role).toBe(role);
      expect(user.emoji).toBe('👤'); // Member emoji (not admin)
    }
  });

  dbTest('should default to member role if not specified', async ({ db }) => {
    const data = createUserData({
      email: 'default@example.com',
      password: 'pass123',
    });

    const user = await createUser(db, data);

    expect(user.role).toBe('member');
    expect(user.emoji).toBe('👤');
  });

  dbTest('should throw error if email already exists', async ({ db }) => {
    const data = createUserData({
      email: 'duplicate@example.com',
      password: 'pass123',
    });

    await createUser(db, data);

    await expect(createUser(db, data)).rejects.toThrow(
      'User with email duplicate@example.com already exists'
    );
  });

  dbTest('should allow different case emails (SQLite is case-sensitive)', async ({ db }) => {
    const data1 = createUserData({
      email: 'case@example.com',
      password: 'pass123',
    });

    const data2 = createUserData({
      email: 'CASE@example.com',
      password: 'pass456',
    });

    const user1 = await createUser(db, data1);
    const user2 = await createUser(db, data2);

    // SQLite TEXT columns are case-sensitive by default
    expect(user1.email).toBe('case@example.com');
    expect(user2.email).toBe('CASE@example.com');
    expect(user1.user_id).not.toBe(user2.user_id);
  });

  dbTest('should create multiple users with unique emails', async ({ db }) => {
    const user1 = await createUser(db, createUserData({ email: 'user1@example.com' }));
    const user2 = await createUser(db, createUserData({ email: 'user2@example.com' }));
    const user3 = await createUser(db, createUserData({ email: 'user3@example.com' }));

    expect(user1.user_id).not.toBe(user2.user_id);
    expect(user2.user_id).not.toBe(user3.user_id);
    expect(user1.email).toBe('user1@example.com');
    expect(user2.email).toBe('user2@example.com');
    expect(user3.email).toBe('user3@example.com');
  });

  dbTest('should initialize preferences as empty object', async ({ db }) => {
    const data = createUserData({
      email: 'prefs@example.com',
      password: 'pass123',
    });

    const user = await createUser(db, data);

    expect(user.preferences).toBeDefined();
    expect(user.preferences).toEqual({});
  });

  dbTest('should set created_at and updated_at to same timestamp', async ({ db }) => {
    const before = Date.now();
    const user = await createUser(db, createUserData({ email: 'time@example.com' }));
    const after = Date.now();

    expect(user.created_at.getTime()).toBeGreaterThanOrEqual(before);
    expect(user.created_at.getTime()).toBeLessThanOrEqual(after);
    expect(user.updated_at?.getTime()).toBe(user.created_at.getTime());
  });

  dbTest('should handle special characters in email', async ({ db }) => {
    const data = createUserData({
      email: 'test+tag@example.co.uk',
      password: 'pass123',
    });

    const user = await createUser(db, data);

    expect(user.email).toBe('test+tag@example.co.uk');
  });

  dbTest('should handle special characters in name', async ({ db }) => {
    const data = createUserData({
      email: 'special@example.com',
      password: 'pass123',
      name: "O'Brien-Smith (née Jones)",
    });

    const user = await createUser(db, data);

    expect(user.name).toBe("O'Brien-Smith (née Jones)");
  });

  dbTest('should handle long passwords', async ({ db }) => {
    const longPassword = 'a'.repeat(200);
    const data = createUserData({
      email: 'long@example.com',
      password: longPassword,
    });

    const user = await createUser(db, data);

    expect(user.user_id).toBeDefined();

    // Verify password hashes correctly
    const result = await (db as any).query.users.findFirst({
      where: (users: any, { eq }: any) => eq(users.email, 'long@example.com'),
    });

    const isValid = await bcrypt.compare(longPassword, result!.password);
    expect(isValid).toBe(true);
  });
});

// ============================================================================
// userExists
// ============================================================================

describe('userExists', () => {
  dbTest('should return true for existing user', async ({ db }) => {
    const data = createUserData({ email: 'exists@example.com' });
    await createUser(db, data);

    const exists = await userExists(db, 'exists@example.com');

    expect(exists).toBe(true);
  });

  dbTest('should return false for non-existent user', async ({ db }) => {
    const exists = await userExists(db, 'nonexistent@example.com');

    expect(exists).toBe(false);
  });

  dbTest('should return false for empty database', async ({ db }) => {
    const exists = await userExists(db, 'any@example.com');

    expect(exists).toBe(false);
  });

  dbTest('should be case-sensitive for email lookups', async ({ db }) => {
    const data = createUserData({ email: 'test@example.com' });
    await createUser(db, data);

    // SQLite TEXT columns are case-sensitive by default
    const exists = await userExists(db, 'TEST@example.com');

    expect(exists).toBe(false);
    expect(await userExists(db, 'test@example.com')).toBe(true);
  });

  dbTest('should check multiple users independently', async ({ db }) => {
    await createUser(db, createUserData({ email: 'user1@example.com' }));
    await createUser(db, createUserData({ email: 'user2@example.com' }));

    expect(await userExists(db, 'user1@example.com')).toBe(true);
    expect(await userExists(db, 'user2@example.com')).toBe(true);
    expect(await userExists(db, 'user3@example.com')).toBe(false);
  });

  dbTest('should handle special characters in email', async ({ db }) => {
    const email = 'test+tag@example.co.uk';
    await createUser(db, createUserData({ email }));

    const exists = await userExists(db, email);

    expect(exists).toBe(true);
  });
});

// ============================================================================
// getUserByEmail
// ============================================================================

describe('getUserByEmail', () => {
  dbTest('should return user for existing email', async ({ db }) => {
    const data = createUserData({
      email: 'find@example.com',
      name: 'Find Me',
      role: 'admin',
    });
    const created = await createUser(db, data);

    const found = await getUserByEmail(db, 'find@example.com');

    expect(found).not.toBeNull();
    expect(found?.user_id).toBe(created.user_id);
    expect(found?.email).toBe('find@example.com');
    expect(found?.name).toBe('Find Me');
    expect(found?.role).toBe('admin');
  });

  dbTest('should return null for non-existent email', async ({ db }) => {
    const found = await getUserByEmail(db, 'nonexistent@example.com');

    expect(found).toBeNull();
  });

  dbTest('should return null for empty database', async ({ db }) => {
    const found = await getUserByEmail(db, 'any@example.com');

    expect(found).toBeNull();
  });

  dbTest('should be case-sensitive for email lookups', async ({ db }) => {
    await createUser(db, createUserData({ email: 'case@example.com', name: 'Case Test' }));

    const found = await getUserByEmail(db, 'CASE@example.com');

    // SQLite TEXT columns are case-sensitive
    expect(found).toBeNull();

    const foundExact = await getUserByEmail(db, 'case@example.com');
    expect(foundExact).not.toBeNull();
    expect(foundExact?.name).toBe('Case Test');
  });

  dbTest('should return complete user object with all fields', async ({ db }) => {
    const data = createUserData({
      email: 'complete@example.com',
      name: 'Complete User',
      role: 'owner',
    });
    await createUser(db, data);

    const user = await getUserByEmail(db, 'complete@example.com');

    expect(user).not.toBeNull();
    expect(user?.user_id).toBeDefined();
    expect(user?.email).toBe('complete@example.com');
    expect(user?.name).toBe('Complete User');
    expect(user?.role).toBe('owner');
    expect(user?.emoji).toBe('👤');
    expect(user?.onboarding_completed).toBe(false);
    expect(user?.created_at).toBeInstanceOf(Date);
    expect(user?.updated_at).toBeInstanceOf(Date);
    expect(user?.preferences).toEqual({});
  });

  dbTest('should handle user with undefined optional fields', async ({ db }) => {
    const data = createUserData({
      email: 'minimal@example.com',
      password: 'pass123',
    });
    await createUser(db, data);

    const user = await getUserByEmail(db, 'minimal@example.com');

    expect(user).not.toBeNull();
    expect(user?.name).toBeUndefined();
    expect(user?.avatar).toBeUndefined();
  });

  dbTest('should distinguish between multiple users', async ({ db }) => {
    await createUser(db, createUserData({ email: 'user1@example.com', name: 'User One' }));
    await createUser(db, createUserData({ email: 'user2@example.com', name: 'User Two' }));

    const user1 = await getUserByEmail(db, 'user1@example.com');
    const user2 = await getUserByEmail(db, 'user2@example.com');

    expect(user1?.name).toBe('User One');
    expect(user2?.name).toBe('User Two');
    expect(user1?.user_id).not.toBe(user2?.user_id);
  });

  dbTest('should not expose password in returned user object', async ({ db }) => {
    await createUser(db, createUserData({ email: 'secure@example.com', password: 'secret123' }));

    const user = await getUserByEmail(db, 'secure@example.com');

    expect(user).not.toBeNull();
    expect((user as any).password).toBeUndefined();
  });
});

// ============================================================================
// DEFAULT_ADMIN_USER constant
// ============================================================================

describe('DEFAULT_ADMIN_USER', () => {
  it('should have expected default values', () => {
    expect(DEFAULT_ADMIN_USER.email).toBe('admin@agor.live');
    expect(DEFAULT_ADMIN_USER.password).toBe('admin');
    expect(DEFAULT_ADMIN_USER.name).toBe('Admin');
    expect(DEFAULT_ADMIN_USER.role).toBe('admin');
  });

  it('should be a const object', () => {
    expect(DEFAULT_ADMIN_USER).toBeDefined();
    expect(typeof DEFAULT_ADMIN_USER).toBe('object');
  });
});

// ============================================================================
// createDefaultAdminUser
// ============================================================================

describe('createDefaultAdminUser', () => {
  dbTest('should create admin user with default credentials', async ({ db }) => {
    const admin = await createDefaultAdminUser(db);

    expect(admin.email).toBe('admin@agor.live');
    expect(admin.name).toBe('Admin');
    expect(admin.role).toBe('admin');
    expect(admin.emoji).toBe('⭐'); // Admin emoji
    expect(admin.user_id).toBeDefined();
  });

  dbTest('should hash default password', async ({ db }) => {
    await createDefaultAdminUser(db);

    const result = await (db as any).query.users.findFirst({
      where: (users: any, { eq }: any) => eq(users.email, 'admin@agor.live'),
    });

    expect(result?.password).not.toBe('admin');
    expect(result?.password).toMatch(/^\$2[aby]\$\d{2}\$/);

    const isValid = await bcrypt.compare('admin', result!.password);
    expect(isValid).toBe(true);
  });

  dbTest('should throw error if admin user already exists', async ({ db }) => {
    await createDefaultAdminUser(db);

    await expect(createDefaultAdminUser(db)).rejects.toThrow(
      'Admin user already exists (email: admin@agor.live)'
    );
  });

  dbTest('should throw error if admin email exists with different user', async ({ db }) => {
    // Create a user with the admin email manually
    await createUser(db, {
      email: 'admin@agor.live',
      password: 'different',
      name: 'Different User',
      role: 'member',
    });

    await expect(createDefaultAdminUser(db)).rejects.toThrow('Admin user already exists');
  });

  dbTest('should use createUser internally', async ({ db }) => {
    const admin = await createDefaultAdminUser(db);

    // Should have all the same properties as any user created via createUser
    expect(admin.preferences).toEqual({});
    expect(admin.onboarding_completed).toBe(false);
    expect(admin.created_at).toBeInstanceOf(Date);
    expect(admin.updated_at).toBeInstanceOf(Date);
  });

  dbTest('should be idempotent check (fails on second call)', async ({ db }) => {
    const admin1 = await createDefaultAdminUser(db);

    await expect(createDefaultAdminUser(db)).rejects.toThrow();

    // Verify original admin still exists unchanged
    const found = await getUserByEmail(db, 'admin@agor.live');
    expect(found?.user_id).toBe(admin1.user_id);
  });
});

// ============================================================================
// Integration Tests
// ============================================================================

describe('User utilities integration', () => {
  dbTest('should support complete user lifecycle', async ({ db }) => {
    // Check user doesn't exist
    expect(await userExists(db, 'lifecycle@example.com')).toBe(false);
    expect(await getUserByEmail(db, 'lifecycle@example.com')).toBeNull();

    // Create user
    const created = await createUser(
      db,
      createUserData({
        email: 'lifecycle@example.com',
        name: 'Lifecycle User',
      })
    );

    // Verify user exists
    expect(await userExists(db, 'lifecycle@example.com')).toBe(true);

    // Retrieve user
    const retrieved = await getUserByEmail(db, 'lifecycle@example.com');
    expect(retrieved).not.toBeNull();
    expect(retrieved?.user_id).toBe(created.user_id);
    expect(retrieved?.email).toBe(created.email);
  });

  dbTest('should handle mixed user roles in same database', async ({ db }) => {
    const owner = await createUser(
      db,
      createUserData({ email: 'owner@example.com', role: 'owner' })
    );
    const admin = await createUser(
      db,
      createUserData({ email: 'admin@example.com', role: 'admin' })
    );
    const member = await createUser(
      db,
      createUserData({ email: 'member@example.com', role: 'member' })
    );
    const viewer = await createUser(
      db,
      createUserData({ email: 'viewer@example.com', role: 'viewer' })
    );

    expect(owner.role).toBe('owner');
    expect(admin.role).toBe('admin');
    expect(member.role).toBe('member');
    expect(viewer.role).toBe('viewer');

    expect(admin.emoji).toBe('⭐');
    expect(owner.emoji).toBe('👤');
    expect(member.emoji).toBe('👤');
    expect(viewer.emoji).toBe('👤');
  });

  dbTest('should work alongside default admin user', async ({ db }) => {
    // Create default admin
    const admin = await createDefaultAdminUser(db);

    // Create regular users
    const user1 = await createUser(db, createUserData({ email: 'user1@example.com' }));
    const user2 = await createUser(db, createUserData({ email: 'user2@example.com' }));

    // All should exist independently
    expect(await userExists(db, 'admin@agor.live')).toBe(true);
    expect(await userExists(db, 'user1@example.com')).toBe(true);
    expect(await userExists(db, 'user2@example.com')).toBe(true);

    expect(admin.role).toBe('admin');
    expect(user1.role).toBe('member');
    expect(user2.role).toBe('member');
  });
});
