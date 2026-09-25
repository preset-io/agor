import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Client, InStatement } from '@libsql/client';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import { readMigrationFiles } from 'drizzle-orm/migrator';

/**
 * Drizzle's libsql migration batch, with one guarded reconciliation statement.
 * SQLite has no ADD COLUMN IF NOT EXISTS. Keep the original SQL/hash/watermark,
 * skipping only the marked 0117 ADD when the column exists or main's unchanged
 * 0115 will add it earlier in this same batch. client.migrate retains Drizzle's
 * atomic DDL + ledger write and foreign-key handling (unlike client.batch).
 */
export async function migrateSQLiteWithCallbackReconciliation<
  TSchema extends Record<string, unknown>,
>(db: LibSQLDatabase<TSchema>, migrationsFolder: string): Promise<void> {
  const client = (db as LibSQLDatabase<TSchema> & { $client: Client }).$client;
  const migrations = readMigrationFiles({ migrationsFolder });
  await client.execute(`CREATE TABLE IF NOT EXISTS __drizzle_migrations (
    id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric
  )`);
  const ledger = await client.execute(
    'SELECT created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1'
  );
  const lastApplied = ledger.rows[0]?.created_at;
  const columns = await client.execute('PRAGMA table_info(user_api_keys)');
  let hasSource = columns.rows.some(({ name }) => name === 'source');
  const sourceDDL = readFileSync(
    join(migrationsFolder, '0115_user_api_key_source.sql'),
    'utf8'
  ).trim();
  const statements: InStatement[] = [];
  for (const migration of migrations) {
    if (lastApplied !== undefined && Number(lastApplied) >= migration.folderMillis) continue;
    for (const statement of migration.sql) {
      const guarded = statement.includes('-- agor:sqlite-add-user-api-key-source-if-missing');
      if (
        guarded &&
        (migration.folderMillis !== 1790129000216 || !statement.trim().endsWith(sourceDDL))
      ) {
        throw new Error('Unexpected SQLite callback reconciliation guard');
      }
      if (guarded && hasSource) continue;
      statements.push(statement);
      if (statement.trim().endsWith(sourceDDL)) hasSource = true;
    }
    statements.push({
      sql: 'INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)',
      args: [migration.hash, migration.folderMillis],
    });
  }
  await client.migrate(statements);
}
