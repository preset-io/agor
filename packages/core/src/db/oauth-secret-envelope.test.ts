import { describe, expect, it } from 'vitest';
import {
  isBoundSecretEnvelope,
  openBoundSecret,
  openBoundSecretAsync,
  sealBoundSecret,
} from './oauth-secret-envelope';

describe.each([
  ['sync', openBoundSecret],
  ['async', openBoundSecretAsync],
] as const)('bound secret envelope (%s)', (_name, open) => {
  const master = 'test-master-secret-with-enough-entropy';

  it('round-trips with explicit OAuth format and no plaintext', async () => {
    const envelope = sealBoundSecret(
      'PKCE-DO-NOT-PERSIST-RAW',
      master,
      'pending-exchange',
      'tenant\0user\0server\0attempt'
    );
    expect(isBoundSecretEnvelope(envelope)).toBe(true);
    expect(envelope).toMatch(/^agor-mcp-oauth:v1:pending-exchange:/);
    expect(envelope).not.toContain('PKCE-DO-NOT-PERSIST-RAW');
    expect(await open(envelope, master, 'pending-exchange', 'tenant\0user\0server\0attempt')).toBe(
      'PKCE-DO-NOT-PERSIST-RAW'
    );
  });

  it.each([
    ['wrong purpose', 'refresh-token', 'tenant\0user\0server\0attempt', master],
    ['wrong binding', 'pending-exchange', 'tenant\0other\0server\0attempt', master],
    ['wrong master secret', 'pending-exchange', 'tenant\0user\0server\0attempt', 'other'],
  ] as const)(
    'rejects %s through AEAD domain separation',
    async (_label, purpose, binding, key) => {
      const envelope = sealBoundSecret(
        'secret',
        master,
        'pending-exchange',
        'tenant\0user\0server\0attempt'
      );
      await expect(async () => open(envelope, key, purpose, binding)).rejects.toThrow();
    }
  );

  it('rejects legacy/plaintext and malformed envelopes without fallback', async () => {
    await expect(async () => open('raw-secret', master, 'access-token', 'binding')).rejects.toThrow(
      'Unsupported bound secret envelope'
    );
    await expect(async () =>
      open('agor-mcp-oauth:v2:access-token:a:b:c:d', master, 'access-token', 'binding')
    ).rejects.toThrow('Unsupported bound secret envelope');
  });

  it('keeps Claude attempt ciphertext outside the MCP exchange purpose domain', async () => {
    const binding = 'tenant\0user\0attempt\x01';
    const envelope = sealBoundSecret(
      '{"codeVerifier":"verifier"}',
      master,
      'claude-signin-attempt',
      binding
    );

    expect(envelope).toMatch(/^agor-mcp-oauth:v1:claude-signin-attempt:/);
    await expect(async () => open(envelope, master, 'pending-exchange', binding)).rejects.toThrow(
      'Unsupported bound secret envelope'
    );
    expect(await open(envelope, master, 'claude-signin-attempt', binding)).toContain('verifier');
  });
});
