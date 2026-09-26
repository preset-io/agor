import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { describe, expect, it } from 'vitest';
import { createDatabase } from './client';
import { isSQLiteDatabase } from './database-wrapper';
import { checkMigrationStatus, runMigrations } from './migrate';

describe('restriction migration integration', () => {
  it.each(['main', 'feature'] as const)(
    'upgrades the %s watermark without skipping API-key source or restriction state',
    async (history) => {
      const folder = await mkdtemp(join(tmpdir(), 'agor-restriction-migrations-'));
      const db = createDatabase({ url: ':memory:' });
      try {
        if (!isSQLiteDatabase(db)) throw new Error('SQLite required');
        await cp(new URL('../../drizzle/sqlite/', import.meta.url), folder, { recursive: true });
        const path = join(folder, 'meta/_journal.json');
        const journal = JSON.parse(await readFile(path, 'utf8'));
        journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx <= 114);
        if (history === 'feature') {
          journal.entries.at(-1).tag = '0116_tenant_restrictions';
        }
        await writeFile(path, JSON.stringify(journal));
        await migrate(db, { migrationsFolder: folder });
        if (history === 'feature') {
          // Exact old feature ledger; its SQL creates the same tables, before
          // main added API-key source at the very same timestamp.
          await db.run(sql`UPDATE __drizzle_migrations
            SET hash = '82f1b30221a6d626e90af4414666b976f576bb5a32689635f81e05a6aee49c0b'
            WHERE created_at = 1790129000212`);
          await db.run(sql`INSERT INTO tenant_restrictions
            (controller_id, placement_id, operation_id, revision, phase)
            VALUES ('controller', 'placement', 'operation', 7, 'restricted')`);
        }
        await db.run(sql`INSERT INTO users (user_id, email, password, created_at, data)
          VALUES ('migration-user', 'migration@example.invalid', '', 1, '{}')`);
        await db.run(sql`INSERT INTO user_api_keys (id, user_id, name, prefix, key_hash, created_at)
          VALUES ('migration-key', 'migration-user', 'Preserved key', 'agor_test', 'test-hash', 1)`);
        if (history === 'main') {
          await db.run(sql`UPDATE user_api_keys SET source = 'cli' WHERE id = 'migration-key'`);
        }
        await runMigrations(db);
        expect((await db.run(sql`PRAGMA table_info(user_api_keys)`)).rows).toContainEqual(
          expect.objectContaining({ name: 'source', dflt_value: "'manual'", notnull: 1 })
        );
        if (history === 'feature') {
          expect((await db.run(sql`SELECT revision, phase FROM tenant_restrictions`)).rows).toEqual(
            [{ revision: 7, phase: 'restricted' }]
          );
        }
        expect(
          (
            await db.run(
              sql`SELECT name, key_hash, source FROM user_api_keys WHERE id = 'migration-key'`
            )
          ).rows
        ).toEqual([
          {
            name: 'Preserved key',
            key_hash: 'test-hash',
            source: history === 'main' ? 'cli' : 'manual',
          },
        ]);
        await db.run(sql`SELECT * FROM kb_import_receipts`);
        await runMigrations(db);
        expect((await checkMigrationStatus(db)).pending).toEqual([]);
      } finally {
        await rm(folder, { recursive: true, force: true });
      }
    },
    60_000
  );

  it.each(['sqlite', 'postgres'] as const)(
    'keeps the %s journal ordered and uniquely allocated',
    async (dialect) => {
      const journal = JSON.parse(
        await readFile(
          new URL(`../../drizzle/${dialect}/meta/_journal.json`, import.meta.url),
          'utf8'
        )
      );
      const entries = journal.entries as Array<{ idx: number; when: number; tag: string }>;
      expect(new Set(entries.map((entry) => entry.tag.split('_')[0])).size).toBe(entries.length);
      for (
        let i = entries.findIndex((entry) => entry.tag.startsWith('0112_'));
        i < entries.length;
        i++
      ) {
        expect(entries[i].idx).toBeGreaterThan(entries[i - 1].idx);
        expect(entries[i].when).toBeGreaterThan(entries[i - 1].when);
      }
    }
  );
});
