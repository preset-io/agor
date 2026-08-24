import { describe, expect, it } from 'vitest';
import { isBoundSecretEnvelope, openBoundSecret, sealBoundSecret } from './oauth-secret-envelope';

describe('bound secret envelope', () => {
  const master = 'test-master-secret-with-enough-entropy';

  it('round-trips with explicit OAuth format and no plaintext', () => {
    const envelope = sealBoundSecret(
      'PKCE-DO-NOT-PERSIST-RAW',
      master,
      'pending-exchange',
      'tenant\0user\0server\0attempt'
    );
    expect(isBoundSecretEnvelope(envelope)).toBe(true);
    expect(envelope).toMatch(/^agor-mcp-oauth:v1:pending-exchange:/);
    expect(envelope).not.toContain('PKCE-DO-NOT-PERSIST-RAW');
    expect(
      openBoundSecret(envelope, master, 'pending-exchange', 'tenant\0user\0server\0attempt')
    ).toBe('PKCE-DO-NOT-PERSIST-RAW');
  });

  it.each([
    ['wrong purpose', 'refresh-token', 'tenant\0user\0server\0attempt', master],
    ['wrong binding', 'pending-exchange', 'tenant\0other\0server\0attempt', master],
    ['wrong master secret', 'pending-exchange', 'tenant\0user\0server\0attempt', 'other'],
  ] as const)('rejects %s through AEAD domain separation', (_label, purpose, binding, key) => {
    const envelope = sealBoundSecret(
      'secret',
      master,
      'pending-exchange',
      'tenant\0user\0server\0attempt'
    );
    expect(() => openBoundSecret(envelope, key, purpose, binding)).toThrow();
  });

  it('rejects legacy/plaintext and malformed envelopes without fallback', () => {
    expect(() => openBoundSecret('raw-secret', master, 'access-token', 'binding')).toThrow(
      'Unsupported bound secret envelope'
    );
    expect(() =>
      openBoundSecret('agor-mcp-oauth:v2:access-token:a:b:c:d', master, 'access-token', 'binding')
    ).toThrow('Unsupported bound secret envelope');
  });

  it('keeps Claude attempt ciphertext outside the MCP exchange purpose domain', () => {
    const binding = 'tenant\0user\0attempt\x01';
    const envelope = sealBoundSecret(
      '{"codeVerifier":"verifier"}',
      master,
      'claude-signin-attempt',
      binding
    );

    expect(envelope).toMatch(/^agor-mcp-oauth:v1:claude-signin-attempt:/);
    expect(() => openBoundSecret(envelope, master, 'pending-exchange', binding)).toThrow(
      'Unsupported bound secret envelope'
    );
    expect(openBoundSecret(envelope, master, 'claude-signin-attempt', binding)).toContain(
      'verifier'
    );
  });
});
