import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  openConfiguredClientSecret,
  sealConfiguredClientSecret,
} from './mcp-configured-client-secret';

const bound = () => '["tenant-a","server-a"]';
// What an unscoped (system/background) read sees: no ambient tenant.
const unscoped = () => {
  throw new Error('Missing active tenant context');
};

describe('configured MCP client custody', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('seals app secrets independently of grants, bound to tenant and server', () => {
    vi.stubEnv('AGOR_MASTER_SECRET', 'disposable-test-key');
    const auth = {
      type: 'oauth' as const,
      oauth_client_id: 'customer-app',
      oauth_client_secret: 'customer-secret',
    };
    const stored = sealConfiguredClientSecret(auth, bound, true);
    expect(JSON.stringify(stored)).not.toContain('customer-secret');
    expect(openConfiguredClientSecret(stored, bound)).toEqual(auth);
    for (const binding of ['["tenant-b","server-a"]', '["tenant-a","server-b"]']) {
      expect(() => openConfiguredClientSecret(stored, () => binding)).toThrow('unavailable');
    }
    expect(() => openConfiguredClientSecret(stored, unscoped)).toThrow('unavailable');
    expect(() => sealConfiguredClientSecret(stored, bound, true)).toThrow('encrypted material');
    expect(() => sealConfiguredClientSecret(stored, bound, false)).toThrow('encrypted material');
    vi.stubEnv('AGOR_MASTER_SECRET', 'wrong-key');
    expect(() => openConfiguredClientSecret(stored, bound)).toThrow('unavailable');
  });
  it('never falls back to plaintext on new PostgreSQL writes without an encryption key', () => {
    vi.stubEnv('AGOR_MASTER_SECRET', '');
    const auth = { type: 'oauth' as const, oauth_client_secret: 'legacy-secret' };
    expect(() => sealConfiguredClientSecret(auth, bound, true)).toThrow('encryption key');
    expect(sealConfiguredClientSecret({ type: 'bearer', token: 'pat' }, unscoped, true)).toEqual({
      type: 'bearer',
      token: 'pat',
    });
  });
  it.each(['legacy-plaintext-secret', '{{ user.env.CLIENT_SECRET }}'])(
    'reads %s without tenant binding or key, and seals neither on SQLite nor an env reference',
    (secret) => {
      vi.stubEnv('AGOR_MASTER_SECRET', '');
      const auth = { type: 'oauth' as const, oauth_client_secret: secret };
      expect(openConfiguredClientSecret(auth, unscoped)).toEqual(auth);
      expect(sealConfiguredClientSecret(auth, unscoped, false)).toEqual(auth);
      if (secret.startsWith('{{'))
        expect(sealConfiguredClientSecret(auth, unscoped, true)).toEqual(auth);
    }
  );
});
