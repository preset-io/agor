/**
 * Read a single-tenant SQLite install as tenant-archive rows, so a self-hosted
 * SQLite install can be exported with `agor tenant export` and imported into a
 * PostgreSQL (Cloud) runtime.
 *
 * Import populates each line into the PostgreSQL row type
 * (`jsonb_populate_record`) and re-canonicalises it there, so a line only has
 * to carry values PostgreSQL parses for each column of `schema.postgres.ts`:
 * booleans from 0/1, JSON columns as JSON (not text), epoch-ms timestamps as
 * ISO strings, bytea as `\x…`, and the exported `tenant_id`.
 */

import { is, sql } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import type { Database } from './client';
import { executeRaw } from './database-wrapper';
import * as postgresSchema from './schema.postgres';
import { TENANT_WRITE_GATE_KEY, TENANT_WRITE_GATE_NAMESPACE } from './tenant-write-gate';

const PAGE_SIZE = 2_000;

type ColumnKind = 'value' | 'boolean' | 'json' | 'timestamp' | 'bytea';

function columnKind(columnType: string): ColumnKind {
  switch (columnType) {
    case 'PgBoolean':
      return 'boolean';
    case 'PgJsonb':
    case 'PgJson':
      return 'json';
    case 'PgTimestamp':
    case 'PgTimestampString':
      return 'timestamp';
    case 'PgCustomColumn':
      return 'bytea';
    default:
      return 'value';
  }
}

let shapes: Map<string, Array<{ name: string; kind: ColumnKind }>> | null = null;

function tableColumns(tableName: string): Array<{ name: string; kind: ColumnKind }> {
  if (!shapes) {
    shapes = new Map();
    for (const value of Object.values(postgresSchema)) {
      if (!is(value, PgTable)) continue;
      const config = getTableConfig(value);
      shapes.set(
        config.name,
        config.columns.map((column) => ({
          name: column.name,
          kind: columnKind(column.columnType),
        }))
      );
    }
  }
  const columns = shapes.get(tableName);
  if (!columns) throw new Error(`Unknown tenant table: ${tableName}`);
  return columns;
}

/** SQLite stores timestamps as epoch ms; a few legacy rows hold `datetime('now')` text. */
function toEpochMs(raw: unknown): number {
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'bigint') return Number(raw);
  if (typeof raw === 'string') {
    const numeric = Number(raw);
    if (raw.trim() !== '' && Number.isFinite(numeric)) return numeric;
    const parsed = Date.parse(
      raw.includes('T') || raw.endsWith('Z') ? raw : `${raw.replace(' ', 'T')}Z`
    );
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new Error(`Unreadable timestamp value: ${String(raw)}`);
}

function coerce(raw: unknown, kind: ColumnKind): unknown {
  if (raw === null || raw === undefined) return null;
  switch (kind) {
    case 'value':
      // PostgreSQL parses a JSON string into any column type losslessly.
      return typeof raw === 'bigint' ? raw.toString() : raw;
    case 'boolean':
      return typeof raw === 'boolean' ? raw : Number(raw) !== 0;
    case 'json':
      return typeof raw === 'string' ? JSON.parse(raw) : raw;
    case 'timestamp':
      return new Date(toEpochMs(raw)).toISOString();
    case 'bytea': {
      const bytes =
        raw instanceof ArrayBuffer
          ? Buffer.from(raw)
          : ArrayBuffer.isView(raw)
            ? Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)
            : Buffer.from(String(raw), 'utf8');
      return `\\x${bytes.toString('hex')}`;
    }
  }
}

/** Encode one SQLite row as an archive line for the PostgreSQL table. */
export function encodeSqliteTenantRow(
  tableName: string,
  row: Record<string, unknown>,
  tenantId: string
): string {
  const out: Record<string, unknown> = {};
  for (const column of tableColumns(tableName)) {
    out[column.name] =
      column.name === 'tenant_id' ? tenantId : coerce(row[column.name], column.kind);
  }
  return JSON.stringify(out);
}

function rowObjects(result: unknown): Array<Record<string, unknown>> {
  const set = result as { rows?: unknown[]; columns?: string[] };
  const rows = Array.isArray(result) ? result : (set.rows ?? []);
  const columns = set.columns;
  return rows.map((row) => {
    if (!columns || !Array.isArray(row)) {
      // libsql rows are array-like objects that also expose column names.
      if (columns) {
        const indexed = row as Record<string | number, unknown>;
        return Object.fromEntries(
          columns.map((name, index) => [name, indexed[index] ?? indexed[name]])
        );
      }
      return row as Record<string, unknown>;
    }
    return Object.fromEntries(columns.map((name, index) => [name, (row as unknown[])[index]]));
  });
}

/**
 * Every row of one table in a single-tenant SQLite database, encoded for
 * `tenantId` in rowid order. Rows are read in bounded pages; the lines of one
 * table are held in memory.
 */
export async function exportSqliteTenantTableRows(
  db: Database,
  tableName: string,
  tenantId: string
): Promise<{ lines: string[] }> {
  if (!/^[a-z_][a-z0-9_]*$/.test(tableName)) throw new Error(`Unsafe table name: ${tableName}`);
  const lines: string[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const result = await executeRaw(
      db,
      sql`SELECT * FROM ${sql.identifier(tableName)} ORDER BY rowid LIMIT ${PAGE_SIZE} OFFSET ${offset}`
    );
    const rows = rowObjects(result);
    for (const row of rows) {
      if (
        tableName === 'app_variables' &&
        row.namespace === TENANT_WRITE_GATE_NAMESPACE &&
        row.key === TENANT_WRITE_GATE_KEY
      ) {
        continue;
      }
      lines.push(encodeSqliteTenantRow(tableName, row, tenantId));
    }
    if (rows.length < PAGE_SIZE) break;
  }
  return { lines };
}

/** Whether a table exists in the SQLite file (imperative tables may not). */
export async function sqliteTableExists(db: Database, tableName: string): Promise<boolean> {
  const result = await executeRaw(
    db,
    sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${tableName}`
  );
  return rowObjects(result).length > 0;
}
