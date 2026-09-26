/**
 * Regression tests for `resolveCodexCredentialRoute()` mode handling.
 *
 * Delegated execution requires an explicit persistent-per-user home guarantee.
 * Sandbox auth is routed to the same per-user store mounted for sessions.
 */
import { loadConfigSync, resolveEffectiveConfig } from '@agor/core/config';
import { runWithTenantContext, type TenantScopedDatabase, UsersRepository } from '@agor/core/db';
import type { UserID } from '@agor/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@agor/core/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agor/core/config')>();
  return {
    ...actual,
    loadConfigSync: vi.fn(),
    resolveEffectiveConfig: vi.fn((config) => config),
  };
});

vi.mock('@agor/core/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agor/core/db')>();
  return {
    ...actual,
    UsersRepository: vi.fn(),
  };
});

import { resolveCodexCredentialRoute } from './codex-auth-shared.js';

const loadConfigSyncMock = vi.mocked(loadConfigSync);
const resolveEffectiveConfigMock = vi.mocked(resolveEffectiveConfig);
const usersRepositoryMock = vi.mocked(UsersRepository);

const USER_ID = 'user-1' as UserID;
const findById = vi.fn();

const withTenantDatabase = <T>(work: (tenantDb: TenantScopedDatabase) => Promise<T>): Promise<T> =>
  work({} as TenantScopedDatabase);

beforeEach(() => {
  vi.clearAllMocks();
  resolveEffectiveConfigMock.mockImplementation((config) => config);
  // Regular function (not arrow) so `new UsersRepository(...)` works: a
  // constructor returning an object yields that object.
  usersRepositoryMock.mockImplementation(function mockRepo() {
    return { findById } as never;
  });
});

it('routes credentials using deployment environment overrides from the effective config', async () => {
  loadConfigSyncMock.mockReturnValue({ execution: { unix_user_mode: 'simple' } } as never);
  resolveEffectiveConfigMock.mockReturnValue({
    execution: { unix_user_mode: 'delegated' },
  } as never);
  findById.mockResolvedValue({ user_id: USER_ID, unix_username: 'root' });

  await expect(
    resolveCodexCredentialRoute(
      USER_ID,
      withTenantDatabase,
      resolveEffectiveConfig(loadConfigSync())
    )
  ).resolves.toEqual({
    ok: true,
    delegatedHomeKey: 'root',
    userId: USER_ID,
  });
});

it('rejects HA credential operations without cross-replica flock admission', async () => {
  loadConfigSyncMock.mockReturnValue({
    deployment: { mode: 'ha' },
    execution: {
      unix_user_mode: 'sandbox',
      executor_storage: {
        user_home: 'persistent-per-user',
        user_home_locking: 'local-only',
      },
    },
  } as never);

  await expect(
    resolveCodexCredentialRoute(
      USER_ID,
      withTenantDatabase,
      resolveEffectiveConfig(loadConfigSync())
    )
  ).resolves.toEqual({
    ok: false,
    reason: 'unsupported-mode',
    message: expect.stringContaining('cross-replica-flock'),
  });
  expect(findById).not.toHaveBeenCalled();
});

describe('resolveCodexCredentialRoute — delegated mode', () => {
  it('rejects a shared credential home for auth-resolved tenancy before user lookup', async () => {
    loadConfigSyncMock.mockReturnValue({
      multi_tenancy: { mode: 'required_from_auth' },
      execution: {
        unix_user_mode: 'simple',
        executor_storage: { user_home: 'shared' },
      },
    } as never);

    await expect(
      resolveCodexCredentialRoute(
        USER_ID,
        withTenantDatabase,
        resolveEffectiveConfig(loadConfigSync())
      )
    ).resolves.toEqual({
      ok: false,
      reason: 'unsupported-mode',
      message: expect.stringContaining('persistent-per-user'),
    });
    expect(findById).not.toHaveBeenCalled();
  });

  it('returns unsupported-mode for delegated + templated execution without any user lookup', async () => {
    loadConfigSyncMock.mockReturnValue({
      execution: {
        unix_user_mode: 'delegated',
        executor_command_template: 'launcher --user {unix_user} -- agor-executor --stdin',
      },
    } as never);

    const result = await resolveCodexCredentialRoute(
      USER_ID,
      withTenantDatabase,
      resolveEffectiveConfig(loadConfigSync())
    );

    expect(result).toEqual({
      ok: false,
      reason: 'unsupported-mode',
      message: expect.stringContaining("execution substrate's per-user home"),
    });
    // No credential path is derived and no user row is read — the operation
    // is rejected before identity resolution starts.
    expect(findById).not.toHaveBeenCalled();
  });

  it('resolves the delegated home key when a unix_username exists', async () => {
    loadConfigSyncMock.mockReturnValue({
      execution: { unix_user_mode: 'delegated' },
    } as never);
    findById.mockResolvedValue({ user_id: USER_ID, unix_username: 'alice' });

    const result = await resolveCodexCredentialRoute(
      USER_ID,
      withTenantDatabase,
      resolveEffectiveConfig(loadConfigSync())
    );

    expect(result).toEqual({
      ok: true,
      delegatedHomeKey: 'alice',
      userId: USER_ID,
    });
  });

  it('returns missing-username for delegated without a template when the user has no unix_username', async () => {
    loadConfigSyncMock.mockReturnValue({
      execution: { unix_user_mode: 'delegated' },
    } as never);
    findById.mockResolvedValue({ user_id: USER_ID, unix_username: null });

    const result = await resolveCodexCredentialRoute(
      USER_ID,
      withTenantDatabase,
      resolveEffectiveConfig(loadConfigSync())
    );

    expect(result).toEqual({
      ok: false,
      reason: 'missing-username',
      message: expect.stringContaining('Delegated execution mode requires a unix_username'),
    });
  });

  it('keeps simple mode untouched even with a template configured', async () => {
    loadConfigSyncMock.mockReturnValue({
      execution: {
        unix_user_mode: 'simple',
        executor_command_template: 'launcher -- agor-executor --stdin',
      },
    } as never);

    const result = await resolveCodexCredentialRoute(
      USER_ID,
      withTenantDatabase,
      resolveEffectiveConfig(loadConfigSync())
    );

    expect(result).toEqual({
      ok: true,
      delegatedHomeKey: null,
      userId: USER_ID,
    });
    expect(findById).not.toHaveBeenCalled();
  });

  it('routes delegated templated auth through a persistent per-user home', async () => {
    loadConfigSyncMock.mockReturnValue({
      execution: {
        unix_user_mode: 'delegated',
        executor_command_template: 'launcher --user-id {user_id} -- agor-executor --stdin',
        executor_storage: {
          user_home: 'persistent-per-user',
          branch_workspace: 'persistent-per-branch',
          base_repository: 'unavailable',
        },
      },
    } as never);
    findById.mockResolvedValue({ user_id: USER_ID, unix_username: 'alice' });

    await expect(
      resolveCodexCredentialRoute(
        USER_ID,
        withTenantDatabase,
        resolveEffectiveConfig(loadConfigSync())
      )
    ).resolves.toEqual({
      ok: true,
      delegatedHomeKey: 'alice',
      userId: USER_ID,
    });
  });
});

