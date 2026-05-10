/**
 * First-run admin bootstrap
 *
 * On daemon (or CLI) startup, ensures at least one admin user exists. If the
 * users table is empty, creates a default admin with a generated password and
 * writes the credentials to `~/.agor/admin-credentials` (mode 0600). Also
 * re-attributes any legacy rows whose `created_by` is the literal string
 * `'anonymous'` (left over from the removed anonymous-mode path) to the
 * bootstrap admin so the data isn't orphaned.
 *
 * This is the upgrade-path safety net for users who previously ran in
 * anonymous mode: their existing sessions / boards / worktrees stay attributed
 * to a real user, and their first launch shows clear credentials in the
 * daemon log.
 */

import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { User } from '../types';
import type { Database } from './client';
import { select, update } from './database-wrapper';
import {
  boardComments,
  boards,
  gatewayChannels,
  sessions,
  tasks,
  users,
  worktrees,
} from './schema';
import { createUser } from './user-utils';

/**
 * Result of the bootstrap check.
 */
export interface BootstrapResult {
  /** True iff a new admin was created on this call. */
  createdAdmin: boolean;
  /** The admin used as the attribution target (newly created or pre-existing). */
  admin: User | null;
  /** Cleartext credentials, only set when `createdAdmin === true`. */
  credentials?: { email: string; password: string };
  /** Number of rows re-attributed away from the legacy 'anonymous' sentinel. */
  reattributedCount: number;
}

const DEFAULT_ADMIN_EMAIL = 'admin@agor.live';
const ADMIN_CREDENTIALS_FILENAME = 'admin-credentials';

/**
 * Generate a memorable-but-secure password: 4 groups of 4 alphanumeric chars
 * separated by dashes, ~95 bits of entropy. Avoids ambiguous chars (0/O/1/l).
 */
