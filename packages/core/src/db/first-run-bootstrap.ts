/**
 * First-run admin bootstrap (data layer)
 *
 * Pure DB operations:
 *   1. If the `users` table is empty, calls the caller-provided
 *      `createAdmin()` factory to produce the bootstrap admin. The factory is
 *      responsible for password generation, hashing, and any side-channel
 *      persistence (writing `~/.agor/admin-credentials`, printing to stderr,
 *      etc.). This module deliberately does NOT touch the filesystem or
 *      stderr — that's a setup/runtime concern, not a database concern.
 *   2. Re-attributes any rows where `created_by` equals the legacy
 *      `'anonymous'` sentinel (left over from the removed anonymous-mode
 *      path) to a real user. New admin if just bootstrapped, otherwise the
 *      oldest existing admin (falling back to the oldest user).
 *
 * Idempotent: safe to call on every daemon startup. Once users exist and no
 * legacy rows remain, it's effectively a no-op.
 */

import { randomInt } from 'node:crypto';
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
  type UserRow,
  users,
  worktrees,
} from './schema';
import { userRowToUser } from './user-utils';

/**
 * Legacy sentinel value written to `created_by` columns when anonymous mode
 * existed. Used as both the pre-bootstrap seed value (so we know which rows
 * still need real attribution) and the predicate for the legacy sweep.
 *
 * NOTE: We deliberately use a non-UUID literal so it can't collide with a
 * real `user_id` value (UUIDv7 is always 36 chars with dashes).
 */
export const LEGACY_ANONYMOUS_OWNER_ID = 'anonymous';

const DEFAULT_ADMIN_EMAIL = 'admin@agor.live';

/** Result of running the bootstrap. */
export interface AdminBootstrapResult {
  /** True iff a new admin was created on this call. */
  createdAdmin: boolean;
  /** The admin used as the legacy-row attribution target. Null only when the DB is empty AND `createAdmin` was not provided. */
  admin: User | null;
  /** Number of rows re-attributed away from the legacy 'anonymous' sentinel. */
  reattributedCount: number;
}

/**
 * Memorable, securely-generated password: 4 groups of 4 alphanumeric chars
 * separated by dashes. Uses `crypto.randomInt` (uniform distribution, CSPRNG)
 * — never `Math.random`. ~95 bits of entropy. Avoids visually-ambiguous chars
 * (0/O/1/l/I) so the printed password is easy to copy from a terminal.
 */
export function generateAdminPassword(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const groups: string[] = [];
  for (let g = 0; g < 4; g++) {
    let group = '';
    for (let i = 0; i < 4; i++) {
      group += alphabet[randomInt(0, alphabet.length)];
    }
    groups.push(group);
  }
  return groups.join('-');
}

/**
 * Default email assigned to the bootstrap admin. Exported so the daemon-side
 * orchestrator can include it in the persisted-credentials file.
 */
export const BOOTSTRAP_ADMIN_EMAIL = DEFAULT_ADMIN_EMAIL;

/**
 * Re-attribute legacy `created_by='anonymous'` rows to a real user.
 *
 * The literal `'anonymous'` was written into `created_by` columns even
 * though no `users` row with that ID ever existed. After removing the
 * anonymous path, those rows would be orphaned. This sweep stamps them with
 * a real admin's user_id. Idempotent — converges across partial reruns.
 */
export async function reattributeLegacyAnonymousRows(
  db: Database,
  targetUserId: string
): Promise<number> {
  const tablesWithCreatedBy = [sessions, tasks, boards, worktrees, boardComments, gatewayChannels];
  let total = 0;
  for (const table of tablesWithCreatedBy) {
    const result = (await update(db, table)
      .set({ created_by: targetUserId })
      .where(eq(table.created_by, LEGACY_ANONYMOUS_OWNER_ID))
      .run()) as { rowsAffected?: number };
    total += result.rowsAffected ?? 0;
  }
  return total;
}

/**
 * Find an admin to use as the legacy-row attribution target. Prefers the
 * oldest admin (stable across runs); falls back to the oldest user when no
 * admins exist. Returns null only on a completely empty users table.
 */
async function findFallbackAdmin(db: Database): Promise<User | null> {
  const byCreatedAtAsc = (a: UserRow, b: UserRow) => {
    const ta = a.created_at instanceof Date ? a.created_at.getTime() : Number(a.created_at);
    const tb = b.created_at instanceof Date ? b.created_at.getTime() : Number(b.created_at);
    return ta - tb;
  };
  const adminRows = (await select(db)
    .from(users)
    .where(eq(users.role, 'admin'))
    .all()) as UserRow[];
  const pool: UserRow[] =
    adminRows.length > 0 ? adminRows : ((await select(db).from(users).all()) as UserRow[]);
  if (pool.length === 0) return null;
  pool.sort(byCreatedAtAsc);
  return userRowToUser(pool[0]);
}

/**
 * Guard against the (unlikely but observable) case where a real user row has
 * `user_id` literally equal to the legacy sentinel. UUIDv7 generation makes
 * this practically impossible, but if some imported / hand-inserted row has
 * that ID the sweep would conflate sentinel rows with that user's data.
 * Returns `true` if the bootstrap should skip the sweep.
 */
async function hasRealUserWithSentinelId(db: Database): Promise<boolean> {
  const row = await select(db)
    .from(users)
    .where(eq(users.user_id, LEGACY_ANONYMOUS_OWNER_ID))
    .one();
  return row != null;
}

/**
 * Ensure at least one admin user exists, and re-attribute legacy anonymous
 * rows. Pure DB operations — caller is responsible for any filesystem /
 * stderr side effects (e.g. persisting the generated password to disk).
 *
 * Behaviour:
 *   - 0 users: invokes `createAdmin()` to produce the admin row. The factory
 *     owns password generation and any external persistence. Then re-attributes
 *     legacy sentinel rows to that admin.
 *   - >=1 users: skips creation, finds a fallback admin, re-attributes sentinel
 *     rows to them.
 *   - If a real user with `user_id = LEGACY_ANONYMOUS_OWNER_ID` exists, the
 *     sweep is skipped (returns `reattributedCount: 0`) to avoid hijacking
 *     their data.
 */
export async function bootstrapFirstRunAdmin(
  db: Database,
  createAdmin: () => Promise<User>
): Promise<AdminBootstrapResult> {
  const existingUsers = await select(db).from(users).all();

  let admin: User | null;
  let createdAdmin = false;

  if (existingUsers.length === 0) {
    admin = await createAdmin();
    createdAdmin = true;
  } else {
    admin = await findFallbackAdmin(db);
  }

  let reattributedCount = 0;
  if (admin) {
    if (await hasRealUserWithSentinelId(db)) {
      // Refuse to overwrite rows that might legitimately reference a real
      // user whose ID happens to be the sentinel string. Operators in that
      // situation should re-attribute manually.
      console.warn(
        `[bootstrap] Skipping legacy-row sweep: a real users row has user_id='${LEGACY_ANONYMOUS_OWNER_ID}'.`
      );
    } else {
      reattributedCount = await reattributeLegacyAnonymousRows(db, admin.user_id);
    }
  }

  return { createdAdmin, admin, reattributedCount };
}
