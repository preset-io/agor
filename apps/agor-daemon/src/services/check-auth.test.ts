import { isTenantAgenticToolEnabled, resolveApiKey } from '@agor/core/config';
import { runWithTenantContext } from '@agor/core/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { inspectCodexAuthViaExecutor } from '../utils/executor-codex-auth.js';
import { createCheckAuthService } from './check-auth';
import { resolveCodexCredentialRoute } from './codex-auth-shared.js';

const claudeQueryMock = vi.hoisted(() => vi.fn());

vi.mock('@agor/core/config', async () => {
  const actual = await vi.importActual<typeof import('@agor/core/config')>('@agor/core/config');
  return {
    ...actual,
    resolveApiKey: vi.fn(),
    isTenantAgenticToolEnabled: vi.fn(),
  };
});

vi.mock('@agor/core/agentic-integrations', async () => {
  const actual = await vi.importActual<typeof import('@agor/core/agentic-integrations')>(
    '@agor/core/agentic-integrations'
  );
  return {
    ...actual,
    loadManagedAgenticToolSdk: vi.fn(async () => ({ query: claudeQueryMock })),
  };
});

vi.mock('../utils/executor-codex-auth.js', async () => {
  const actual = await vi.importActual<typeof import('../utils/executor-codex-auth.js')>(
    '../utils/executor-codex-auth.js'
  );
  return {
    ...actual,
    inspectCodexAuthViaExecutor: vi.fn(),
  };
});

vi.mock('./codex-auth-shared.js', () => ({
  resolveCodexCredentialRoute: vi.fn(),
}));

const resolveApiKeyMock = vi.mocked(resolveApiKey);
const isTenantAgenticToolEnabledMock = vi.mocked(isTenantAgenticToolEnabled);
const inspectCodexAuthViaExecutorMock = vi.mocked(inspectCodexAuthViaExecutor);
const resolveCodexCredentialRouteMock = vi.mocked(resolveCodexCredentialRoute);
const TEST_DB = { run: vi.fn() } as never;

function mockClaudeAccount(account: Record<string, unknown> | null) {
  claudeQueryMock.mockReturnValue({
    accountInfo: vi.fn(async () => account),
    close: vi.fn(),
  } as never);
}

const service = () => {
  const delegate = createCheckAuthService(TEST_DB, {} as never);
  return {
    create: (...args: Parameters<typeof delegate.create>) =>
      runWithTenantContext('tenant-test', () => delegate.create(...args)),
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  isTenantAgenticToolEnabledMock.mockResolvedValue(true);
  resolveApiKeyMock.mockResolvedValue({ apiKey: undefined, source: 'none', useNativeAuth: false });
});

// #1867 — Claude subscription-token handling (kept verbatim; `authenticated`
// boolean is the derived convenience these assertions rely on).
describe('check-auth Claude subscription tokens', () => {
  it('validates a raw claude setup-token as OAuth instead of an Anthropic API key', async () => {
    mockClaudeAccount({ tokenSource: 'CLAUDE_CODE_OAUTH_TOKEN' });

    const result = await service().create({ tool: 'claude-code', apiKey: 'sk-ant-oat01-test' });

    expect(result).toMatchObject({ authenticated: true, method: 'oauth' });
    expect(claudeQueryMock).toHaveBeenCalledTimes(1);
    expect(claudeQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          env: expect.objectContaining({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-test' }),
        }),
      })
    );
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(resolveApiKeyMock).not.toHaveBeenCalled();
  });

  it('checks stored CLAUDE_CODE_OAUTH_TOKEN when no Anthropic API key is configured', async () => {
    resolveApiKeyMock.mockResolvedValueOnce({
      apiKey: undefined,
      connection: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-stored' },
      source: 'user',
      useNativeAuth: false,
    });
    mockClaudeAccount({ tokenSource: 'CLAUDE_CODE_OAUTH_TOKEN' });

    const result = await service().create({ tool: 'claude-code' }, {
      user: { user_id: 'user-1' },
    } as never);

    expect(result).toMatchObject({ authenticated: true, method: 'oauth' });
    expect(claudeQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          env: expect.objectContaining({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-stored' }),
        }),
      })
    );
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(resolveApiKeyMock).toHaveBeenCalledTimes(1);
    expect(resolveApiKeyMock).toHaveBeenCalledWith('ANTHROPIC_API_KEY', {
      userId: 'user-1',
      db: TEST_DB,
      tool: 'claude-code',
    });
  });

  it('treats missing subscription account metadata as unknown, not rejected', async () => {
    resolveApiKeyMock.mockResolvedValueOnce({
      apiKey: undefined,
      connection: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-stored' },
      source: 'user',
      useNativeAuth: false,
    });
    mockClaudeAccount(null);

    const result = await service().create({ tool: 'claude-code' }, {
      user: { user_id: 'user-1' },
    } as never);

    expect(result.status).toBe('unknown');
  });

  it('treats the SDK tokenSource "none" sentinel as unknown', async () => {
    mockClaudeAccount({ tokenSource: 'none' });

    const result = await service().create({ tool: 'claude-code', apiKey: 'sk-ant-oat01-test' });

    expect(result.status).toBe('unknown');
  });
});

