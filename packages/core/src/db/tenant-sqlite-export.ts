/**
 * Read a single-tenant SQLite install as tenant-archive rows that are
 * byte-identical to what PostgreSQL's `to_jsonb(row)::text` produces for the
 * same data, so a self-hosted SQLite install can be exported with
 * `agor tenant export` and imported into a PostgreSQL (Cloud) runtime.
 *
 * The PostgreSQL schema is the contract: every movable table and column comes
 * from `schema.postgres.ts`, values are coerced to the PostgreSQL column type
 * (booleans from 0/1, JSON text parsed, epoch-ms timestamps rendered as
 * `timestamptz` text, bytea as `\x…`), `tenant_id` is injected, and objects
 * are rendered with jsonb's key order (shorter keys first, then bytewise) and
 * separators. Lines are ordered bytewise, matching the PostgreSQL export's
 * `ORDER BY … COLLATE "C"`.
 */

import { is, sql } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { getTableConfig as getSqliteTableConfig, SQLiteTable } from 'drizzle-orm/sqlite-core';
import type { Database } from './client';
import { executeRaw } from './database-wrapper';
import * as postgresSchema from './schema.postgres';
import * as sqliteSchema from './schema.sqlite';
import { TENANT_WRITE_GATE_KEY, TENANT_WRITE_GATE_NAMESPACE } from './tenant-write-gate';

const PAGE_SIZE = 2_000;

function compareJsonbKeys(a: string, b: string): number {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length - right.length || Buffer.compare(left, right);
}

