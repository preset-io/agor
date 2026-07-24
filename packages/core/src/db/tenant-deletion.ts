/**
 * Permanent, audited, idempotent deletion of all data belonging to a single
 * tenant.
 *
 * Operators of a multi-tenant Agor deployment need a verifiable way to remove a
 * tenant entirely (offboarding, data-removal requests, regulatory erasure). This
 * module performs that removal against the runtime-derived
 * {@link buildTenantDeletionManifest tenant manifest}:
 *
 *   1. Validate the tenant id (refuse empty / whitespace / wildcard values).
 *   2. Delete every tenant-scoped row inside a single tenant-scoped transaction,
 *      children before parents, so foreign keys are never violated.
 *   3. Re-scan the whole manifest in a fresh transaction and fail unless zero
 *      rows remain for the tenant.
 *
 * Running it twice on the same tenant is safe: the second run deletes zero rows
 * and still reports success. Multi-tenancy is PostgreSQL-only, so the command
 * refuses to run against a SQLite database.
 *
 * Precondition — quiesce the tenant first: this operation verifies tenant state
 * at scan time; it does not by itself fence out a concurrent writer. The
 * operator must disable/quiesce the tenant (stop new tenant-scoped work at the
 * control/auth layer) BEFORE running, otherwise a writer active during or after
 * verification can recreate tenant rows that the verification pass will not see.
 *
 * The result object is a frozen machine-readable contract (see
 * {@link TenantDeletionResult}) intended to be parsed by external automation. It
 * contains only booleans, numbers, and identifier strings — never row content,
 * connection strings, or other secrets.
 */

import { count } from 'drizzle-orm';
import { QueryBuilder } from 'drizzle-orm/pg-core';
import type { Database } from './client';
import { deleteFrom, isPostgresDatabase, select } from './database-wrapper';
import { checkMigrationStatus } from './migrate';
import {
  buildTenantDeletionManifest,
  buildTenantScopeCondition,
  indexManifest,
  type TenantDeletionTable,
} from './tenant-deletion-manifest';
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
  /** Rows deleted per table. Every manifest table is present, even at zero. */
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

/**
 * Validate a tenant id, refusing empty, whitespace-only, whitespace-padded, and
 * wildcard-like values. A concrete id such as `default` or a UUID is accepted.
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
  // Fail closed unless the schema is in lockstep in BOTH directions: the binary's
  // compiled schema (and thus the deletion manifest) must match exactly the
  // schema the database currently has applied. That requires !dbAheadOfBinary AND
  // !hasPending.
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
        "the running binary's schema does not match the database. " +
        'Run migrations so the binary and database schemas match before deleting a tenant ' +
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
  const startedAt = Date.now();

  log(
    `${dryRun ? 'dry-run: ' : ''}tenant deletion started (schemaVersion=${schemaVersion}, tables=${manifest.length})`
  );

  const rowCounts: Record<string, number> = {};

  // Phase 1: snapshot per-table counts, then (unless this is a dry run) delete,
  // all inside one tenant-scoped transaction so the deletion is atomic and RLS
  // pins every statement to the tenant.
  //
  // Counts are captured up front, BEFORE any DELETE runs. This keeps the reported
  // rowCounts accurate even when an `ON DELETE CASCADE` from a parent table would
  // otherwise remove a child's rows before that child's own DELETE statement runs
  // (deletion order only constrains blocking foreign keys, so a cascade parent can
  // legitimately be deleted first). Each row belongs to exactly one table, so the
  // pre-deletion snapshot is precisely the set of rows the operation removes.
  await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
    for (const entry of manifest) {
      rowCounts[entry.name] = await countTenantRows(scoped, queryBuilder, entry, tenantId, byName);
      if (rowCounts[entry.name] > 0) {
        log(
          `${dryRun ? 'would delete' : 'deleting'} ${rowCounts[entry.name]} row(s) from ${entry.name}`
        );
      }
    }
    if (dryRun) return;
    for (const entry of manifest) {
      await deleteTenantRows(scoped, queryBuilder, entry, tenantId, byName);
    }
  });

  // Phase 2: verify committed state in a fresh transaction (skipped for dry-run).
  if (!dryRun) {
    const remaining = await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
      const offending: string[] = [];
      for (const entry of manifest) {
        const left = await countTenantRows(scoped, queryBuilder, entry, tenantId, byName);
        if (left > 0) offending.push(entry.name);
      }
      return offending;
    });
    assertNoRemainingTenantRows(remaining);
  }

  const durationMs = Date.now() - startedAt;
  const totalRows = Object.values(rowCounts).reduce((sum, value) => sum + value, 0);
  log(
    `${dryRun ? 'dry-run complete' : 'tenant deletion verified'} (${totalRows} row(s) across ${manifest.length} tables in ${durationMs}ms)`
  );

  if (dryRun) {
    return { tenantDataDeleted: false, dryRun: true, schemaVersion, rowCounts };
  }
  return { tenantDataDeleted: true, schemaVersion, rowCounts };
}
