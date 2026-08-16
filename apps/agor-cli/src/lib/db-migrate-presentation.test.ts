import { MigrationError, OfflineMigrationCutoverRequiredError } from '@agor/core/db';
import { describe, expect, it } from 'vitest';
import {
  databaseBackupGuidance,
  MigrationVerificationError,
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

  it.each([
    'libsql://remote_user:raw-secret@db.example/remote?authToken=token%2Fencoded&mode=rw',
    'https://db.example/remote?username=remote_user&password=raw-secret&token=token%2Fencoded',
  ])('never prints remote SQLite connection details for %s', (remoteUrl) => {
    const output = [
      ...databaseBackupGuidance('sqlite', remoteUrl),
      ...migrationVerificationDiagnostics('sqlite', remoteUrl),
    ].join('\n');

    expect(output).toContain('database provider procedure');
    expect(output).toContain('database administration tools');
    expect(output).not.toContain('cp ');
    expect(output).not.toContain('sqlite3');
    for (const sensitive of [
      remoteUrl,
      'db.example',
      'remote',
      'remote_user',
      'raw-secret',
      'authToken',
      'password',
      'token/encoded',
      'token%2Fencoded',
    ]) {
      expect(output).not.toContain(sensitive);
      expect(output).not.toContain(encodeURIComponent(sensitive));
    }
  });

  it('retains only explicitly recognized actionable migration failures', () => {
    expect(
      migrationFailureMessage(new OfflineMigrationCutoverRequiredError(['0074_safe']))
    ).toContain('Offline migration cutover required for: 0074_safe');
    expect(migrationFailureMessage(new MigrationVerificationError())).toBe(
      'Failed to run migrations: Migration verification failed'
    );
  });

  it('sanitizes arbitrary MigrationError messages and wrapped driver failures', () => {
    const secret = 'libsql://user:secret@private.example/db?authToken=encoded%2Ftoken';
    for (const error of [
      new MigrationError(`Driver rejected ${secret}`),
      new MigrationError('Migration failed', new Error(`connection failed: ${secret}`)),
    ]) {
      const message = migrationFailureMessage(error);
      expect(message).toBe('Failed to run migrations: Database operation failed');
      expect(message).not.toContain(secret);
      expect(message).not.toContain('private.example');
      expect(message).not.toContain('encoded%2Ftoken');
    }
  });
});
