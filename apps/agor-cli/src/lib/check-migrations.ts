/**
 * Pre-flight migration check for CLI commands that start the daemon.
 *
 * The daemon itself also checks migrations on startup (and calls process.exit(1)
 * if any are pending). That is sufficient in foreground mode, but when the
 * daemon is spawned as a detached background process, its stderr is redirected
 * into ~/.agor/logs/daemon.log — so the user sees no error at their terminal
 * prompt and the failure looks silent.
 *
 * This helper lets the CLI surface the same failure inline on stderr *before*
 * it spawns the daemon, so the user gets an actionable error at the terminal
 * (with a pointer to `agor db migrate`) and the CLI exits with a non-zero
 * status code.
 */

import { checkMigrationStatus, createDatabase, getDatabaseUrl } from '@agor/core/db';
import { extractDbFilePath } from '@agor/core/utils/path';

export interface PendingMigrationsInfo {
  /** Resolved database URL used for the check (file:… or postgresql://…). */
  dbUrl: string;
  /** Filesystem path for SQLite databases, or the URL as-is for postgres. */
  dbPath: string;
  /** List of migration tags that have not yet been applied. */
  pending: string[];
}

/**
 * Returns info about pending migrations, or null if the database is up to date.
 *
 * Deliberately does not call process.exit — callers format their own user-facing
 * error message and decide how to exit. This keeps the helper pure and testable.
 */
export async function getPendingMigrationsInfo(): Promise<PendingMigrationsInfo | null> {
  const dbUrl = getDatabaseUrl();
  const db = createDatabase({ url: dbUrl });
  const status = await checkMigrationStatus(db);

  if (!status.hasPending) {
    return null;
  }

  return {
    dbUrl,
    dbPath: extractDbFilePath(dbUrl),
    pending: status.pending,
  };
}

/**
 * Format a multi-line stderr message describing pending migrations, with a
 * clear pointer to `agor db migrate` and (for SQLite) a backup command.
 *
 * Exported so tests can assert on the exact user-facing output.
 */
export function formatPendingMigrationsMessage(info: PendingMigrationsInfo): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('✗ Database migrations required');
  lines.push('');
  lines.push(`Pending migrations (${info.pending.length}):`);
  for (const tag of info.pending) {
    lines.push(`  • ${tag}`);
  }
  lines.push('');

  // Only show a backup hint for SQLite — the path-based cp command does not
  // make sense against a postgres:// URL.
  const isSQLite = info.dbUrl.startsWith('file:') || !info.dbUrl.includes('://');
  if (isSQLite) {
    lines.push('⚠️  IMPORTANT: Backup your database before running migrations!');
    lines.push('');
    lines.push(`  cp ${info.dbPath} ${info.dbPath}.backup-$(date +%s)`);
    lines.push('');
  }

  lines.push('Then run migrations with:');
  lines.push('  agor db migrate');
  lines.push('');

  return lines.join('\n');
}
