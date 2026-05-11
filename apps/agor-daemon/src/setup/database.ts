/**
 * Database Initialization
 *
 * Handles database connection, directory creation, migration checks, and seeding.
 * Supports both SQLite (file:) and PostgreSQL connection strings.
 */

import { constants } from 'node:fs';
import { access, mkdir } from 'node:fs/promises';
import {
  checkMigrationStatus,
  createDatabaseAsync,
  formatPendingMigrationsMessage,
  seedInitialData,
} from '@agor/core/db';
import { extractDbFilePath } from '@agor/core/utils/path';
import { logFirstRunAdminBootstrap, runFirstRunAdminBootstrap } from './first-run-admin.js';

export interface DatabaseInitResult {
  /** Initialized database instance */
  db: Awaited<ReturnType<typeof createDatabaseAsync>>;
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
  const dbDir = dbFilePath.substring(0, dbFilePath.lastIndexOf('/'));

  // Ensure database directory exists
  try {
    await access(dbDir, constants.F_OK);
  } catch {
    console.log(`📁 Creating database directory: ${dbDir}`);
    await mkdir(dbDir, { recursive: true });
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
export async function initializeDatabase(dbPath: string): Promise<DatabaseInitResult> {
  console.log(`📦 Connecting to database: ${dbPath}`);

  // Ensure directory exists for SQLite
  await ensureDatabaseDirectory(dbPath);

  // Create database with foreign keys enabled
  const db = await createDatabaseAsync({ url: dbPath });

  // Check migrations (exits if pending)
  await checkAndReportMigrations(db, dbPath);

  // Seed initial data (idempotent - only creates if missing)
  console.log('🌱 Seeding initial data...');
  await seedInitialData(db);

  // First-run admin bootstrap: create a default admin if no users exist, and
  // re-attribute any legacy `created_by='anonymous'` rows to a real user. This
  // is the upgrade path for installs that previously ran in (now-removed)
  // anonymous mode — their data isn't orphaned, and they get clear credentials
  // written to disk on first start.
  const bootstrapResult = await runFirstRunAdminBootstrap(db);
  logFirstRunAdminBootstrap(bootstrapResult);

  console.log('✅ Database ready');

  return { db };
}
