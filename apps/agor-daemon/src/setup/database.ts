/**
 * Database Initialization
 *
 * Handles database connection, directory creation, migration checks, and seeding.
 * Supports both SQLite (file:) and PostgreSQL connection strings.
 */

import { constants } from 'node:fs';
import { access, mkdir } from 'node:fs/promises';
import { checkMigrationStatus, createDatabaseAsync, seedInitialData } from '@agor/core/db';
import { extractDbFilePath } from '@agor/core/utils/path';

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
 */
async function checkAndReportMigrations(
  db: Awaited<ReturnType<typeof createDatabaseAsync>>
): Promise<void> {
  console.log('🔍 Checking database migration status...');
  const migrationStatus = await checkMigrationStatus(db);

  if (migrationStatus.hasPending) {
    console.error('');
    console.error('❌ Database migrations required!');
    console.error('');
    console.error(`   Found ${migrationStatus.pending.length} pending migration(s):`);
    migrationStatus.pending.forEach((tag) => {
      console.error(`     - ${tag}`);
    });
    console.error('');
    console.error('⚠️  For safety, please backup your database before running migrations:');
    console.error(`   cp ~/.agor/agor.db ~/.agor/agor.db.backup-$(date +%s)`);
    console.error('');
    console.error('Then run migrations with:');
    console.error('   agor db migrate');
    console.error('');
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
  await checkAndReportMigrations(db);

  // Seed initial data (idempotent - only creates if missing)
  console.log('🌱 Seeding initial data...');
  await seedInitialData(db);

  console.log('✅ Database ready');

  return { db };
}
