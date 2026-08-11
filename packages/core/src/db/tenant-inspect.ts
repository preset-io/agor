/**
 * `inspectTenant` — a bounded, machine-readable inventory and proof of one
 * tenant's footprint across the tenant-owned database rows and the configured
 * tenant filesystem root. It prints counts, hashes, and identifiers only; never
 * row contents, file contents, connection strings, or other secrets.
 *
 * The database identity (dialect, migration ledger, tenant-table set, and a
 * fingerprint over all of it) is derived entirely from the runtime — the
 * compiled tenant manifest and the applied-migration ledger — so the same
 * inventory can be independently recomputed and compared by `verify`.
 */

import type { Database } from './client';
import { resolveTenantDatabaseIdentity, type TenantDatabaseIdentity } from './tenant-catalog';
import { countTenantTableRows } from './tenant-database-io';
import { assertValidTenantId } from './tenant-deletion';
import { summarizeTenantFilesystem, type TenantFilesystemInventory } from './tenant-filesystem';
import { buildTenantInsertOrder } from './tenant-portability-manifest';
import { runWithTenantDatabaseScope } from './tenant-scope';

/** Per-table row count. */
export interface TenantTableCount {
  name: string;
  rowCount: number;
}

/** Bounded machine-readable inventory of a tenant. Contains no secrets. */
export interface TenantInspectionResult {
  tenantId: string;
  database: {
    dialect: 'postgresql';
    schemaVersion: string;
    migrationCount: number;
    /** Number of movable tenant-owned tables. */
    tenantTableCount: number;
    /** Movable tables and their tenant row counts, sorted by name. */
    tables: TenantTableCount[];
    /** Derived (imperative) tables present in the catalog and their counts. */
    derivedTables: TenantTableCount[];
    /** Sum of movable-table row counts. */
    totalRows: number;
    /** Runtime-derived identity fingerprint (schema + migrations + tables). */
    identityFingerprint: string;
  };
  filesystem: {
    /** Whether a tenant filesystem root was supplied for inspection. */
    inspected: boolean;
    inventory: TenantFilesystemInventory | null;
  };
}

export interface TenantInspectionOptions {
  /**
   * Absolute tenant filesystem root to inventory (as resolved by
   * `getTenantDataRoot(tenantId)`). Omit to inspect the database only.
   */
  filesystemRoot?: string;
}

/**
 * Collect per-tenant row counts for the movable tables and any present derived
 * tables, plus the runtime identity, inside a single tenant database scope.
 */
export async function collectTenantDatabaseCounts(
  db: Database,
  tenantId: string,
  identity: TenantDatabaseIdentity
): Promise<{ tables: TenantTableCount[]; derivedTables: TenantTableCount[]; totalRows: number }> {
  const insertOrder = buildTenantInsertOrder();
  return runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
    const tables: TenantTableCount[] = [];
    let totalRows = 0;
    for (const table of insertOrder) {
      const rowCount = await countTenantTableRows(scoped, table.name, tenantId, table.tenantColumn);
      tables.push({ name: table.name, rowCount });
      totalRows += rowCount;
    }
    tables.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    const derivedTables: TenantTableCount[] = [];
    for (const name of identity.presentImperativeTables) {
      const rowCount = await countTenantTableRows(scoped, name, tenantId);
      derivedTables.push({ name, rowCount });
    }
    return { tables, derivedTables, totalRows };
  });
}

/**
 * Produce the bounded inventory/proof for a single tenant. Validates the tenant
 * id, resolves the runtime database identity (failing closed on schema drift),
 * counts every tenant-owned table, and — when a filesystem root is provided —
 * summarises the tenant filesystem tree without reading file contents.
 */
export async function inspectTenant(
  db: Database,
  tenantId: string,
  options: TenantInspectionOptions = {}
): Promise<TenantInspectionResult> {
  assertValidTenantId(tenantId);
  const identity = await resolveTenantDatabaseIdentity(db);
  const { tables, derivedTables, totalRows } = await collectTenantDatabaseCounts(
    db,
    tenantId,
    identity
  );

  const inspected = typeof options.filesystemRoot === 'string';
  const inventory = inspected
    ? await summarizeTenantFilesystem(options.filesystemRoot as string)
    : null;

  return {
    tenantId,
    database: {
      dialect: identity.dialect,
      schemaVersion: identity.schemaVersion,
      migrationCount: identity.migrations.length,
      tenantTableCount: tables.length,
      tables,
      derivedTables,
      totalRows,
      identityFingerprint: identity.fingerprint,
    },
    filesystem: { inspected, inventory },
  };
}
