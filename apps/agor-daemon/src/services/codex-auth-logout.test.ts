import { loadConfigSync } from '@agor/core/config';
import { runWithTenantContext, UsersRepository } from '@agor/core/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteCodexAuthFile, readCodexAuthFile } from '../utils/codex-auth-file.js';
import { revokeCodexChatgptTokens } from '../utils/codex-auth-revoke.js';
import { createCodexAuthLogoutService } from './codex-auth-logout';

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

vi.mock('../utils/codex-auth-file.js', async () => {
  const actual = await vi.importActual<typeof import('../utils/codex-auth-file.js')>(
    '../utils/codex-auth-file.js'
  );
  return { ...actual, readCodexAuthFile: vi.fn(), deleteCodexAuthFile: vi.fn() };
});

vi.mock('../utils/codex-auth-revoke.js', () => ({ revokeCodexChatgptTokens: vi.fn() }));

const loadConfigSyncMock = vi.mocked(loadConfigSync);
const readCodexAuthFileMock = vi.mocked(readCodexAuthFile);
const deleteCodexAuthFileMock = vi.mocked(deleteCodexAuthFile);
const revokeMock = vi.mocked(revokeCodexChatgptTokens);
const usersRepositoryMock = vi.mocked(UsersRepository);

const TEST_DB = { run: vi.fn() } as never;
const AUTH_PARAMS = {
  user: { user_id: 'user-1', email: 'u@example.com', role: 'member' },
} as never;

const LOGIN_JSON = JSON.stringify({ tokens: { refresh_token: 'refresh-xyz' } });

function makeApp(
  current: { agentic_auth_methods: Record<string, string | undefined> } = {
    agentic_auth_methods: { 'claude-code': 'api_key', codex: 'subscription' },
  }
) {
  const usersService = { get: vi.fn(async () => current), patch: vi.fn(async () => ({})) };
  return { app: { service: () => usersService }, usersService };
}

function service(app: { service: () => unknown }) {
  const delegate = createCodexAuthLogoutService(app as never, TEST_DB);
  return {
    create: (...args: Parameters<typeof delegate.create>) =>
      runWithTenantContext('tenant-test', () => delegate.create(...args)),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks keeps implementations — reset the delete mock so a throwing
  // impl from one test can't leak into the next (its default is a no-op void).
  deleteCodexAuthFileMock.mockReset();
  loadConfigSyncMock.mockReturnValue({ execution: { unix_user_mode: 'simple' } } as never);
  readCodexAuthFileMock.mockReturnValue({ ok: true, content: LOGIN_JSON });
  revokeMock.mockResolvedValue('revoked');
});

describe('codex-auth-logout', () => {
  it('rejects unauthenticated callers before touching anything', async () => {
    const { app } = makeApp();
    await expect(service(app).create({})).rejects.toThrow(/Sign in/);
    expect(revokeMock).not.toHaveBeenCalled();
    expect(deleteCodexAuthFileMock).not.toHaveBeenCalled();
  });

  it('revokes, deletes, and clears the codex method for the caller only', async () => {
    const { app, usersService } = makeApp();
    const result = await service(app).create({}, AUTH_PARAMS);

    // Revocation is attempted against the on-disk tokens BEFORE the delete.
    expect(revokeMock).toHaveBeenCalledWith(LOGIN_JSON);
    expect(deleteCodexAuthFileMock).toHaveBeenCalledWith(null); // simple mode → daemon user
    // Delete happens BEFORE the network revoke, so a concurrent connect/refresh
    // can't be clobbered by a delete that waited on the revoke round-trip.
    expect(deleteCodexAuthFileMock.mock.invocationCallOrder[0]).toBeLessThan(
      revokeMock.mock.invocationCallOrder[0]
    );
    // Only the codex key is sent — the users-service merge clears it against the
    // FRESH record, so a concurrent method update for another tool isn't
    // clobbered by a read-modify-write of a stale snapshot. userId comes from the
    // auth context, never from request data.
    expect(usersService.patch).toHaveBeenCalledWith(
      'user-1',
      { agentic_auth_methods: { codex: undefined } },
      expect.objectContaining({ authenticated: true })
    );
    expect(result).toEqual({ status: 'removed', revoked: 'revoked' });
  });

  it('still deletes and clears the method when revocation fails', async () => {
    revokeMock.mockResolvedValue('failed');
    const { app, usersService } = makeApp();
    const result = await service(app).create({}, AUTH_PARAMS);

    expect(deleteCodexAuthFileMock).toHaveBeenCalledTimes(1);
    expect(usersService.patch).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ status: 'removed', revoked: 'failed' });
  });

  it('skips revocation when no login is on disk but still clears the method (idempotent)', async () => {
    readCodexAuthFileMock.mockReturnValue({ ok: false, reason: 'not-found' });
    const { app, usersService } = makeApp();
    const result = await service(app).create({}, AUTH_PARAMS);

    expect(revokeMock).not.toHaveBeenCalled();
    expect(deleteCodexAuthFileMock).toHaveBeenCalledTimes(1);
    expect(usersService.patch).toHaveBeenCalledTimes(1);
    expect(result.revoked).toBe('skipped');
  });

  it('surfaces a friendly error, does NOT revoke, and does NOT clear the method if the delete fails', async () => {
    deleteCodexAuthFileMock.mockImplementation(() => {
      throw new Error('sudo: a password is required; stderr: refresh-xyz');
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { app, usersService } = makeApp();
      await expect(service(app).create({}, AUTH_PARAMS)).rejects.toThrow(/Could not remove/);
      const logged = errorSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(logged).toContain('Error');
      expect(logged).not.toContain('refresh-xyz');
      // Delete precedes revoke: a login we could not remove keeps its tokens
      // valid rather than being left revoked-but-present (broken).
      expect(revokeMock).not.toHaveBeenCalled();
      expect(usersService.patch).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('strict mode targets the caller’s own unix_username for the delete', async () => {
    loadConfigSyncMock.mockReturnValue({ execution: { unix_user_mode: 'strict' } } as never);
    usersRepositoryMock.mockImplementation(function mockRepo() {
      return { findById: vi.fn(async () => ({ unix_username: 'alice' })) };
    } as never);
    const { app } = makeApp();
    await service(app).create({}, AUTH_PARAMS);
    expect(deleteCodexAuthFileMock).toHaveBeenCalledWith('alice');
  });
});
