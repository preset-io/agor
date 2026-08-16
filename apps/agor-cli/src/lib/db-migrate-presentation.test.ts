import { describe, expect, it } from 'vitest';
import {
  databaseBackupGuidance,
  migrationFailureMessage,
  migrationVerificationDiagnostics,
} from './db-migrate-presentation.js';

const databaseUrl =
  'postgresql://migration_user:super-secret-password@db.internal/runtime?sslmode=require';

const sensitiveValues = [
  databaseUrl,
  'migration_user',
  'super-secret-password',
  'db.internal',
  'runtime',
  'sslmode',
  'require',
];

function expectSecretSafe(stdout: string, stderr = ''): void {
  for (const value of sensitiveValues) {
    expect(stdout).not.toContain(value);
    expect(stderr).not.toContain(value);
    expect(stdout).not.toContain(encodeURIComponent(value));
    expect(stderr).not.toContain(encodeURIComponent(value));
  }
}

describe('db migrate presentation', () => {
  it('presents successful PostgreSQL migration backup guidance without connection details', () => {
    const stdout = databaseBackupGuidance('postgresql', databaseUrl).join('\n');
    const stderr = '';

    expect(stdout).toContain('PostgreSQL backup procedure');
    expect(stdout).not.toContain('cp ');
    expectSecretSafe(stdout, stderr);
  });

  it('presents a PostgreSQL migration failure without connection details', () => {
    const stdout = '';
    const stderr = migrationFailureMessage(
      new Error(`connection to ${databaseUrl} (${encodeURIComponent(databaseUrl)}) failed`)
    );

    expect(stderr).toBe('Failed to run migrations: Database operation failed');
    expectSecretSafe(stdout, stderr);
  });

  it('presents PostgreSQL verification failure diagnostics without SQLite commands or details', () => {
    const stdout = migrationVerificationDiagnostics('postgresql', databaseUrl).join('\n');
    const stderr = '';

    expect(stdout).toContain('PostgreSQL administration tools');
    expect(stdout).not.toContain('sqlite3');
    expect(stdout).not.toContain('PRAGMA');
    expectSecretSafe(stdout, stderr);
  });

  it('keeps SQLite backup and verification guidance safely path-based', () => {
    const sqliteUrl = "file:/tmp/agor db's/runtime.db";
    const backup = databaseBackupGuidance('sqlite', sqliteUrl).join('\n');
    const diagnostics = migrationVerificationDiagnostics('sqlite', sqliteUrl).join('\n');

    expect(backup).toContain(`cp -- '/tmp/agor db'"'"'s/runtime.db'`);
    expect(diagnostics).toContain(`sqlite3 '/tmp/agor db'"'"'s/runtime.db'`);
    expect(diagnostics).toContain('PRAGMA table_info(branches)');
  });
});
