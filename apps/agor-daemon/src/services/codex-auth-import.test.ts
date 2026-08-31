import { isTenantAgenticToolEnabled, loadConfigSync } from '@agor/core/config';
import { runWithTenantContext } from '@agor/core/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { writeCodexAuthCredential } from '../utils/executor-codex-auth.js';
import { createCodexAuthImportService } from './codex-auth-import';
import { CODEX_AUTH_DEFER_USER_REALTIME } from './codex-auth-shared.js';

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
  };
});

vi.mock('../utils/executor-codex-auth.js', async () => {
  const actual = await vi.importActual<typeof import('../utils/executor-codex-auth.js')>(
    '../utils/executor-codex-auth.js'
  );
  return {
    ...actual,
    writeCodexAuthCredential: vi.fn(),
  };
});

const isTenantAgenticToolEnabledMock = vi.mocked(isTenantAgenticToolEnabled);
const loadConfigSyncMock = vi.mocked(loadConfigSync);
const writeCodexAuthCredentialMock = vi.mocked(writeCodexAuthCredential);

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
  return { app: { get: () => loadConfigSyncMock(), service: () => usersService }, usersService };
}

const AUTH_PARAMS = {
  user: { user_id: 'user-1', email: 'u@example.com', role: 'member' },
} as never;

function service(app: { service: () => unknown }, invalidateCredentialBinds = vi.fn()) {
  const delegate = createCodexAuthImportService(
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
  isTenantAgenticToolEnabledMock.mockResolvedValue(true);
  loadConfigSyncMock.mockReturnValue({ execution: { unix_user_mode: 'simple' } } as never);
  writeCodexAuthCredentialMock.mockResolvedValue({ authMode: 'chatgpt' });
});

describe('codex-auth-import', () => {
  it('rejects unauthenticated callers before touching anything', async () => {
    const { app } = makeApp();
    await expect(service(app).create({ authJson: VALID_AUTH_JSON })).rejects.toThrow(/Sign in/);
    expect(writeCodexAuthCredentialMock).not.toHaveBeenCalled();
  });

  it('rejects hosted multi-tenant mode', async () => {
    loadConfigSyncMock.mockReturnValue({
      multi_tenancy: { mode: 'required_from_auth' },
    } as never);
    const { app } = makeApp();
    await expect(service(app).create({ authJson: VALID_AUTH_JSON }, AUTH_PARAMS)).rejects.toThrow(
      /hosted multi-tenant/
    );
    expect(writeCodexAuthCredentialMock).not.toHaveBeenCalled();
  });

  it('admits hosted auth-file import with persistent per-user executor homes', async () => {
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

    await expect(
      service(app).create({ authJson: VALID_AUTH_JSON }, AUTH_PARAMS)
    ).resolves.toMatchObject({ status: 'authenticated' });
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
    expect(writeCodexAuthCredentialMock).not.toHaveBeenCalled();
  });

  it('rejects a credential-free file', async () => {
    const { app } = makeApp();
    await expect(
      service(app).create({ authJson: JSON.stringify({ tokens: {} }) }, AUTH_PARAMS)
    ).rejects.toThrow(/codex login/);
    expect(writeCodexAuthCredentialMock).not.toHaveBeenCalled();
  });

  it('writes, verifies, flips the auth method, and returns non-secret metadata only', async () => {
    const { app, usersService } = makeApp();
    const invalidateCredentialBinds = vi.fn(async () => undefined);
    const result = await service(app, invalidateCredentialBinds).create(
      { authJson: VALID_AUTH_JSON },
      AUTH_PARAMS
    );

    expect(writeCodexAuthCredentialMock).toHaveBeenCalledTimes(1);
    const [writtenContent, routing] = writeCodexAuthCredentialMock.mock.calls[0];
    expect(JSON.parse(writtenContent)).toEqual(JSON.parse(VALID_AUTH_JSON));
    expect(routing).toEqual({
      delegatedHomeKey: null,
      userId: 'user-1',
      codexHome: expect.stringMatching(/\/\.local\/share\/agor\/codex\/[0-9a-f]{64}$/),
    });

    expect(usersService.patch).toHaveBeenCalledWith(
      'user-1',
      { agentic_auth_methods: { 'claude-code': 'api_key', codex: 'subscription' } },
      expect.objectContaining({ authenticated: true })
    );

    expect(result).toMatchObject({ status: 'authenticated', authMode: 'chatgpt' });
    expect(invalidateCredentialBinds).toHaveBeenCalledWith({
      tenantId: 'tenant-test',
      userId: 'user-1',
      reason: 'credentials_imported',
    });
    expect(JSON.stringify(result)).not.toContain('refresh-xyz');
    expect(JSON.stringify(result)).not.toContain('access-abc');
  });

  it('generation-fences HA import and defers its users event until commit', async () => {
    const { app, usersService } = makeApp();
    const coordinator = {
      runCredentialMutation: vi.fn(
        async (
          _tenantId: string,
          _userId: string,
          _reason: string,
          work: (generation: number) => Promise<unknown>
        ) => work(41)
      ),
    };
    const delegate = createCodexAuthImportService(app as never, TEST_DB, coordinator as never);

    await runWithTenantContext('tenant-test', () =>
      delegate.create({ authJson: VALID_AUTH_JSON }, AUTH_PARAMS)
    );

    expect(writeCodexAuthCredentialMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ userId: 'user-1' }),
      41
    );
    expect(usersService.patch.mock.calls[0]?.[2]).toMatchObject({
      authenticated: true,
      [CODEX_AUTH_DEFER_USER_REALTIME]: true,
    });
  });

  it('maps write failures to a friendly error and logs only the error class', async () => {
    writeCodexAuthCredentialMock.mockImplementationOnce(async () => {
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
});
