import {
  type DatabaseDialect,
  formatSanitizedDbError,
  OfflineMigrationCutoverRequiredError,
  sanitizeDbError,
} from '@agor/core/db';
import { extractDbFilePath } from '@agor/core/utils/path';

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function localSQLitePath(dbUrl: string): string | undefined {
  if (dbUrl.startsWith('file:')) {
    if (dbUrl.includes('?') || dbUrl.includes('#')) return undefined;
    const remainder = dbUrl.slice('file:'.length);
    // A file URL with a non-local authority names a remote resource.
    if (remainder.startsWith('//')) {
      try {
        const parsed = new URL(dbUrl);
        if (parsed.hostname) return undefined;
      } catch {
        return undefined;
      }
    }
    return extractDbFilePath(dbUrl);
  }

  // Scheme-less values are filesystem paths. Refuse URL-like and
  // protocol-relative values rather than ever printing a remote endpoint.
  if (/^[A-Za-z][A-Za-z\d+.-]*:/.test(dbUrl) || dbUrl.startsWith('//')) return undefined;
  return extractDbFilePath(dbUrl);
}

const REMOTE_SQLITE_BACKUP =
  'Create a database backup or storage snapshot using your database provider procedure.';
const REMOTE_SQLITE_VERIFICATION =
  '  1. Inspect the schema and migration ledger using your database administration tools.';

export function databaseBackupGuidance(dialect: DatabaseDialect, dbUrl: string): string[] {
  if (dialect === 'postgresql') {
    return ['Create a database backup or storage snapshot using your PostgreSQL backup procedure.'];
  }

  const localPath = localSQLitePath(dbUrl);
  if (!localPath) return [REMOTE_SQLITE_BACKUP];
  const path = shellQuote(localPath);
  return ['Run this command to create a backup:', `  cp -- ${path} ${path}.backup-$(date +%s)`];
}

export function migrationVerificationDiagnostics(
  dialect: DatabaseDialect,
  dbUrl: string
): string[] {
  if (dialect === 'postgresql') {
    return [
      '  1. Inspect the schema and migration ledger using your PostgreSQL administration tools.',
      '  2. Rebuild core package:',
      '     cd packages/core && pnpm build',
      '  3. Compare the applied migration ledger with the migrations in this release.',
    ];
  }

  const localPath = localSQLitePath(dbUrl);
  if (!localPath) {
    return [
      REMOTE_SQLITE_VERIFICATION,
      '  2. Rebuild core package:',
      '     cd packages/core && pnpm build',
      '  3. Compare the applied migration ledger with the migrations in this release.',
    ];
  }
  const path = shellQuote(localPath);
  return [
    '  1. Check if columns already exist:',
    `     sqlite3 ${path} "PRAGMA table_info(branches)"`,
    '  2. Rebuild core package:',
    '     cd packages/core && pnpm build',
    '  3. Check migration hashes:',
    `     sqlite3 ${path} "SELECT hash FROM __drizzle_migrations"`,
  ];
}

export class MigrationVerificationError extends Error {
  constructor() {
    super('Migration verification failed');
    this.name = 'MigrationVerificationError';
  }
}

export function migrationFailureMessage(error: unknown): string {
  if (
    error instanceof OfflineMigrationCutoverRequiredError ||
    error instanceof MigrationVerificationError
  ) {
    return `Failed to run migrations: ${error.message}`;
  }
  return `Failed to run migrations: ${formatSanitizedDbError(sanitizeDbError(error))}`;
}
