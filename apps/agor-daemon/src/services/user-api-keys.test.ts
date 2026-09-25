import type { UserApiKeyPublic } from '@agor/core/db';
import type { AuthenticatedParams } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { createUserApiKeysService } from './user-api-keys.js';

const params = {
  user: { user_id: 'user-1', email: 'u@example.test', role: 'member' },
} as AuthenticatedParams;

function key(overrides: Partial<UserApiKeyPublic> = {}): UserApiKeyPublic {
  return {
    id: 'key-old',
    name: 'agor-cli-laptop-1a2b',
    prefix: 'agor_sk_abcd',
    source: 'cli_login',
    created_at: new Date(0),
    ...overrides,
  };
}

function setup(existing: UserApiKeyPublic[] = []) {
  const calls: string[] = [];
  const repo = {
    listByUser: vi.fn(async () => existing),
    create: vi.fn(async (_user: string, name: string, source = 'manual') => {
      calls.push('create');
      return { rawKey: 'agor_sk_new', key: key({ id: 'key-new', name, source }) };
    }),
    deleteReplacedCliKeys: vi.fn(async () => {
      calls.push('replace');
      return 1;
    }),
  };
  return { repo, calls, service: createUserApiKeysService(repo as never) };
}

describe('user API keys service', () => {
  it('creates manual keys by default without replacing anything', async () => {
    const { repo, service } = setup([key()]);
    const result = await service.create({ name: 'agor-cli-laptop-1a2b' }, params);

    expect(repo.create).toHaveBeenCalledWith('user-1', 'agor-cli-laptop-1a2b', 'manual');
    expect(repo.deleteReplacedCliKeys).not.toHaveBeenCalled();
    expect(result.replaced).toBe(0);
  });

  it('replaces the machine CLI key only after the new key exists', async () => {
    const { repo, calls, service } = setup([key()]);
    const result = await service.create(
      { name: 'agor-cli-laptop-1a2b', source: 'cli_login', replace_previous: true },
      params
    );

    expect(calls).toEqual(['create', 'replace']);
    expect(repo.deleteReplacedCliKeys).toHaveBeenCalledWith(
      'user-1',
      'agor-cli-laptop-1a2b',
      'key-new'
    );
    expect(result).toMatchObject({ rawKey: 'agor_sk_new', replaced: 1 });
  });

  it('never replaces for manual keys even when asked', async () => {
    const { repo, service } = setup([key()]);
    await service.create({ name: 'agor-cli-laptop-1a2b', replace_previous: true }, params);
    expect(repo.deleteReplacedCliKeys).not.toHaveBeenCalled();
  });

  it('rejects unknown sources', async () => {
    const { repo, service } = setup();
    await expect(
      service.create({ name: 'x', source: 'admin' as never }, params)
    ).rejects.toMatchObject({ name: 'BadRequest' });
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('lets a CLI re-login replace at the 25-key limit but blocks new keys', async () => {
    const full = Array.from({ length: 24 }, (_, i) =>
      key({ id: `manual-${i}`, name: `k${i}`, source: 'manual' })
    ).concat(key());

    const relogin = setup(full);
    await expect(
      relogin.service.create(
        { name: 'agor-cli-laptop-1a2b', source: 'cli_login', replace_previous: true },
        params
      )
    ).resolves.toMatchObject({ replaced: 1 });

    const fresh = setup(full);
    await expect(
      fresh.service.create({ name: 'agor-cli-other-9f9f', source: 'cli_login' }, params)
    ).rejects.toThrow('Maximum of 25 API keys per user');
  });
});
