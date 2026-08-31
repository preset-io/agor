/**
 * Database Client Factory
 *
 * Creates and configures database clients for Drizzle ORM.
 * Supports both SQLite (LibSQL) and PostgreSQL.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Client, Config } from '@libsql/client';
import { createClient } from '@libsql/client';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import { drizzle as drizzleSQLite } from 'drizzle-orm/libsql';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { loadConfigSync } from '../config/config-manager';
import type { AgorConfig } from '../config/types';
import type { DatadogTracer } from '../tracing/datadog';
import {
  coordinateInMemorySQLiteClient,
  coordinateInMemorySQLiteDatabase,
} from './in-memory-sqlite-coordinator';
import { instrumentDrizzlePostgresForTracing } from './postgres-tracing';
import { sanitizeDbError } from './sanitize-error';
import * as postgresSchema from './schema.postgres';
// Import both schemas explicitly
import * as sqliteSchema from './schema.sqlite';
import { detectDialectFromUrl, getDatabaseDialect } from './schema-factory';

/**
 * Marks the one SQLite configuration whose connection lifetime is part of the
 * database's identity. The local libsql client detaches its current native
 * connection when the client starts a transaction; reopening `:memory:` after
 * commit would otherwise produce a brand-new empty database.
 */
export const IN_MEMORY_SQLITE_DATABASE = Symbol.for('agor.db.sqlite.in-memory');

function isInMemorySQLiteUrl(url: string): boolean {
  return (
    url === ':memory:' || url.startsWith('file::memory:') || /[?&]mode=memory(?:&|$)/.test(url)
  );
}

function markInMemorySQLiteDatabase<T extends object>(db: T, url: string, client: Client): T {
  if (isInMemorySQLiteUrl(url)) {
    Object.defineProperty(db, IN_MEMORY_SQLITE_DATABASE, { value: true });
    return coordinateInMemorySQLiteDatabase(db, client);
  }
  return db;
}

/**
 * Database configuration options
 */
export interface DbConfig {
  /**
   * Database dialect
   */
  dialect?: 'sqlite' | 'postgresql';

  /**
   * Database URL
   * - SQLite local file: 'file:~/.agor/agor.db' or 'file:/absolute/path/agor.db'
   * - Remote Turso: 'libsql://your-db.turso.io'
   * - PostgreSQL: 'postgresql://user:pass@host:port/db'
   */
  url: string;

  /**
   * Auth token for Turso (required for remote databases, SQLite only)
   */
  authToken?: string;

  /**
   * Sync URL for embedded replica (Turso only, SQLite only)
   * Enables offline-first mode with local replica
   */
  syncUrl?: string;

  /**
   * Sync interval in seconds (default: 60)
   * Only used when syncUrl is provided (SQLite only)
   */
  syncInterval?: number;

  /**
   * PostgreSQL connection pool settings
   */
  pool?: {
    min?: number;
    max?: number;
    idleTimeout?: number;
  };

  /**
   * SSL configuration for PostgreSQL
   */
  ssl?:
    | boolean
    | {
        rejectUnauthorized?: boolean;
        ca?: string;
        cert?: string;
        key?: string;
      };

  /**
   * PostgreSQL schema name (default: 'public')
   */
  schema?: string;
}

/**
 * Error thrown when database connection fails
 */
export class DatabaseConnectionError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'DatabaseConnectionError';
  }
}

import { expandPath } from '../utils/path';

/**
 * Create LibSQL client with configuration
 */
function createLibSQLClient(config: DbConfig): Client {
  try {
    // Expand home directory for local file paths
    const url = expandPath(config.url);

    const clientConfig: Config = { url };

    // Add auth token for remote databases
    if (config.authToken) {
      clientConfig.authToken = config.authToken;
    }

    // Add sync configuration for embedded replica
    if (config.syncUrl) {
      clientConfig.syncUrl = config.syncUrl;
      clientConfig.syncInterval = config.syncInterval ?? 60;
    }

    const client = createClient(clientConfig);
    return isInMemorySQLiteUrl(config.url) ? coordinateInMemorySQLiteClient(client) : client;
  } catch (error) {
    throw new DatabaseConnectionError(
      `Failed to create LibSQL client: ${error instanceof Error ? error.message : String(error)}`,
      error
    );
  }
}