// Round-3 — honest tri-state / fail-safe distinctions layered on top of #1867.
describe('check-auth tri-state', () => {
  const params = { user: { user_id: 'user-1' } } as never;

  it('rejects unsupported tools before reading tenant settings', async () => {
    await expect(service().create({ tool: 'unsupported' }, params)).resolves.toEqual({
      status: 'unknown',
      authenticated: false,
      method: 'none',
      hint: 'Unsupported tool',
    });
    expect(isTenantAgenticToolEnabledMock).not.toHaveBeenCalled();
    expect(resolveApiKeyMock).not.toHaveBeenCalled();
  });

  it('claude stored API key rejected with 401 → unauthenticated', async () => {
    resolveApiKeyMock.mockResolvedValue({ apiKey: 'sk-bad', source: 'user', useNativeAuth: false });
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({ ok: false, status: 401 } as Response);

    const result = await service().create({ tool: 'claude-code' }, params);
    expect(result.status).toBe('unauthenticated');
    fetchMock.mockRestore();
  });

  it('validates the resolved Claude bearer token exactly as the executor uses it', async () => {
    const syntheticToken = 'synthetic-bearer-token';
    resolveApiKeyMock.mockResolvedValue({
      apiKey: undefined,
      connection: { ANTHROPIC_AUTH_TOKEN: syntheticToken },
      source: 'user',
      useNativeAuth: false,
    });
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({ ok: true, status: 200 } as Response);

    const result = await service().create({ tool: 'claude-code' }, params);

    expect(result).toMatchObject({ status: 'authenticated', method: 'api-key' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: `Bearer ${syntheticToken}` }),
      })
    );
    expect(JSON.stringify(result)).not.toContain(syntheticToken);
    fetchMock.mockRestore();
  });

  it('expired/revoked Claude bearer token rejected with 401 → unauthenticated', async () => {
    const syntheticToken = 'synthetic-expired-token';
    resolveApiKeyMock.mockResolvedValue({
      apiKey: undefined,
      connection: { ANTHROPIC_AUTH_TOKEN: syntheticToken },
      source: 'user',
      useNativeAuth: false,
    });
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({ ok: false, status: 401 } as Response);

    const result = await service().create({ tool: 'claude-code' }, params);

    expect(result).toMatchObject({ status: 'unauthenticated', method: 'api-key' });
    expect(JSON.stringify(result)).not.toContain(syntheticToken);
    fetchMock.mockRestore();
  });

  it('Claude bearer-token timeout stays unknown and secret-free', async () => {
    const syntheticToken = 'synthetic-timeout-token';
    resolveApiKeyMock.mockResolvedValue({
      apiKey: undefined,
      connection: { ANTHROPIC_AUTH_TOKEN: syntheticToken },
      source: 'user',
      useNativeAuth: false,
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('timeout'));

    const result = await service().create({ tool: 'claude-code' }, params);

    expect(result.status).toBe('unknown');
    expect(JSON.stringify(result)).not.toContain(syntheticToken);
    fetchMock.mockRestore();
  });

  it('claude API key check that times out / errors → unknown (not proof of no auth)', async () => {
    resolveApiKeyMock.mockResolvedValue({
      apiKey: 'sk-maybe',
      source: 'user',
      useNativeAuth: false,
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));

    const result = await service().create({ tool: 'claude-code' }, params);
    expect(result.status).toBe('unknown');
    fetchMock.mockRestore();
  });

  it('claude provider 5xx → unknown', async () => {
    resolveApiKeyMock.mockResolvedValue({
      apiKey: 'sk-maybe',
      source: 'user',
      useNativeAuth: false,
    });
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({ ok: false, status: 503 } as Response);

    const result = await service().create({ tool: 'claude-code' }, params);
    expect(result.status).toBe('unknown');
    fetchMock.mockRestore();
  });

  it('gemini with no scoped API key → unauthenticated', async () => {
    const result = await service().create({ tool: 'gemini' }, params);
    expect(result.status).toBe('unauthenticated');
  });

  it('gemini with a valid API key → authenticated', async () => {
    resolveApiKeyMock.mockResolvedValue({ apiKey: 'g-key', source: 'user', useNativeAuth: false });
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({ ok: true, status: 200 } as Response);

    const result = await service().create({ tool: 'gemini' }, params);
    expect(result.status).toBe('authenticated');
    fetchMock.mockRestore();
  });

  it('codex with no scoped credential → unauthenticated', async () => {
    const result = await service().create({ tool: 'codex' }, params);
    expect(result.status).toBe('unauthenticated');
  });

  it('opencode is always authenticated', async () => {
    const result = await service().create({ tool: 'opencode' }, params);
    expect(result.status).toBe('authenticated');
  });

  it('a raw key that 401s → unauthenticated (settings "Test Connection")', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({ ok: false, status: 401 } as Response);

    const result = await service().create({ tool: 'claude-code', apiKey: 'sk-typed' }, params);
    expect(result.status).toBe('unauthenticated');
    fetchMock.mockRestore();
  });
});

