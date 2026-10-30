import { type AnyColumn, eq, type SQL, sql } from 'drizzle-orm';
import { EXAMPLE_BOARD_OWNER_EMAIL, type UserID } from '../types';
import type { Database } from './client';
import { select } from './database-wrapper';
import { users } from './schema';

/** The example board owner in the current tenant, or null when it was never seeded. */
export async function findExampleBoardOwnerId(db: Database): Promise<UserID | null> {
  const row = await select(db, { user_id: users.user_id })
    .from(users)
    .where(eq(users.email, EXAMPLE_BOARD_OWNER_EMAIL))
    .one();
  return (row?.user_id as UserID | undefined) ?? null;
}

/** Keeps rows whose creator is not the example board owner (for totals and searches). */
export function notExampleBoardOwned(createdBy: AnyColumn): SQL {
  return sql`(${createdBy} IS NULL OR ${createdBy} NOT IN (SELECT ${users.user_id} FROM ${users} WHERE ${users.email} = ${EXAMPLE_BOARD_OWNER_EMAIL}))`;
}
