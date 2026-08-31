/**
 * Database Initialization
 *
 * Handles database connection, directory creation, migration checks, and seeding.
 * Supports both SQLite (file:) and PostgreSQL connection strings.
 */

import { constants } from 'node:fs';
import { access, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import type { ApmTraceServiceDepth } from '@agor/core/config';
import { ensureAgorHome, getAgorHome } from '@agor/core/config';
import {
  checkMigrationStatus,
  createDatabaseAsync,
  createTenantScopedDatabaseProxy,
  detectDialectFromUrl,
  formatPendingMigrationsMessage,
  getDatabaseDialect,
  runWithSystemDatabaseScope,
  runWithTenantDatabaseScope,
  seedInitialData,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import { resolveDatadogTracer } from '@agor/core/tracing/datadog';
import type { TenantID } from '@agor/core/types';
import { extractDbFilePath } from '@agor/core/utils/path';
import { logFirstRunAdminBootstrap, runFirstRunAdminBootstrap } from './first-run-admin.js';

export interface DatabaseInitResult {
  /** Initialized database instance */
  db: TenantScopeAwareDatabase;
}

/**
 * Ensure the database directory exists for SQLite databases
 *
 * Only applies to file: URLs. PostgreSQL connections skip this step.
 *
 * @param dbPath - Database connection string (file:~/.agor/agor.db or postgresql://...)
 */
async function ensureDatabaseDirectory(dbPath: string): Promise<void> {
  // Only handle file system setup for SQLite (file: URLs)
  if (!dbPath.startsWith('file:')) {
    return;
  }

  // Extract file path from DB_PATH (remove 'file:' prefix and expand ~)
  const dbFilePath = extractDbFilePath(dbPath);
  const dbDir = dirname(dbFilePath);

  // Ensure database directory exists
  try {
    await access(dbDir, constants.F_OK);
  } catch {
    console.log('[database] creating sqlite directory');
    if (resolve(dbDir) === resolve(getAgorHome())) {
      await ensureAgorHome(dbDir);
    } else {
      // A custom SQLite parent is operator-managed and may intentionally use
      // group ownership or default ACLs; only the canonical Agor home receives
      // Agor's private-state policy.
      await mkdir(dbDir, { recursive: true });
    }
  }

  // Check if database file exists (create message if needed)
  try {
    await access(dbFilePath, constants.F_OK);
  } catch {
    console.log('🆕 Database does not exist - will create on first connection');
  }
}

/**
 * Check migrations and exit if pending migrations require manual intervention
 *
 * @param db - Database instance
 * @param dbUrl - Database connection URL (used to render backup hint path)
 */
async function checkAndReportMigrations(
  db: Awaited<ReturnType<typeof createDatabaseAsync>>,
  dbUrl: string
): Promise<void> {
  console.log('🔍 Checking database migration status...');
  const migrationStatus = await checkMigrationStatus(db);

  if (migrationStatus.dbAheadOfBinary) {
    throw new Error(
      'Database schema is newer than this Agor binary. Refusing to start because an older daemon cannot safely interpret newer authorization state. Upgrade this binary to match the database.'
    );
  }

  if (migrationStatus.hasPending) {
    // Use the shared formatter from @agor/core/db so this message stays
    // in lockstep with the CLI pre-flight check (agor daemon start).
    process.stderr.write(
      formatPendingMigrationsMessage({
        dbUrl,
        dbPath: extractDbFilePath(dbUrl),
        pending: migrationStatus.pending,
      })
    );
    console.error('After migrations complete successfully, restart the daemon.');
    console.error('');
    process.exit(1);
  }

  console.log('✅ Database migrations up to date');
}

/**
 * Initialize the database connection with all required setup
 *
 * Performs:
 * 1. Directory creation (for SQLite)
 * 2. Database connection
 * 3. Migration status check (exits if migrations needed)
 * 4. Initial data seeding
 *
 * @param dbPath - Database connection string
 * @returns Initialized database instance
 */
export async function initializeDatabase(
  dbPath: string,
  options: {
    tenantId?: TenantID | string;
    requireTenantScope?: boolean;
    skipFirstRunAdminBootstrap?: boolean;
    /** PostgreSQL per-replica connection limit. PostgreSQL only. */
    pool?: { max: number };
    /** Shared custom APM tracing gate; `off` also disables PostgreSQL tracing. */
    traceServices?: ApmTraceServiceDepth;
  } = {}
): Promise<DatabaseInitResult> {
  const dialect = detectDialectFromUrl(dbPath) ?? getDatabaseDialect();
  console.log(`[database] connecting backend=${dialect}`);

  // Ensure directory exists for SQLite
  await ensureDatabaseDirectory(dbPath);

  // `trace_services` is the single gate for both custom APM layers. Avoid even
  // resolving the optional tracer when tracing is off: this keeps the disabled
  // path free of per-query and startup module-resolution overhead.
  const tracingEnabled = (options.traceServices ?? 'off') !== 'off';
  const tracer = tracingEnabled ? resolveDatadogTracer(createRequire(import.meta.url)) : null;

  // Create database with foreign keys enabled
  const databaseConfig = {
    url: dbPath,
    ...(options.pool ? { pool: options.pool } : {}),
  };
  const db = tracer
    ? await createDatabaseAsync(databaseConfig, { tracer })
    : await createDatabaseAsync(databaseConfig);
  const scopedDb = createTenantScopedDatabaseProxy(db, {
    requireScope: options.requireTenantScope === true,
    label: 'daemon database',
  });

  // Check migrations (exits if pending)
  await checkAndReportMigrations(db, dbPath);

  const runInitialDataSetup = async () => {
    // First-run admin bootstrap: create a default admin if no users exist in
    // the current tenant, and re-attribute any legacy `created_by='anonymous'`
    // rows to a real user. External-launch managed deployments skip the local
    // bootstrap account; the first trusted launch user becomes the attribution
    // target instead.
    if (options.skipFirstRunAdminBootstrap) {
      console.log(
        '🔐 Skipping local first-run admin/bootstrap data; external launch owns the first User and default Board.'
      );
    } else {
      const bootstrapResult = await runFirstRunAdminBootstrap(scopedDb);
      logFirstRunAdminBootstrap(bootstrapResult);
      if (!bootstrapResult.admin) {
        throw new Error('First-run setup could not resolve a primary owner for the default Board');
      }
      console.log('🌱 Seeding initial data...');
      await seedInitialData(scopedDb, bootstrapResult.admin.user_id);
    }
  };

  if (options.tenantId) {
    await runWithTenantDatabaseScope(scopedDb, options.tenantId, runInitialDataSetup);
  } else {
    await runWithSystemDatabaseScope(scopedDb, 'database initialization', runInitialDataSetup);
  }

  console.log('✅ Database ready');

  return { db: scopedDb };
}
