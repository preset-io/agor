/**
 * Permanent, audited, idempotent deletion of all data belonging to a single
 * tenant.
 *
 * Operators of a multi-tenant Agor deployment need a verifiable way to remove a
 * tenant entirely (offboarding, data-removal requests, regulatory erasure). This
 * module performs that removal against a deletion plan assembled from the
 * runtime-derived {@link buildTenantDeletionManifest tenant manifest} and the
 * registry of tenant tables created imperatively at runtime:
 *
 *   1. Validate the tenant id (refuse empty / whitespace / wildcard values).
 *   2. Reconcile the plan against the live PostgreSQL catalog and fail closed if
 *      any tenant-contract table is missing or malformed.
 *   3. Delete every tenant-scoped row inside a single tenant-scoped transaction,
 *      children before parents, so foreign keys are never violated.
 *   4. Re-scan the whole plan in a fresh transaction and fail unless zero
 *      rows remain for the tenant.
 *
 * Running it twice on the same tenant is safe: the second run deletes zero rows
 * and still reports success. Multi-tenancy is PostgreSQL-only, so the command
 * refuses to run against a SQLite database.
 *
 * Precondition — quiesce the tenant first: this operation verifies tenant state
 * at scan time; it does not by itself fence out a concurrent writer. The
 * operator must stop new tenant-scoped work in the deployment BEFORE running,
 * otherwise a writer active during or after verification can recreate tenant
 * rows that the verification pass will not see.
 *
 * The result object is a frozen machine-readable contract (see
 * {@link TenantDeletionResult}) intended to be parsed by external automation. It
 * contains only booleans, numbers, and identifier strings — never row content,
 * connection strings, or other secrets.
 */

import { count, sql } from 'drizzle-orm';
import { QueryBuilder } from 'drizzle-orm/pg-core';
import type { Database } from './client';
import { deleteFrom, executeRaw, isPostgresDatabase, select } from './database-wrapper';
import { checkMigrationStatus } from './migrate';
import {
  buildTenantDeletionManifest,
  buildTenantScopeCondition,
  indexManifest,
  type TenantDeletionTable,
} from './tenant-deletion-manifest';
import { IMPERATIVE_TENANT_TABLES, type ImperativeTenantTable } from './tenant-imperative-tables';
import { getCurrentTenantDatabaseScope, runWithTenantDatabaseScope } from './tenant-scope';

/** Thrown when the supplied tenant id is empty, blank, or wildcard-like. */
export class InvalidTenantIdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidTenantIdError';
  }
}

/** Thrown when tenant deletion is attempted against a non-multi-tenant database. */
export class TenantDeletionUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantDeletionUnsupportedError';
  }
}

/** Thrown when the live catalog cannot prove that the deletion plan is exhaustive. */
export class TenantDeletionCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantDeletionCatalogError';
  }
}

/** Thrown when post-deletion verification still finds tenant rows. */
export class TenantDeletionVerificationError extends Error {
  /** Names of tables that still contain rows for the tenant. */
  readonly tables: string[];
  constructor(tables: string[]) {
    super(
      `Tenant deletion verification failed: ${tables.length} table(s) still contain tenant rows`
    );
    this.name = 'TenantDeletionVerificationError';
    this.tables = tables;
  }
}

/**
 * Stable machine-readable success contract. Key names are frozen — external
 * automation parses them exactly. Only booleans, numbers, and identifier
 * strings are ever emitted.
 */
export interface TenantDeletionResult {
  tenantDataDeleted: true;
  /** Current applied schema/migration version (last applied migration tag). */
  schemaVersion: string;
  /** Rows deleted per table. Every plan table is present, even at zero. */
  rowCounts: Record<string, number>;
}

/** Result of a `--dry-run`: reports would-be deletions without mutating data. */
export interface TenantDeletionDryRunResult {
  tenantDataDeleted: false;
  dryRun: true;
  schemaVersion: string;
  /** Rows that WOULD be deleted per table. */
  rowCounts: Record<string, number>;
}

export interface TenantDeletionOptions {
  /** Report counts without deleting anything. */
  dryRun?: boolean;
  /** Human-readable audit sink (secret-safe). Defaults to a no-op. */
  log?: (message: string) => void;
}

/** Wildcard-like characters that must never be accepted as a concrete tenant id. */
const WILDCARD_CHARACTERS = /[%*]/;
/** Unicode control and formatting characters can forge terminal or audit output. */
const CONTROL_CHARACTERS = /[\p{Cc}\p{Cf}]/u;

