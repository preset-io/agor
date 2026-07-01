/**
 * Database Wrapper with Unified Query API
 *
 * Provides a unified, dialect-agnostic API for database operations.
 * All dialect differences are handled internally, so repository code
 * can use a single consistent interface for both SQLite and PostgreSQL.
 *
 * Key Pattern: Instead of writing:
 *   const row = isSQLiteDatabase(db) ? await query.get() : (await query)[0];
 *
 * Simply write:
 *   const row = await db.execute(query).one();
 *
 * This wrapper returns augmented query builders with unified execution methods.
 */

import { type SQL, sql } from 'drizzle-orm';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import type { Database } from './client';
import type * as postgresSchema from './schema.postgres';
import type * as sqliteSchema from './schema.sqlite';
import { getCurrentTenantId } from './tenant-context';

/**
 * Cast a Drizzle transaction handle to the unified Database type.
 *
 * Drizzle transaction callbacks receive dialect-specific types (LibSQLTransaction / PostgresJsTransaction)
 * that aren't assignable to `Database` (LibSQLDatabase | PostgresJsDatabase). The wrapper functions
 * in this module (`select`, `update`, `lockRowForUpdate`, etc.) accept `Database`, so this helper
 * centralizes the unavoidable double-cast instead of repeating `tx as unknown as Database` everywhere.
 */
export function txAsDb(tx: unknown): Database {
  return tx as unknown as Database;
}

/**
 * Result of a mutation query (INSERT/UPDATE/DELETE)
 */
export interface MutationResult {
  rowsAffected: number;
}

/**
 * Unified query executor with dialect-aware methods
 */
export interface UnifiedQuery<T = unknown> {
  /** Get a single row (returns null if not found) */
  one(): Promise<T | null>;
  /** Get all rows */
  all(): Promise<T[]>;
  /** Execute mutation (INSERT/UPDATE/DELETE) and return result */
  run(): Promise<MutationResult>;
  /** Get first row from .returning() clause */
  returning(): UnifiedReturning<T>;
}

/**
 * Unified returning clause handler
 */
export interface UnifiedReturning<T = unknown> {
  /** Get first returned row */
  one(): Promise<T>;
  /** Get all returned rows */
  all(): Promise<T[]>;
}

/**
 * Type guard to check if database is SQLite
 */
export function isSQLiteDatabase(db: Database): db is LibSQLDatabase<typeof sqliteSchema> {
  // Check for SQLite-specific method
  return 'run' in db && typeof (db as LibSQLDatabase<typeof sqliteSchema>).run === 'function';
}

/**
 * Type guard to check if database is PostgreSQL
 */
export function isPostgresDatabase(db: Database): db is PostgresJsDatabase<typeof postgresSchema> {
  // PostgreSQL doesn't have .run() method
  return !('run' in db);
}

/**
 * Create a JSON path extraction SQL expression that works for both SQLite and PostgreSQL
 *
 * @param db - Database instance
 * @param column - The JSONB/JSON column to extract from
 * @param path - Dot-separated path (e.g., 'genealogy.parent_session_id')
 * @returns SQL expression for extracting the value as text
 *
 * @example
 * // SQLite: json_extract(column, '$.genealogy.parent_session_id')
 * // PostgreSQL: column->'genealogy'->>'parent_session_id'
 * jsonExtract(db, sessions.data, 'genealogy.parent_session_id')
 */
// biome-ignore lint/suspicious/noExplicitAny: Drizzle columns have complex union types that are difficult to represent
export function jsonExtract(db: Database, column: SQL.Aliased | SQL | any, path: string): SQL {
  const parts = path.split('.');

  if (isSQLiteDatabase(db)) {
    // SQLite: json_extract(column, '$.path.to.field')
    return sql`json_extract(${column}, ${`$.${path}`})`;
  } else {
    // PostgreSQL: column->'path'->'to'->>'field'
    // Use -> for all but the last part (keeps as JSON), ->> for the last part (extracts as text)
    // IMPORTANT: Use sql.raw() for JSON keys to avoid parameterization
    if (parts.length === 1) {
      // Single level: column->>'key'
      return sql`${column}${sql.raw(`->>'${parts[0]}'`)}`;
    } else {
      // Multiple levels: column->'key1'->'key2'->>'key3'
      const objectParts = parts.slice(0, -1).map((p) => sql.raw(`->'${p}'`));
      const lastPart = parts[parts.length - 1];
      return sql`${column}${sql.join(objectParts, sql``)}${sql.raw(`->>'${lastPart}'`)}`;
    }
  }
}

