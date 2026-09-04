/** Exact b0585d76 OAuth authority history -> final reconciliation proof. */

import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { migrate as migratePostgres } from 'drizzle-orm/postgres-js/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateId } from '../lib/ids';
import { createDatabase, type Database } from './client';
import { executeRaw, isPostgresDatabase, rawRows } from './database-wrapper';
import { checkMigrationStatus, classifyMigrationWatermark, runMigrations } from './migrate';
import { MCPServerRepository } from './repositories/mcp-servers';
import { UsersRepository } from './repositories/users';
import { runWithTenantDatabaseScope } from './tenant-scope';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';
const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), '../../drizzle/postgres');
const oldHeadFixture = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'test-fixtures/b0585d76/0100_mcp_oauth_client_registrations.sql'
);
const OLD_HEAD_WATERMARK = 1_788_292_800_000;
const FINAL_RECONCILIATION_WATERMARK = 1_788_379_200_000;
const OLD_HEAD_MIGRATION_SHA256 =
  'f1e964942fd61182d564cf45dfcf5b13218b1eee242a3927a7fc9fba168fe7c5';

describe.skipIf(!postgresUrl || !usesPostgresSchema)(
  'MCP OAuth DCR b0585d76 -> final migration (PostgreSQL)',
  () => {
    let db: Database | null = null;
    let oldHeadFolder: string | null = null;

    beforeAll(async () => {
      db = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      if (!isPostgresDatabase(db)) throw new Error('PostgreSQL test requires PostgreSQL');

      // Reproduce the old PR head with its actual checked-in SQL artifact and
      // timestamp-only ledger. In particular, do not approximate the legacy
      // table with hand-written test DDL: the sequence, policies, constraints,
      // and migration hash all come from b0585d76.
      oldHeadFolder = await mkdtemp(join(tmpdir(), 'agor-pg-migrations-b0585d76-'));
      await cp(migrationsFolder, oldHeadFolder, { recursive: true });
      expect(
        createHash('sha256')
          .update(await readFile(oldHeadFixture))
          .digest('hex')
      ).toBe(OLD_HEAD_MIGRATION_SHA256);
      await Promise.all([
        unlink(join(oldHeadFolder, '0100_claude_oauth_attempts.sql')),
        unlink(join(oldHeadFolder, '0101_mcp_oauth_client_registrations.sql')),
        unlink(join(oldHeadFolder, '0102_oauth_authority_watermark_reconciliation.sql')),
      ]);
      await cp(oldHeadFixture, join(oldHeadFolder, '0100_mcp_oauth_client_registrations.sql'));
      const journalPath = join(oldHeadFolder, 'meta', '_journal.json');
      const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {
        entries: Array<{
          idx: number;
          version: string;
          when: number;
          tag: string;
          breakpoints: boolean;
        }>;
      };
      journal.entries = journal.entries.filter((entry) => entry.idx <= 99);
      journal.entries.push({
        idx: 100,
        version: '7',
        when: OLD_HEAD_WATERMARK,
        tag: '0100_mcp_oauth_client_registrations',
        breakpoints: true,
      });
      await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
      await migratePostgres(db as never, { migrationsFolder: oldHeadFolder });
    });

    afterAll(async () => {
      if (db) await (db as Database & { $client: { end: () => Promise<void> } }).$client.end();
      if (oldHeadFolder) await rm(oldHeadFolder, { recursive: true, force: true });
    });

    it('detects the collision, requires an offline cutover, and reconciles both authorities', async () => {
      if (!db) throw new Error('PostgreSQL test database was not initialized');

      const beforeColumns = rawRows(
        await executeRaw(
          db,
          sql`SELECT table_name, column_name
              FROM information_schema.columns
              WHERE table_schema = 'public'
                AND table_name IN ('claude_oauth_attempts', 'mcp_oauth_client_registrations')`
        )
      );
      expect(beforeColumns).toContainEqual(
        expect.objectContaining({
          table_name: 'mcp_oauth_client_registrations',
          column_name: 'registration_generation',
        })
      );
      expect(beforeColumns.some((row) => row.table_name === 'claude_oauth_attempts')).toBe(false);

      const legacyRegistrationId = generateId();
      await runWithTenantDatabaseScope(db, 'old-head-reconciliation', async (scoped) => {
        const owner = await new UsersRepository(scoped).create({
          email: `${generateId()}@example.test`,
          name: 'Old head migration owner',
          role: 'admin',
        });
        const server = await new MCPServerRepository(scoped).create({
          name: `old-head-dcr-${generateId()}`,
          transport: 'http',
          url: 'https://provider.example.test/mcp',
          scope: 'global',
          enabled: true,
          source: 'user',
          owner_user_id: owner.user_id,
          auth: { type: 'oauth', oauth_mode: 'per_user' },
        });
        await executeRaw(
          scoped,
          sql`INSERT INTO mcp_oauth_client_registrations (
                tenant_id, registration_id, mcp_server_id,
                registration_generation, binding_version, binding_fingerprint,
                server_config_version, envelope_version, status, sealed_material,
                claim_generation, dispatched_at, created_at, updated_at
              ) VALUES (
                'old-head-reconciliation', ${legacyRegistrationId}, ${server.mcp_server_id},
                1, 1, ${'a'.repeat(64)}, 1, 1, 'registered', 'legacy-sealed-material',
                1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
              )`
        );
      });

      // Because 0100/0101 are at or below the old timestamp-only watermark,
      // only the deliberately later reconciliation is visible as pending.
      await expect(checkMigrationStatus(db)).resolves.toMatchObject({
        pending: ['0102_oauth_authority_watermark_reconciliation'],
        dbAheadOfBinary: false,
      });
      await expect(runMigrations(db)).rejects.toThrow('Offline migration cutover required');
      await runMigrations(db, { allowOfflineCutover: true });

      const afterColumns = rawRows(
        await executeRaw(
          db,
          sql`SELECT table_name, column_name
              FROM information_schema.columns
              WHERE table_schema = 'public'
                AND table_name IN ('claude_oauth_attempts', 'mcp_oauth_client_registrations')`
        )
      );
      expect(afterColumns).toContainEqual(
        expect.objectContaining({
          table_name: 'claude_oauth_attempts',
          column_name: 'attempt_generation',
        })
      );
      expect(afterColumns).toContainEqual(
        expect.objectContaining({
          table_name: 'mcp_oauth_client_registrations',
          column_name: 'claim_generation',
        })
      );
      expect(afterColumns.some((row) => row.column_name === 'registration_generation')).toBe(false);
      await expect(
        runWithTenantDatabaseScope(db, 'old-head-reconciliation', async (scoped) =>
          rawRows(
            await executeRaw(
              scoped,
              sql`SELECT registration_id FROM mcp_oauth_client_registrations`
            )
          )
        )
      ).resolves.toEqual([]);

      const legacySequence = rawRows(
        await executeRaw(
          db,
          sql`SELECT relname FROM pg_class
              WHERE relkind = 'S'
                AND relname = 'mcp_oauth_client_registration_generation_seq'`
        )
      );
      expect(legacySequence).toEqual([]);

      const ledger = rawRows(
        await executeRaw(
          db,
          sql`SELECT MAX(created_at) AS max_ts FROM drizzle.__drizzle_migrations`
        )
      );
      const finalWatermark = Number(ledger[0]?.max_ts);
      expect(finalWatermark).toBe(FINAL_RECONCILIATION_WATERMARK);
      const oldHeadJournal = JSON.parse(
        await readFile(join(oldHeadFolder!, 'meta', '_journal.json'), 'utf8')
      ) as { entries: Array<{ tag: string; when: number }> };
      // Run the exact production status classifier against b0585d76's real
      // journal. Its daemon startup rejects this database-ahead result.
      expect(classifyMigrationWatermark(oldHeadJournal.entries, finalWatermark)).toMatchObject({
        hasPending: false,
        dbAheadOfBinary: true,
      });
      await expect(checkMigrationStatus(db)).resolves.toMatchObject({
        hasPending: false,
        dbAheadOfBinary: false,
      });
    });
  }
);
