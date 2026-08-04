/**
 * Generic, runtime-derived identity of a multi-tenant database, shared by the
 * tenant portability operations (inspect / export / import / verify).
 *
 * Every portability operation must agree on two things: (1) which tables are
 * tenant-owned, and (2) what schema the archive was produced against, so an
 * import or verification can refuse a mismatched database instead of silently
 * corrupting or misreporting. This module derives both from the runtime itself —
 * the compiled tenant manifest, the registered imperative tables, and the
 * applied-migration ledger — never from anything a caller supplies.
 *
 * It deliberately does not re-implement the deep row-level-security policy audit
 * performed by the tenant-deletion engine (`tenant-deletion.ts`). That engine
 * remains the authority that proves the RLS contract before destructive work.
 * Here we assert the weaker, sufficient properties portability needs: the
 * database is PostgreSQL, its migration ledger is exactly known, every compiled
 * tenant table is physically present with a tenant discriminator, and no
 * additional tenant-owned table exists that the manifest does not cover (which
 * would make an export silently incomplete).
 *
 * Multi-tenancy is a PostgreSQL-only feature in Agor; the SQLite schema is
 * single-tenant and carries no `tenant_id` columns.
 */

import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Database } from './client';
import { executeRaw, isPostgresDatabase } from './database-wrapper';
import { checkMigrationStatus } from './migrate';
import { buildTenantDeletionManifest } from './tenant-deletion-manifest';
import { IMPERATIVE_TENANT_TABLES } from './tenant-imperative-tables';

/** Thrown when a portability operation targets a non-multi-tenant database. */
export class TenantPortabilityUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantPortabilityUnsupportedError';
  }
}

/** Thrown when the live catalog cannot prove the tenant-table set is complete. */
export class TenantCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantCatalogError';
  }
}

/**
 * Runtime-derived database identity. Stable, machine-readable, secret-free — it
 * contains only the dialect, the applied-migration ledger, and the sorted set of
 * tenant-owned table names, plus a fingerprint over all of them.
 */
export interface TenantDatabaseIdentity {
  dialect: 'postgresql';
  /** Last applied migration tag (the schema version). */
  schemaVersion: string;
  /** Applied migration tags, in applied order. Import requires an exact match. */
  migrations: string[];
  /** Sorted names of every tenant-owned table covered by the manifest. */
  tenantTables: string[];
  /**
   * Imperative tenant tables (created lazily outside the schema) proven present
   * in the live catalog. A subset of the registered imperative tables.
   */
  presentImperativeTables: string[];
  /** SHA-256 over the canonical form of every field above. */
  fingerprint: string;
}

/**
 * Assert the database is PostgreSQL (the only dialect that carries tenant data),
 * throwing the shared unsupported error otherwise.
 */
export function assertPortabilityDatabaseSupported(db: Database): void {
  if (!isPostgresDatabase(db)) {
    throw new TenantPortabilityUnsupportedError(
      'Tenant portability requires a PostgreSQL (multi-tenant) database; the SQLite schema is single-tenant'
    );
  }
}

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  const rows = (result as { rows?: unknown[] } | undefined)?.rows;
  return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
}

/**
 * Read the names of every `public` base table that carries a NOT NULL `text`
 * `tenant_id` column. All system-catalog references are pg_catalog-qualified so
 * a hostile search_path cannot redirect the read.
 */
async function readLiveTenantTableNames(db: Database): Promise<Set<string>> {
  const result = await executeRaw(
    db,
    sql`
      SELECT c.relname AS table_name
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r'
        AND n.nspname = 'public'
        AND EXISTS (
          SELECT 1
          FROM pg_catalog.pg_attribute a
          WHERE a.attrelid = c.oid
            AND a.attname = 'tenant_id'
            AND a.attnum > 0
            AND NOT a.attisdropped
            AND a.atttypid = 'pg_catalog.text'::pg_catalog.regtype
            AND a.attnotnull
        )
    `
  );
  const names = new Set<string>();
  for (const row of rowsOf(result)) names.add(String(row.table_name));
  return names;
}

/**
 * Resolve the applied-migration ledger, applying the same fail-closed watermark
 * guards the deletion engine uses: refuse when the database was migrated by a
 * newer binary, when this binary has unapplied migrations, or when the schema is
 * uninitialised. Returns the applied tags (in order) and the schema version.
 */
export async function resolveTenantMigrationLedger(
  db: Database
): Promise<{ schemaVersion: string; migrations: string[] }> {
  const status = await checkMigrationStatus(db);
  if (status.dbAheadOfBinary) {
    throw new TenantCatalogError(
      'Database schema is newer than this binary: the database has migrations this release does not know about. ' +
        'Refusing the tenant operation because the tenant-table manifest may be incomplete. ' +
        'Upgrade this binary to match the database, then retry.'
    );
  }
  if (status.hasPending) {
    throw new TenantCatalogError(
      `Refusing the tenant operation: the database has ${status.pending.length} pending migration(s); ` +
        'apply pending migrations so the tenant-table manifest matches the live schema before continuing.'
    );
  }
  if (status.applied.length === 0) {
    throw new TenantCatalogError(
      'Database has no applied migrations; refusing the tenant operation against an uninitialised schema'
    );
  }
  return {
    schemaVersion: status.applied[status.applied.length - 1],
    migrations: status.applied,
  };
}

/**
 * Compute the runtime-derived identity of the tenant database, failing closed
 * if the compiled manifest and the live catalog disagree on the tenant-table
 * set. This is the trust anchor every portability operation shares.
 */
export async function resolveTenantDatabaseIdentity(db: Database): Promise<TenantDatabaseIdentity> {
  assertPortabilityDatabaseSupported(db);

  const { schemaVersion, migrations } = await resolveTenantMigrationLedger(db);

  // Fail closed on an unclassified/transitive schema table (the manifest throws).
  const manifest = buildTenantDeletionManifest();
  const manifestNames = manifest.map((entry) => entry.name);
  const manifestSet = new Set(manifestNames);
  const imperativeSet = new Set(IMPERATIVE_TENANT_TABLES.map((table) => table.name));

  const live = await readLiveTenantTableNames(db);

  // Every compiled tenant table must physically exist, or the archive we produce
  // (or verify against) would omit rows the schema says belong to the tenant.
  const missing = manifestNames.filter((name) => !live.has(name)).sort();
  if (missing.length > 0) {
    throw new TenantCatalogError(
      `Refusing the tenant operation: compiled tenant table(s) are absent from the live catalog: ${missing.join(', ')}`
    );
  }

  // Any live tenant-owned table the manifest does not cover would silently escape
  // export/verify — refuse rather than under-report a tenant's footprint.
  const uncovered = [...live]
    .filter((name) => !manifestSet.has(name) && !imperativeSet.has(name))
    .sort();
  if (uncovered.length > 0) {
    throw new TenantCatalogError(
      `Refusing the tenant operation: live tenant-owned table(s) are not covered by the manifest: ${uncovered.join(', ')}`
    );
  }

  const presentImperativeTables = [...imperativeSet].filter((name) => live.has(name)).sort();
  const tenantTables = [...manifestSet].sort();

  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        dialect: 'postgresql',
        schemaVersion,
        migrations,
        tenantTables,
        presentImperativeTables,
      })
    )
    .digest('hex');

  return {
    dialect: 'postgresql',
    schemaVersion,
    migrations,
    tenantTables,
    presentImperativeTables,
    fingerprint,
  };
}
