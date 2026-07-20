import { isTenantAgenticToolEnabled, loadConfigSync } from '@agor/core/config';
import { runWithTenantContext, UsersRepository } from '@agor/core/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readCodexAuthFile, writeCodexAuthFile } from '../utils/codex-auth-file.js';
import { createCodexAuthImportService } from './codex-auth-import';

vi.mock('@agor/core/config', async () => {
  const actual = await vi.importActual<typeof import('@agor/core/config')>('@agor/core/config');
  return {
    ...actual,
    isTenantAgenticToolEnabled: vi.fn(),
    loadConfigSync: vi.fn(),
  };
});

vi.mock('@agor/core/db', async () => {
  const actual = await vi.importActual<typeof import('@agor/core/db')>('@agor/core/db');
  return {
    ...actual,
    UsersRepository: vi.fn(),
  };
});

vi.mock('@agor/core/unix', async () => {
  const actual = await vi.importActual<typeof import('@agor/core/unix')>('@agor/core/unix');
  return {
    ...actual,
    // The real validator asserts against /etc/passwd — the mocked Unix
    // accounts in these tests don't exist on the test host.
    validateResolvedUnixUser: vi.fn(),
  };
});

vi.mock('../utils/codex-auth-file.js', async () => {
  const actual = await vi.importActual<typeof import('../utils/codex-auth-file.js')>(
    '../utils/codex-auth-file.js'
  );
  return {
    ...actual,
    writeCodexAuthFile: vi.fn(),
    readCodexAuthFile: vi.fn(),
  };
});

const isTenantAgenticToolEnabledMock = vi.mocked(isTenantAgenticToolEnabled);
const loadConfigSyncMock = vi.mocked(loadConfigSync);
const writeCodexAuthFileMock = vi.mocked(writeCodexAuthFile);
const readCodexAuthFileMock = vi.mocked(readCodexAuthFile);
const usersRepositoryMock = vi.mocked(UsersRepository);

const TEST_DB = { run: vi.fn() } as never;

const VALID_AUTH_JSON = JSON.stringify({
  OPENAI_API_KEY: null,
  tokens: {
    id_token: 'header.payload.sig',
    access_token: 'access-abc',
    refresh_token: 'refresh-xyz',
    account_id: 'acct-1',
  },
  last_refresh: '2026-07-16T12:00:00.000000Z',
});

function makeApp() {
  const usersService = {
    get: vi.fn(async () => ({ agentic_auth_methods: { 'claude-code': 'api_key' } })),
    patch: vi.fn(async () => ({})),
  };
  return { app: { service: () => usersService }, usersService };
}

const AUTH_PARAMS = {
  user: { user_id: 'user-1', email: 'u@example.com', role: 'member' },
} as never;

function service(app: { service: () => unknown }) {
  const delegate = createCodexAuthImportService(app as never, TEST_DB);
  return {
    create: (...args: Parameters<typeof delegate.create>) =>
      runWithTenantContext('tenant-test', () => delegate.create(...args)),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  isTenantAgenticToolEnabledMock.mockResolvedValue(true);
  loadConfigSyncMock.mockReturnValue({ execution: { unix_user_mode: 'simple' } } as never);
  // Readback verification is byte-exact against what was written, so the
  // read mock returns whatever the write mock captured.
  let written = '';
  writeCodexAuthFileMock.mockImplementation((content: string) => {
    written = content;
  });
  readCodexAuthFileMock.mockImplementation(() =>
    written ? { ok: true, content: written } : { ok: false, reason: 'not-found' }
  );
});