describe('resolveCodexCredentialRoute — sandbox mode', () => {
  it('writes Codex auth into the user filesystem home mounted by sandbox sessions', async () => {
    loadConfigSyncMock.mockReturnValue({
      execution: {
        unix_user_mode: 'sandbox',
        sandbox: { enabled: true, home_mode: 'per_user' },
        executor_storage: {
          user_home: 'persistent-per-user',
          user_home_locking: 'cross-replica-flock',
        },
      },
    } as never);
    findById.mockResolvedValue({
      user_id: USER_ID,
      unix_username: null,
      filesystem_home: '/srv/agor-homes/alice',
    });

    await expect(
      resolveCodexCredentialRoute(
        USER_ID,
        withTenantDatabase,
        resolveEffectiveConfig(loadConfigSync())
      )
    ).resolves.toEqual({
      ok: true,
      delegatedHomeKey: null,
      userId: USER_ID,
      codexHome: '/srv/agor-homes/alice/.codex',
      claudeConfigDir: '/srv/agor-homes/alice/.claude',
    });
    expect(findById).toHaveBeenCalledOnce();
  });

  it('derives distinct Claude config directories for every sandbox tenant and user', async () => {
    const config = {
      agor: { data_dir: '/srv/agor' },
      execution: {
        unix_user_mode: 'sandbox',
        sandbox: { enabled: true, home_mode: 'per_user' },
        executor_storage: { user_home: 'persistent-per-user' },
      },
    } as never;
    findById.mockImplementation(async (userId: string) => ({
      user_id: userId,
      unix_username: null,
      filesystem_home: null,
    }));
    const route = (tenantId: string, userId: string) =>
      runWithTenantContext(tenantId, () =>
        resolveCodexCredentialRoute(userId as UserID, withTenantDatabase, config)
      );

    const tenantAUserA = await route('tenant-a', 'user-a');
    const tenantAUserB = await route('tenant-a', 'user-b');
    const tenantBUserA = await route('tenant-b', 'user-a');
    expect(tenantAUserA.ok && tenantAUserA.claudeConfigDir).toBeTruthy();
    expect(
      new Set([
        tenantAUserA.ok && tenantAUserA.claudeConfigDir,
        tenantAUserB.ok && tenantAUserB.claudeConfigDir,
        tenantBUserA.ok && tenantBUserA.claudeConfigDir,
      ]).size
    ).toBe(3);
  });

  it('rejects filesystem_home overrides in HA rather than trusting shared ownership', async () => {
    loadConfigSyncMock.mockReturnValue({
      deployment: { mode: 'ha' },
      execution: {
        unix_user_mode: 'sandbox',
        sandbox: { enabled: true, home_mode: 'per_user' },
        executor_storage: {
          user_home: 'persistent-per-user',
          user_home_locking: 'cross-replica-flock',
        },
      },
    } as never);
    findById.mockResolvedValue({
      user_id: USER_ID,
      filesystem_home: '/srv/agor-homes/shared',
    });

    await expect(
      resolveCodexCredentialRoute(
        USER_ID,
        withTenantDatabase,
        resolveEffectiveConfig(loadConfigSync())
      )
    ).resolves.toEqual({
      ok: false,
      reason: 'unsupported-home-override',
      message: expect.stringContaining('canonical tenant/user home'),
    });
  });
});
