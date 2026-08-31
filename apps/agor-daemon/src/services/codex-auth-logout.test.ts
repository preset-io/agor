import { loadConfigSync } from '@agor/core/config';
import { runWithTenantContext } from '@agor/core/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteCodexAuthCredential } from '../utils/executor-codex-auth.js';
import { createCodexAuthLogoutService } from './codex-auth-logout';
import { CODEX_AUTH_DEFER_USER_REALTIME } from './codex-auth-shared.js';

vi.mock('@agor/core/config', async () => {
  const actual = await vi.importActual<typeof import('@agor/core/config')>('@agor/core/config');
  return { ...actual, loadConfigSync: vi.fn() };
});

vi.mock('@agor/core/db', async () => {
  const actual = await vi.importActual<typeof import('@agor/core/db')>('@agor/core/db');
  return actual;
});

vi.mock('../utils/executor-codex-auth.js', async () => {
  const actual = await vi.importActual<typeof import('../utils/executor-codex-auth.js')>(
    '../utils/executor-codex-auth.js'
  );
  return { ...actual, deleteCodexAuthCredential: vi.fn() };
});

const loadConfigSyncMock = vi.mocked(loadConfigSync);
const deleteCodexAuthCredentialMock = vi.mocked(deleteCodexAuthCredential);

const TEST_DB = { run: vi.fn() } as never;
const AUTH_PARAMS = {
  user: { user_id: 'user-1', email: 'u@example.com', role: 'member' },
} as never;

function makeApp(
  current: { agentic_auth_methods: Record<string, string | undefined> } = {
    agentic_auth_methods: { 'claude-code': 'api_key', codex: 'subscription' },
  }
) {
  const usersService = { get: vi.fn(async () => current), patch: vi.fn(async () => ({})) };
  return { app: { get: () => loadConfigSyncMock(), service: () => usersService }, usersService };
}

function service(app: { service: () => unknown }, invalidateCredentialBinds = vi.fn()) {
  const delegate = createCodexAuthLogoutService(
    app as never,
    TEST_DB,
    undefined,
    invalidateCredentialBinds
  );
  return {
    create: (...args: Parameters<typeof delegate.create>) =>
      runWithTenantContext('tenant-test', () => delegate.create(...args)),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks keeps implementations — reset the delete mock so a throwing
  // impl from one test can't leak into the next (its default is a no-op void).
  deleteCodexAuthCredentialMock.mockReset();
  loadConfigSyncMock.mockReturnValue({ execution: { unix_user_mode: 'simple' } } as never);
});

describe('codex-auth-logout', () => {
  it('rejects unauthenticated callers before touching anything', async () => {
    const { app } = makeApp();
    await expect(service(app).create({})).rejects.toThrow(/Sign in/);
    expect(deleteCodexAuthCredentialMock).not.toHaveBeenCalled();
  });

  it('deletes the login and clears the codex method for the caller only', async () => {
    const { app, usersService } = makeApp();
    const invalidateCredentialBinds = vi.fn(async () => undefined);
    const result = await service(app, invalidateCredentialBinds).create({}, AUTH_PARAMS);

    expect(deleteCodexAuthCredentialMock).toHaveBeenCalledWith({
      delegatedHomeKey: null,
      userId: 'user-1',
      codexHome: expect.stringMatching(/\/\.local\/share\/agor\/codex\/[0-9a-f]{64}$/),
    });
    // Only the codex key is sent — the users-service merge clears it against the
    // FRESH record, preserving any concurrently-updated method for another tool.
    // userId comes from the auth context, never from request data. No token
    // revocation happens — removal is Agor-scoped (this server only).
    expect(usersService.patch).toHaveBeenCalledWith(
      'user-1',
      { agentic_auth_methods: { codex: undefined } },
      expect.objectContaining({ authenticated: true })
    );
    expect(result).toEqual({ status: 'removed' });
    expect(invalidateCredentialBinds).toHaveBeenCalledWith({
      tenantId: 'tenant-test',
      userId: 'user-1',
      reason: 'credentials_removed',
    });
  });

  it('is idempotent — deletes and clears regardless of prior state', async () => {
    // deleteCodexAuthCredential is itself idempotent (rm -f / rmSync force); the
    // service always deletes then clears, with no read/revoke branch.
    const { app, usersService } = makeApp();
    const result = await service(app).create({}, AUTH_PARAMS);
    expect(deleteCodexAuthCredentialMock).toHaveBeenCalledTimes(1);
    expect(usersService.patch).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ status: 'removed' });
  });

  it('generation-fences HA logout and defers its users event until commit', async () => {
    const { app, usersService } = makeApp();
    const coordinator = {
      runCredentialMutation: vi.fn(
        async (
          _tenantId: string,
          _userId: string,
          _reason: string,
          work: (generation: number) => Promise<unknown>
        ) => work(42)
      ),
    };
    const delegate = createCodexAuthLogoutService(app as never, TEST_DB, coordinator as never);

    await runWithTenantContext('tenant-test', () => delegate.create({}, AUTH_PARAMS));

    expect(deleteCodexAuthCredentialMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1' }),
      42
    );
    expect(usersService.patch.mock.calls[0]?.[2]).toMatchObject({
      authenticated: true,
      [CODEX_AUTH_DEFER_USER_REALTIME]: true,
    });
  });

  it('surfaces a friendly error and does NOT clear the method if the delete fails', async () => {
    deleteCodexAuthCredentialMock.mockImplementation(async () => {
      throw new Error('sudo: a password is required; stderr: refresh-xyz');
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { app, usersService } = makeApp();
      await expect(service(app).create({}, AUTH_PARAMS)).rejects.toThrow(/Could not remove/);
      const logged = errorSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(logged).toContain('Error');
      expect(logged).not.toContain('refresh-xyz');
      // A login we could not remove keeps working — the method stays intact.
      expect(usersService.patch).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('refuses hosted multi-tenant mode before touching the shared login file', async () => {
    loadConfigSyncMock.mockReturnValue({
      multi_tenancy: { mode: 'required_from_auth' },
    } as never);
    const { app, usersService } = makeApp();
    await expect(service(app).create({}, AUTH_PARAMS)).rejects.toThrow(/hosted multi-tenant/);
    expect(deleteCodexAuthCredentialMock).not.toHaveBeenCalled();
    expect(usersService.patch).not.toHaveBeenCalled();
  });

  it('admits hosted logout with persistent per-user executor homes', async () => {
    loadConfigSyncMock.mockReturnValue({
      multi_tenancy: { mode: 'required_from_auth' },
      execution: {
        executor_storage: {
          user_home: 'persistent-per-user',
          branch_workspace: 'persistent-per-branch',
          base_repository: 'unavailable',
        },
      },
    } as never);
    const { app } = makeApp();

    await expect(service(app).create({}, AUTH_PARAMS)).resolves.toEqual({ status: 'removed' });
  });
});
