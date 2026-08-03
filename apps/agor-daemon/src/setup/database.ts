/**
 * Database Initialization
 *
 * Handles database connection, directory creation, migration checks, and seeding.
 * Supports both SQLite (file:) and PostgreSQL connection strings.
 */

import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { dirname } from 'node:path';
import { getAgorHome, secureOwnerDirectory, secureOwnerFileIfPresent } from '@agor/core/config';
import {
  checkMigrationStatus,
  createDatabaseAsync,
  createTenantScopedDatabaseProxy,
  formatPendingMigrationsMessage,
  runWithSystemDatabaseScope,
  runWithTenantDatabaseScope,
  seedInitialData,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
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
export async function ensureDatabaseDirectory(dbPath: string): Promise<void> {
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
    // ~/.agor is the daemon's private data home. A custom database may live in
    // a shared parent (for example /var/lib), so do not seize that parent;
    // confidentiality is enforced on the database files themselves.
    if (dbDir === getAgorHome()) await secureOwnerDirectory(dbDir);
  } catch {
    console.log(`📁 Creating database directory: ${dbDir}`);
    await secureOwnerDirectory(dbDir);
  }

  await secureOwnerFileIfPresent(dbFilePath);
  await secureOwnerFileIfPresent(`${dbFilePath}-wal`);
  await secureOwnerFileIfPresent(`${dbFilePath}-shm`);
  await secureOwnerFileIfPresent(`${dbFilePath}-journal`);

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
  } = {}
): Promise<DatabaseInitResult> {
  console.log(`📦 Connecting to database: ${dbPath}`);

  // Ensure directory exists for SQLite
  await ensureDatabaseDirectory(dbPath);

  // Create database with foreign keys enabled
  const db = await createDatabaseAsync({ url: dbPath });
  if (dbPath.startsWith('file:')) {
    const dbFilePath = extractDbFilePath(dbPath);
    await secureOwnerFileIfPresent(dbFilePath);
    await secureOwnerFileIfPresent(`${dbFilePath}-wal`);
    await secureOwnerFileIfPresent(`${dbFilePath}-shm`);
    await secureOwnerFileIfPresent(`${dbFilePath}-journal`);
  }
  const scopedDb = createTenantScopedDatabaseProxy(db, {
    requireScope: options.requireTenantScope === true,
    label: 'daemon database',
  });

  // Check migrations (exits if pending)
  await checkAndReportMigrations(db, dbPath);

  const runInitialDataSetup = async () => {
    // Seed initial data (idempotent - only creates if missing). In static
    // Postgres deployments, scope this to the configured tenant so changing
    // multi_tenancy.static_tenant_id starts from a clean tenant-local slate.
    console.log('🌱 Seeding initial data...');
    await seedInitialData(scopedDb);

    // First-run admin bootstrap: create a default admin if no users exist in
    // the current tenant, and re-attribute any legacy `created_by='anonymous'`
    // rows to a real user. External-launch managed deployments skip the local
    // bootstrap account; the first trusted launch user becomes the attribution
    // target instead.
    if (options.skipFirstRunAdminBootstrap) {
      console.log(
        '🔐 Skipping local first-run admin bootstrap; external launch owns user identity.'
      );
    } else {
      const bootstrapResult = await runFirstRunAdminBootstrap(scopedDb);
      logFirstRunAdminBootstrap(bootstrapResult);
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