/**
 * Supported bucket granularities for {@link dateTruncUtc}.
 */
export type DateBucket = 'hour' | 'day' | 'week' | 'month';

/**
 * Truncate a timestamp column to a bucket boundary in UTC and return an ISO 8601 string.
 *
 * Produces stable bucket keys that can be grouped and ordered chronologically in both
 * SQLite and PostgreSQL. Week buckets use ISO-8601 semantics (Monday as start of week).
 *
 * - SQLite: `created_at` is stored as integer ms since epoch (`mode: 'timestamp_ms'`),
 *   so the column value is divided by 1000 to feed into `strftime` via the `unixepoch` modifier.
 * - PostgreSQL: uses `date_trunc` on a `timestamp with time zone` column, cast to text in
 *   `YYYY-MM-DDTHH24:MI:SS.MSZ` so the output matches SQLite's.
 *
 * @param db - Database instance (for dialect detection)
 * @param column - Timestamp column to truncate
 * @param bucket - Granularity
 * @returns SQL expression producing an ISO-8601 UTC timestamp string
 *
 * @example
 * // SELECT ... dateTruncUtc(db, tasks.created_at, 'day') AS bucket
 * // → '2026-04-17T00:00:00.000Z'
 */
// biome-ignore lint/suspicious/noExplicitAny: Drizzle columns have complex union types
export function dateTruncUtc(db: Database, column: SQL | any, bucket: DateBucket): SQL {
  if (isSQLiteDatabase(db)) {
    // SQLite columns with timestamp_ms mode store integer ms — convert to unix seconds.
    const unixSeconds = sql`${column} / 1000`;
    switch (bucket) {
      case 'hour':
        return sql`strftime('%Y-%m-%dT%H:00:00.000Z', ${unixSeconds}, 'unixepoch')`;
      case 'day':
        return sql`strftime('%Y-%m-%dT00:00:00.000Z', ${unixSeconds}, 'unixepoch')`;
      case 'month':
        return sql`strftime('%Y-%m-01T00:00:00.000Z', ${unixSeconds}, 'unixepoch')`;
      case 'week':
        // Shift to the Monday of the same ISO week, then emit midnight UTC.
        // %w returns 0 (Sun) … 6 (Sat); (wd + 6) mod 7 = days since Monday.
        return sql`strftime(
          '%Y-%m-%dT00:00:00.000Z',
          ${unixSeconds},
          'unixepoch',
          '-' || ((strftime('%w', ${unixSeconds}, 'unixepoch') + 6) % 7) || ' days'
        )`;
    }
  } else {
    // PostgreSQL date_trunc accepts 'hour'|'day'|'week'|'month'; week is already ISO (Monday).
    // IMPORTANT: `date_trunc(unit, timestamptz)` truncates in the session's timezone, so we
    // convert to a UTC wall-clock timestamp *first* (`column AT TIME ZONE 'UTC'`) and truncate
    // that. Otherwise day/week/month buckets misalign for any session not set to UTC.
    // Use a validated raw literal for the date_trunc unit. If this is emitted as
    // a bound parameter, selecting and grouping by the same helper expression can
    // produce separate placeholders (for example $1 and $3). PostgreSQL then treats
    // those as different expressions and rejects bucketed leaderboard queries.
    return sql`to_char(
      date_trunc(${sql.raw(`'${bucket}'`)}, ${column} AT TIME ZONE 'UTC'),
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    )`;
  }
}

/**
 * Acquire a row-level lock within a transaction (PostgreSQL FOR UPDATE).
 *
 * On PostgreSQL, executes `SELECT 1 FROM <table> WHERE <pk> = <id> FOR UPDATE`
 * so that concurrent transactions block until this one commits.
 * On SQLite, this is a no-op — SQLite's transaction model provides implicit locking.
 *
 * @param tx - Transaction context (from db.transaction callback)
 * @param db - Database instance (used for dialect detection only)
 * @param table - The Drizzle table to lock
 * @param where - WHERE clause identifying the row (e.g., eq(sessions.session_id, id))
 */
export async function lockRowForUpdate(
  tx: Database,
  db: Database,
  table: SQLiteTable | PgTable,
  where: SQL
): Promise<void> {
  if (isPostgresDatabase(db)) {
    // biome-ignore lint/suspicious/noExplicitAny: Transaction context requires type assertion for raw SQL execution
    await (tx as any).execute(sql`SELECT 1 FROM ${table} WHERE ${where} FOR UPDATE`);
  }
  // SQLite: no-op — implicit locking via transaction
}

