/**
 * Type-faithful, deterministic movement of a single tenant's rows in and out of
 * the archive, one table at a time. Rows are read with PostgreSQL's own
 * `to_jsonb(row)` and restored with `jsonb_populate_recordset(NULL::table, ...)`,
 * so every column type round-trips through the server's own input/output
 * functions rather than lossy JavaScript coercion.
 *
 * All statements are tenant-scoped: an explicit `WHERE tenant_id = $1` predicate
 * plus the ambient row-level-security policy, and — on restore — every row's
 * tenant discriminator is rewritten to the destination tenant so the RLS
 * `WITH CHECK` clause admits it. Reads are ordered by the canonical text of each
 * row so an unchanged table exports to identical bytes every time.
 *
 * These helpers must run inside an active tenant database scope
 * (`runWithTenantDatabaseScope`); the caller owns the transaction boundary.
 */

import { sql } from 'drizzle-orm';
import type { Database } from './client';
import { executeRaw } from './database-wrapper';
import {
  canonicalJson,
  readTableJsonl,
  sha256Hex,
  type TenantArchiveTable,
} from './tenant-archive';
import { buildTenantInsertOrder } from './tenant-portability-manifest';
import { TENANT_WRITE_GATE_KEY, TENANT_WRITE_GATE_NAMESPACE } from './tenant-write-gate';

const TENANT_SCHEMA = 'public';
const TENANT_SCOPE_COLUMN = 'tenant_id';

/** Rows are inserted in batches to bound statement/parameter size. */
const IMPORT_BATCH_SIZE = 500;

/**
 * Deterministic, cross-runtime ordering key for a tenant table export. Rows are
 * ordered by the canonical text of `to_jsonb(row)` under the byte-wise
 * `COLLATE "C"` collation. The explicit collation is load-bearing: without it,
 * PostgreSQL orders text under the database's default locale/ICU collation, so
 * two runtimes with different `lc_collate` (or ICU versions) could order the
 * same rows differently and produce diverging per-table content hashes for
 * identical data. Pinning `COLLATE "C"` makes the export byte order — and thus
 * the archive fingerprint — depend only on the row bytes, never on the server
 * locale. Exported so a test can assert the collation is present in the query.
 */
export const TENANT_EXPORT_ORDER_BY = sql`ORDER BY pg_catalog.to_jsonb(t)::pg_catalog.text COLLATE "C"`;

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  const rows = (result as { rows?: unknown[] } | undefined)?.rows;
  return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
}

function qualifiedTable(name: string) {
  return sql`${sql.identifier(TENANT_SCHEMA)}.${sql.identifier(name)}`;
}

/** Count the rows a table holds for one tenant. */
export async function countTenantTableRows(
  db: Database,
  tableName: string,
  tenantId: string,
  tenantColumn: string = TENANT_SCOPE_COLUMN
): Promise<number> {
  const column = sql.identifier(tenantColumn);
  // Exclude the reserved write-gate record so inspect's inventory matches what
  // export/verify account for (both drop this row); see exportTenantTableRows.
  const excludeGateRow =
    tableName === 'app_variables'
      ? sql` AND NOT (namespace = ${TENANT_WRITE_GATE_NAMESPACE} AND key = ${TENANT_WRITE_GATE_KEY})`
      : sql``;
  const result = await executeRaw(
    db,
    sql`SELECT pg_catalog.count(*) AS n FROM ${qualifiedTable(tableName)} WHERE ${column} = ${tenantId}${excludeGateRow}`
  );
  return Number(rowsOf(result)[0]?.n ?? 0);
}

/**
 * Read every row a table holds for one tenant as canonical JSON lines (JSONL),
 * ordered deterministically. Returns the serialized text and the row count.
 */
export async function exportTenantTableRows(
  db: Database,
  tableName: string,
  tenantId: string,
  tenantColumn: string = TENANT_SCOPE_COLUMN
): Promise<{ jsonl: string; rowCount: number }> {
  const column = sql.identifier(tenantColumn);
  // The reserved per-tenant write-gate record (a single row in `app_variables`)
  // is live orchestration state, not tenant data: it carries a wall-clock
  // `acquiredAt` and a per-run `generation`, so archiving it would break
  // export determinism, and restoring it would leave the destination frozen at
  // the source's generation. Exclude it here so export, verify (live re-export
  // compare), and import classification — all of which call this function —
  // agree that the gate row is never part of the archive.
  const excludeGateRow =
    tableName === 'app_variables'
      ? sql` AND NOT (namespace = ${TENANT_WRITE_GATE_NAMESPACE} AND key = ${TENANT_WRITE_GATE_KEY})`
      : sql``;
  const result = await executeRaw(
    db,
    sql`
      SELECT pg_catalog.to_jsonb(t) AS row
      FROM ${qualifiedTable(tableName)} t
      WHERE ${column} = ${tenantId}${excludeGateRow}
      ${TENANT_EXPORT_ORDER_BY}
    `
  );
  const rows = rowsOf(result);
  // postgres.js parses jsonb into a JS value; the shared serializer canonicalises
  // each row for stable bytes — the same path re-home derivation uses, so export
  // and classification bytes cannot drift.
  const jsonl = serializeTenantTableJsonl(
    rows.map((record) => record.row as Record<string, unknown>)
  );
  return { jsonl, rowCount: rows.length };
}

