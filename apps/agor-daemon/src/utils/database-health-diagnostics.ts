import { redactPostgresqlUrlForDiagnostics } from '@agor/core/config';

export type DatabaseHealthInfo = { dialect: string; url?: string; path?: string };

/** Build the authenticated health diagnostic without serializing PostgreSQL DSNs. */
export function buildDatabaseHealthInfo(
  dialect: 'postgresql' | 'sqlite',
  databasePath: string
): DatabaseHealthInfo {
  return dialect === 'postgresql'
    ? {
        dialect,
        url: redactPostgresqlUrlForDiagnostics(databasePath, '<redacted-database-url>'),
      }
    : { dialect, path: databasePath };
}