/** Render a JSON value exactly as PostgreSQL renders jsonb as text. */
export function canonicalJsonbText(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Non-finite number cannot be stored as jsonb');
    return JSON.stringify(value);
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return `[${value.map(canonicalJsonbText).join(', ')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort(compareJsonbKeys);
    return `{${keys.map((key) => `${JSON.stringify(key)}: ${canonicalJsonbText(record[key])}`).join(', ')}}`;
  }
  throw new Error(`Unsupported value type: ${typeof value}`);
}

/** `timestamptz` → jsonb text in a UTC session: `YYYY-MM-DDTHH:MM:SS[.fff]+00:00`. */
export function timestamptzJsonText(epochMs: number): string {
  const date = new Date(epochMs);
  const iso = date.toISOString(); // YYYY-MM-DDTHH:MM:SS.sssZ
  const millis = date.getUTCMilliseconds();
  const fraction = millis === 0 ? '' : `.${String(millis).padStart(3, '0').replace(/0+$/, '')}`;
  return `${iso.slice(0, 19)}${fraction}+00:00`;
}

type ColumnKind = 'text' | 'integer' | 'boolean' | 'json' | 'timestamptz' | 'timestamp' | 'bytea';

function columnKind(column: {
  columnType: string;
  withTimezone?: boolean;
  name: string;
}): ColumnKind {
  switch (column.columnType) {
    case 'PgText':
    case 'PgVarchar':
    case 'PgChar':
    case 'PgUUID':
      return 'text';
    case 'PgInteger':
    case 'PgBigInt53':
    case 'PgBigInt64':
    case 'PgSmallInt':
    case 'PgSerial':
    case 'PgReal':
    case 'PgDoublePrecision':
    case 'PgNumeric':
      return 'integer';
    case 'PgBoolean':
      return 'boolean';
    case 'PgJsonb':
    case 'PgJson':
      return 'json';
    case 'PgTimestamp':
    case 'PgTimestampString':
      return column.withTimezone ? 'timestamptz' : 'timestamp';
    case 'PgCustomColumn':
      return 'bytea';
    default:
      throw new Error(
        `Unsupported PostgreSQL column type for ${column.name}: ${column.columnType}`
      );
  }
}

interface TableShape {
  name: string;
  columns: Array<{ name: string; kind: ColumnKind; sqliteSeconds: boolean }>;
  sqliteColumns: Set<string>;
}

let shapes: Map<string, TableShape> | null = null;

function tableShapes(): Map<string, TableShape> {
  if (shapes) return shapes;
  const sqliteColumnsByTable = new Map<string, Map<string, { mode?: string }>>();
  for (const value of Object.values(sqliteSchema)) {
    if (!is(value, SQLiteTable)) continue;
    const config = getSqliteTableConfig(value);
    sqliteColumnsByTable.set(
      config.name,
      new Map(config.columns.map((column) => [column.name, column as unknown as { mode?: string }]))
    );
  }
  const out = new Map<string, TableShape>();
  for (const value of Object.values(postgresSchema)) {
    if (!is(value, PgTable)) continue;
    const config = getTableConfig(value);
    const sqliteColumns = sqliteColumnsByTable.get(config.name) ?? new Map();
    out.set(config.name, {
      name: config.name,
      sqliteColumns: new Set(sqliteColumns.keys()),
      columns: config.columns.map((column) => ({
        name: column.name,
        kind: columnKind(
          column as unknown as { columnType: string; withTimezone?: boolean; name: string }
        ),
        sqliteSeconds: sqliteColumns.get(column.name)?.mode === 'timestamp',
      })),
    });
  }
  shapes = out;
  return out;
}

function toEpochMs(raw: unknown, seconds: boolean): number {
  if (typeof raw === 'number') return seconds ? raw * 1000 : raw;
  if (typeof raw === 'bigint') return Number(raw) * (seconds ? 1000 : 1);
  if (typeof raw === 'string') {
    const numeric = Number(raw);
    if (raw.trim() !== '' && Number.isFinite(numeric)) return seconds ? numeric * 1000 : numeric;
    const parsed = Date.parse(
      raw.includes('T') || raw.endsWith('Z') ? raw : `${raw.replace(' ', 'T')}Z`
    );
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new Error(`Unreadable timestamp value: ${String(raw)}`);
}

function coerce(raw: unknown, kind: ColumnKind, sqliteSeconds: boolean): unknown {
  if (raw === null || raw === undefined) return null;
  switch (kind) {
    case 'text':
      return typeof raw === 'string' ? raw : String(raw);
    case 'integer':
      return typeof raw === 'bigint' ? raw : Number(raw);
    case 'boolean':
      return typeof raw === 'boolean' ? raw : Number(raw) !== 0;
    case 'json':
      return typeof raw === 'string' ? JSON.parse(raw) : raw;
    case 'timestamptz':
      return { __agorTimestamp: timestamptzJsonText(toEpochMs(raw, sqliteSeconds)) };
    case 'timestamp':
      return {
        __agorTimestamp: timestamptzJsonText(toEpochMs(raw, sqliteSeconds)).replace(/\+00:00$/, ''),
      };
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

/** Encode one SQLite row as the PostgreSQL `to_jsonb(row)::text` line. */
export function encodeSqliteTenantRow(
  tableName: string,
  row: Record<string, unknown>,
  tenantId: string
): string {
  const shape = tableShapes().get(tableName);
  if (!shape) throw new Error(`Unknown tenant table: ${tableName}`);
  const parts = shape.columns
    .map((column) => column.name)
    .sort(compareJsonbKeys)
    .map((name) => {
      const column = shape.columns.find((c) => c.name === name)!;
      let text: string;
      if (name === 'tenant_id' && !shape.sqliteColumns.has('tenant_id')) {
        text = JSON.stringify(tenantId);
      } else {
        const value = coerce(row[name], column.kind, column.sqliteSeconds);
        text =
          value && typeof value === 'object' && '__agorTimestamp' in value
            ? JSON.stringify((value as { __agorTimestamp: string }).__agorTimestamp)
            : canonicalJsonbText(value);
      }
      return `${JSON.stringify(name)}: ${text}`;
    });
  return `{${parts.join(', ')}}`;
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
 * `tenantId` and sorted bytewise. Rows are read in bounded pages; the sorted
 * lines of one table are held in memory.
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
  const sorted = lines
    .map((line) => ({ line, bytes: Buffer.from(line, 'utf8') }))
    .sort((a, b) => Buffer.compare(a.bytes, b.bytes))
    .map((entry) => entry.line);
  return { lines: sorted };
}

/** Whether a table exists in the SQLite file (imperative tables may not). */
export async function sqliteTableExists(db: Database, tableName: string): Promise<boolean> {
  const result = await executeRaw(
    db,
    sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${tableName}`
  );
  return rowObjects(result).length > 0;
}
