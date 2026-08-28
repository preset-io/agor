import { describe, expect, it } from 'vitest';
import { buildDatabaseHealthInfo } from './database-health-diagnostics';

describe('database health diagnostics', () => {
  it('redacts the complete PostgreSQL DSN including query-string secrets', () => {
    const canary = 'HEALTH_QUERY_SECRET_CANARY';
    const result = buildDatabaseHealthInfo(
      'postgresql',
      `postgresql://user:password@db.example/agor?sslpassword=${canary}`
    );

    expect(result).toEqual({ dialect: 'postgresql', url: '<redacted-database-url>' });
    expect(JSON.stringify(result)).not.toContain(canary);
  });

  it('retains the SQLite diagnostic path', () => {
    expect(buildDatabaseHealthInfo('sqlite', '/var/lib/agor.db')).toEqual({
      dialect: 'sqlite',
      path: '/var/lib/agor.db',
    });
  });
});
