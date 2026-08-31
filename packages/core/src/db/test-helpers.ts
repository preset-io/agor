/**
 * Database Test Helpers
 *
 * Shared test utilities used ACROSS multiple test files.
 *
 * Add helpers here ONLY if multiple test files need them:
 * - Shared fixtures (like dbTest below)
 * - Common assertions used by many tests
 * - Seeded database fixtures for integration tests
 *
 * For helpers used within a single test file, keep them inline in that file.
 * Don't add single-use utilities here - keep this file lean.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  BranchID,
  CapabilityPolicyFsAccess,
  CapabilityPolicyPresetId,
  UserID,
  UUID,
} from '@agor/core/types';
import { eq } from 'drizzle-orm';
import { test } from 'vitest';
import { generateId } from '../lib/ids';
import { capabilityPolicyPresetCapabilities } from '../types/capability-policy';
import { createDatabase, type Database } from './client';
import { insert, select } from './database-wrapper';
import { initializeDatabase } from './migrate';
import { CapabilityPolicyRepository } from './repositories/capability-policies';
import { users } from './schema';

/**
 * Test fixture providing fresh in-memory database for each test.
 *
 * Each test gets an isolated SQLite :memory: database with full schema.
 * Cleanup happens automatically after each test.
 *
 * @example
 * ```typescript
 * import { dbTest } from '../test-helpers';
 * import { RepoRepository } from './repos';
 *
 * dbTest('should create repo', async ({ db }) => {
 *   const repo = new RepoRepository(db);
 *   const created = await repo.create({ path: '/test', name: 'test' });
 *   expect(created.id).toBeDefined();
 * });
 * ```
 */
export const dbTest = test.extend<{ db: Database }>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright test fixture pattern requires empty destructure
  db: async ({}, use) => {
    // Use a per-test temp file instead of :memory:.
    // Rationale: the libsql client opens a fresh connection for each
    // transaction, and `:memory:` databases are isolated per-connection,
    // which breaks any code under test that starts a transaction after
    // creating schema on the initial connection. A unique file path per
    // test gives us identical isolation with a single shared DB.
    const dir = mkdtempSync(join(tmpdir(), 'agor-core-test-'));
    const dbPath = join(dir, 'test.db');
    const db = createDatabase({ url: `file:${dbPath}` });

    // Initialize schema (creates all tables, indexes, etc.)
    await initializeDatabase(db);
    try {
      // Provide database to test
      await use(db);
    } finally {
      // Best-effort cleanup of the temp dir (ignore errors on Windows)
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // noop
      }
    }
  },
});

/**
 * Explicitly seed a stable owner principal for tests that create protected
 * Boards or Branches. The generic `dbTest` fixture intentionally stays empty
 * so unrelated repository tests retain production-like count semantics.
 */
export async function ensureTestUser(db: Database, userId: UserID = 'test-user' as UserID) {
  const existing = await select(db, { user_id: users.user_id })
    .from(users)
    .where(eq(users.user_id, userId))
    .one();
  if (existing) return userId;

  await insert(db, users)
    .values({
      user_id: userId,
      created_at: new Date(),
      email: `${userId}@agor.test`,
      password: 'not-a-login-secret',
      role: 'member',
      data: {},
    })
    .run();
  return userId;
}

/** Opt-in database fixture for repository suites built around `test-user`. */
export const ownedDbTest = dbTest.extend<{ protectedOwner: undefined }>({
  protectedOwner: [
    async ({ db }, use) => {
      await ensureTestUser(db);
      await use(undefined);
    },
    { auto: true },
  ],
});

/** Add or replace one direct-user entry through the canonical test seam. */
export async function setTestBranchUserRole(
  db: Database,
  branchId: BranchID,
  userId: UserID,
  preset: CapabilityPolicyPresetId = 'manager',
  fsAccess: CapabilityPolicyFsAccess = 'none',
  actorId: UserID = userId
): Promise<void> {
  const policies = new CapabilityPolicyRepository(db);
  const current = await policies.getBranchPolicy(branchId);
  const base =
    current.binding_mode === 'inherit' ? current.inherited_config : current.override_config;
  if (!base) throw new Error('Missing branch permission configuration');
  const capabilities = capabilityPolicyPresetCapabilities('branch_access', preset, fsAccess);
  if (!capabilities) throw new Error(`Invalid branch test role: ${preset}`);
  await policies.replaceBranchPolicy(
    branchId,
    {
      ...current,
      binding_mode: 'override',
      override_config: {
        ...base,
        access: {
          ...base.access,
          sharing_mode: 'shared',
          entries: [
            ...base.access.entries.filter(
              (entry) =>
                entry.principal.principal_type !== 'user' || entry.principal.user_id !== userId
            ),
            {
              entry_id: generateId() as UUID,
              principal: { principal_type: 'user', user_id: userId },
              preset,
              capabilities,
              fs_access: fsAccess,
            },
          ],
        },
      },
    },
    actorId
  );
}