/**
 * Validate a tenant id, refusing empty, whitespace-only, whitespace-padded, and
 * wildcard-like or non-printable values. A concrete id such as `default` or a
 * UUID is accepted.
 */
export function assertValidTenantId(tenantId: unknown): asserts tenantId is string {
  if (typeof tenantId !== 'string') {
    throw new InvalidTenantIdError('A tenant id is required');
  }
  if (tenantId.length === 0) {
    throw new InvalidTenantIdError('Tenant id must not be empty');
  }
  if (tenantId.trim().length === 0) {
    throw new InvalidTenantIdError('Tenant id must not be blank');
  }
  if (tenantId.trim() !== tenantId) {
    throw new InvalidTenantIdError('Tenant id must not have leading or trailing whitespace');
  }
  if (WILDCARD_CHARACTERS.test(tenantId)) {
    throw new InvalidTenantIdError('Tenant id must not contain wildcard characters ("%" or "*")');
  }
  if (CONTROL_CHARACTERS.test(tenantId)) {
    throw new InvalidTenantIdError('Tenant id must not contain control or formatting characters');
  }
}

/**
 * Convert the set of tables that still hold tenant rows after deletion into a
 * thrown {@link TenantDeletionVerificationError}. Extracted so the failure path
 * is unit-testable without a live database.
 */
export function assertNoRemainingTenantRows(remaining: string[]): void {
  if (remaining.length > 0) {
    throw new TenantDeletionVerificationError(remaining);
  }
}

async function resolveSchemaVersion(db: Database): Promise<string> {
  const status = await checkMigrationStatus(db);
  // This migration-watermark check is a conservative compatibility guard, not a
  // proof that the compiled schema equals the live catalog. Exhaustiveness is
  // established separately by the catalog reconciliation before any deletion.
  //
  // DB ahead of binary: the database was migrated by a newer release, so this
  // binary's schema omits tables the database now has. Deleting + verifying
  // against that incomplete manifest would falsely certify success while tenant
  // data survives in tables this binary cannot see.
  if (status.dbAheadOfBinary) {
    throw new Error(
      'Database schema is newer than this binary: the database has migrations this release does not know about. ' +
        'Refusing to run tenant deletion because the deletion manifest may be incomplete and could falsely certify success. ' +
        'Upgrade this binary to match the database, then retry.'
    );
  }
  // Binary ahead of DB (pending migrations): this binary has migrations the DB
  // has not applied. If a pending migration DROPS or RENAMES a tenant-scoped
  // table, the live database still holds that table with tenant data, but this
  // binary's compiled schema no longer lists it under that name — so the manifest
  // omits it, deletion skips it, and verification (scanning the same manifest)
  // reports false success while tenant data survives. (The ADD-a-table case does
  // fail loudly with 'relation does not exist', but the DROP/RENAME case does
  // not — hence this guard.)
  if (status.hasPending) {
    throw new Error(
      `Refusing to delete tenant data: the database has ${status.pending.length} pending migration(s); ` +
        "the running binary's migration watermark is not compatible with the database. " +
        'Apply the pending migrations before deleting a tenant ' +
        '(a pending migration may drop or rename a tenant-scoped table, which would make deletion silently incomplete).'
    );
  }
  const applied = status.applied;
  if (applied.length === 0) {
    throw new Error(
      'Database has no applied migrations; refusing to run tenant deletion against an uninitialized schema'
    );
  }
  return applied[applied.length - 1];
}

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  const rows = (result as { rows?: unknown[] } | undefined)?.rows;
  return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
}

function boolValue(value: unknown): boolean {
  return value === true || value === 't' || value === 'true' || value === 1 || value === '1';
}

interface CatalogRelation {
  schemaName: string;
  tableName: string;
  relkind: string;
  rlsEnabled: boolean;
  rlsForced: boolean;
  hasTenantColumn: boolean;
  tenantColumnTextNotNull: boolean;
  hasTenantPolicyMarker: boolean;
  hasTenantIsolationPolicy: boolean;
  participatesInInheritance: boolean;
}

/**
 * Read every non-system ordinary or partitioned relation that claims some part
 * of the tenant contract. Catalog names are used for comparison and diagnostics
 * only; executed deletion SQL never uses them.
 */
