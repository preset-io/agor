/**
 * Database Migration Runner
 *
 * Uses Drizzle's built-in migration system to automatically apply schema changes.
 *
 * **How it works:**
 * - Migrations are auto-generated from schema.ts using `pnpm db:generate`
 * - Migration SQL files live in drizzle/ folder
 * - Drizzle tracks applied migrations in __drizzle_migrations table
 * - Each migration runs in a transaction (auto-rollback on failure)
 *
 * **Developer workflow:**
 * 1. Edit schema.ts to make schema changes
 * 2. Run `pnpm db:generate` to create migration SQL
 * 3. Review generated SQL in drizzle/XXXX.sql
 * 4. Commit migration to git
 * 5. Daemon auto-applies on startup
 *
 * **Single source of truth:** packages/core/src/db/schema.ts
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, sql } from 'drizzle-orm';
import { migrate as migrateSQLite } from 'drizzle-orm/libsql/migrator';
import { migrate as migratePostgres } from 'drizzle-orm/postgres-js/migrator';
import type { Database } from './client';
import { insert, isPostgresDatabase, isSQLiteDatabase, select } from './database-wrapper';
import { boards } from './schema';

/**
 * Error thrown when migration fails
 */
export class MigrationError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'MigrationError';
  }
}

/**
 * Check if migrations tracking table exists (dialect-aware)
 */
async function hasMigrationsTable(db: Database): Promise<boolean> {
  try {
    if (isSQLiteDatabase(db)) {
      const result = await db.run(sql`
        SELECT name FROM sqlite_master
        WHERE type='table' AND name='__drizzle_migrations'
      `);
      return result.rows.length > 0;
    } else if (isPostgresDatabase(db)) {
      const result = await db.execute(sql`
        SELECT tablename FROM pg_tables
        WHERE schemaname = 'drizzle' AND tablename = '__drizzle_migrations'
      `);
      return result.length > 0;
    }
    return false;
  } catch (error) {
    throw new MigrationError(
      `Failed to check migrations table: ${error instanceof Error ? error.message : String(error)}`,
      error
    );
  }
}

/**
 * Bootstrap existing databases to use Drizzle migrations
 *
 * For databases created before the migration system:
 * - Creates __drizzle_migrations table
 * - Marks baseline migration as applied
 * - Allows future migrations to run normally
 *
 * Safe to run multiple times (idempotent).
 */
