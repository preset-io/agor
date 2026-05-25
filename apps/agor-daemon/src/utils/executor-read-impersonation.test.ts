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

import { resolveExecutorReadAsUser } from './executor-read-impersonation.js';

const db = {} as Database;
const user = {
  user_id: '550e8400-e29b-41d4-a716-446655440001' as UserID,
  unix_username: 'alice',
} as User;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadConfigSync.mockReturnValue({ execution: { unix_user_mode: 'simple' } });
});

describe('resolveExecutorReadAsUser', () => {
  it('does not force sudo in simple mode', async () => {
    await expect(resolveExecutorReadAsUser(db, user)).resolves.toBeUndefined();
  });

  it('leaves insulated mode to configured executor defaults', async () => {
    mocks.loadConfigSync.mockReturnValue({
      execution: { unix_user_mode: 'insulated', executor_unix_user: 'agor_executor' },
    });
    await expect(resolveExecutorReadAsUser(db, user)).resolves.toBeUndefined();
  });

  it('returns the requesting unix_username in strict mode', async () => {
    mocks.loadConfigSync.mockReturnValue({ execution: { unix_user_mode: 'strict' } });
    await expect(resolveExecutorReadAsUser(db, user)).resolves.toBe('alice');
  });

  it('loads a user id and fails clearly when strict mode lacks unix_username', async () => {
    mocks.loadConfigSync.mockReturnValue({ execution: { unix_user_mode: 'strict' } });
    mocks.findById.mockResolvedValue({ user_id: user.user_id });
    await expect(resolveExecutorReadAsUser(db, user.user_id)).rejects.toThrow(/unix_username/);
  });
});