/**
 * Configure SQLite pragmas for better concurrent access
 * - WAL mode allows readers and writers to coexist
 * - Busy timeout retries locked operations instead of failing immediately
 * - Foreign key constraints required for CASCADE, SET NULL, etc.
 */
async function configureSQLitePragmas(client: Client): Promise<void> {
  // Allow silencing pragma logs via environment variable (useful for scripts)
  const silent = process.env.AGOR_SILENT_PRAGMA_LOGS === 'true';

  try {
    await client.execute('PRAGMA journal_mode = WAL');
    if (!silent) console.log('✅ WAL mode enabled for concurrent access');

    await client.execute('PRAGMA busy_timeout = 5000');
    if (!silent) console.log('✅ Busy timeout set to 5 seconds');

    await client.execute('PRAGMA foreign_keys = ON');
    if (!silent) console.log('✅ Foreign key constraints enabled');
  } catch (error) {
    console.warn('⚠️  Failed to configure SQLite pragmas:', sanitizeDbError(error));
  }
}

/**
 * Create Drizzle database instance based on configured dialect
 *
 * @param config Database configuration
 * @returns Drizzle database instance with schema (LibSQL or PostgreSQL)
 *
 * @example
 * ```typescript
 * // Local SQLite file (default)
 * const db = createDatabase({ url: 'file:~/.agor/agor.db' });
 *
 * // Remote Turso
 * const db = createDatabase({
 *   url: 'libsql://your-db.turso.io',
 *   authToken: process.env.TURSO_AUTH_TOKEN
 * });
 *
 * // PostgreSQL
 * const db = createDatabase({
 *   dialect: 'postgresql',
 *   url: 'postgresql://user:pass@host:port/db'
 * });
 * ```
 */
/**
 * Optional runtime hooks for database creation. `tracer` is the resolved
 * dd-trace tracer, injected by the daemon so Postgres queries emit APM spans;
 * `@agor/core` never resolves dd-trace itself (see postgres-tracing.ts).
 */
export interface CreateDatabaseOptions {
  tracer?: DatadogTracer | null;
}

export function createDatabase(config: DbConfig, options: CreateDatabaseOptions = {}): RawDatabase {
  // Auto-detect dialect from URL if not explicitly set
  let dialect = config.dialect;

  if (!dialect) {
    // Check if URL starts with postgresql://, postgres://, or pg://
    if (
      config.url.startsWith('postgresql://') ||
      config.url.startsWith('postgres://') ||
      config.url.startsWith('pg://')
    ) {
      dialect = 'postgresql';
    } else {
      // Fall back to environment variable or default
      dialect = getDatabaseDialect();
    }
  }

  if (dialect === 'postgresql') {
    return createPostgresDatabase(config, options.tracer) as unknown as RawDatabase;
  }

  return createSQLiteDatabase(config) as unknown as RawDatabase;
}

/**
 * Create PostgreSQL database client
 */
