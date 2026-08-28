import { describe, expect, it } from 'vitest';
import { redactPostgresqlUrlForDiagnostics } from './diagnostic-redaction';

describe('PostgreSQL diagnostic redaction', () => {
  it('redacts the complete URL, including query-string credentials', () => {
    const canary = 'QUERY_SECRET_CANARY';
    const value = redactPostgresqlUrlForDiagnostics(
      `postgresql://user:password@db.example/agor?sslpassword=${canary}&sslkey=/secret/key.pem`
    );

    expect(value).toBe('<redacted>');
    expect(value).not.toContain(canary);
  });
});
