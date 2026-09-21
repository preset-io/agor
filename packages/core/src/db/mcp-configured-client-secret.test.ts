import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  openConfiguredClientSecret,
  sealConfiguredClientSecret,
} from './mcp-configured-client-secret';

describe('configured MCP client custody', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('seals app secrets independently of grants, bound to tenant and server', () => {
    vi.stubEnv('AGOR_MASTER_SECRET', 'disposable-test-key');
    const auth = {
      type: 'oauth' as const,
      oauth_client_id: 'customer-app',
      oauth_client_secret: 'customer-secret',
    };
    const stored = sealConfiguredClientSecret(auth, '["tenant-a","server-a"]');
    expect(JSON.stringify(stored)).not.toContain('customer-secret');
    expect(openConfiguredClientSecret(stored, '["tenant-a","server-a"]')).toEqual(auth);
    for (const binding of ['["tenant-b","server-a"]', '["tenant-a","server-b"]']) {
      expect(() => openConfiguredClientSecret(stored, binding)).toThrow('unavailable');
    }
    expect(() => sealConfiguredClientSecret(stored, '["tenant-a","server-a"]')).toThrow(
      'encrypted material'
    );
    vi.stubEnv('AGOR_MASTER_SECRET', 'wrong-key');
    expect(() => openConfiguredClientSecret(stored, '["tenant-a","server-a"]')).toThrow(
      'unavailable'
    );
  });
  it('never falls back to plaintext on new writes without an encryption key', () => {
    vi.stubEnv('AGOR_MASTER_SECRET', '');
    const auth = { type: 'oauth' as const, oauth_client_secret: 'legacy-secret' };
    expect(openConfiguredClientSecret(auth, 'binding')).toEqual(auth);
    expect(() => sealConfiguredClientSecret(auth, 'binding')).toThrow('encryption key');
    expect(sealConfiguredClientSecret({ type: 'bearer', token: 'pat' }, 'binding')).toEqual({
      type: 'bearer',
      token: 'pat',
    });
  });
});
