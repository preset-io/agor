import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { migrate as migratePostgres } from 'drizzle-orm/postgres-js/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from './client';
import { executeRaw, rawRows } from './database-wrapper';
import { checkMigrationStatus, runMigrations } from './migrate';

const url = process.env.AGOR_TEST_POSTGRES_URL;
const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), '../../drizzle/postgres');

describe.skipIf(!url || process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'MCP OAuth upgrade from main environment-discovery watermark',
  () => {
    let db: Database;
    let mainFolder: string;
    beforeAll(async () => {
      db = createDatabase({ dialect: 'postgresql', url: url! });
      mainFolder = await mkdtemp(join(tmpdir(), 'agor-oauth-main-upgrade-'));
      await cp(migrationsFolder, mainFolder, { recursive: true });
      const journalPath = join(mainFolder, 'meta', '_journal.json');
      const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {
        entries: Array<{ idx: number; tag: string; when: number }>;
      };
      journal.entries = journal.entries.filter(({ idx }) => idx <= 101);
      expect(journal.entries.at(-1)).toMatchObject({
        tag: '0101_environment_command_discovery',
        when: 1788728664645,
      });
      await writeFile(journalPath, JSON.stringify(journal));
      await migratePostgres(db as never, { migrationsFolder: mainFolder });
    });
    afterAll(async () => {
      if (db) await (db as Database & { $client: { end(): Promise<void> } }).$client.end();
      if (mainFolder) await rm(mainFolder, { recursive: true, force: true });
    });

    it('requires offline cutover, retains main discovery policy, and creates forced-RLS DCR authority', async () => {
      const policy = () =>
        executeRaw(
          db,
          sql`SELECT pg_get_expr(polqual, polrelid) AS expression FROM pg_policy
              WHERE polname = 'environment_health_discovery'`
        ).then(rawRows);
      const beforePolicy = await policy();
      expect(beforePolicy[0]?.expression).toContain('stopping');
      await expect(checkMigrationStatus(db)).resolves.toMatchObject({
        pending: [
          '0102_mcp_oauth_client_registrations',
          '0103_oauth_authority_watermark_reconciliation',
          '0104_mcp_slack_recovery_due',
        ],
        dbAheadOfBinary: false,
      });
      await expect(runMigrations(db)).rejects.toThrow('Offline migration cutover required');
      await runMigrations(db, { allowOfflineCutover: true });
      expect(await policy()).toEqual(beforePolicy);
      expect(
        rawRows(
          await executeRaw(
            db,
            sql`SELECT relrowsecurity, relforcerowsecurity FROM pg_class
                WHERE oid = 'public.mcp_oauth_client_registrations'::regclass`
          )
        )
      ).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
      await expect(checkMigrationStatus(db)).resolves.toMatchObject({ hasPending: false });
    });
  }
);