async function readTenantCatalog(db: Database): Promise<CatalogRelation[]> {
  const result = await executeRaw(
    db,
    sql`
      SELECT
        n.nspname AS schema_name,
        c.relname AS table_name,
        c.relkind::text AS relkind,
        c.relrowsecurity AS rls_enabled,
        c.relforcerowsecurity AS rls_forced,
        EXISTS (
          SELECT 1
          FROM pg_attribute a
          WHERE a.attrelid = c.oid
            AND a.attname = 'tenant_id'
            AND a.attnum > 0
            AND NOT a.attisdropped
        ) AS has_tenant_column,
        EXISTS (
          SELECT 1
          FROM pg_attribute a
          WHERE a.attrelid = c.oid
            AND a.attname = 'tenant_id'
            AND a.attnum > 0
            AND NOT a.attisdropped
            AND a.atttypid = 'text'::regtype
            AND a.attnotnull
        ) AS tenant_column_text_not_null,
        EXISTS (
          SELECT 1
          FROM pg_policy p
          WHERE p.polrelid = c.oid
            AND (
              p.polname LIKE 'tenant_isolation_%'
              OR COALESCE(pg_get_expr(p.polqual, p.polrelid), '') LIKE '%agor.tenant_id%'
              OR COALESCE(pg_get_expr(p.polwithcheck, p.polrelid), '') LIKE '%agor.tenant_id%'
            )
        ) AS has_tenant_policy_marker,
        EXISTS (
          SELECT 1
          FROM pg_policy p
          WHERE p.polrelid = c.oid
            AND p.polname LIKE 'tenant_isolation_%'
            AND COALESCE(pg_get_expr(p.polqual, p.polrelid), '') LIKE '%agor.tenant_id%'
            AND COALESCE(pg_get_expr(p.polwithcheck, p.polrelid), '') LIKE '%agor.tenant_id%'
        ) AS has_tenant_isolation_policy,
        EXISTS (
          SELECT 1
          FROM pg_inherits i
          WHERE i.inhrelid = c.oid OR i.inhparent = c.oid
        ) AS participates_in_inheritance
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p')
        AND n.nspname <> 'information_schema'
        AND n.nspname NOT LIKE 'pg_%'
        AND (
          c.relforcerowsecurity
          OR EXISTS (
            SELECT 1
            FROM pg_attribute a
            WHERE a.attrelid = c.oid
              AND a.attname = 'tenant_id'
              AND a.attnum > 0
              AND NOT a.attisdropped
          )
          OR EXISTS (
            SELECT 1
            FROM pg_policy p
            WHERE p.polrelid = c.oid
              AND (
                p.polname LIKE 'tenant_isolation_%'
                OR COALESCE(pg_get_expr(p.polqual, p.polrelid), '') LIKE '%agor.tenant_id%'
                OR COALESCE(pg_get_expr(p.polwithcheck, p.polrelid), '') LIKE '%agor.tenant_id%'
              )
          )
        )
    `
  );

  return rowsOf(result).map((row) => ({
    schemaName: String(row.schema_name),
    tableName: String(row.table_name),
    relkind: String(row.relkind),
    rlsEnabled: boolValue(row.rls_enabled),
    rlsForced: boolValue(row.rls_forced),
    hasTenantColumn: boolValue(row.has_tenant_column),
    tenantColumnTextNotNull: boolValue(row.tenant_column_text_not_null),
    hasTenantPolicyMarker: boolValue(row.has_tenant_policy_marker),
    hasTenantIsolationPolicy: boolValue(row.has_tenant_isolation_policy),
    participatesInInheritance: boolValue(row.participates_in_inheritance),
  }));
}

/**
 * Assert the full contract for every catalog relation and reconcile the live set
 * against the typed manifest plus the constant imperative-table registry.
 */