// Codex subscription login is verified against the auth.json of the Unix
// identity that runs Codex. The probe must stay honestly tri-state: only a
// genuinely absent/malformed file is "unauthenticated"; failures to LOOK
// (sudo/permission/transport) are "unknown".
describe('check-auth codex auth.json probe', () => {
  const params = { user: { user_id: 'user-1' } } as never;

  beforeEach(() => {
    resolveApiKeyMock.mockResolvedValue({ apiKey: undefined, source: 'user', useNativeAuth: true });
    resolveCodexCredentialRouteMock.mockResolvedValue({
      ok: true,
      delegatedHomeKey: null,
      userId: 'user-1' as never,
      codexHome: '/daemon/authorized/codex-home',
    });
  });

  it('reports persisted native auth as unverified without launching an executor by default', async () => {
    const result = await service().create({ tool: 'codex' }, params);
    expect(result).toMatchObject({ status: 'unknown', method: 'none' });
    expect(inspectCodexAuthViaExecutorMock).not.toHaveBeenCalled();
  });

  it('valid ChatGPT tokens → authenticated via oauth with a plan hint', async () => {
    inspectCodexAuthViaExecutorMock.mockResolvedValue({
      ok: true,
      authMode: 'chatgpt',
      planType: 'plus',
    });

    const result = await service().create({ tool: 'codex', validateNative: true }, params);
    expect(result).toMatchObject({ status: 'authenticated', method: 'oauth' });
    expect(result.hint).toContain('plus');
    expect(inspectCodexAuthViaExecutorMock).toHaveBeenCalledWith({
      delegatedHomeKey: null,
      userId: 'user-1',
      codexHome: '/daemon/authorized/codex-home',
    });
  });

  it('genuinely absent auth.json → unauthenticated', async () => {
    inspectCodexAuthViaExecutorMock.mockResolvedValue({ ok: false, reason: 'not-found' });
    const result = await service().create({ tool: 'codex', validateNative: true }, params);
    expect(result.status).toBe('unauthenticated');
    expect(result.hint).toContain('your Agor user');
    expect(result.hint).not.toContain('branch terminal');
  });

  it('unreadable auth.json (sudo/permission failure) → unknown, never unauthenticated', async () => {
    inspectCodexAuthViaExecutorMock.mockResolvedValue({ ok: false, reason: 'unreadable' });
    const result = await service().create({ tool: 'codex', validateNative: true }, params);
    expect(result.status).toBe('unknown');
  });

  it('malformed auth.json → unauthenticated (positive evidence of a broken login)', async () => {
    inspectCodexAuthViaExecutorMock.mockResolvedValue({ ok: false, reason: 'malformed' });
    const result = await service().create({ tool: 'codex', validateNative: true }, params);
    expect(result.status).toBe('unauthenticated');
  });

  it('identity resolution failure → unknown; missing unix_username → unauthenticated', async () => {
    resolveCodexCredentialRouteMock.mockResolvedValue({
      ok: false,
      reason: 'resolve-failed',
      message: 'x',
    });
    expect((await service().create({ tool: 'codex', validateNative: true }, params)).status).toBe(
      'unknown'
    );

    resolveCodexCredentialRouteMock.mockResolvedValue({
      ok: false,
      reason: 'missing-username',
      message: 'x',
    });
    expect((await service().create({ tool: 'codex', validateNative: true }, params)).status).toBe(
      'unauthenticated'
    );
  });

  it('passes through the actionable HA home-override recovery message', async () => {
    resolveCodexCredentialRouteMock.mockResolvedValue({
      ok: false,
      reason: 'unsupported-home-override',
      message: 'Remove the filesystem_home override for this account or use an API key.',
    });

    const result = await service().create({ tool: 'codex', validateNative: true }, params);

    expect(result).toMatchObject({
      status: 'unknown',
      hint: 'Remove the filesystem_home override for this account or use an API key.',
    });
  });
});
