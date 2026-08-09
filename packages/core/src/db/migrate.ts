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
import { sql } from 'drizzle-orm';
import { migrate as migrateSQLite } from 'drizzle-orm/libsql/migrator';
import { migrate as migratePostgres } from 'drizzle-orm/postgres-js/migrator';
import type { Database } from './client';
import { insert, isPostgresDatabase, isSQLiteDatabase } from './database-wrapper';
import { sanitizeDbError } from './sanitize-error';
import { boards } from './schema';
import { getCurrentTenantId } from './tenant-scope';

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

const OFFLINE_CUTOVER_MIGRATIONS = new Set(['0074_knowledge_embedding_claims']);

export interface RunMigrationsOptions {
  /**
   * Acknowledge that every daemon using this existing database is stopped.
   * This is deliberately separate from ordinary non-interactive confirmation.
   */
  allowOfflineCutover?: boolean;
}

export class OfflineMigrationCutoverRequiredError extends MigrationError {
  readonly migrations: string[];

  constructor(migrations: string[]) {
    super(
      `Offline migration cutover required for: ${migrations.join(', ')}. Stop every daemon using this database, run \`agor db migrate --offline-cutover\` once, then start only daemons running the new version.`
    );
    this.name = 'OfflineMigrationCutoverRequiredError';
    this.migrations = migrations;
  }
}

export function pendingOfflineCutoverMigrations(status: {
  pending: readonly string[];
  applied: readonly string[];
}): string[] {
  // A genuinely fresh database cannot have an old worker using the pre-claim
  // protocol, so first installation remains automatic.
  if (status.applied.length === 0) return [];
  return status.pending.filter((tag) => OFFLINE_CUTOVER_MIGRATIONS.has(tag));
}