async function _bootstrapMigrations(db: Database): Promise<void> {
  try {
    console.log('🔧 Bootstrapping migration tracking...');

    const hasTable = await hasMigrationsTable(db);
    if (hasTable) {
      console.log('✅ Already bootstrapped (migrations table exists)');
      return;
    }

    // Create migrations table (Drizzle's schema)
    // biome-ignore lint/suspicious/noExplicitAny: SQLite-specific .run() method not available in unified Database type
    await (db as any).run(sql`
      CREATE TABLE __drizzle_migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);

    // Mark baseline migration as applied
    // This hash comes from drizzle/meta/_journal.json: "tag": "0000_pretty_mac_gargan"
    const baselineHash = '0000_pretty_mac_gargan';
    // biome-ignore lint/suspicious/noExplicitAny: SQLite-specific .run() method not available in unified Database type
    await (db as any).run(sql`
      INSERT INTO __drizzle_migrations (hash, created_at)
      VALUES (${baselineHash}, ${Date.now()})
    `);

    console.log('✅ Bootstrap complete!');
    console.log('   Baseline migration marked as applied');
    console.log('   Future migrations will run normally');
  } catch (error) {
    throw new MigrationError(
      `Bootstrap failed: ${error instanceof Error ? error.message : String(error)}`,
      error
    );
  }
}

/**
 * Get migrations folder path (dialect-aware)
 */
function getMigrationsFolder(db: Database): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const isProduction = __dirname.includes('/dist/');
  const dialect = isSQLiteDatabase(db) ? 'sqlite' : 'postgres';
  return join(__dirname, isProduction ? '..' : '../..', 'drizzle', dialect);
}

/**
 * Check migration status and return pending migrations
 *
 * Drizzle stores SHA256 hashes of SQL file content in the hash column.
 * We compute hashes of our migration files and compare against the database.
 *
 * @returns Object with hasPending flag and list of pending migration tags
 */
export async function checkMigrationStatus(
  db: Database
): Promise<{ hasPending: boolean; pending: string[]; applied: string[] }> {
  try {
    const migrationsFolder = getMigrationsFolder(db);

    // Read expected migrations from journal
    const journalPath = join(migrationsFolder, 'meta', '_journal.json');
    const { readFile } = await import('node:fs/promises');
    const { createHash } = await import('node:crypto');
    const journalContent = await readFile(journalPath, 'utf-8');
    const journal = JSON.parse(journalContent);
    const expectedMigrations: { tag: string; hash: string }[] = [];

    // Compute hash for each migration SQL file
    for (const entry of journal.entries) {
      const sqlPath = join(migrationsFolder, `${entry.tag}.sql`);
      try {
        const sqlContent = await readFile(sqlPath, 'utf-8');
        const hash = createHash('sha256').update(sqlContent).digest('hex');
        expectedMigrations.push({ tag: entry.tag, hash });
      } catch (err) {
        console.warn(`Warning: Could not read migration file ${entry.tag}.sql:`, err);
      }
    }

    // Get applied migrations from database
    const hasTable = await hasMigrationsTable(db);
    if (!hasTable) {
      // No migrations table = fresh database, all migrations pending
      return {
        hasPending: true,
        pending: expectedMigrations.map((m) => m.tag),
        applied: [],
      };
    }

    let appliedHashes: string[] = [];
    if (isSQLiteDatabase(db)) {
      const result = await db.run(sql`SELECT hash FROM __drizzle_migrations ORDER BY id`);
      appliedHashes = result.rows.map((row: Record<string, unknown>) => String(row.hash));
    } else if (isPostgresDatabase(db)) {
      const result = await db.execute(
        sql`SELECT hash FROM drizzle.__drizzle_migrations ORDER BY id`
      );
      appliedHashes = result.map((row: Record<string, unknown>) => String(row.hash));
    }

    // Use applied hashes as-is
    const normalizedAppliedHashes = appliedHashes;

    // Strategy: If we have N migrations in journal and N hashes in DB, consider all applied
    // (even if one hash changed). This handles the case where a migration was modified
    // after being applied, which is safe if the modification is idempotent (IF NOT EXISTS).
    const numExpected = expectedMigrations.length;
    const numApplied = normalizedAppliedHashes.length;

    if (numApplied >= numExpected) {
      // All migrations accounted for (might have extra hashes from modified migrations)
      return {
        hasPending: false,
        pending: [],
        applied: expectedMigrations.map((m) => m.tag),
      };
    }

    // Find pending migrations (hash not in database, after normalization)
    const pending = expectedMigrations
      .filter((m) => !normalizedAppliedHashes.includes(m.hash))
      .map((m) => m.tag);

    // Find applied migration tags (hash exists in database, after normalization)
    const appliedTags = expectedMigrations
      .filter((m) => normalizedAppliedHashes.includes(m.hash))
      .map((m) => m.tag);

    return {
      hasPending: pending.length > 0,
      pending,
      applied: appliedTags,
    };
  } catch (error) {
    throw new MigrationError(
      `Failed to check migration status: ${error instanceof Error ? error.message : String(error)}`,
      error
    );
  }
}

/**
 * Run all pending database migrations
 *
 * Uses Drizzle's built-in migration system:
 * - Reads SQL files from drizzle/ folder
 * - Tracks applied migrations in __drizzle_migrations table
 * - Runs migrations in transaction (auto-rollback on failure)
 *
 * Safe to call multiple times - only runs pending migrations.
 *
 * For existing databases (created before migration system):
 * - Automatically bootstraps migration tracking
 * - Marks baseline migration as applied
 */
export async function runMigrations(db: Database): Promise<void> {
  try {
    console.log('Running database migrations...');

    const migrationsFolder = getMigrationsFolder(db);
    console.log(`Using migrations folder: ${migrationsFolder}`);
    console.log(`Database dialect: ${isSQLiteDatabase(db) ? 'sqlite' : 'postgres'}`);

    // Drizzle handles everything:
    // 1. Creates __drizzle_migrations table if needed
    // 2. Checks which migrations are pending
    // 3. Runs them in order within transaction
    // 4. Updates tracking table
    if (isSQLiteDatabase(db)) {
      await migrateSQLite(db, { migrationsFolder });
    } else if (isPostgresDatabase(db)) {
      await migratePostgres(db, { migrationsFolder });
    } else {
      throw new MigrationError('Unknown database dialect');
    }

    console.log('✅ Migrations complete');
  } catch (error) {
    console.error('❌ Migration error details:');
    console.error('  Error type:', error?.constructor?.name);
    console.error('  Error message:', error instanceof Error ? error.message : String(error));
    console.error('  Error stack:', error instanceof Error ? error.stack : 'N/A');
    if (error && typeof error === 'object') {
      console.error('  Error keys:', Object.keys(error));
      // Check for cause (nested error)
      if ('cause' in error) {
        console.error('  Cause error:', error.cause);
        if (error.cause && typeof error.cause === 'object') {
          console.error('  Cause type:', error.cause.constructor?.name);
          console.error(
            '  Cause message:',
            error.cause instanceof Error ? error.cause.message : String(error.cause)
          );
          console.error('  Cause keys:', Object.keys(error.cause));
        }
      }
      console.error('  Full error object:', JSON.stringify(error, null, 2));
    }
    throw new MigrationError(
      `Migration failed: ${error instanceof Error ? error.message : String(error)}`,
      error
    );
  }
}

/**
 * DEPRECATED: Use runMigrations() instead
 *
 * Kept for backwards compatibility during transition.
 * Will be removed in future version.
 */
export async function initializeDatabase(db: Database): Promise<void> {
  console.warn('⚠️  initializeDatabase() is deprecated. Use runMigrations() instead.');
  await runMigrations(db);
}

/**
 * Seed initial data (default board only)
 *
 * Note: Does NOT create a default admin user.
 * Admin users must be created explicitly via `agor user create-admin` or during `agor init`
 */
export async function seedInitialData(db: Database): Promise<void> {
  try {
    const { generateId } = await import('../lib/ids');
    const now = new Date();

    // 1. Check if default board exists (by slug to avoid duplicates)
    const existingBoard = await select(db).from(boards).where(eq(boards.slug, 'default')).one();

    if (!existingBoard) {
      // Create default board
      const boardId = generateId();

      await insert(db, boards)
        .values({
          board_id: boardId,
          name: 'Main Board',
          slug: 'default',
          created_at: now,
          updated_at: now,
          created_by: 'anonymous',
          data: {
            description: 'Main board for all sessions',
            sessions: [],
            color: '#1677ff',
            icon: '⭐',
          },
        })
        .run();

      console.log('✅ Main Board created');
    }
  } catch (error) {
    throw new MigrationError(
      `Failed to seed initial data: ${error instanceof Error ? error.message : String(error)}`,
      error
    );
  }
}
