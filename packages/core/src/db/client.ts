/**
 * Database Client Factory
 *
 * Creates and configures database clients for Drizzle ORM.
 * Supports both SQLite (LibSQL) and PostgreSQL.
 */

import type { Client, Config } from '@libsql/client';
import { createClient } from '@libsql/client';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import { drizzle as drizzleSQLite } from 'drizzle-orm/libsql';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as postgresSchema from './schema.postgres';

// Import both schemas explicitly
import * as sqliteSchema from './schema.sqlite';
import { detectDialectFromUrl, getDatabaseDialect } from './schema-factory';

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

    return createClient(clientConfig);
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
    console.warn('⚠️  Failed to configure SQLite pragmas:', error);
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
export function createDatabase(config: DbConfig): Database {
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
    return createPostgresDatabase(config);
  }

  return createSQLiteDatabase(config);
}

/**
 * Create PostgreSQL database client
 */
function createPostgresDatabase(config: DbConfig): PostgresJsDatabase<typeof postgresSchema> {
  try {
    const sql = postgres(config.url, {
      max: config.pool?.max || 10,
      idle_timeout: config.pool?.idleTimeout || 30,
      ssl: config.ssl,
      // Disable prepared statements - they can cause issues with DDL statements like CREATE SCHEMA
      // and with Drizzle's migration system
      prepare: false,
    });

    return drizzlePostgres(sql, { schema: postgresSchema });
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
  const db = drizzleSQLite(client, { schema: sqliteSchema });

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
export async function createDatabaseAsync(config: DbConfig): Promise<Database> {
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
    return createPostgresDatabase(config);
  }

  // SQLite: Wait for pragmas to be configured
  const client = createLibSQLClient(config);
  const db = drizzleSQLite(client, { schema: sqliteSchema });
  await configureSQLitePragmas(client);
  return db;
}

/**
 * Type alias for Drizzle database instance (union of LibSQL and PostgreSQL)
 */
export type Database =
  | LibSQLDatabase<typeof sqliteSchema>
  | PostgresJsDatabase<typeof postgresSchema>;

/**
 * Default database path for local development
 */
export const DEFAULT_DB_PATH = 'file:~/.agor/agor.db';

/**
 * Create database with default local configuration
 */
export function createLocalDatabase(customPath?: string): Database {
  return createDatabase({ url: customPath ?? DEFAULT_DB_PATH });
}
