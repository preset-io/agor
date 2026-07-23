import { describe, expect, it } from 'vitest';
import { redactLaunchSecrets, safeLaunchDiagnostic } from './launch-redaction.js';

describe('launch secret redaction', () => {
  it('redacts explicit secret literals (codes, assertions, credentials)', () => {
    const code = 'otc_abcdef123456';
    const assertion = 'eyJhbGciOiJSUzI1NiJ9.payload.signature';
    const bearer = 'exchange-credential-xyz';
    const message = `exchange failed for ${code} using ${assertion} and ${bearer}`;

    const out = redactLaunchSecrets(message, [code, assertion, bearer]);

    expect(out).not.toContain(code);
    expect(out).not.toContain(assertion);
    expect(out).not.toContain(bearer);
    expect(out).toContain('[redacted]');
  });

  it('redacts Authorization/Bearer values structurally', () => {
    expect(redactLaunchSecrets('Authorization: Bearer supersecrettoken')).not.toContain(
      'supersecrettoken'
    );
    expect(redactLaunchSecrets('sent Bearer supersecrettoken to issuer')).toBe(
      'sent Bearer [redacted] to issuer'
    );
  });

  it('redacts Set-Cookie / Cookie headers', () => {
    const out = redactLaunchSecrets('set-cookie: agor-access=abc; Path=/; HttpOnly');
    expect(out).not.toContain('agor-access=abc');
    expect(out).toContain('[redacted]');
  });

  it('redacts credentialed database URLs', () => {
    const out = redactLaunchSecrets('db=postgres://user:s3cr3t@db.internal:5432/agor');
    expect(out).not.toContain('s3cr3t');
    expect(out).toContain('[redacted]');
  });

  it('ignores short/empty secret literals to avoid over-redaction', () => {
    expect(redactLaunchSecrets('normal message', ['', 'ab', undefined])).toBe('normal message');
  });

  it('safeLaunchDiagnostic prefixes and scrubs', () => {
    const out = safeLaunchDiagnostic('failed with token tok_longsecret', ['tok_longsecret']);
    expect(out.startsWith('[auth/launch] ')).toBe(true);
    expect(out).not.toContain('tok_longsecret');
  });
});
