/** Real current-main 0100 -> 0101 DCR authority upgrade proof. */

import { cp, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { migrate as migratePostgres } from 'drizzle-orm/postgres-js/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from './client';
import { executeRaw, isPostgresDatabase, rawRows } from './database-wrapper';
import { runMigrations } from './migrate';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';
const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), '../../drizzle/postgres');

describe.skipIf(!postgresUrl || !usesPostgresSchema)(
  'MCP OAuth DCR current-main 0100 -> 0101 migration (PostgreSQL)',
  () => {
    let db: Database | null = null;
    let throughMainFolder: string | null = null;

    beforeAll(async () => {
      db = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      if (!isPostgresDatabase(db)) throw new Error('PostgreSQL test requires PostgreSQL');

      throughMainFolder = await mkdtemp(join(tmpdir(), 'agor-pg-migrations-through-main-0100-'));
      await cp(migrationsFolder, throughMainFolder, { recursive: true });
      await unlink(join(throughMainFolder, '0101_mcp_oauth_client_registrations.sql'));
      const journalPath = join(throughMainFolder, 'meta', '_journal.json');
      const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {
        entries: Array<{ idx: number }>;
      };
      journal.entries = journal.entries.filter((entry) => entry.idx <= 100);
      await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
      await migratePostgres(db as never, { migrationsFolder: throughMainFolder });
    });

    afterAll(async () => {
      if (db) await (db as Database & { $client: { end: () => Promise<void> } }).$client.end();
      if (throughMainFolder) await rm(throughMainFolder, { recursive: true, force: true });
    });

    it('requires the offline cohort acknowledgement and adds UUID/CAS authority without a sequence', async () => {
      if (!db) throw new Error('PostgreSQL test database was not initialized');

      await expect(runMigrations(db)).rejects.toThrow('Offline migration cutover required');
      await runMigrations(db, { allowOfflineCutover: true });

      const columns = rawRows(
        await executeRaw(
          db,
          sql`SELECT column_name
              FROM information_schema.columns
              WHERE table_schema = 'public'
                AND table_name = 'mcp_oauth_client_registrations'`
        )
      ).map((row) => row.column_name);
      expect(columns).toContain('registration_id');
      expect(columns).toContain('claim_generation');
      expect(columns).not.toContain('registration_generation');

      const legacySequence = rawRows(
        await executeRaw(
          db,
          sql`SELECT relname FROM pg_class
              WHERE relkind = 'S'
                AND relname = 'mcp_oauth_client_registration_generation_seq'`
        )
      );
      expect(legacySequence).toEqual([]);
    });
  }
);
