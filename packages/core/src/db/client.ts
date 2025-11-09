/**
 * LibSQL Client Factory
 *
 * Creates and configures LibSQL database clients for Drizzle ORM.
 * Supports both local file-based SQLite and remote Turso endpoints.
 */

import type { Client, Config } from '@libsql/client';
import { createClient } from '@libsql/client';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import { drizzle } from 'drizzle-orm/libsql';
import * as schema from './schema';

/**
 * Database configuration options
 */
export interface DbConfig {
  /**
   * Database URL
   * - Local file: 'file:~/.agor/agor.db' or 'file:/absolute/path/agor.db'
   * - Remote Turso: 'libsql://your-db.turso.io'
   */
  url: string;

  /**
   * Auth token for Turso (required for remote databases)
   */
  authToken?: string;

  /**
   * Sync URL for embedded replica (Turso only)
   * Enables offline-first mode with local replica
   */
  syncUrl?: string;

  /**
   * Sync interval in seconds (default: 60)
   * Only used when syncUrl is provided
   */
  syncInterval?: number;
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
  try {
    await client.execute('PRAGMA journal_mode = WAL');
    console.log('✅ WAL mode enabled for concurrent access');

    await client.execute('PRAGMA busy_timeout = 5000');
    console.log('✅ Busy timeout set to 5 seconds');

    await client.execute('PRAGMA foreign_keys = ON');
    console.log('✅ Foreign key constraints enabled');
  } catch (error) {
    console.warn('⚠️  Failed to configure SQLite pragmas:', error);
  }
}

/**
 * Create Drizzle database instance (synchronous)
 *
 * NOTE: This function enables foreign key constraints asynchronously after returning.
 * For guaranteed foreign key enforcement, use createDatabaseAsync() instead.
 *
 * @param config Database configuration
 * @returns Drizzle database instance with schema
 *
 * @example
 * ```typescript
 * // Local SQLite file
 * const db = createDatabase({ url: 'file:~/.agor/agor.db' });
 *
 * // Remote Turso
 * const db = createDatabase({
 *   url: 'libsql://your-db.turso.io',
 *   authToken: process.env.TURSO_AUTH_TOKEN
 * });
 * ```
 */
export function createDatabase(config: DbConfig): LibSQLDatabase<typeof schema> {
  const client = createLibSQLClient(config);
  const db = drizzle(client, { schema });

  // Configure SQLite pragmas asynchronously (fire-and-forget)
  // This doesn't block database creation but pragmas will be set shortly after
  void configureSQLitePragmas(client);

  return db;
}

/**
 * Create Drizzle database instance with foreign keys enabled (async)
 *
 * Use this when you need guaranteed foreign key constraint enforcement immediately.
 *
 * @param config Database configuration
 * @returns Promise resolving to Drizzle database instance with foreign keys enabled
 */
export async function createDatabaseAsync(
  config: DbConfig
): Promise<LibSQLDatabase<typeof schema>> {
  const client = createLibSQLClient(config);
  const db = drizzle(client, { schema });

  // Configure SQLite pragmas and wait for completion
  await configureSQLitePragmas(client);

  return db;
}

/**
 * Type alias for Drizzle database instance
 */
export type Database = LibSQLDatabase<typeof schema>;

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
