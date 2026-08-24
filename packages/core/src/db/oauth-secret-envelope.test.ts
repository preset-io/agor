import { describe, expect, it } from 'vitest';
import {
  isMCPOAuthSecretEnvelope,
  openMCPOAuthSecret,
  sealMCPOAuthSecret,
} from './oauth-secret-envelope';

describe('MCP OAuth secret envelope', () => {
  const master = 'test-master-secret-with-enough-entropy';

  it('round-trips with explicit OAuth format and no plaintext', () => {
    const envelope = sealMCPOAuthSecret(
      'PKCE-DO-NOT-PERSIST-RAW',
      master,
      'pending-exchange',
      'tenant\0user\0server\0attempt'
    );
    expect(isMCPOAuthSecretEnvelope(envelope)).toBe(true);
    expect(envelope).toMatch(/^agor-mcp-oauth:v1:pending-exchange:/);
    expect(envelope).not.toContain('PKCE-DO-NOT-PERSIST-RAW');
    expect(
      openMCPOAuthSecret(envelope, master, 'pending-exchange', 'tenant\0user\0server\0attempt')
    ).toBe('PKCE-DO-NOT-PERSIST-RAW');
  });

  it.each([
    ['wrong purpose', 'refresh-token', 'tenant\0user\0server\0attempt', master],
    ['wrong binding', 'pending-exchange', 'tenant\0other\0server\0attempt', master],
    ['wrong master secret', 'pending-exchange', 'tenant\0user\0server\0attempt', 'other'],
  ] as const)('rejects %s through AEAD domain separation', (_label, purpose, binding, key) => {
    const envelope = sealMCPOAuthSecret(
      'secret',
      master,
      'pending-exchange',
      'tenant\0user\0server\0attempt'
    );
    expect(() => openMCPOAuthSecret(envelope, key, purpose, binding)).toThrow();
  });

  it('rejects legacy/plaintext and malformed envelopes without fallback', () => {
    expect(() => openMCPOAuthSecret('raw-secret', master, 'access-token', 'binding')).toThrow(
      'Unsupported MCP OAuth secret envelope'
    );
    expect(() =>
      openMCPOAuthSecret(
        'agor-mcp-oauth:v2:access-token:a:b:c:d',
        master,
        'access-token',
        'binding'
      )
    ).toThrow('Unsupported MCP OAuth secret envelope');
  });

  it('keeps Claude attempt ciphertext outside the MCP exchange purpose domain', () => {
    const binding = 'tenant\0user\0attempt\x01';
    const envelope = sealMCPOAuthSecret(
      '{"codeVerifier":"verifier"}',
      master,
      'claude-signin-attempt',
      binding
    );

    expect(envelope).toMatch(/^agor-mcp-oauth:v1:claude-signin-attempt:/);
    expect(() => openMCPOAuthSecret(envelope, master, 'pending-exchange', binding)).toThrow(
      'Unsupported MCP OAuth secret envelope'
    );
    expect(openMCPOAuthSecret(envelope, master, 'claude-signin-attempt', binding)).toContain(
      'verifier'
    );
  });
});
