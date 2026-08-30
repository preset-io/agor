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

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { migrate as migrateSQLite } from 'drizzle-orm/libsql/migrator';
import { migrate as migratePostgres } from 'drizzle-orm/postgres-js/migrator';
import type { Database } from './client';
import {
  getDatabaseInstanceDialect,
  insert,
  isPostgresDatabase,
  isSQLiteDatabase,
  runDatabaseTransaction,
} from './database-wrapper';
import { sanitizeDbError } from './sanitize-error';
import { boards } from './schema';
import type { DatabaseDialect } from './schema-factory';
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

/** Maximum length of an automation-facing migration impact summary. */
export const MIGRATION_IMPACT_SUMMARY_MAX_LENGTH = 200;

export type MigrationImpactClassification =
  | 'schema'
  | 'data'
  | 'protocol'
  | 'performance'
  | 'unknown';
export type MigrationUserAction = 'none' | 'required' | 'unknown';
export type MigrationRollbackCompatibility = 'compatible' | 'incompatible' | 'unknown';

/** Bounded metadata maintained by the migration runtime, never inferred from SQL or CLI text. */
export interface MigrationImpact {
  classification: MigrationImpactClassification;
  userAction: MigrationUserAction;
  rollbackCompatibility: MigrationRollbackCompatibility;
  summary: string;
}

export interface MigrationImpactPolicy {
  requiresOfflineCutover: boolean;
  impact: Readonly<MigrationImpact>;
}

export interface PendingMigrationIntrospection {
  name: string;
  requiresOfflineCutover: boolean;
  impact: MigrationImpact;
}

/** Stable, versioned contract returned by migration status tooling. */
export interface MigrationStatusIntrospection {
  schemaVersion: 1;
  dialect: DatabaseDialect;
  appliedMigrations: string[];
  pendingMigrations: PendingMigrationIntrospection[];
  requiresOfflineCutover: boolean;
  databaseAheadOfBinary: boolean;
}

function defineMigrationImpact(impact: MigrationImpact): Readonly<MigrationImpact> {
  if (impact.summary.length > MIGRATION_IMPACT_SUMMARY_MAX_LENGTH) {
    throw new Error(
      `Migration impact summary exceeds ${MIGRATION_IMPACT_SUMMARY_MAX_LENGTH} characters`
    );
  }
  return Object.freeze(impact);
}

const UNKNOWN_MIGRATION_IMPACT = defineMigrationImpact({
  classification: 'unknown',
  userAction: 'unknown',
  rollbackCompatibility: 'unknown',
  summary: 'Migration impact metadata is unavailable.',
});

const QUEUED_MESSAGES_MIGRATION_POLICY: MigrationImpactPolicy = {
  requiresOfflineCutover: false,
  impact: defineMigrationImpact({
    classification: 'data',
    userAction: 'required',
    rollbackCompatibility: 'compatible',
    summary: 'Queued work interrupted by the migration may need to be submitted again.',
  }),
};

export function createMigrationImpactRegistry(
  entries: ReadonlyArray<readonly [string, MigrationImpactPolicy]>
): {
  impacts: ReadonlyMap<string, MigrationImpactPolicy>;
  offlineCutoverMigrations: ReadonlySet<string>;
} {
  const impacts = new Map(entries);
  const offlineCutoverMigrations = new Set(
    entries.filter(([, policy]) => policy.requiresOfflineCutover).map(([name]) => name)
  );
  return { impacts, offlineCutoverMigrations };
}

const MIGRATION_IMPACT_REGISTRY = createMigrationImpactRegistry([
  ['0030_migrate_queued_messages', QUEUED_MESSAGES_MIGRATION_POLICY],
  ['0040_migrate_queued_messages', QUEUED_MESSAGES_MIGRATION_POLICY],
  ...[
    '0074_knowledge_embedding_claims',
    '0078_mcp_oauth_pending_flows',
    '0082_github_install_state',
    '0091_codex_device_auth_attempts',
    '0095_board_branch_capability_policies',
    '0098_board_branch_capability_policies',
    '0099_shared_session_prompting',
    '0102_shared_session_prompting',
  ].map(
    (name) =>
      [
        name,
        {
          requiresOfflineCutover: true,
          impact: defineMigrationImpact({
            classification: 'protocol',
            userAction: 'required',
            rollbackCompatibility: 'incompatible',
            summary: 'Requires a coordinated offline cutover and is not rollback compatible.',
          }),
        },
      ] as const
  ),
  [
    '0083_transcript_hydration_keysets',
    {
      requiresOfflineCutover: true,
      impact: defineMigrationImpact({
        classification: 'performance',
        userAction: 'required',
        rollbackCompatibility: 'compatible',
        summary: 'Requires a coordinated offline cutover to build indexes; rollback is compatible.',
      }),
    },
  ],
  [
    '0092_add_user_credential_generation',
    {
      requiresOfflineCutover: true,
      impact: defineMigrationImpact({
        classification: 'protocol',
        userAction: 'required',
        rollbackCompatibility: 'compatible',
        summary:
          'Requires a coordinated offline cutover so every daemon uses credential-generation token claims; older code may ignore the additive column.',
      }),
    },
  ],
]);

