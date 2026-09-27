import { resolveExternalUserAuthorityBinding } from '@agor/core/config';
import { UserApiKeysRepository } from '@agor/core/db';
import { expect, vi } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { NOOP_METRICS } from '../metrics/index.js';
import { UsersService } from '../services/users.js';
import { ApiKeyStrategy } from './api-key-strategy.js';
import { installUserAuthorityCheck } from './user-authority.js';

dbTest(
  'authority uses one projection per check, no positive cache, and bounded metric labels',
  async ({ db }) => {
    const users = new UsersService(db);
    const user = await users.create({
      email: 'projection@example.test',
      password: 'test-password-1234',
      role: 'member',
    });
    const metrics = { ...NOOP_METRICS, enabled: true, increment: vi.fn(), timing: vi.fn() };
    const checker = installUserAuthorityCheck({ get: () => metrics }, db as never);
    const client = (
      db as unknown as { $client: { execute: (...args: unknown[]) => Promise<unknown> } }
    ).$client;
    const execute = vi.spyOn(client, 'execute');
    try {
      await expect(checker('default', user.user_id)).resolves.toEqual({ role: 'member' });
      expect(execute).toHaveBeenCalledTimes(1);
      await users.patch(user.user_id, { access_disabled: true });
      execute.mockClear();
      await expect(checker('default', user.user_id)).rejects.toMatchObject({ code: 401 });
      expect(execute).toHaveBeenCalledTimes(1);
      execute.mockRejectedValueOnce(new Error('synthetic database outage'));
      await expect(checker('default', user.user_id)).rejects.toThrow();
      expect(
        metrics.increment.mock.calls.filter(([name]) => name === 'auth.authority.check')
      ).toEqual([
        ['auth.authority.check', 1, { result: 'allowed' }],
        ['auth.authority.check', 1, { result: 'denied' }],
        ['auth.authority.check', 1, { result: 'unavailable' }],
      ]);
      expect(
        metrics.increment.mock.calls.filter(([name]) => name === 'auth.authority.db_statements')
      ).toHaveLength(3);
      expect(JSON.stringify(metrics.increment.mock.calls)).not.toContain(user.user_id);
    } finally {
      execute.mockRestore();
    }
  }
);

dbTest(
  'external lifecycle denies an unsynchronized enabled legacy user and its raw API key',
  async ({ db }) => {
    const users = new UsersService(db);
    const user = await users.create({
      email: 'unsynchronized@example.test',
      password: 'test-password-1234',
      role: 'admin',
    });
    const keys = new UserApiKeysRepository(db);
    const key = await keys.create(user.user_id, 'legacy');
    const check = installUserAuthorityCheck(
      {},
      db as never,
      resolveExternalUserAuthorityBinding({
        identity: { user_lifecycle: 'external' },
        external_launch: { issuer: 'https://cloud.example.test' },
      })
    );
    const api = new ApiKeyStrategy();
    api.setDependencies(keys, users, check, 'default');
    expect((await users.get(user.user_id)).access_disabled).toBe(false);
    await expect(api.authenticate({ apiKey: key.rawKey }, {})).rejects.toMatchObject({ code: 401 });
    const local = installUserAuthorityCheck({}, db as never);
    api.setDependencies(keys, users, local, 'default');
    await expect(api.authenticate({ apiKey: key.rawKey }, {})).resolves.toMatchObject({
      user: { user_id: user.user_id },
    });
  }
);
