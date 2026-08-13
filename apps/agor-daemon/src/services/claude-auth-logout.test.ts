import { loadConfigSync } from '@agor/core/config';
import { runWithTenantContext, UsersRepository } from '@agor/core/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteClaudeAuthViaExecutor } from '../utils/executor-claude-auth.js';
import { createClaudeAuthLogoutService } from './claude-auth-logout';

vi.mock('@agor/core/config', async () => {
  const actual = await vi.importActual<typeof import('@agor/core/config')>('@agor/core/config');
  return { ...actual, loadConfigSync: vi.fn() };
});

vi.mock('@agor/core/db', async () => {
  const actual = await vi.importActual<typeof import('@agor/core/db')>('@agor/core/db');
  return { ...actual, UsersRepository: vi.fn() };
});

vi.mock('@agor/core/unix', async () => {
  const actual = await vi.importActual<typeof import('@agor/core/unix')>('@agor/core/unix');
  // The real validator checks /etc/passwd — the mocked Unix accounts here don't exist.
  return { ...actual, validateResolvedUnixUser: vi.fn() };
});

vi.mock('../utils/executor-claude-auth.js', async () => {
  const actual = await vi.importActual<typeof import('../utils/executor-claude-auth.js')>(
    '../utils/executor-claude-auth.js'
  );
  return { ...actual, deleteClaudeAuthViaExecutor: vi.fn() };
});

const loadConfigSyncMock = vi.mocked(loadConfigSync);
const deleteClaudeAuthViaExecutorMock = vi.mocked(deleteClaudeAuthViaExecutor);
const usersRepositoryMock = vi.mocked(UsersRepository);

const TEST_DB = { run: vi.fn() } as never;
const AUTH_PARAMS = {
  user: { user_id: 'user-1', email: 'u@example.com', role: 'member' },
} as never;

function makeApp() {
  const usersService = { get: vi.fn(async () => ({})), patch: vi.fn(async () => ({})) };
  return { app: { get: () => loadConfigSyncMock(), service: () => usersService }, usersService };
}

function service(app: { service: () => unknown }) {
  const delegate = createClaudeAuthLogoutService(app as never, TEST_DB);
  return {
    create: (...args: Parameters<typeof delegate.create>) =>
      runWithTenantContext('tenant-test', () => delegate.create(...args)),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
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

    expect(deleteClaudeAuthViaExecutorMock).toHaveBeenCalledWith(null, {
      reportedUnixUser: null,
      userId: 'user-1',
    }); // simple mode → daemon user
    // Clears BOTH the method and any pasted token, sent as only the claude-code
    // keys so the users-service merge clears them against the FRESH record.
    // userId comes from the auth context, never request data.
    expect(usersService.patch).toHaveBeenCalledWith(
      'user-1',
      {
        agentic_auth_methods: { 'claude-code': undefined },
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

  it('refuses hosted multi-tenant mode before touching the shared login file', async () => {
    loadConfigSyncMock.mockReturnValue({
      multi_tenancy: { mode: 'required_from_auth' },
    } as never);
    const { app, usersService } = makeApp();
    await expect(service(app).create({}, AUTH_PARAMS)).rejects.toThrow(/hosted multi-tenant/);
    expect(deleteClaudeAuthViaExecutorMock).not.toHaveBeenCalled();
    expect(usersService.patch).not.toHaveBeenCalled();
  });

  it('strict mode targets the caller’s own unix_username for the delete', async () => {
    loadConfigSyncMock.mockReturnValue({ execution: { unix_user_mode: 'strict' } } as never);
    usersRepositoryMock.mockImplementation(function mockRepo() {
      return { findById: vi.fn(async () => ({ unix_username: 'alice' })) };
    } as never);
    const { app } = makeApp();
    await service(app).create({}, AUTH_PARAMS);
    expect(deleteClaudeAuthViaExecutorMock).toHaveBeenCalledWith('alice', {
      reportedUnixUser: 'alice',
      userId: 'user-1',
    });
  });
});
