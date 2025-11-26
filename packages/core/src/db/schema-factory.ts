/**
 * Schema Factory - Dialect Detection for Multi-Dialect Support
 *
 * Provides runtime dialect detection utilities used by:
 * - schema.ts: Determine which schema to load at runtime
 * - client.ts: Auto-detect database dialect from connection URL
 *
 * Note: The actual type helpers (timestamp, bool, json) are defined INLINE in each schema
 * (schema.sqlite.ts and schema.postgres.ts) due to TypeScript type inference limitations
 * with factory patterns. See the comment in those files for details.
 */

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
