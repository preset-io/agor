import { loadConfigSync } from '@agor/core/config';
import { runWithTenantContext } from '@agor/core/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteClaudeAuthViaExecutor } from '../utils/executor-claude-auth.js';
import { createClaudeAuthLogoutService } from './claude-auth-logout';
import {
  type ClaudeOAuthAttemptStore,
  InMemoryClaudeOAuthAttemptStore,
} from './claude-oauth-attempt-store';

vi.mock('@agor/core/config', async () => {
  const actual = await vi.importActual<typeof import('@agor/core/config')>('@agor/core/config');
  return { ...actual, loadConfigSync: vi.fn() };
});

vi.mock('@agor/core/db', async () => {
  const actual = await vi.importActual<typeof import('@agor/core/db')>('@agor/core/db');
  return actual;
});

vi.mock('../utils/executor-claude-auth.js', async () => {
  const actual = await vi.importActual<typeof import('../utils/executor-claude-auth.js')>(
    '../utils/executor-claude-auth.js'
  );
  return { ...actual, deleteClaudeAuthViaExecutor: vi.fn() };
});

const loadConfigSyncMock = vi.mocked(loadConfigSync);
const deleteClaudeAuthViaExecutorMock = vi.mocked(deleteClaudeAuthViaExecutor);

const TEST_DB = { run: vi.fn() } as never;
const AUTH_PARAMS = {
  user: { user_id: 'user-1', email: 'u@example.com', role: 'member' },
} as never;

function makeApp(
  current: { agentic_auth_methods: Record<string, string | undefined> } = {
    agentic_auth_methods: { 'claude-code': 'subscription', codex: 'subscription' },
  }
) {
  const usersService = { get: vi.fn(async () => current), patch: vi.fn(async () => ({})) };
  return { app: { get: () => loadConfigSyncMock(), service: () => usersService }, usersService };
}

function service(app: { service: () => unknown }, coordinator?: ClaudeOAuthAttemptStore) {
  const delegate = createClaudeAuthLogoutService(app as never, TEST_DB, coordinator);
  return {
    create: (...args: Parameters<typeof delegate.create>) =>
      runWithTenantContext('tenant-test', () => delegate.create(...args)),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks keeps implementations — reset the delete mock so a throwing
  // impl from one test can't leak into the next (its default is a no-op void).
  deleteClaudeAuthViaExecutorMock.mockReset();
  loadConfigSyncMock.mockReturnValue({ execution: { unix_user_mode: 'simple' } } as never);
});

describe('claude-auth-logout', () => {
  it('rejects unauthenticated callers before touching anything', async () => {
    const { app } = makeApp();
    await expect(service(app).create({})).rejects.toThrow(/Sign in/);
    expect(deleteClaudeAuthViaExecutorMock).not.toHaveBeenCalled();
  });

  it('deletes the login and clears the token + method for the caller only', async () => {
    const { app, usersService } = makeApp();
    const result = await service(app).create({}, AUTH_PARAMS);

    expect(deleteClaudeAuthViaExecutorMock).toHaveBeenCalledWith({
      delegatedHomeKey: null,
      userId: 'user-1',
    }); // simple mode → daemon user
    // Clears BOTH the method and any pasted token, sent as only the claude-code
    // keys so the users-service merge clears them against the FRESH record.
    // userId comes from the auth context, never request data.
    expect(usersService.patch).toHaveBeenCalledWith(
      'user-1',
      {
        agentic_auth_methods: { 'claude-code': undefined },
        agentic_credential_sources: { 'claude-code': 'none' },
        agentic_tools: { 'claude-code': { CLAUDE_CODE_OAUTH_TOKEN: null } },
      },
      expect.objectContaining({ authenticated: true })
    );
    expect(result).toEqual({ status: 'removed' });
  });

  it('is idempotent — deletes and clears regardless of prior state', async () => {
    const { app, usersService } = makeApp();
    const result = await service(app).create({}, AUTH_PARAMS);
    expect(deleteClaudeAuthViaExecutorMock).toHaveBeenCalledTimes(1);
    expect(usersService.patch).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ status: 'removed' });
  });

  it('shares the OAuth coordinator so logout linearizes after an in-flight credential write', async () => {
    const coordinator = new InMemoryClaudeOAuthAttemptStore();
    let releaseWrite!: () => void;
    const events: string[] = [];
    const write = coordinator.runCredentialMutation(
      { tenantId: 'tenant-test', userId: 'user-1' as never },
      'credentials_changed',
      () =>
        new Promise<void>((resolve) => {
          events.push('write-start');
          releaseWrite = () => {
            events.push('write-end');
            resolve();
          };
        })
    );
    await vi.waitFor(() => expect(events).toEqual(['write-start']));

    const { app } = makeApp();
    deleteClaudeAuthViaExecutorMock.mockImplementation(async () => {
      events.push('delete');
    });
    const logout = service(app, coordinator).create({}, AUTH_PARAMS);
    await Promise.resolve();
    expect(deleteClaudeAuthViaExecutorMock).not.toHaveBeenCalled();

    releaseWrite();
    await write;
    await logout;
    expect(events).toEqual(['write-start', 'write-end', 'delete']);
    expect(deleteClaudeAuthViaExecutorMock.mock.calls[0]?.[1]).toBeUndefined();
  });

  it('surfaces a friendly error and does NOT clear anything if the delete fails', async () => {
    deleteClaudeAuthViaExecutorMock.mockImplementation(async () => {
      throw new Error('sudo: a password is required; stderr: sk-ant-ort01-secret');
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { app, usersService } = makeApp();
      await expect(service(app).create({}, AUTH_PARAMS)).rejects.toThrow(/Could not remove/);
      const logged = errorSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(logged).toContain('Error');
      expect(logged).not.toContain('sk-ant-ort01-secret');
      // A login we could not remove keeps working — method/token stay intact.
      expect(usersService.patch).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('reports stale metadata safely when the file was deleted but the metadata patch fails', async () => {
    const { app, usersService } = makeApp();
    usersService.patch.mockRejectedValueOnce(
      new Error('postgres password=secret should not reach the browser')
    );

    await expect(service(app).create({}, AUTH_PARAMS)).rejects.toThrow(
      /login file was removed, but account metadata could not be updated/
    );
    expect(deleteClaudeAuthViaExecutorMock).toHaveBeenCalledTimes(1);
  });

  it('refuses hosted multi-tenant mode before touching the shared login file', async () => {
    loadConfigSyncMock.mockReturnValue({
      multi_tenancy: { mode: 'required_from_auth' },
    } as never);
    const { app, usersService } = makeApp();
    await expect(service(app).create({}, AUTH_PARAMS)).rejects.toThrow(/hosted multi-tenant/);
    expect(deleteClaudeAuthViaExecutorMock).not.toHaveBeenCalled();
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
