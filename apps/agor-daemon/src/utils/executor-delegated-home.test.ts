import type { Database } from '@agor/core/db';
import type { User, UserID } from '@agor/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadConfigSync: vi.fn(),
  findById: vi.fn(),
}));

vi.mock('@agor/core/config', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@agor/core/config');
  return { ...actual, loadConfigSync: mocks.loadConfigSync };
});

vi.mock('@agor/core/db', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@agor/core/db');
  return {
    ...actual,
    UsersRepository: class {
      findById = mocks.findById;
    },
  };
});

import { resolveDelegatedExecutionHomeKey } from './executor-delegated-home.js';

const db = {} as Database;
const user = {
  user_id: '550e8400-e29b-41d4-a716-446655440001' as UserID,
  unix_username: 'alice',
} as User;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadConfigSync.mockReturnValue({ execution: { unix_user_mode: 'simple' } });
});

describe('resolveDelegatedExecutionHomeKey', () => {
  it('does not force sudo in simple mode', async () => {
    await expect(
      resolveDelegatedExecutionHomeKey(db, user, mocks.loadConfigSync())
    ).resolves.toBeUndefined();
  });

  it('reports the requesting unix_username to a delegated executor command template', async () => {
    mocks.loadConfigSync.mockReturnValue({
      execution: {
        unix_user_mode: 'delegated',
        executor_command_template: 'launcher --user {unix_user} -- agor-executor --stdin',
      },
    });
    mocks.findById.mockResolvedValue(user);

    await expect(
      resolveDelegatedExecutionHomeKey(db, user.user_id, mocks.loadConfigSync())
    ).resolves.toBe('alice');
    expect(mocks.findById).toHaveBeenCalledWith(user.user_id);
  });

  it('does not turn delegated local execution into sudo impersonation', async () => {
    mocks.loadConfigSync.mockReturnValue({ execution: { unix_user_mode: 'delegated' } });
    await expect(
      resolveDelegatedExecutionHomeKey(db, user, mocks.loadConfigSync())
    ).resolves.toBeUndefined();
  });

  it('fails before launch when a delegated command template lacks unix_username', async () => {
    mocks.loadConfigSync.mockReturnValue({
      execution: {
        unix_user_mode: 'delegated',
        executor_command_template: 'launcher --user {unix_user} -- agor-executor --stdin',
      },
    });
    mocks.findById.mockResolvedValue({ user_id: user.user_id });

    await expect(
      resolveDelegatedExecutionHomeKey(db, user.user_id, mocks.loadConfigSync())
    ).rejects.toThrow(/unix_username/);
  });
});