async function auditLiveTenantCatalog(
  db: Database,
  planNames: ReadonlySet<string>
): Promise<ReadonlySet<string>> {
  const relations = await readTenantCatalog(db);
  const liveTenantTables = new Set<string>();

  for (const relation of relations) {
    const qualifiedName = `${relation.schemaName}.${relation.tableName}`;
    if (relation.schemaName !== 'public') {
      throw new TenantDeletionCatalogError(
        `Refusing tenant deletion: tenant-contract relation ${qualifiedName} is outside the public schema`
      );
    }
    if (relation.relkind === 'p') {
      throw new TenantDeletionCatalogError(
        `Refusing tenant deletion: tenant-contract relation ${qualifiedName} is partitioned`
      );
    }
    if (relation.participatesInInheritance) {
      throw new TenantDeletionCatalogError(
        `Refusing tenant deletion: tenant-contract relation ${qualifiedName} participates in table inheritance`
      );
    }
    if (!relation.hasTenantColumn) {
      throw new TenantDeletionCatalogError(
        `Refusing tenant deletion: ${qualifiedName} has forced row security or a tenant-isolation policy but no tenant_id column`
      );
    }
    if (!relation.tenantColumnTextNotNull) {
      throw new TenantDeletionCatalogError(
        `Refusing tenant deletion: ${qualifiedName}.tenant_id must be a NOT NULL text column`
      );
    }
    if (!relation.rlsEnabled || !relation.rlsForced) {
      throw new TenantDeletionCatalogError(
        `Refusing tenant deletion: ${qualifiedName} must enable and force row-level security`
      );
    }
    if (!relation.hasTenantPolicyMarker || !relation.hasTenantIsolationPolicy) {
      throw new TenantDeletionCatalogError(
        `Refusing tenant deletion: ${qualifiedName} lacks a complete tenant_isolation_* policy referencing agor.tenant_id`
      );
    }
    liveTenantTables.add(relation.tableName);
  }

  if (liveTenantTables.size === 0) {
    throw new TenantDeletionCatalogError(
      'Refusing tenant deletion: live-catalog discovery found zero tenant-contract tables'
    );
  }

  const uncovered = [...liveTenantTables].filter((name) => !planNames.has(name)).sort();
  if (uncovered.length > 0) {
    throw new TenantDeletionCatalogError(
      `Refusing tenant deletion: live tenant table(s) are not covered by the deletion plan: ${uncovered.join(', ')}`
    );
  }

  return liveTenantTables;
}

async function countTenantRows(
  db: Database,
  queryBuilder: QueryBuilder,
  entry: TenantDeletionTable,
  tenantId: string,
  byName: Map<string, TenantDeletionTable>
): Promise<number> {
  const condition = buildTenantScopeCondition(queryBuilder, entry, tenantId, byName);
  const rows = (await select(db, { n: count() })
    .from(entry.table)
    .where(condition)
    .all()) as Array<{
    n: number | string | bigint;
  }>;
  return Number(rows[0]?.n ?? 0);
}

async function deleteTenantRows(
  db: Database,
  queryBuilder: QueryBuilder,
  entry: TenantDeletionTable,
  tenantId: string,
  byName: Map<string, TenantDeletionTable>
): Promise<number> {
  const condition = buildTenantScopeCondition(queryBuilder, entry, tenantId, byName);
  const result = (await deleteFrom(db, entry.table).where(condition).run()) as {
    rowsAffected?: number;
  };
  return Number(result?.rowsAffected ?? 0);
}

interface DeletionStep {
  name: string;
  countRows(db: Database, tenantId: string): Promise<number>;
  deleteRows(db: Database, tenantId: string): Promise<void>;
}

function buildManifestStep(
  entry: TenantDeletionTable,
  queryBuilder: QueryBuilder,
  byName: Map<string, TenantDeletionTable>
): DeletionStep {
  return {
    name: entry.name,
    countRows: (db, tenantId) => countTenantRows(db, queryBuilder, entry, tenantId, byName),
    deleteRows: async (db, tenantId) => {
      await deleteTenantRows(db, queryBuilder, entry, tenantId, byName);
    },
  };
}

function buildImperativeStep(table: ImperativeTenantTable): DeletionStep {
  const tableIdentifier = sql.identifier(table.name);
  const tenantColumnIdentifier = sql.identifier(table.tenantColumn);
  return {
    name: table.name,
    countRows: async (db, tenantId) => {
      const result = await executeRaw(
        db,
        sql`SELECT count(*) AS n FROM ${tableIdentifier} WHERE ${tenantColumnIdentifier} = ${tenantId}`
      );
      return Number(rowsOf(result)[0]?.n ?? 0);
    },
    deleteRows: async (db, tenantId) => {
      await executeRaw(
        db,
        sql`DELETE FROM ${tableIdentifier} WHERE ${tenantColumnIdentifier} = ${tenantId}`
      );
    },
  };
}

/**
 * Permanently delete all data for a single tenant, or report what would be
 * deleted when `dryRun` is set. Returns the frozen machine-readable result.
 */
