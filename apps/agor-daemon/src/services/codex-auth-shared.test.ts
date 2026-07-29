/**
 * Regression tests for `resolveCodexUnixIdentity()` mode handling.
 *
 * Delegated + templated execution must resolve to `unsupported-mode` WITHOUT
 * looking up the user or touching any credential path: the auth.json Codex
 * reads lives in the execution substrate's per-user home, so daemon-side
 * import/verify/logout would silently share one daemon-home file across
 * users and never reach the executor. Delegated WITHOUT a template keeps the
 * simple-mode behavior (daemon home) but still requires a unix_username.
 */
import { loadConfigSync } from '@agor/core/config';
import { UsersRepository } from '@agor/core/db';
import type { TenantScopedDatabase, UserID } from '@agor/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@agor/core/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agor/core/config')>();
  return {
    ...actual,
    loadConfigSync: vi.fn(),
  };
});

vi.mock('@agor/core/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agor/core/db')>();
  return {
    ...actual,
    UsersRepository: vi.fn(),
  };
});

import { resolveCodexUnixIdentity } from './codex-auth-shared.js';

const loadConfigSyncMock = vi.mocked(loadConfigSync);
const usersRepositoryMock = vi.mocked(UsersRepository);

const USER_ID = 'user-1' as UserID;
const findById = vi.fn();

const withTenantDatabase = <T>(work: (tenantDb: TenantScopedDatabase) => Promise<T>): Promise<T> =>
  work({} as TenantScopedDatabase);

beforeEach(() => {
  vi.clearAllMocks();
  // Regular function (not arrow) so `new UsersRepository(...)` works: a
  // constructor returning an object yields that object.
  usersRepositoryMock.mockImplementation(function mockRepo() {
    return { findById } as never;
  });
});

describe('resolveCodexUnixIdentity — delegated mode', () => {
  it('returns unsupported-mode for delegated + templated execution without any user lookup', async () => {
    loadConfigSyncMock.mockReturnValue({
      execution: {
        unix_user_mode: 'delegated',
        executor_command_template: 'launcher --user {unix_user} -- agor-executor --stdin',
      },
    } as never);

    const result = await resolveCodexUnixIdentity(USER_ID, withTenantDatabase);

    expect(result).toEqual({
      ok: false,
      reason: 'unsupported-mode',
      message: expect.stringContaining("execution substrate's per-user home"),
    });
    // No credential path is derived and no user row is read — the operation
    // is rejected before identity resolution starts.
    expect(findById).not.toHaveBeenCalled();
  });

  it('resolves to the daemon home (null) for delegated without a template when a unix_username exists', async () => {
    loadConfigSyncMock.mockReturnValue({
      execution: { unix_user_mode: 'delegated' },
    } as never);
    findById.mockResolvedValue({ user_id: USER_ID, unix_username: 'alice' });

    const result = await resolveCodexUnixIdentity(USER_ID, withTenantDatabase);

    // No impersonation in delegated mode — auth.json lives in the daemon
    // user's home, exactly like simple mode.
    expect(result).toEqual({ ok: true, unixUser: null });
  });

  it('returns missing-username for delegated without a template when the user has no unix_username', async () => {
    loadConfigSyncMock.mockReturnValue({
      execution: { unix_user_mode: 'delegated' },
    } as never);
    findById.mockResolvedValue({ user_id: USER_ID, unix_username: null });

    const result = await resolveCodexUnixIdentity(USER_ID, withTenantDatabase);

    expect(result).toEqual({
      ok: false,
      reason: 'missing-username',
      message: expect.stringContaining('Delegated Unix user mode requires a unix_username'),
    });
  });

  it('keeps simple mode untouched even with a template configured', async () => {
    loadConfigSyncMock.mockReturnValue({
      execution: {
        unix_user_mode: 'simple',
        executor_command_template: 'launcher -- agor-executor --stdin',
      },
    } as never);

    const result = await resolveCodexUnixIdentity(USER_ID, withTenantDatabase);

    expect(result).toEqual({ ok: true, unixUser: null });
    expect(findById).not.toHaveBeenCalled();
  });
});
