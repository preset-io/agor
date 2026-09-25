import { appendFile, cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { expect, it } from 'vitest';
import { withPreviousCallbackJournal } from './callback-watermark.test-support';
import { createDatabase } from './client';
import { executeRaw, isSQLiteDatabase, rawRows } from './database-wrapper';
import { checkMigrationStatus, runMigrations } from './migrate';
import { migrateSQLiteWithCallbackReconciliation } from './migrate-sqlite';
import { UsersRepository } from './repositories/users';

it('restores API-key source after the 7475feacb watermark (1790129000214)', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'agor-callback-upgrade-'));
  const db = createDatabase({ url: `file:${join(folder, 'test.db')}` });
  if (!isSQLiteDatabase(db)) throw new Error('SQLite required');
  try {
    await withPreviousCallbackJournal('sqlite', (migrationsFolder) =>
      migrate(db, { migrationsFolder })
    );
    const columns = () => executeRaw(db, sql`PRAGMA table_info(user_api_keys)`).then(rawRows);
    expect((await columns()).some(({ name }) => name === 'source')).toBe(false);
    expect(await checkMigrationStatus(db)).toMatchObject({
      pending: ['0117_callback_ownership_reconciliation'],
    });
    const owner = await new UsersRepository(db).create({ email: 'watermark@example.invalid' });
    await executeRaw(
      db,
      sql`INSERT INTO user_api_keys (id, user_id, name, prefix, key_hash, created_at)
      VALUES ('retained-key', ${owner.user_id}, 'retained', 'fixture', 'fixture-hash', 1)`
    );

    // The guarded ADD and its ledger entry must roll back with the rest of DDL.
    const brokenFolder = join(folder, 'broken-migrations');
    await cp(new URL('../../drizzle/sqlite/', import.meta.url), brokenFolder, { recursive: true });
    await appendFile(
      join(brokenFolder, '0117_callback_ownership_reconciliation.sql'),
      '\n--> statement-breakpoint\nSELECT * FROM deliberately_missing_table;'
    );
    await expect(migrateSQLiteWithCallbackReconciliation(db, brokenFolder)).rejects.toThrow();
    expect((await columns()).some(({ name }) => name === 'source')).toBe(false);
    expect(await checkMigrationStatus(db)).toMatchObject({
      pending: ['0117_callback_ownership_reconciliation'],
    });
    await runMigrations(db);
    expect((await columns()).find(({ name }) => name === 'source')).toMatchObject({
      type: 'TEXT',
      notnull: 1,
      dflt_value: "'manual'",
    });
    expect(rawRows(await executeRaw(db, sql`SELECT source, key_hash FROM user_api_keys`))).toEqual([
      { source: 'manual', key_hash: 'fixture-hash' },
    ]);
    // The source column must also survive replay when already present.
    await executeRaw(db, sql`UPDATE user_api_keys SET source = 'cli_login'`);
    await executeRaw(db, sql`DELETE FROM __drizzle_migrations WHERE created_at = 1790129000216`);
    await runMigrations(db);
    expect(rawRows(await executeRaw(db, sql`SELECT source, key_hash FROM user_api_keys`))).toEqual([
      { source: 'cli_login', key_hash: 'fixture-hash' },
    ]);
    expect(await checkMigrationStatus(db)).toMatchObject({ hasPending: false });
    expect(rawRows(await executeRaw(db, sql`PRAGMA foreign_key_check`))).toEqual([]);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