describe('codex-auth-import', () => {
  it('rejects unauthenticated callers before touching anything', async () => {
    const { app } = makeApp();
    await expect(service(app).create({ authJson: VALID_AUTH_JSON })).rejects.toThrow(/Sign in/);
    expect(writeCodexAuthFileMock).not.toHaveBeenCalled();
  });

  it('rejects hosted multi-tenant mode', async () => {
    loadConfigSyncMock.mockReturnValue({
      multi_tenancy: { mode: 'required_from_auth' },
    } as never);
    const { app } = makeApp();
    await expect(service(app).create({ authJson: VALID_AUTH_JSON }, AUTH_PARAMS)).rejects.toThrow(
      /hosted multi-tenant/
    );
    expect(writeCodexAuthFileMock).not.toHaveBeenCalled();
  });

  it('rejects when codex is disabled for the workspace', async () => {
    isTenantAgenticToolEnabledMock.mockResolvedValue(false);
    const { app } = makeApp();
    await expect(service(app).create({ authJson: VALID_AUTH_JSON }, AUTH_PARAMS)).rejects.toThrow(
      /disabled/
    );
  });

  it('rejects garbage input with a friendly error and never writes', async () => {
    const { app } = makeApp();
    await expect(service(app).create({ authJson: 'not json' }, AUTH_PARAMS)).rejects.toThrow(
      /valid JSON/
    );
    expect(writeCodexAuthFileMock).not.toHaveBeenCalled();
  });

  it('rejects a credential-free file', async () => {
    const { app } = makeApp();
    await expect(
      service(app).create({ authJson: JSON.stringify({ tokens: {} }) }, AUTH_PARAMS)
    ).rejects.toThrow(/codex login/);
    expect(writeCodexAuthFileMock).not.toHaveBeenCalled();
  });

  it('writes, verifies, flips the auth method, and returns non-secret metadata only', async () => {
    const { app, usersService } = makeApp();
    const result = await service(app).create({ authJson: VALID_AUTH_JSON }, AUTH_PARAMS);

    expect(writeCodexAuthFileMock).toHaveBeenCalledTimes(1);
    const [writtenContent, asUser] = writeCodexAuthFileMock.mock.calls[0];
    expect(JSON.parse(writtenContent)).toEqual(JSON.parse(VALID_AUTH_JSON));
    expect(asUser).toBeNull();

    expect(usersService.patch).toHaveBeenCalledWith(
      'user-1',
      { agentic_auth_methods: { 'claude-code': 'api_key', codex: 'subscription' } },
      expect.objectContaining({ authenticated: true })
    );

    expect(result).toMatchObject({ status: 'authenticated', authMode: 'chatgpt' });
    expect(JSON.stringify(result)).not.toContain('refresh-xyz');
    expect(JSON.stringify(result)).not.toContain('access-abc');
  });

  it('surfaces a friendly error when the readback verification fails persistently', async () => {
    readCodexAuthFileMock.mockReturnValue({ ok: false, reason: 'unreadable' });
    const { app, usersService } = makeApp();
    await expect(service(app).create({ authJson: VALID_AUTH_JSON }, AUTH_PARAMS)).rejects.toThrow(
      /verified/
    );
    // One retry on a transient-looking read failure, then give up.
    expect(readCodexAuthFileMock).toHaveBeenCalledTimes(2);
    expect(usersService.patch).not.toHaveBeenCalled();
  });

  it('retries the readback once and succeeds on a transient read failure', async () => {
    // First read fails transiently; the retry falls through to the capture
    // implementation and returns the written bytes.
    readCodexAuthFileMock.mockReturnValueOnce({ ok: false, reason: 'unreadable' });
    const { app, usersService } = makeApp();
    const result = await service(app).create({ authJson: VALID_AUTH_JSON }, AUTH_PARAMS);
    expect(result.status).toBe('authenticated');
    expect(usersService.patch).toHaveBeenCalledTimes(1);
  });

  it('rejects when the readback bytes differ from what was written', async () => {
    readCodexAuthFileMock.mockReturnValue({
      ok: true,
      content: '{"OPENAI_API_KEY":"sk-someone-elses-import"}\n',
    });
    const { app, usersService } = makeApp();
    await expect(service(app).create({ authJson: VALID_AUTH_JSON }, AUTH_PARAMS)).rejects.toThrow(
      /verified/
    );
    expect(usersService.patch).not.toHaveBeenCalled();
  });

  it('maps write failures to a friendly error and logs only the error class', async () => {
    writeCodexAuthFileMock.mockImplementationOnce(() => {
      throw new Error('sudo: a password is required; stderr: refresh-xyz');
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { app } = makeApp();
      await expect(service(app).create({ authJson: VALID_AUTH_JSON }, AUTH_PARAMS)).rejects.toThrow(
        /Could not write/
      );
      const logged = errorSpy.mock.calls.map((call) => call.join(' ')).join('\n');
      expect(logged).toContain('Error');
      expect(logged).not.toContain('refresh-xyz');
      expect(logged).not.toContain('password is required');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('strict mode targets the caller’s unix_username', async () => {
    loadConfigSyncMock.mockReturnValue({ execution: { unix_user_mode: 'strict' } } as never);
    // `new UsersRepository(db)` — the implementation must be constructible.
    usersRepositoryMock.mockImplementation(function mockRepo() {
      return { findById: vi.fn(async () => ({ unix_username: 'alice' })) };
    } as never);
    const { app } = makeApp();
    const result = await service(app).create({ authJson: VALID_AUTH_JSON }, AUTH_PARAMS);
    expect(result.status).toBe('authenticated');
    expect(writeCodexAuthFileMock).toHaveBeenCalledWith(expect.any(String), 'alice');
  });

  it('strict mode without a unix_username rejects before writing', async () => {
    loadConfigSyncMock.mockReturnValue({ execution: { unix_user_mode: 'strict' } } as never);
    usersRepositoryMock.mockImplementation(function mockRepo() {
      return { findById: vi.fn(async () => ({ unix_username: null })) };
    } as never);
    const { app } = makeApp();
    await expect(service(app).create({ authJson: VALID_AUTH_JSON }, AUTH_PARAMS)).rejects.toThrow(
      /Unix account/
    );
    expect(writeCodexAuthFileMock).not.toHaveBeenCalled();
  });

  it('insulated mode targets the configured executor user', async () => {
    loadConfigSyncMock.mockReturnValue({
      execution: { unix_user_mode: 'insulated', executor_unix_user: 'agor_executor' },
    } as never);
    const { app } = makeApp();
    const result = await service(app).create({ authJson: VALID_AUTH_JSON }, AUTH_PARAMS);
    expect(result.status).toBe('authenticated');
    expect(writeCodexAuthFileMock).toHaveBeenCalledWith(expect.any(String), 'agor_executor');
  });
});