const NO_OFFLINE_ACTION_SUMMARY =
  'No offline cutover is required for this database and migration state.';

export function getMigrationImpact(name: string): MigrationImpact {
  return MIGRATION_IMPACT_REGISTRY.impacts.get(name)?.impact ?? UNKNOWN_MIGRATION_IMPACT;
}

export function introspectMigrationStatus(
  dialect: DatabaseDialect,
  status: {
    pending: readonly string[];
    applied: readonly string[];
    dbAheadOfBinary: boolean;
  }
): MigrationStatusIntrospection {
  const offline = new Set(pendingOfflineCutoverMigrations(dialect, status));
  const pendingMigrations = status.pending.map((name) => {
    const requiresOfflineCutover = offline.has(name);
    const registeredPolicy = MIGRATION_IMPACT_REGISTRY.impacts.get(name);
    const registeredImpact = registeredPolicy?.impact ?? UNKNOWN_MIGRATION_IMPACT;
    const impact =
      registeredPolicy?.requiresOfflineCutover === true && !requiresOfflineCutover
        ? defineMigrationImpact({
            ...registeredImpact,
            userAction: 'none',
            summary: NO_OFFLINE_ACTION_SUMMARY,
          })
        : registeredImpact;
    return { name, requiresOfflineCutover, impact };
  });
  return {
    schemaVersion: 1,
    dialect,
    appliedMigrations: [...status.applied],
    pendingMigrations,
    requiresOfflineCutover: pendingMigrations.some((migration) => migration.requiresOfflineCutover),
    databaseAheadOfBinary: status.dbAheadOfBinary,
  };
}

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

export function pendingOfflineCutoverMigrations(
  _dialect: DatabaseDialect,
  status: {
    pending: readonly string[];
    applied: readonly string[];
  }
): string[] {
  // A genuinely fresh database cannot have an old worker using the previous
  // protocol or schema, so first installation remains automatic.
  if (status.applied.length === 0) return [];
  return status.pending.filter((tag) =>
    MIGRATION_IMPACT_REGISTRY.offlineCutoverMigrations.has(tag)
  );
}

/**
 * SQLite cannot interpolate object ids into a trigger/constraint error. Run a
 * readable preflight before the transactional migration so operators know
 * exactly which protected resources need manual cleanup or attribution.
 */
