import type { Params } from '@agor/core/types';
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
      get: vi.fn(async (_id: string, _params: Params) => ({
        user_id: 'user-1',
        email: 'user@example.test',
      })),
    };
    const params = { tenant: { tenant_id: 'tenant-a', source: 'auth_claim' } };
    strategy.setDependencies(apiKeysRepo as never, usersService as never);

    await strategy.authenticate({ apiKey: 'agor_sk_test' }, params);

    expect(apiKeysRepo.verifyKey).toHaveBeenCalledWith('agor_sk_test');
    const lookupParams = usersService.get.mock.calls[0][1];
    expect(usersService.get).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ tenant: params.tenant, query: {} })
    );
    expect(lookupParams).not.toBe(params);
    expect(isAuthenticationUserLookup(lookupParams)).toBe(true);
    expect(isAuthenticationUserLookup(params)).toBe(false);
    expect(params.tenant).toEqual({ tenant_id: 'tenant-a', source: 'auth_claim' });
  });

  it('isolates the internal user query from caller filters and projections', async () => {
    const strategy = new ApiKeyStrategy();
    const apiKeysRepo = {
      verifyKey: vi.fn(async () => ({ id: 'key-1', user_id: 'user-1' })),
      updateLastUsed: vi.fn(async () => undefined),
    };
    const query = Object.freeze({
      namespace: 'agor-cloud-team',
      bundle: 'a'.repeat(64),
      $select: ['email'],
    });
    const params = { tenant: { tenant_id: 'tenant-a', source: 'auth_claim' }, query };
    const usersService = {
      get: vi.fn(async (_id: string, lookupParams: Params) => {
        expect(lookupParams.query).toEqual({});
        // Mutation by an internal hook must not affect the original request.
        lookupParams.query!.internal = true;
        return { user_id: 'user-1', tenant_id: 'tenant-a' };
      }),
    };
    strategy.setDependencies(apiKeysRepo as never, usersService);
    await strategy.authenticate({ apiKey: 'agor_sk_test' }, params);
    expect(params.query).toBe(query);
    expect(params.query).not.toHaveProperty('internal');
    expect(isAuthenticationUserLookup(params)).toBe(false);
  });

  it.each([
    ['key row', { id: 'key-1', user_id: 'user-1', tenant_id: 'tenant-b' }, 'tenant-a'],
    ['owning user', { id: 'key-1', user_id: 'user-1', tenant_id: 'tenant-a' }, 'tenant-b'],
  ])('rejects a %s from another tenant than the request', async (_label, keyRow, userTenant) => {
    const strategy = new ApiKeyStrategy();
    const apiKeysRepo = {
      verifyKey: vi.fn(async () => keyRow),
      updateLastUsed: vi.fn(async () => undefined),
    };
    const usersService = {
      get: vi.fn(async () => ({ user_id: 'user-1', tenant_id: userTenant })),
    };
    strategy.setDependencies(apiKeysRepo as never, usersService as never);

    await expect(
      strategy.authenticate(
        { apiKey: 'agor_sk_test' },
        { tenant: { tenant_id: 'tenant-a', source: 'trusted_host' } }
      )
    ).rejects.toMatchObject({ name: 'NotAuthenticated', message: 'Invalid API key' });
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
