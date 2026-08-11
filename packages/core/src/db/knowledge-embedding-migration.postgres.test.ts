/**
 * Real 0073 -> 0074 upgrade proof under the same non-superuser/NOBYPASSRLS
 * contract as the PostgreSQL integration runner.
 *
 * Run through the root PostgreSQL integration lane; the canonical runner gives
 * every PostgreSQL suite its own temporary database.
 */

import { cp, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { migrate as migratePostgres } from 'drizzle-orm/postgres-js/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from './client';
import { executeRaw, isPostgresDatabase } from './database-wrapper';
import { runMigrations } from './migrate';
import { runWithTenantDatabaseScope } from './tenant-scope';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';
const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), '../../drizzle/postgres');

function firstRow(result: unknown): Record<string, unknown> {
  if (Array.isArray(result)) return (result[0] ?? {}) as Record<string, unknown>;
  const rows = (result as { rows?: unknown[] } | undefined)?.rows;
  return ((Array.isArray(rows) ? rows[0] : undefined) ?? {}) as Record<string, unknown>;
}

describe.skipIf(!postgresUrl || !usesPostgresSchema)(
  'Knowledge embedding 0073 -> 0074 migration (PostgreSQL)',
  () => {
    let db: Database | null = null;
    let pre0074Folder: string | null = null;

    beforeAll(async () => {
      db = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      if (!isPostgresDatabase(db)) throw new Error('PostgreSQL test requires PostgreSQL');

      const role = firstRow(
        await executeRaw(
          db,
          sql`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
        )
      );
      expect(role.rolsuper).toBe(false);
      expect(role.rolbypassrls).toBe(false);

      pre0074Folder = await mkdtemp(join(tmpdir(), 'agor-pg-migrations-through-0073-'));
      await cp(migrationsFolder, pre0074Folder, { recursive: true });
      await unlink(join(pre0074Folder, '0074_knowledge_embedding_claims.sql'));
      const journalPath = join(pre0074Folder, 'meta', '_journal.json');
      const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {
        entries: Array<{ idx: number }>;
      };
      journal.entries = journal.entries.filter((entry) => entry.idx <= 73);
      await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`);

      await migratePostgres(db as never, { migrationsFolder: pre0074Folder });
    });

    afterAll(async () => {
      if (db) await (db as Database & { $client: { end: () => Promise<void> } }).$client.end();
      if (pre0074Folder) await rm(pre0074Folder, { recursive: true, force: true });
    });

    it('cleans non-default archived work under FORCE RLS and removes migration policies', async () => {
      if (!db) throw new Error('PostgreSQL test database was not initialized');
      const tenantId = 'migration-non-default';
      const namespaceId = '019fdd52-0000-7000-8000-000000000001';
      const documentId = '019fdd52-0000-7000-8000-000000000002';
      const versionId = '019fdd52-0000-7000-8000-000000000003';
      const unitId = '019fdd52-0000-7000-8000-000000000004';

      await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
        await executeRaw(
          scoped,
          sql`INSERT INTO kb_namespaces (
                tenant_id, namespace_id, slug, display_name, created_at, updated_at
              ) VALUES (
                ${tenantId}, ${namespaceId}, 'migration-archived', 'Migration archived',
                CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
              )`
        );
        await executeRaw(
          scoped,
          sql`INSERT INTO kb_documents (
                tenant_id, document_id, namespace_id, path, uri, title,
                current_version_id, created_at, updated_at, archived, archived_at
              ) VALUES (
                ${tenantId}, ${documentId}, ${namespaceId}, 'archived.md',
                'kb://migration-non-default/migration-archived/archived.md', 'Archived',
                NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, true, CURRENT_TIMESTAMP
              )`
        );
        await executeRaw(
          scoped,
          sql`INSERT INTO kb_document_versions (
                tenant_id, version_id, document_id, version_number, content_text, created_at
              ) VALUES (
                ${tenantId}, ${versionId}, ${documentId}, 1, '# Archived', CURRENT_TIMESTAMP
              )`
        );
        await executeRaw(
          scoped,
          sql`UPDATE kb_documents SET current_version_id = ${versionId}
              WHERE document_id = ${documentId}`
        );
        await executeRaw(
          scoped,
          sql`INSERT INTO kb_document_units (
                tenant_id, unit_id, document_id, version_id, content_text,
                embedding_status, created_at, updated_at
              ) VALUES (
                ${tenantId}, ${unitId}, ${documentId}, ${versionId}, '# Archived',
                'pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
              )`
        );
      });

      await expect(runMigrations(db)).rejects.toThrow('Offline migration cutover required');
      await runMigrations(db, { allowOfflineCutover: true });

      const migrated = await runWithTenantDatabaseScope(db, tenantId, (scoped) =>
        executeRaw(
          scoped,
          sql`SELECT embedding_status, embedding_claim_generation, embedding_claim_token
              FROM kb_document_units WHERE unit_id = ${unitId}`
        )
      );
      expect(firstRow(migrated)).toMatchObject({
        embedding_status: 'not_configured',
        embedding_claim_generation: 0,
        embedding_claim_token: null,
      });

      const temporaryPolicies = await executeRaw(
        db,
        sql`SELECT tablename, policyname
            FROM pg_policies
            WHERE policyname LIKE 'knowledge_embedding_migration_0074_%'`
      );
      expect(Array.isArray(temporaryPolicies) ? temporaryPolicies : []).toEqual([]);
    });
  }
);
