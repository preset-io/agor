import { describe, expect } from 'vitest';
import type { Database } from '../client';
import { dbTest } from '../test-helpers';
import { UserApiKeysRepository } from './user-api-keys';
import { UsersRepository } from './users';

async function seedUser(db: Database, label: string) {
  return new UsersRepository(db).create({
    email: `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
    name: label,
    role: 'member',
  });
}

describe('UserApiKeysRepository sources', () => {
  dbTest('defaults to manual and records cli_login keys', async ({ db }) => {
    const user = await seedUser(db, 'source');
    const keys = new UserApiKeysRepository(db);

    const manual = await keys.create(user.user_id, 'CI pipeline');
    const cli = await keys.create(user.user_id, 'agor-cli-laptop-1a2b', 'cli_login');

    expect(manual.key.source).toBe('manual');
    expect(cli.key.source).toBe('cli_login');
    const listed = await keys.listByUser(user.user_id);
    expect(Object.fromEntries(listed.map((key) => [key.name, key.source]))).toEqual({
      'CI pipeline': 'manual',
      'agor-cli-laptop-1a2b': 'cli_login',
    });
    expect((await keys.verifyKey(cli.rawKey))?.source).toBe('cli_login');
  });

  dbTest('replaces only the same machine CLI key of the same user', async ({ db }) => {
    const owner = await seedUser(db, 'owner');
    const other = await seedUser(db, 'other');
    const keys = new UserApiKeysRepository(db);
    const machine = 'agor-cli-laptop-1a2b';

    const previous = await keys.create(owner.user_id, machine, 'cli_login');
    const otherMachine = await keys.create(owner.user_id, 'agor-cli-desktop-9f9f', 'cli_login');
    const manualSameName = await keys.create(owner.user_id, machine, 'manual');
    const otherUserSameName = await keys.create(other.user_id, machine, 'cli_login');
    const current = await keys.create(owner.user_id, machine, 'cli_login');

    await expect(keys.deleteReplacedCliKeys(owner.user_id, machine, current.key.id)).resolves.toBe(
      1
    );

    expect(await keys.verifyKey(previous.rawKey)).toBeNull();
    for (const kept of [current, otherMachine, manualSameName, otherUserSameName]) {
      expect(await keys.verifyKey(kept.rawKey)).not.toBeNull();
    }
  });

  dbTest('overlapping logins for one machine keep exactly the newer key', async ({ db }) => {
    const owner = await seedUser(db, 'race');
    const keys = new UserApiKeysRepository(db);
    const machine = 'agor-cli-laptop-1a2b';

    // Both logins create before either replaces — the interleaving that used to
    // let each delete the other's key.
    const first = await keys.create(owner.user_id, machine, 'cli_login');
    const second = await keys.create(owner.user_id, machine, 'cli_login');
    const [newer, older] = second.key.id > first.key.id ? [second, first] : [first, second];

    await expect(keys.deleteReplacedCliKeys(owner.user_id, machine, older.key.id)).resolves.toBe(0);
    await expect(keys.deleteReplacedCliKeys(owner.user_id, machine, newer.key.id)).resolves.toBe(1);

    expect(await keys.verifyKey(newer.rawKey)).not.toBeNull();
    expect(await keys.verifyKey(older.rawKey)).toBeNull();
  });
});
