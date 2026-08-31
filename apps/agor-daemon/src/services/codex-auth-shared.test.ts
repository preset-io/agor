/**
 * Regression tests for `resolveCodexCredentialRoute()` mode handling.
 *
 * Delegated execution requires an explicit persistent-per-user home guarantee.
 * Sandbox auth is routed to the same per-user store mounted for sessions.
 * Built-in local simple execution uses a trusted tenant/user Codex namespace.
 */
import { homedir } from 'node:os';
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

import { resolveSimpleCodexHome } from '../utils/codex-credential-namespace.js';
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

  it('routes local simple mode to a tenant-and-user Codex home', async () => {
    loadConfigSyncMock.mockReturnValue({
      execution: { unix_user_mode: 'simple' },
    } as never);

    const result = await runWithTenantContext('tenant-test', () =>
      resolveCodexCredentialRoute(
        USER_ID,
        withTenantDatabase,
        resolveEffectiveConfig(loadConfigSync())
      )
    );

    expect(result).toEqual({
      ok: true,
      delegatedHomeKey: null,
      userId: USER_ID,
      codexHome: resolveSimpleCodexHome({
        tenantId: 'tenant-test',
        subjectUserId: USER_ID,
        homeDir: homedir(),
      }),
    });
    expect(findById).not.toHaveBeenCalled();
  });

  it('does not let the same user id share a simple Codex home across tenants', async () => {
    loadConfigSyncMock.mockReturnValue({
      execution: { unix_user_mode: 'simple' },
    } as never);
    const resolveForTenant = (tenantId: string) =>
      runWithTenantContext(tenantId, () =>
        resolveCodexCredentialRoute(
          USER_ID,
          withTenantDatabase,
          resolveEffectiveConfig(loadConfigSync())
        )
      );

    const tenantA = await resolveForTenant('tenant-a');
    const tenantB = await resolveForTenant('tenant-b');

    expect(tenantA).toMatchObject({ ok: true, codexHome: expect.any(String) });
    expect(tenantB).toMatchObject({ ok: true, codexHome: expect.any(String) });
    if (!tenantA.ok || !tenantB.ok) throw new Error('Expected successful credential routes');
    expect(tenantA.codexHome).not.toBe(tenantB.codexHome);
  });

  it('does not impose a daemon-local path on a templated simple executor', async () => {
    loadConfigSyncMock.mockReturnValue({
      execution: {
        unix_user_mode: 'simple',
        executor_command_template: 'launcher -- agor-executor --stdin',
      },
    } as never);

    await expect(
      resolveCodexCredentialRoute(
        USER_ID,
        withTenantDatabase,
        resolveEffectiveConfig(loadConfigSync())
      )
    ).resolves.toEqual({ ok: true, delegatedHomeKey: null, userId: USER_ID });
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
    });
    expect(findById).toHaveBeenCalledOnce();
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
