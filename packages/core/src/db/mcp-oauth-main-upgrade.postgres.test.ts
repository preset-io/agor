import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { migrate as migratePostgres } from 'drizzle-orm/postgres-js/migrator';
import type { Sql } from 'postgres';
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
    let pendingMigrations: string[];
    beforeAll(async () => {
      db = createDatabase({ dialect: 'postgresql', url: url! });
      mainFolder = await mkdtemp(join(tmpdir(), 'agor-oauth-main-upgrade-'));
      await cp(migrationsFolder, mainFolder, { recursive: true });
      const journalPath = join(mainFolder, 'meta', '_journal.json');
      const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {
        entries: Array<{ idx: number; tag: string; when: number }>;
      };
      pendingMigrations = journal.entries.filter(({ idx }) => idx > 101).map(({ tag }) => tag);
      // Preserve the historical cutover contract without pinning today's suffix.
      expect(pendingMigrations.slice(0, 4)).toEqual([
        '0102_mcp_oauth_client_registrations',
        '0103_oauth_authority_watermark_reconciliation',
        '0104_mcp_slack_recovery_due',
        '0105_mcp_oauth_grant_attribution',
      ]);
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

    it.each(['"$user", public', 'public, pg_temp'])(
      'accepts the actual 0102 fingerprint in the same transaction (search_path=%s)',
      async (searchPath) => {
        const client = (db as Database & { $client: Sql }).$client;
        const rollback = new Error('diagnostic rollback');
        await expect(
          client.begin(async (tx) => {
            await tx`SELECT set_config('search_path', ${searchPath}, true)`;
            const actual = await readFile(
              join(migrationsFolder, '0102_mcp_oauth_client_registrations.sql'),
              'utf8'
            );
            const reconciliation = await readFile(
              join(migrationsFolder, '0103_oauth_authority_watermark_reconciliation.sql'),
              'utf8'
            );
            // Stop immediately before the reported guard, with both real references
            // constructed by the actual migration, not a hand-written approximation.
            const references = reconciliation.slice(
              0,
              reconciliation.indexOf('DO $$\nDECLARE\n  dcr regclass')
            );
            for (const statement of `${actual}\n${references}`.split('--> statement-breakpoint')) {
              if (statement.trim()) await tx.unsafe(statement);
            }
            const mismatches = await tx`
            SELECT a.key FROM jsonb_each(pg_temp.agor_0102_relation_fingerprint('public.mcp_oauth_client_registrations'::regclass)) a
            JOIN jsonb_each(pg_temp.agor_0102_relation_fingerprint('pg_temp.agor_0102_final_dcr_expected'::regclass)) e USING (key)
            WHERE a.value IS DISTINCT FROM e.value`;
            expect(mismatches).toEqual([]);
            // PG18 has table-derived NOT NULL names. They MUST differ while the
            // structural identity, validation/inheritance flags and definition agree.
            const names = await tx`SELECT conname FROM pg_constraint
            WHERE conrelid='public.mcp_oauth_client_registrations'::regclass AND contype='n'`;
            const version = await tx`SELECT current_setting('server_version_num')::int AS version`;
            expect(names.length > 0).toBe(Number(version[0].version) >= 180000);
            throw rollback;
          })
        ).rejects.toBe(rollback);
      }
    );

    it('rolls back the actual pending batch on an unsafe DCR shape and permits an explicit repair/retry', async () => {
      const client = (db as Database & { $client: Sql }).$client;
      await client.begin(async (tx) => {
        const source = await readFile(
          join(migrationsFolder, '0102_mcp_oauth_client_registrations.sql'),
          'utf8'
        );
        for (const statement of source.split('--> statement-breakpoint')) {
          if (statement.trim()) await tx.unsafe(statement);
        }
        await tx`ALTER TABLE mcp_oauth_client_registrations ALTER COLUMN binding_version DROP NOT NULL`;
      });
      const before = await checkMigrationStatus(db);
      const ledger = await client`SELECT * FROM drizzle.__drizzle_migrations ORDER BY id`;
      const relation =
        await client`SELECT 'public.mcp_oauth_client_registrations'::regclass::oid AS oid`;
      await expect(runMigrations(db, { allowOfflineCutover: true })).rejects.toThrow(
        'Migration failed'
      );
      expect(await checkMigrationStatus(db)).toEqual(before);
      expect(await client`SELECT * FROM drizzle.__drizzle_migrations ORDER BY id`).toEqual(ledger);
      expect(
        await client`SELECT 'public.mcp_oauth_client_registrations'::regclass::oid AS oid`
      ).toEqual(relation);
      // No data rewrite/drop: explicitly restore only the known malformed attribute.
      await client`ALTER TABLE mcp_oauth_client_registrations ALTER COLUMN binding_version SET NOT NULL`;
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
        pending: pendingMigrations,
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