/**
 * Try to acquire a per-key Postgres transaction-scoped advisory lock.
 *
 * Used by the scheduler (and other multi-daemon work-distribution code)
 * to ensure that two daemons don't both spawn a session for the same
 * schedule on the same tick. The lock is automatically released at
 * transaction commit/rollback.
 *
 * - PostgreSQL: executes `SELECT pg_try_advisory_xact_lock($1)`. Returns
 *   `true` if this transaction won the lock, `false` otherwise (the
 *   caller should skip whatever it was about to do).
 * - SQLite: returns `true`. SQLite is single-node by definition — no
 *   cross-process coordination needed.
 *
 * Must be called from inside a transaction (`db.transaction(...)`) on
 * Postgres; on SQLite it's safe to call outside a transaction.
 *
 * @param tx - Transaction context (or db on SQLite)
 * @param db - Database instance (used for dialect detection only)
 * @param key - 64-bit signed integer key derived from the resource ID.
 *   See `advisoryLockKeyForUuid` for a stable UUID→bigint hash.
 */
export async function tryAdvisoryXactLock(
  tx: Database,
  db: Database,
  key: bigint
): Promise<boolean> {
  if (!isPostgresDatabase(db)) return true;
  // biome-ignore lint/suspicious/noExplicitAny: Transaction context requires type assertion for raw SQL execution
  const result = (await (tx as any).execute(
    sql`SELECT pg_try_advisory_xact_lock(${key.toString()}::bigint) AS acquired`
  )) as { rows?: Array<{ acquired: boolean }> } | Array<{ acquired: boolean }>;
  // postgres.js returns an array; pg returns { rows: [...] }. Handle both.
  const row = Array.isArray(result) ? result[0] : result.rows?.[0];
  return row?.acquired === true;
}

/**
 * Stable 64-bit hash of a UUID string for use as a Postgres advisory
 * lock key. Postgres advisory keys are bigint (signed 64-bit), so we
 * fold the UUID's 128 bits down with a simple FNV-1a-style mix and
 * clamp into the signed range.
 *
 * Deterministic per UUID, so a schedule's lock key is stable across
 * processes and restarts. Hash quality is not load-bearing — we only
 * need "low collision rate across the modest number of schedules
 * actually due in the same tick"; any two-bigint cell of the hash
 * space is fine.
 */
export function advisoryLockKeyForUuid(uuid: string): bigint {
  // FNV-1a 64-bit
  const FNV_OFFSET = 0xcbf29ce484222325n;
  const FNV_PRIME = 0x100000001b3n;
  const MASK_64 = 0xffffffffffffffffn;
  let hash = FNV_OFFSET;
  for (let i = 0; i < uuid.length; i++) {
    hash ^= BigInt(uuid.charCodeAt(i));
    hash = (hash * FNV_PRIME) & MASK_64;
  }
  // Convert unsigned 64-bit to signed (Postgres bigint is signed).
  return hash > 0x7fffffffffffffffn ? hash - 0x10000000000000000n : hash;
}

/**
 * Raw SQL query result type
 */
export type RawQueryResult = {
  rows?: unknown[];
  rowCount?: number;
};

/**
 * Execute a raw SQL query on any database
 */
export async function executeRaw(db: Database, query: SQL): Promise<RawQueryResult> {
  if (isSQLiteDatabase(db)) {
    return (await db.run(query)) as RawQueryResult;
  } else {
    // PostgreSQL uses execute for raw SQL
    return (await db.execute(query)) as RawQueryResult;
  }
}

/**
 * Get a single row from a table
 * Works for both SQLite and PostgreSQL
 */
export async function getOne<T extends SQLiteTable | PgTable, TResult = unknown>(
  db: Database,
  table: T,
  where?: SQL
): Promise<TResult | null> {
  if (isSQLiteDatabase(db)) {
    // biome-ignore lint/suspicious/noExplicitAny: Drizzle query builder types are complex and require type assertion
    const query = db.select().from(table as any);
    if (where) {
      return (await (query as { where: (where: SQL) => { get: () => Promise<unknown> } })
        .where(where)
        .get()) as TResult;
    }
    return (await (query as { get: () => Promise<unknown> }).get()) as TResult;
  } else {
    // biome-ignore lint/suspicious/noExplicitAny: Drizzle query builder types are complex and require type assertion
    const query = (db as any).select().from(table);
    if (where) {
      const results = await query.where(where).limit(1);
      return (results[0] as TResult) || null;
    }
    const results = await query.limit(1);
    return (results[0] as TResult) || null;
  }
}