function generatePassword(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const groups: string[] = [];
  for (let g = 0; g < 4; g++) {
    let group = '';
    for (let i = 0; i < 4; i++) {
      group += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    groups.push(group);
  }
  return groups.join('-');
}

/**
 * Re-attribute legacy `created_by='anonymous'` rows to a real user.
 *
 * Anonymous mode used to write the literal string `'anonymous'` into
 * `created_by` columns even though no `users` row with that ID ever existed.
 * After removing the anonymous path, those rows are orphaned. This sweep
 * stamps them with a real admin's user_id so listings, audit trails, and
 * ownership checks behave consistently.
 */
async function reattributeLegacyAnonymousRows(db: Database, targetUserId: string): Promise<number> {
  const tablesWithCreatedBy = [sessions, tasks, boards, worktrees, boardComments, gatewayChannels];
  let total = 0;
  for (const table of tablesWithCreatedBy) {
    const result = (await update(db, table)
      .set({ created_by: targetUserId })
      .where(eq(table.created_by, 'anonymous'))
      .run()) as { rowsAffected?: number };
    total += result.rowsAffected ?? 0;
  }
  return total;
}

/**
 * Find an admin to use as the attribution target when users already exist
 * but legacy `'anonymous'` rows are present. Prefers the oldest admin so the
 * choice is stable across runs.
 */
async function findFallbackAdmin(db: Database): Promise<User | null> {
  type UserRow = typeof users.$inferSelect;
  const byCreatedAtAsc = (a: UserRow, b: UserRow) => {
    const ta = a.created_at instanceof Date ? a.created_at.getTime() : Number(a.created_at);
    const tb = b.created_at instanceof Date ? b.created_at.getTime() : Number(b.created_at);
    return ta - tb;
  };
  const adminRows = (await select(db)
    .from(users)
    .where(eq(users.role, 'admin'))
    .all()) as UserRow[];
  if (adminRows.length === 0) {
    // No admin? Use whichever user has the lowest created_at — the
    // installation owner most likely.
    const allUsers = (await select(db).from(users).all()) as UserRow[];
    if (allUsers.length === 0) return null;
    allUsers.sort(byCreatedAtAsc);
    return userRowToUser(allUsers[0]);
  }
  adminRows.sort(byCreatedAtAsc);
  return userRowToUser(adminRows[0]);
}

function userRowToUser(row: typeof users.$inferSelect): User {
  return {
    user_id: row.user_id as User['user_id'],
    email: row.email,
    name: row.name ?? undefined,
    emoji: row.emoji ?? undefined,
    role: (row.role ?? 'member') as User['role'],
    unix_username: row.unix_username ?? undefined,
    onboarding_completed: !!row.onboarding_completed,
    must_change_password: !!row.must_change_password,
    created_at: row.created_at,
    updated_at: row.updated_at ?? undefined,
  };
}

/**
 * Resolve the path used to persist generated admin credentials. Honours the
 * standard `~/.agor` layout; callers can override for tests.
 */
export function getAdminCredentialsPath(baseDir: string = join(homedir(), '.agor')): string {
  return join(baseDir, ADMIN_CREDENTIALS_FILENAME);
}

/**
 * Ensure at least one admin user exists, and re-attribute legacy anonymous
 * rows to a real user. Idempotent — safe to call on every startup.
 *
 * Behaviour:
 *   - 0 users: creates `admin@agor.live` with a generated password, writes
 *     `~/.agor/admin-credentials` (mode 0600), returns credentials in the
 *     result so the caller can print them. Re-attributes anonymous rows.
 *   - >=1 users: skips creation, finds the oldest admin (or oldest user if
 *     none are admins), re-attributes anonymous rows to them.
 */
export async function ensureFirstRunAdmin(
  db: Database,
  options: { credentialsBaseDir?: string } = {}
): Promise<BootstrapResult> {
  const userCountResult = await select(db).from(users).all();
  const hasUsers = userCountResult.length > 0;

  if (!hasUsers) {
    const password = generatePassword();
    const admin = await createUser(db, {
      email: DEFAULT_ADMIN_EMAIL,
      password,
      name: 'Admin',
      role: 'admin',
    });

    const credentialsPath = getAdminCredentialsPath(options.credentialsBaseDir);
    const credentialsBody = [
      '# Agor admin credentials (auto-generated on first run)',
      '#',
      '# Use these to log in at the UI. You will be prompted to change the',
      '# password on first login. This file is mode 0600 — keep it that way.',
      '',
      `email: ${DEFAULT_ADMIN_EMAIL}`,
      `password: ${password}`,
      '',
    ].join('\n');
    await writeFile(credentialsPath, credentialsBody, { mode: 0o600 });

    const reattributedCount = await reattributeLegacyAnonymousRows(db, admin.user_id);
    return {
      createdAdmin: true,
      admin,
      credentials: { email: DEFAULT_ADMIN_EMAIL, password },
      reattributedCount,
    };
  }

  // Users already exist — only the legacy-row migration needs to run.
  const fallback = await findFallbackAdmin(db);
  let reattributedCount = 0;
  if (fallback) {
    reattributedCount = await reattributeLegacyAnonymousRows(db, fallback.user_id);
  }
  return {
    createdAdmin: false,
    admin: fallback,
    reattributedCount,
  };
}

/**
 * Pretty-print the bootstrap result to stderr. Centralized so the daemon and
 * the CLI render the same message.
 */
export function logBootstrapResult(result: BootstrapResult, credentialsPath: string): void {
  if (result.createdAdmin && result.credentials) {
    process.stderr.write('\n');
    process.stderr.write('================================================================\n');
    process.stderr.write('🔐  First-run admin user created\n');
    process.stderr.write('----------------------------------------------------------------\n');
    process.stderr.write(`    Email:    ${result.credentials.email}\n`);
    process.stderr.write(`    Password: ${result.credentials.password}\n`);
    process.stderr.write('\n');
    process.stderr.write(`    Saved to: ${credentialsPath} (mode 0600)\n`);
    process.stderr.write('    You will be prompted to change the password on first login.\n');
    process.stderr.write('================================================================\n');
    process.stderr.write('\n');
  }
  if (result.reattributedCount > 0 && result.admin) {
    process.stderr.write(
      `🧹 Re-attributed ${result.reattributedCount} legacy anonymous row(s) → ${result.admin.email}\n`
    );
  }
}