export async function preflightSQLiteCapabilityPolicyOwners(db: Database): Promise<void> {
  if (!isSQLiteDatabase(db)) return;
  const result = await db.run(sql`
    SELECT 'board' AS kind, b.board_id AS id
    FROM boards b
    WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.user_id = b.created_by)
      AND NOT EXISTS (
        SELECT 1 FROM board_owners bo
        JOIN users u ON u.user_id = bo.user_id
        WHERE bo.board_id = b.board_id
      )
    UNION ALL
    SELECT 'branch' AS kind, br.branch_id AS id
    FROM branches br
    WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.user_id = br.created_by)
      AND NOT EXISTS (
        SELECT 1 FROM branch_owners bo
        JOIN users u ON u.user_id = bo.user_id
        WHERE bo.branch_id = br.branch_id
      )
    ORDER BY kind, id
    LIMIT 100
  `);
  if (result.rows.length === 0) return;
  const failures = result.rows.map((row) => `${String(row.kind)}:${String(row.id)}`).join(', ');
  throw new MigrationError(
    `RBAC migration cannot attribute primary owners: ${failures}. Delete these resources or restore an existing creator/owner, then rerun the migration.`
  );
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
  const dialect = isSQLiteDatabase(db) ? 'sqlite' : 'postgres';

  // tsup can place this module at an entry root or under db/, while source
  // execution places it under src/db/. Resolve by the shipped data instead of
  // inferring a topology from directory names; this also supports @agor/core
  // as a normal bundled dependency rather than a postinstall-created symlink.
  const candidates = [
    join(__dirname, 'drizzle', dialect),
    join(__dirname, '..', 'drizzle', dialect),
    join(__dirname, '../..', 'drizzle', dialect),
  ];
  return (
    candidates.find((candidate) => existsSync(join(candidate, 'meta', '_journal.json'))) ??
    candidates[0]
  );
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

    const dialect = getDatabaseInstanceDialect(db);
    const migrationsFolder = getMigrationsFolder(db);
    console.log(`Using migrations folder: ${migrationsFolder}`);
    console.log(`Database dialect: ${dialect === 'sqlite' ? 'sqlite' : 'postgres'}`);

    const status = await checkMigrationStatus(db);
    if (options.allowOfflineCutover !== true) {
      const offlineMigrations = pendingOfflineCutoverMigrations(dialect, status);
      if (offlineMigrations.length > 0) {
        throw new OfflineMigrationCutoverRequiredError(offlineMigrations);
      }
    }

    if (
      dialect === 'sqlite' &&
      status.applied.length > 0 &&
      status.pending.includes('0098_board_branch_capability_policies')
    ) {
      await preflightSQLiteCapabilityPolicyOwners(db);
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
 * The caller must provide the real User that becomes the immutable primary
 * owner. Fresh-install setup therefore creates/projects the first User before
 * seeding the default Board.
 *
 * Admin users are NOT created here. They are created either by `agor init`
 * (interactive) or by `bootstrapFirstRunAdmin` on first daemon start (default
 * admin with generated password).
 */
export async function seedInitialDataInTransaction(
  db: Database,
  createdBy: string
): Promise<number> {
  const { generateId } = await import('../lib/ids');
  const now = new Date();
  const tenantId = getCurrentTenantId();
  const boardId = generateId();
  const inserted = await insert(db, boards)
    .values({
      board_id: boardId,
      name: 'Main Board',
      slug: 'default',
      created_at: now,
      updated_at: now,
      created_by: createdBy,
      primary_owner_user_id: createdBy,
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
  if (inserted.rowsAffected > 0) {
    const { CapabilityPolicyRepository } = await import('./repositories/capability-policies');
    await new CapabilityPolicyRepository(db).initializeBoardInTransaction(
      db,
      boardId as import('@agor/core/types').BoardID,
      createdBy as import('@agor/core/types').UserID,
      { shared: true, defaultOthersCan: 'session', defaultOthersFsAccess: 'read' }
    );
  }
  return inserted.rowsAffected;
}

export async function seedInitialData(db: Database, createdBy: string): Promise<void> {
  try {
    // Insert atomically instead of using a read-then-write check. Multiple HA
    // daemons can reach first-run seeding together, and the unique tenant/slug
    // constraint is the correctness fence for that race.
    const seedOnce = () =>
      runDatabaseTransaction(db, (tx) => seedInitialDataInTransaction(tx, createdBy), {
        sqliteImmediate: true,
      });

    // Two first-start daemons can both reach SQLite before either has claimed
    // the slug. BEGIN IMMEDIATE gives the transaction the right correctness
    // boundary; bounded busy retries let the loser observe the winning row and
    // converge through ON CONFLICT rather than failing startup.
    let result: Awaited<ReturnType<typeof seedOnce>> | undefined;
    for (let attempt = 0; attempt < (isSQLiteDatabase(db) ? 10 : 1); attempt += 1) {
      try {
        result = await seedOnce();
        break;
      } catch (error) {
        const root = getRootCause(error) as { code?: string; message?: string };
        const busy =
          root?.code === 'SQLITE_BUSY' ||
          /SQLITE_BUSY|database is locked/i.test(root?.message ?? '');
        if (!busy || attempt === 9) throw error;
        await new Promise((resolve) => setTimeout(resolve, 5 * (attempt + 1)));
      }
    }
    if (result === undefined) {
      throw new MigrationError('Failed to seed initial data after SQLite busy retries');
    }

    if (result > 0) {
      console.log('✅ Main Board created');
    }
  } catch (error) {
    throw new MigrationError(
      `Failed to seed initial data: ${error instanceof Error ? error.message : String(error)}`,
      error
    );
  }
}
