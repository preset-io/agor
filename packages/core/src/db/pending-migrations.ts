/**
 * Shared pending-migrations presentation layer.
 *
 * Both the CLI (`agor daemon start` pre-flight) and the daemon
 * (`apps/agor-daemon/src/setup/database.ts::checkAndReportMigrations`) need
 * to tell the user "your database has pending migrations, run `agor db
 * migrate`". Keeping the message in one place avoids the wording drifting
 * apart as we touch either entrypoint.
 *
 * This module is deliberately UI-agnostic — no chalk, no oclif — so it can
 * be consumed from anywhere (CLI, daemon, tests). Callers layer their own
 * colors / stream routing on top.
 */

export interface PendingMigrationsInfo {
  /** Resolved database URL used for the check (file:… or postgresql://…). */
  dbUrl: string;
  /**
   * Filesystem path for SQLite databases. For non-SQLite URLs (e.g. postgres)
   * this will typically mirror `dbUrl` — consumers use `isSQLite` below to
   * decide whether showing a filesystem backup hint makes sense.
   */
  dbPath: string;
  /** List of migration tags that have not yet been applied. */
  pending: string[];
}

/**
 * Best-effort SQLite detection from a database URL. Used to decide whether
 * to print a filesystem `cp` backup hint — postgres URLs would render a
 * nonsensical command.
 */
export function isSQLiteUrl(dbUrl: string): boolean {
  return dbUrl.startsWith('file:') || !dbUrl.includes('://');
}

/**
 * Build a multi-line plain-text message describing pending migrations, with
 * a clear pointer to `agor db migrate` and (for SQLite) a backup command.
 *
 * Leading / trailing blank lines are included so callers can write the
 * string directly to a stream without extra padding. The output is plain
 * text: callers can apply colors by wrapping the return value.
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

  if (isSQLiteUrl(info.dbUrl)) {
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