function getRootCause(error: unknown): unknown {
  let current = error;
  while (current instanceof Error && current.cause) {
    current = current.cause;
  }
  return current;
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
    const rootCause = getRootCause(error);
    const rootMsg =
      rootCause !== error
        ? ` (root cause: ${rootCause instanceof Error ? rootCause.message : String(rootCause)})`
        : '';
    throw new MigrationError(
      `Failed to check migrations table: ${error instanceof Error ? error.message : String(error)}${rootMsg}`,
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
    // This bootstrap function is only called for SQLite databases
    if (!isSQLiteDatabase(db)) {
      throw new MigrationError('Bootstrap is only supported for SQLite databases');
    }
    await db.run(sql`
      CREATE TABLE __drizzle_migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);

    // Mark baseline migration as applied
    // This hash comes from drizzle/meta/_journal.json: "tag": "0000_pretty_mac_gargan"
    const baselineHash = '0000_pretty_mac_gargan';
    await db.run(sql`
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

  // Detect if running from bundled structure (agor-live package)
  // In bundled package: dist/core/db/index.js → go up 1 level to dist/core/
  // In monorepo dev: src/db/migrate.ts → go up 2 levels to packages/core/
  // In monorepo prod: dist/db/migrate.js → go up 2 levels to packages/core/
  const isBundled = __dirname.includes('/dist/core/');
  const levelsUp = isProduction && isBundled ? '..' : '../..';

  return join(__dirname, levelsUp, 'drizzle', dialect);
}

/**
 * Check migration status and return pending migrations
 *
 * Uses the same timestamp-based logic as Drizzle's migrator:
 * - Gets the max created_at (= folderMillis) from __drizzle_migrations
 * - A migration is "pending" if its journal `when` timestamp > max applied timestamp
 *
 * This matches Drizzle's actual check (drizzle-orm/migrator.js), which compares
 * folderMillis against the last applied migration's created_at, NOT hashes.
 * Hash-based checking breaks when migration files are modified after being applied.
 *
 * `dbAheadOfBinary` is true when the database's max applied migration timestamp
 * is NEWER than the newest entry in this binary's local journal — i.e. the
 * database was migrated by a newer release than the one running now. This is the
 * inverse of `hasPending` (binary ahead of DB) and cannot be detected from the
 * journal alone, so consumers that require a complete, matching schema (e.g.
 * tenant deletion) must check it explicitly.
 *
 * @returns Object with hasPending flag and list of pending migration tags
 */
export async function checkMigrationStatus(db: Database): Promise<{
  hasPending: boolean;
  pending: string[];
  applied: string[];
  dbAheadOfBinary: boolean;
}> {
  try {
    const migrationsFolder = getMigrationsFolder(db);

    // Read expected migrations from journal
    const journalPath = join(migrationsFolder, 'meta', '_journal.json');
    const { readFile } = await import('node:fs/promises');
    const journalContent = await readFile(journalPath, 'utf-8');
    const journal = JSON.parse(journalContent);
    const journalEntries: { tag: string; when: number }[] = journal.entries.map(
      (e: { tag: string; when: number }) => ({ tag: e.tag, when: e.when })
    );
    const journalMaxWhen = journalEntries.reduce((max, e) => Math.max(max, e.when), 0);

    // Get max applied timestamp from database (Drizzle's watermark)
    const hasTable = await hasMigrationsTable(db);
    if (!hasTable) {
      return {
        hasPending: true,
        pending: journalEntries.map((e) => e.tag),
        applied: [],
        dbAheadOfBinary: false,
      };
    }

    let maxAppliedMillis = 0;
    if (isSQLiteDatabase(db)) {
      const result = await db.run(sql`SELECT MAX(created_at) as max_ts FROM __drizzle_migrations`);
      const row = result.rows[0] as Record<string, unknown> | undefined;
      maxAppliedMillis = row ? Number(row.max_ts ?? 0) : 0;
    } else if (isPostgresDatabase(db)) {
      const result = await db.execute(
        sql`SELECT MAX(created_at) as max_ts FROM drizzle.__drizzle_migrations`
      );
      const row = result[0] as Record<string, unknown> | undefined;
      maxAppliedMillis = row ? Number(row.max_ts ?? 0) : 0;
    }

    // Mirror Drizzle's logic: pending if folderMillis > last applied created_at
    const pending = journalEntries.filter((e) => e.when > maxAppliedMillis).map((e) => e.tag);
    const applied = journalEntries.filter((e) => e.when <= maxAppliedMillis).map((e) => e.tag);

    // The database has been migrated by a newer binary than this one when its
    // watermark is past every migration this binary knows about.
    const dbAheadOfBinary = maxAppliedMillis > journalMaxWhen;

    return {
      hasPending: pending.length > 0,
      pending,
      applied,
      dbAheadOfBinary,
    };
  } catch (error) {
    const rootCause = getRootCause(error);
    const rootMsg =
      rootCause !== error
        ? ` (root cause: ${rootCause instanceof Error ? rootCause.message : String(rootCause)})`
        : '';
    throw new MigrationError(
      `Failed to check migration status: ${error instanceof Error ? error.message : String(error)}${rootMsg}`,
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
export async function runMigrations(
  db: Database,
  options: RunMigrationsOptions = {}
): Promise<void> {
  try {
    console.log('Running database migrations...');

    const migrationsFolder = getMigrationsFolder(db);
    console.log(`Using migrations folder: ${migrationsFolder}`);
    console.log(`Database dialect: ${isSQLiteDatabase(db) ? 'sqlite' : 'postgres'}`);

    if (isPostgresDatabase(db) && options.allowOfflineCutover !== true) {
      const status = await checkMigrationStatus(db);
      const offlineMigrations = pendingOfflineCutoverMigrations(status);
      if (offlineMigrations.length > 0) {
        throw new OfflineMigrationCutoverRequiredError(offlineMigrations);
      }
    }

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
    if (error instanceof OfflineMigrationCutoverRequiredError) throw error;
    console.error('❌ Migration failed:', sanitizeDbError(error));
    throw new MigrationError('Migration failed', error);
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
 * Seed initial data (default board only).
 *
 * The caller may pass `createdBy` to stamp the default board with a real
 * user_id. When omitted, the board is stamped with `LEGACY_ANONYMOUS_OWNER_ID`
 * — a sentinel that the first-run admin bootstrap re-attributes to a real
 * admin on the next daemon start.
 *
 * Admin users are NOT created here. They are created either by `agor init`
 * (interactive) or by `bootstrapFirstRunAdmin` on first daemon start (default
 * admin with generated password).
 */
export async function seedInitialData(db: Database, createdBy?: string): Promise<void> {
  try {
    const { generateId } = await import('../lib/ids');
    const { LEGACY_ANONYMOUS_OWNER_ID } = await import('./first-run-bootstrap');
    const now = new Date();
    const owner = createdBy ?? LEGACY_ANONYMOUS_OWNER_ID;

    // Insert atomically instead of using a read-then-write check. Multiple HA
    // daemons can reach first-run seeding together, and the unique tenant/slug
    // constraint is the correctness fence for that race.
    const tenantId = getCurrentTenantId();
    const result = await insert(db, boards)
      .values({
        board_id: generateId(),
        name: 'Main Board',
        slug: 'default',
        created_at: now,
        updated_at: now,
        created_by: owner,
        data: {
          description: 'Main board for all sessions',
          sessions: [],
          color: '#1677ff',
          icon: '⭐',
        },
        ...(isPostgresDatabase(db) && tenantId ? { tenant_id: String(tenantId) } : {}),
      })
      .onConflictDoNothing()
      .run();

    if (result.rowsAffected > 0) {
      console.log('✅ Main Board created');
    }
  } catch (error) {
    throw new MigrationError(
      `Failed to seed initial data: ${error instanceof Error ? error.message : String(error)}`,
      error
    );
  }
}
