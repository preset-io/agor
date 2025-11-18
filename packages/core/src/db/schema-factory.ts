/**
 * Schema Factory - Type Helpers for Multi-Dialect Support
 *
 * THIS IS THE ONLY PLACE WHERE DIALECT DIFFERENCES ARE DEFINED.
 *
 * Provides helper functions that abstract the 3 types that differ between SQLite and PostgreSQL:
 * 1. Timestamp (integer vs timestamp)
 * 2. Boolean (integer vs boolean)
 * 3. JSON (text vs jsonb)
 *
 * All other types (text, index, foreign keys, etc.) are identical across dialects.
 *
 * Usage:
 * - Import this in schema.sqlite.ts and schema.postgres.ts
 * - Call createSchemaHelpers('sqlite') or createSchemaHelpers('postgresql')
 * - Use the returned helpers (t.timestamp, t.bool, t.json) for dialect-specific types
 */

import { boolean, jsonb, timestamp } from 'drizzle-orm/pg-core';
import { integer, text } from 'drizzle-orm/sqlite-core';

/**
 * Supported database dialects
 */
export type DatabaseDialect = 'sqlite' | 'postgresql';

/**
 * Detect database dialect from connection URL
 *
 * @param url - Database connection URL
 * @returns Detected dialect or null if unable to determine
 */
export function detectDialectFromUrl(url: string): DatabaseDialect | null {
  if (!url) return null;

  const lowerUrl = url.toLowerCase();

  // PostgreSQL URLs
  if (
    lowerUrl.startsWith('postgresql://') ||
    lowerUrl.startsWith('postgres://') ||
    lowerUrl.startsWith('pg://')
  ) {
    return 'postgresql';
  }

  // SQLite URLs
  if (
    lowerUrl.startsWith('file:') ||
    lowerUrl.startsWith('libsql://') ||
    lowerUrl.startsWith('http://') ||
    lowerUrl.startsWith('https://')
  ) {
    return 'sqlite';
  }

  return null;
}

/**
 * Get current database dialect from environment or config
 *
 * Priority:
 * 1. AGOR_DB_DIALECT environment variable
 * 2. Auto-detect from DATABASE_URL
 * 3. Database config from config file (future)
 * 4. Default to 'sqlite'
 */
export function getDatabaseDialect(): DatabaseDialect {
  const envDialect = process.env.AGOR_DB_DIALECT;
  if (envDialect === 'postgresql' || envDialect === 'sqlite') {
    return envDialect;
  }

  // Auto-detect from DATABASE_URL
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl) {
    const detected = detectDialectFromUrl(databaseUrl);
    if (detected) {
      return detected;
    }
  }

  // Future: Load from config file
  // const config = loadConfigSync();
  // return config.database?.dialect || 'sqlite';

  return 'sqlite';
}

/**
 * Create dialect-specific type helpers
 *
 * This is THE central abstraction for dialect differences.
 * Only 3 types differ between SQLite and PostgreSQL:
 * - Timestamp: integer (ms) vs timestamp (with timezone)
 * - Boolean: integer (0/1) vs boolean
 * - JSON: text vs jsonb
 *
 * @param dialect - Database dialect ('sqlite' or 'postgresql')
 * @returns Object with 3 helper functions (timestamp, bool, json)
 */
export function createSchemaHelpers(dialect: DatabaseDialect) {
  if (dialect === 'postgresql') {
    return {
      /**
       * PostgreSQL: native TIMESTAMP WITH TIME ZONE
       * Stores timestamps as native PostgreSQL timestamp type with timezone support
       * Note: .notNull() must be chained explicitly in schema definitions
       */
      timestamp: (name: string) => timestamp(name, { mode: 'date', withTimezone: true }),

      /**
       * PostgreSQL: native BOOLEAN
       * Stores booleans as native PostgreSQL boolean type (true/false)
       */
      bool: (name: string) => boolean(name),

      /**
       * PostgreSQL: native JSONB (binary JSON)
       * Stores JSON as binary format with indexing support
       */
      json: <T>(name: string) => jsonb(name).$type<T>(),
    };
  }

  // SQLite
  return {
    /**
     * SQLite: integer with timestamp_ms mode
     * Stores timestamps as milliseconds since Unix epoch (integer)
     * Note: .notNull() must be chained explicitly in schema definitions
     */
    timestamp: (name: string) => integer(name, { mode: 'timestamp_ms' }),

    /**
     * SQLite: integer with boolean mode (0/1)
     * Stores booleans as integers (0 = false, 1 = true)
     */
    bool: (name: string) => integer(name, { mode: 'boolean' }),

    /**
     * SQLite: text with json mode
     * Stores JSON as text string
     */
    json: <T>(name: string) => text(name, { mode: 'json' }).$type<T>(),
  };
}

/**
 * Type helper for extracting schema helper types
 * Useful for type inference in schema definitions
 */
export type SchemaHelpers = ReturnType<typeof createSchemaHelpers>;
