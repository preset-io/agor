import { describe, expect, it, vi } from 'vitest';
import { isAuthenticationUserLookup } from '../services/users.js';
import { ApiKeyStrategy } from './api-key-strategy.js';

describe('ApiKeyStrategy tenant propagation', () => {
  it('passes the resolved tenant params into the user lookup', async () => {
    const strategy = new ApiKeyStrategy();
    const apiKeysRepo = {
      verifyKey: vi.fn(async () => ({ id: 'key-1', user_id: 'user-1' })),
      updateLastUsed: vi.fn(async () => undefined),
    };
    const usersService = {
      get: vi.fn(async () => ({ user_id: 'user-1', email: 'user@example.test' })),
    };
    const params = { tenant: { tenant_id: 'tenant-a', source: 'auth_claim' } };
    strategy.setDependencies(apiKeysRepo as never, usersService as never);

    await strategy.authenticate({ apiKey: 'agor_sk_test' }, params);

    expect(apiKeysRepo.verifyKey).toHaveBeenCalledWith('agor_sk_test');
    expect(usersService.get).toHaveBeenCalledWith('user-1', params);
    expect(isAuthenticationUserLookup(params)).toBe(true);
    expect(params.tenant).toEqual({ tenant_id: 'tenant-a', source: 'auth_claim' });
  });

  it('leaves Socket.IO header authentication to the namespace boundary', async () => {
    const strategy = new ApiKeyStrategy();
    const handshake = {
      auth: {},
      issued: Date.now(),
      query: {},
      headers: { authorization: 'Bearer agor_sk_test' },
    };

    await expect(strategy.parse(handshake)).resolves.toBeNull();
    await expect(
      strategy.parse({ headers: { authorization: 'Bearer agor_sk_test' } })
    ).resolves.toEqual({ strategy: 'api-key', apiKey: 'agor_sk_test' });
  });
});