/**
 * Insert values for a table row
 */
export type InsertValues<_T extends SQLiteTable | PgTable> = Record<string, unknown>;

/**
 * Insert a row into a table
 * Works for both SQLite and PostgreSQL
 */
export async function insertOne<T extends SQLiteTable | PgTable, TResult = unknown>(
  db: Database,
  table: T,
  values: InsertValues<T>
): Promise<TResult> {
  if (isSQLiteDatabase(db)) {
    const result = await db
      // biome-ignore lint/suspicious/noExplicitAny: Drizzle query builder types are complex and require type assertion
      .insert(table as any)
      .values(withTenantInsertValues(values, table) as never)
      .returning();
    return result as TResult;
  } else {
    // biome-ignore lint/suspicious/noExplicitAny: Drizzle query builder types are complex and require type assertion
    const result = await (db as any)
      .insert(table)
      .values(withTenantInsertValues(values, table) as never)
      .returning();
    return result[0] as TResult;
  }
}

/**
 * Generic query type for Drizzle query builders
 */
type DrizzleQuery = Record<string, unknown>;
// biome-ignore lint/suspicious/noExplicitAny: Drizzle query builders are highly dialect/chain specific.
type UnsafeDrizzleAny = any;

/**
 * Wrap a query with unified execution methods
 */
function tableHasTenantColumn(table?: SQLiteTable | PgTable): boolean {
  return Boolean(table && 'tenant_id' in (table as unknown as object));
}

function withTenantInsertValues(values: unknown, table?: SQLiteTable | PgTable): unknown {
  const tenantId = getCurrentTenantId();
  if (!tenantId || !tableHasTenantColumn(table)) return values;

  const stamp = (row: unknown): unknown => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
    if ('tenant_id' in row) return row;
    return { tenant_id: tenantId, ...(row as Record<string, unknown>) };
  };

  return Array.isArray(values) ? values.map(stamp) : stamp(values);
}

function wrapQuery(
  query: DrizzleQuery,
  db: Database,
  table?: SQLiteTable | PgTable
): UnsafeDrizzleAny {
  return {
    ...query,
    one: async () => {
      if (isSQLiteDatabase(db)) {
        return await (query as { get: () => Promise<unknown> }).get();
      } else {
        // For PostgreSQL, add .limit(1) and execute the query
        const results = (await (query as { limit: (count: number) => Promise<unknown[]> }).limit(
          1
        )) as unknown[];
        return results[0] || null;
      }
    },
    all: async () => {
      if (isSQLiteDatabase(db)) {
        return await (query as { all: () => Promise<unknown[]> }).all();
      } else {
        // For PostgreSQL, just await the query (it's a promise)
        return await query;
      }
    },
    run: async () => {
      if (isSQLiteDatabase(db)) {
        return await (query as { run: () => Promise<unknown> }).run();
      } else {
        // For PostgreSQL, execute and return result metadata
        // PostgreSQL returns an array for SELECT, but has a 'count' property for INSERT/UPDATE/DELETE
        const result = (await query) as unknown;

        // For DELETE/UPDATE/INSERT, postgres-js returns an array-like object with a 'count' property
        // For SELECT, it returns a plain array
        if (Array.isArray(result) && 'count' in result) {
          return { rowsAffected: (result as { count: number }).count };
        }

        // Fallback: treat as array (for queries that return rows)
        return { rowsAffected: (result as unknown[]).length || 0 };
      }
    },
    returning: () => wrapReturning((query as { returning: () => DrizzleQuery }).returning(), db),
    // Preserve chainable methods
    where: (...args: unknown[]) =>
      wrapQuery(
        (query as { where: (...args: unknown[]) => DrizzleQuery }).where(...args),
        db,
        table
      ),
    limit: (...args: unknown[]) =>
      wrapQuery(
        (query as { limit: (...args: unknown[]) => DrizzleQuery }).limit(...args),
        db,
        table
      ),
    offset: (...args: unknown[]) =>
      wrapQuery(
        (query as { offset: (...args: unknown[]) => DrizzleQuery }).offset(...args),
        db,
        table
      ),
    orderBy: (...args: unknown[]) =>
      wrapQuery(
        (query as { orderBy: (...args: unknown[]) => DrizzleQuery }).orderBy(...args),
        db,
        table
      ),
    groupBy: (...args: unknown[]) =>
      wrapQuery(
        (query as { groupBy: (...args: unknown[]) => DrizzleQuery }).groupBy(...args),
        db,
        table
      ),
    set: (...args: unknown[]) =>
      wrapQuery((query as { set: (...args: unknown[]) => DrizzleQuery }).set(...args), db, table),
    values: (...args: unknown[]) =>
      wrapQuery(
        (query as { values: (...args: unknown[]) => DrizzleQuery }).values(
          ...args.map((arg) => withTenantInsertValues(arg, table))
        ),
        db,
        table
      ),
    innerJoin: (...args: unknown[]) =>
      wrapQuery(
        (query as { innerJoin: (...args: unknown[]) => DrizzleQuery }).innerJoin(...args),
        db,
        table
      ),
    leftJoin: (...args: unknown[]) =>
      wrapQuery(
        (query as { leftJoin: (...args: unknown[]) => DrizzleQuery }).leftJoin(...args),
        db,
        table
      ),
    onConflictDoNothing: (...args: unknown[]) =>
      wrapQuery(
        (
          query as { onConflictDoNothing: (...args: unknown[]) => DrizzleQuery }
        ).onConflictDoNothing(...args),
        db,
        table
      ),
  };
}

