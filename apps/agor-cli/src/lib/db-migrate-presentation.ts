import { formatSanitizedDbError, type getDatabaseDialect, sanitizeDbError } from '@agor/core/db';
import { extractDbFilePath } from '@agor/core/utils/path';

type DatabaseDialect = ReturnType<typeof getDatabaseDialect>;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function databaseBackupGuidance(dialect: DatabaseDialect, dbUrl: string): string[] {
  if (dialect === 'postgresql') {
    return ['Create a database backup or storage snapshot using your PostgreSQL backup procedure.'];
  }

  const path = shellQuote(extractDbFilePath(dbUrl));
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

  const path = shellQuote(extractDbFilePath(dbUrl));
  return [
    '  1. Check if columns already exist:',
    `     sqlite3 ${path} "PRAGMA table_info(branches)"`,
    '  2. Rebuild core package:',
    '     cd packages/core && pnpm build',
    '  3. Check migration hashes:',
    `     sqlite3 ${path} "SELECT hash FROM __drizzle_migrations"`,
  ];
}

export function migrationFailureMessage(error: unknown): string {
  return `Failed to run migrations: ${formatSanitizedDbError(sanitizeDbError(error))}`;
}
