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
      // biome-ignore lint/suspicious/noExplicitAny: Drizzle query builder types are complex and require type assertion
      return await (query as any).where(where).get();
    }
    // biome-ignore lint/suspicious/noExplicitAny: Drizzle query builder types are complex and require type assertion
    return await (query as any).get();
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
      .values(values)
      .returning();
    return result as TResult;
  } else {
    // biome-ignore lint/suspicious/noExplicitAny: Drizzle query builder types are complex and require type assertion
    const result = await (db as any).insert(table).values(values).returning();
    return result[0] as TResult;
  }
}

/**
 * Generic query type for Drizzle query builders
 */
type DrizzleQuery = Record<string, unknown>;

/**
 * Wrap a query with unified execution methods
 */
// biome-ignore lint/suspicious/noExplicitAny: This is a generic wrapper that needs to accept any Drizzle query builder type
function wrapQuery(query: DrizzleQuery, db: Database): any {
  return {
    ...query,
    one: async () => {
      if (isSQLiteDatabase(db)) {
        // biome-ignore lint/suspicious/noExplicitAny: Drizzle query builder types vary by dialect
        return await (query as any).get();
      } else {
        // For PostgreSQL, add .limit(1) and execute the query
        // biome-ignore lint/suspicious/noExplicitAny: Drizzle query builder types vary by dialect
        const results = await (query as any).limit(1);
        return results[0] || null;
      }
    },
    all: async () => {
      if (isSQLiteDatabase(db)) {
        // biome-ignore lint/suspicious/noExplicitAny: Drizzle query builder types vary by dialect
        return await (query as any).all();
      } else {
        // For PostgreSQL, just await the query (it's a promise)
        return await query;
      }
    },
    run: async () => {
      if (isSQLiteDatabase(db)) {
        // biome-ignore lint/suspicious/noExplicitAny: Drizzle query builder types vary by dialect
        return await (query as any).run();
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
    // biome-ignore lint/suspicious/noExplicitAny: Drizzle query builder types vary by dialect
    returning: () => wrapReturning((query as any).returning(), db),
    // Preserve chainable methods
    // biome-ignore lint/suspicious/noExplicitAny: These methods accept varying argument types from Drizzle
    where: (...args: unknown[]) => wrapQuery((query as any).where(...args), db),
    // biome-ignore lint/suspicious/noExplicitAny: These methods accept varying argument types from Drizzle
    limit: (...args: unknown[]) => wrapQuery((query as any).limit(...args), db),
    // biome-ignore lint/suspicious/noExplicitAny: These methods accept varying argument types from Drizzle
    offset: (...args: unknown[]) => wrapQuery((query as any).offset(...args), db),
    // biome-ignore lint/suspicious/noExplicitAny: These methods accept varying argument types from Drizzle
    orderBy: (...args: unknown[]) => wrapQuery((query as any).orderBy(...args), db),
    // biome-ignore lint/suspicious/noExplicitAny: These methods accept varying argument types from Drizzle
    set: (...args: unknown[]) => wrapQuery((query as any).set(...args), db),
    // biome-ignore lint/suspicious/noExplicitAny: These methods accept varying argument types from Drizzle
    values: (...args: unknown[]) => wrapQuery((query as any).values(...args), db),
  };
}

/**
 * Wrap a .returning() clause with unified execution methods
 */
function wrapReturning(query: DrizzleQuery, db: Database): UnifiedReturning {
  return {
    one: async () => {
      if (isSQLiteDatabase(db)) {
        // biome-ignore lint/suspicious/noExplicitAny: Drizzle query builder types vary by dialect
        return await (query as any).get();
      } else {
        const results = (await query) as unknown;
        return (results as unknown[])[0];
      }
    },
    all: async () => {
      if (isSQLiteDatabase(db)) {
        // biome-ignore lint/suspicious/noExplicitAny: Drizzle query builder types vary by dialect
        return await (query as any).all();
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
  return wrapQuery(query, db);
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
    // biome-ignore lint/suspicious/noExplicitAny: Drizzle query builder types vary by dialect
    return await (query as any).get();
  } else {
    // biome-ignore lint/suspicious/noExplicitAny: Drizzle query builder types vary by dialect
    const results = await (query as any).limit(1);
    return (results[0] as T) || null;
  }
}

/**
 * Execute a query and get all results
 * Dialect-aware wrapper for .all()
 */
export async function executeAll<T = unknown>(query: DrizzleQuery, db: Database): Promise<T[]> {
  if (isSQLiteDatabase(db)) {
    // biome-ignore lint/suspicious/noExplicitAny: Drizzle query builder types vary by dialect
    return await (query as any).all();
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
    // biome-ignore lint/suspicious/noExplicitAny: Drizzle query builder types vary by dialect
    return await (query as any).run();
  } else {
    // PostgreSQL: Just execute the query
    const result = (await query) as unknown;
    return result as unknown[];
  }
}