export async function deleteTenantData(
  db: Database,
  tenantId: string,
  options: TenantDeletionOptions = {}
): Promise<TenantDeletionResult | TenantDeletionDryRunResult> {
  assertValidTenantId(tenantId);

  // Refuse to run inside an ambient tenant/system database scope. This routine
  // relies on two independent transactions — phase 1 deletes and commits, phase
  // 2 re-scans committed state. runWithTenantDatabaseScope JOINS an existing
  // scope rather than opening a fresh transaction, so a caller that invokes us
  // within an active scope would collapse both phases into their single
  // uncommitted transaction: verification would then observe uncommitted state
  // and could report success before the outer transaction commits or rolls back.
  if (getCurrentTenantDatabaseScope()) {
    throw new Error(
      'deleteTenantData must run with its own fresh connection, not within an ambient tenant/system database scope.'
    );
  }

  if (!isPostgresDatabase(db)) {
    throw new TenantDeletionUnsupportedError(
      'Tenant deletion requires a PostgreSQL (multi-tenant) database; the SQLite schema is single-tenant'
    );
  }

  const log = options.log ?? (() => {});
  const dryRun = options.dryRun ?? false;
  const manifest = buildTenantDeletionManifest();
  const byName = indexManifest(manifest);
  const queryBuilder = new QueryBuilder();
  const schemaVersion = await resolveSchemaVersion(db);
  const planNames = new Set([
    ...manifest.map((entry) => entry.name),
    ...IMPERATIVE_TENANT_TABLES.map((table) => table.name),
  ]);
  const liveTenantTables = await auditLiveTenantCatalog(db, planNames);
  const presentImperativeTables = IMPERATIVE_TENANT_TABLES.filter((table) =>
    liveTenantTables.has(table.name)
  );
  // Imperative registry entries are leaves whose cascade parents are in the
  // typed manifest, so placing them first preserves children-before-parents.
  const steps: DeletionStep[] = [
    ...presentImperativeTables.map(buildImperativeStep),
    ...manifest.map((entry) => buildManifestStep(entry, queryBuilder, byName)),
  ];
  if (steps.length === 0) {
    throw new TenantDeletionCatalogError(
      'Refusing tenant deletion: the reconciled deletion plan is empty'
    );
  }
  const startedAt = Date.now();

  log(
    `${dryRun ? 'dry-run: ' : ''}tenant deletion started (schemaVersion=${schemaVersion}, tables=${steps.length})`
  );

  const rowCounts: Record<string, number> = {};

  // Phase 1: snapshot per-table counts, then (unless this is a dry run) delete,
  // all inside one tenant-scoped transaction so the deletion is atomic and RLS
  // pins every statement to the tenant.
  //
  // Counts are captured up front, BEFORE any DELETE runs. This keeps the reported
  // rowCounts accurate even when an `ON DELETE CASCADE` from a parent table would
  // otherwise remove a child's rows before that child's own DELETE statement
  // runs. Each row belongs to exactly one table, so the pre-deletion snapshot is
  // precisely the set of rows the operation removes.
  await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
    for (const step of steps) {
      rowCounts[step.name] = await step.countRows(scoped, tenantId);
      if (rowCounts[step.name] > 0) {
        log(
          `${dryRun ? 'would delete' : 'deleting'} ${rowCounts[step.name]} row(s) from ${step.name}`
        );
      }
    }
    if (dryRun) return;
    for (const step of steps) {
      await step.deleteRows(scoped, tenantId);
    }
  });

  // Phase 2: verify committed state in a fresh transaction (skipped for dry-run).
  if (!dryRun) {
    const remaining = await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
      const offending: string[] = [];
      for (const step of steps) {
        const left = await step.countRows(scoped, tenantId);
        if (left > 0) offending.push(step.name);
      }
      return offending;
    });
    assertNoRemainingTenantRows(remaining);
  }

  const durationMs = Date.now() - startedAt;
  const totalRows = Object.values(rowCounts).reduce((sum, value) => sum + value, 0);
  log(
    `${dryRun ? 'dry-run complete' : 'tenant deletion verified'} (${totalRows} row(s) across ${steps.length} tables in ${durationMs}ms)`
  );

  if (dryRun) {
    return { tenantDataDeleted: false, dryRun: true, schemaVersion, rowCounts };
  }
  return { tenantDataDeleted: true, schemaVersion, rowCounts };
}
