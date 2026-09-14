import { and, eq, ne } from 'drizzle-orm';
import type { Database } from './client';
import { select } from './database-wrapper';
import { users } from './schema';

/** Tenant-scoped execution-home uniqueness check shared by every user writer. */
export async function isExecutionHomeKeyAvailable(
  db: Database,
  executionHomeKey: string,
  excludeUserId?: string
): Promise<boolean> {
  const existing = await select(db)
    .from(users)
    .where(
      excludeUserId
        ? and(eq(users.unix_username, executionHomeKey), ne(users.user_id, excludeUserId))
        : eq(users.unix_username, executionHomeKey)
    )
    .one();
  return !existing;
}
