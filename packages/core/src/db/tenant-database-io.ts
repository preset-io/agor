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
import { canonicalJson } from './tenant-archive';
import { TENANT_WRITE_GATE_KEY, TENANT_WRITE_GATE_NAMESPACE } from './tenant-write-gate';

const TENANT_SCHEMA = 'public';
const TENANT_SCOPE_COLUMN = 'tenant_id';

/** Rows are inserted in batches to bound statement/parameter size. */
const IMPORT_BATCH_SIZE = 500;

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
      ORDER BY pg_catalog.to_jsonb(t)::pg_catalog.text
    `
  );
  const rows = rowsOf(result);
  const lines: string[] = [];
  for (const record of rows) {
    // postgres.js parses jsonb into a JS value; canonicalise for stable bytes.
    lines.push(canonicalJson(record.row));
  }
  return {
    jsonl: lines.length > 0 ? `${lines.join('\n')}\n` : '',
    rowCount: lines.length,
  };
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
