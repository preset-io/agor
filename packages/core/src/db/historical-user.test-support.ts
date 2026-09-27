import { sql } from 'drizzle-orm';
import { generateId } from '../lib/ids';
import type { UserRole } from '../types/user';
import type { Database } from './client';
import { executeRaw, isPostgresDatabase } from './database-wrapper';
import { getCurrentTenantId } from './tenant-context';

/** Seed pre-access-authority schemas without coupling them to today's users model. */
export async function seedHistoricalUser(
  db: Database,
  input: { email: string; name?: string; role?: UserRole }
) {
  const user_id = generateId();
  const postgres = isPostgresDatabase(db);
  const now = postgres ? new Date().toISOString() : Date.now();
  await executeRaw(
    db,
    sql`INSERT INTO users
      (${postgres ? sql`tenant_id,` : sql``} user_id, created_at, email, password, name, role, data)
      VALUES (${postgres ? sql`${getCurrentTenantId()},` : sql``}
        ${user_id}, ${now}, ${input.email}, '', ${input.name ?? null}, ${input.role ?? 'member'}, '{}')`
  );
  return { user_id };
}