/** One live tenant table's re-derived row count and content hash. */
export interface TenantTableSnapshot {
  name: string;
  rowCount: number;
  /** SHA-256 hex of the canonical JSONL bytes of this table's tenant rows. */
  sha256: string;
}

/**
 * Re-derive every movable tenant table's row count and content hash from the
 * live database for one tenant, in deterministic insert order — the minimal
 * shared basis both import (destination classification) and verify (drift
 * detection) build on. Must run inside an active tenant database scope; the
 * caller owns comparison and evidence aggregation.
 */
export async function snapshotTenantTableHashes(
  scoped: Database,
  tenantId: string
): Promise<TenantTableSnapshot[]> {
  const snapshots: TenantTableSnapshot[] = [];
  for (const table of buildTenantInsertOrder()) {
    const { jsonl, rowCount } = await exportTenantTableRows(
      scoped,
      table.name,
      tenantId,
      table.tenantColumn
    );
    snapshots.push({ name: table.name, rowCount, sha256: sha256Hex(Buffer.from(jsonl, 'utf8')) });
  }
  return snapshots;
}

/**
 * The SHA-256 of an empty (zero-row) table export — the hash
 * {@link snapshotTenantTableHashes} yields for a table with no tenant rows.
 */
const EMPTY_TABLE_SHA256 = sha256Hex(Buffer.from('', 'utf8'));

/**
 * Serialise a table's tenant rows to the exact canonical JSONL bytes an export
 * writes: one {@link canonicalJson} line per row, newline-separated with a
 * trailing newline, or empty for zero rows. Shared by the archive reader (source
 * bytes on export) and re-home derivation so their byte semantics cannot drift.
 */
export function serializeTenantTableJsonl(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '';
  return `${rows.map((row) => canonicalJson(row)).join('\n')}\n`;
}

/**
 * Derive, from the validated archive alone, the per-table row count and content
 * hash the destination database will hold once {@link parseTenantJsonl} rewrites
 * every row to `destinationTenantId` and it is restored. This applies the SAME
 * tenant-id rewrite and canonical serialization `restoreDatabase` uses, so the
 * result is the exact snapshot a post-restore {@link snapshotTenantTableHashes}
 * re-derives — for a same-tenant import the rewrite is the identity, so it equals
 * the archive's own per-table hashes; for a re-home it is the hash bound to the
 * destination tenant id. Import classification compares live snapshots against
 * these to prove an exact (possibly re-homed) restore, so a database committed
 * before a filesystem-tail failure is recognised as already applied on retry.
 *
 * Row ORDER is preserved from the archive, which the export ordered by the
 * server's `to_jsonb(row)::text COLLATE "C"`. Rewriting the tenant discriminator
 * to a single destination value uniformly (an equal contribution to every row's
 * ordering key) cannot reorder two distinct rows, so the archive order equals the
 * order a live re-export of the rewritten rows produces — the bytes, and thus the
 * hash, match exactly. Any mismatch is fail-closed: it classifies as a conflict.
 */
export async function deriveExpectedTenantTableSnapshots(
  archivePath: string,
  archivedTables: readonly TenantArchiveTable[],
  destinationTenantId: string
): Promise<TenantTableSnapshot[]> {
  const archivedByName = new Map(archivedTables.map((table) => [table.name, table]));
  const snapshots: TenantTableSnapshot[] = [];
  for (const table of buildTenantInsertOrder()) {
    const archived = archivedByName.get(table.name);
    if (!archived || archived.rowCount === 0) {
      snapshots.push({ name: table.name, rowCount: 0, sha256: EMPTY_TABLE_SHA256 });
      continue;
    }
    const jsonl = await readTableJsonl(archivePath, table.name);
    const rows = parseTenantJsonl(jsonl, destinationTenantId);
    const bytes = serializeTenantTableJsonl(rows);
    snapshots.push({
      name: table.name,
      rowCount: rows.length,
      sha256: sha256Hex(Buffer.from(bytes, 'utf8')),
    });
  }
  return snapshots;
}

/**
 * Parse JSONL text into row objects, rewriting each row's tenant discriminator
 * to the destination tenant. Rejects lines that are not JSON objects.
 */
export function parseTenantJsonl(
  jsonl: string,
  destinationTenantId: string
): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  const lines = jsonl.split('\n');
  for (const line of lines) {
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error('Archive database file contains a line that is not valid JSON');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('Archive database file contains a row that is not a JSON object');
    }
    const row = parsed as Record<string, unknown>;
    row[TENANT_SCOPE_COLUMN] = destinationTenantId;
    rows.push(row);
  }
  return rows;
}

/**
 * Insert tenant rows into a table using the table's own row type to reconstruct
 * every column value. Rows must already be scoped to the destination tenant
 * (see {@link parseTenantJsonl}). Returns the number of rows inserted.
 */
export async function insertTenantTableRows(
  db: Database,
  tableName: string,
  rows: Record<string, unknown>[]
): Promise<number> {
  let inserted = 0;
  for (let offset = 0; offset < rows.length; offset += IMPORT_BATCH_SIZE) {
    const chunk = rows.slice(offset, offset + IMPORT_BATCH_SIZE);
    const payload = JSON.stringify(chunk);
    await executeRaw(
      db,
      sql`
        INSERT INTO ${qualifiedTable(tableName)}
        SELECT * FROM pg_catalog.jsonb_populate_recordset(
          NULL::${qualifiedTable(tableName)},
          ${payload}::pg_catalog.jsonb
        )
      `
    );
    inserted += chunk.length;
  }
  return inserted;
}