/**
 * Wrap a .returning() clause with unified execution methods
 */
function wrapReturning(query: DrizzleQuery, db: Database): UnifiedReturning {
  return {
    one: async () => {
      if (isSQLiteDatabase(db)) {
        return await (query as { get: () => Promise<unknown> }).get();
      } else {
        const results = (await query) as unknown;
        return (results as unknown[])[0];
      }
    },
    all: async () => {
      if (isSQLiteDatabase(db)) {
        return await (query as { all: () => Promise<unknown[]> }).all();
      } else {
        const result = (await query) as unknown;
        return result as unknown[];
      }
    },
  };
}

/**
 * Column selection for queries
 */
type ColumnSelection = Record<string, unknown> | undefined;

/**
 * Select from a table
 * Returns a wrapped query builder with unified execution methods
 */
export function select(db: Database, columns?: ColumnSelection) {
  // biome-ignore lint/suspicious/noExplicitAny: Drizzle's select method has complex overloads
  const query = columns ? (db as any).select(columns) : (db as any).select();
  return {
    ...query,
    from: (table: SQLiteTable | PgTable) => wrapQuery(query.from(table), db),
  };
}

/**
 * Insert into a table
 * Returns a wrapped insert builder with unified execution methods
 */
export function insert(db: Database, table: SQLiteTable | PgTable) {
  // biome-ignore lint/suspicious/noExplicitAny: Drizzle's insert method has complex overloads
  const query = (db as any).insert(table);
  return wrapQuery(query, db, table);
}

/**
 * Update a table
 * Returns a wrapped update builder with unified execution methods
 */
export function update(db: Database, table: SQLiteTable | PgTable) {
  // biome-ignore lint/suspicious/noExplicitAny: Drizzle's update method has complex overloads
  const query = (db as any).update(table);
  return wrapQuery(query, db);
}

/**
 * Delete from a table
 * Returns a wrapped delete builder with unified execution methods
 */
export function deleteFrom(db: Database, table: SQLiteTable | PgTable) {
  // biome-ignore lint/suspicious/noExplicitAny: Drizzle's delete method has complex overloads
  const query = (db as any).delete(table);
  return wrapQuery(query, db);
}

/**
 * Execute a query and get a single result
 * Dialect-aware wrapper for .get()
 */
export async function executeGet<T = unknown>(
  query: DrizzleQuery,
  db: Database
): Promise<T | null> {
  if (isSQLiteDatabase(db)) {
    return (await (query as { get: () => Promise<unknown> }).get()) as T;
  } else {
    const results = await (query as { limit: (count: number) => Promise<unknown[]> }).limit(1);
    return (results[0] as T) || null;
  }
}

/**
 * Execute a query and get all results
 * Dialect-aware wrapper for .all()
 */
export async function executeAll<T = unknown>(query: DrizzleQuery, db: Database): Promise<T[]> {
  if (isSQLiteDatabase(db)) {
    return (await (query as { all: () => Promise<unknown[]> }).all()) as T[];
  } else {
    const result = (await query) as unknown;
    return result as T[];
  }
}

/**
 * Execute a mutation query (INSERT/UPDATE/DELETE)
 * Dialect-aware wrapper for .run()
 */
export async function executeRun(
  query: DrizzleQuery,
  db: Database
): Promise<MutationResult | unknown[]> {
  if (isSQLiteDatabase(db)) {
    return await (query as { run: () => Promise<MutationResult> }).run();
  } else {
    // PostgreSQL: Just execute the query
    const result = (await query) as unknown;
    return result as unknown[];
  }
}