function createPostgresDatabase(
  config: DbConfig,
  tracer?: DatadogTracer | null
): PostgresJsDatabase<typeof postgresSchema> {
  try {
    // Build options without ssl key by default — postgres.js treats an explicitly-present
    // `ssl: undefined` differently from an absent key. When the key is absent, postgres.js
    // reads sslmode from the connection URL (e.g. ?sslmode=require). When present (even as
    // undefined), it overrides URL-based SSL detection.
    const options: postgres.Options<Record<string, postgres.PostgresType>> = {
      max: config.pool?.max || 10,
      idle_timeout: config.pool?.idleTimeout || 30,
      // Recycle connections after 5 minutes so the pool doesn't hold onto
      // connections that the server-side proxy has silently closed.
      max_lifetime: 300,
      // Disable prepared statements - they can cause issues with DDL statements like CREATE SCHEMA
      // and with Drizzle's migration system
      prepare: false,
      // Per-connection parameters set immediately after each connection is
      // established. These prevent zombie transactions from blocking forever
      // when the server (or a proxy) closes the underlying socket while a
      // Drizzle transaction is idle between nested service calls.
      //
      // Root cause: tenantDatabaseScopeAround wraps entire service calls
      // (including all after-hooks) in a single PG transaction. After-hooks
      // dispatch callbacks and trigger queue processing, so the transaction
      // can sit idle for seconds between SQL statements. If the server's
      // idle-in-transaction timeout fires, the server kills the backend but
      // the Node.js client only discovers this on the next write (COMMIT),
      // producing "write CONNECTION_CLOSED". The server-side transaction
      // remains open as a zombie, holding row locks and blocking other queries.
      connection: {
        // Kill this backend after 45 s idle inside a transaction. Surfaced as
        // a real error to the caller so we can log and retry rather than
        // blocking silently. 45 s is generous for any single service call.
        idle_in_transaction_session_timeout: 45000,
        // Hard cap on individual statement execution time.
        statement_timeout: 60000,
      },
    };
    if (config.ssl !== undefined) {
      options.ssl = config.ssl;
    }
    const sql = postgres(config.url, options);

    const db = drizzlePostgres(sql, { schema: postgresSchema });
    // Emit `postgres.query` APM spans for every query. dd-trace has no
    // postgres.js plugin, so without this the daemon's DB layer is invisible in
    // Datadog. Best-effort and additive — a no-op unless the daemon injected a
    // tracer, and it can never break a query (see postgres-tracing.ts).
    instrumentDrizzlePostgresForTracing(db, { tracer });
    return db;
  } catch (error) {
    throw new DatabaseConnectionError(
      `Failed to create PostgreSQL client: ${error instanceof Error ? error.message : String(error)}`,
      error
    );
  }
}

/**
 * Create SQLite database client
 */
function createSQLiteDatabase(config: DbConfig): LibSQLDatabase<typeof sqliteSchema> {
  const client = createLibSQLClient(config);
  const db = markInMemorySQLiteDatabase(
    drizzleSQLite(client, { schema: sqliteSchema }),
    config.url,
    client
  );

  // Configure SQLite pragmas asynchronously (fire-and-forget)
  // This doesn't block database creation but pragmas will be set shortly after
  void configureSQLitePragmas(client);

  return db;
}

/**
 * Create Drizzle database instance with foreign keys enabled (async)
 *
 * For SQLite: Guarantees foreign key constraint enforcement immediately.
 * For PostgreSQL: No difference from sync version (pragmas not needed).
 *
 * @param config Database configuration
 * @returns Promise resolving to Drizzle database instance
 */
export async function createDatabaseAsync(
  config: DbConfig,
  options: CreateDatabaseOptions = {}
): Promise<RawDatabase> {
  // Determine dialect: use config.dialect, then auto-detect from URL, then fallback to env/default
  let dialect = config.dialect;
  if (!dialect && config.url) {
    const detected = detectDialectFromUrl(config.url);
    dialect = detected || getDatabaseDialect();
  } else {
    dialect = dialect || getDatabaseDialect();
  }

  if (dialect === 'postgresql') {
    // PostgreSQL doesn't need pragma configuration
    return createPostgresDatabase(config, options.tracer) as unknown as RawDatabase;
  }

  // SQLite: Wait for pragmas to be configured
  const client = createLibSQLClient(config);
  const db = markInMemorySQLiteDatabase(
    drizzleSQLite(client, { schema: sqliteSchema }),
    config.url,
    client
  );
  await configureSQLitePragmas(client);
  return db as unknown as RawDatabase;
}

/**
 * Type alias for Drizzle database instance (union of LibSQL and PostgreSQL)
 */
export type Database =
  | LibSQLDatabase<typeof sqliteSchema>
  | PostgresJsDatabase<typeof postgresSchema>;

declare const rawDatabaseBrand: unique symbol;
declare const tenantScopeAwareDatabaseBrand: unique symbol;
declare const tenantScopedDatabaseBrand: unique symbol;
declare const systemDatabaseBrand: unique symbol;

/**
 * Raw Drizzle database handle. This should be limited to setup, migrations,
 * and low-level scope plumbing. Application services should generally receive
 * a TenantScopeAwareDatabase instead.
 */
export type RawDatabase = Database & { readonly [rawDatabaseBrand]: 'raw-database' };

/**
 * Long-lived daemon/repository database handle. It is not itself tenant-scoped;
 * it is a proxy that resolves to the active tenant/system scope at call time.
 */
export type TenantScopeAwareDatabase = Database & {
  readonly [tenantScopeAwareDatabaseBrand]: 'tenant-scope-aware-database';
};

/**
 * Database handle available only while an active tenant DB scope is running.
 */
export type TenantScopedDatabase = Database & {
  readonly [tenantScopedDatabaseBrand]: 'tenant-scoped-database';
};

/**
 * Database handle available only while explicit global/system DB work is running.
 */
export type SystemDatabase = Database & { readonly [systemDatabaseBrand]: 'system-database' };

/**
 * Default database path for local development
 */
export const DEFAULT_DB_PATH = 'file:~/.agor/agor.db';

export interface DatabaseUrlResolutionOptions {
  /** Already-loaded config, allowing local callers to choose the correct home. */
  config?: Pick<AgorConfig, 'database'>;
  /** Environment override source (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
  /** Home used to expand `~` in local database paths. */
  homeDir?: string;
}

function expandDatabasePathForHome(value: string, homeDir: string): string {
  if (value.startsWith('file:~/')) return `file:${join(homeDir, value.slice(7))}`;
  if (value.startsWith('~/')) return join(homeDir, value.slice(2));
  return value;
}

/** Resolve the effective database URL from an explicit config/environment view. */
export function resolveDatabaseUrl(options: DatabaseUrlResolutionOptions = {}): string {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();

  if (env.AGOR_DB_DIALECT === 'postgresql') {
    return env.DATABASE_URL || 'postgresql://localhost:5432/agor';
  }
  if (env.AGOR_DB_PATH) {
    return expandDatabasePathForHome(env.AGOR_DB_PATH, homeDir);
  }
  if (env.DATABASE_URL) {
    return expandDatabasePathForHome(env.DATABASE_URL, homeDir);
  }

  const dbConfig = options.config?.database;
  if (dbConfig) {
    const inferredDialect = dbConfig.postgresql?.url
      ? detectDialectFromUrl(dbConfig.postgresql.url)
      : null;
    const dialect = dbConfig.dialect ?? inferredDialect ?? 'sqlite';

    if (dialect === 'postgresql') {
      if (dbConfig.postgresql?.url) return dbConfig.postgresql.url;
      if (dbConfig.postgresql?.host) {
        const pg = dbConfig.postgresql;
        const user = encodeURIComponent(pg.user || 'postgres');
        const password = pg.password ? `:${encodeURIComponent(pg.password)}` : '';
        const port = pg.port || 5432;
        const database = pg.database || 'agor';
        return `postgresql://${user}${password}@${pg.host}:${port}/${database}`;
      }
      return 'postgresql://localhost:5432/agor';
    }

    if (dbConfig.sqlite?.path) {
      const sqlitePath = dbConfig.sqlite.path;
      const prefixed = sqlitePath.startsWith('file:') ? sqlitePath : `file:${sqlitePath}`;
      return expandDatabasePathForHome(prefixed, homeDir);
    }
  }

  return expandDatabasePathForHome(DEFAULT_DB_PATH, homeDir);
}

/**
 * Resolve database URL from environment and config
 *
 * Priority:
 * 1. AGOR_DB_DIALECT + DATABASE_URL/AGOR_DB_PATH environment variables
 * 2. database.dialect + database.postgresql.url / database.sqlite.path from config.yaml
 * 3. Default SQLite path (~/.agor/agor.db)
 *
 * This ensures consistent database URL resolution across CLI and daemon.
 *
 * @returns Database URL string
 */
export function getDatabaseUrl(): string {
  let config: AgorConfig | undefined;
  try {
    config = loadConfigSync();
  } catch {
    // Config not available — resolve from environment/defaults.
  }
  return resolveDatabaseUrl({ config });
}

/**
 * Create database with default local configuration
 */
export function createLocalDatabase(customPath?: string): Database {
  return createDatabase({ url: customPath ?? DEFAULT_DB_PATH });
}
