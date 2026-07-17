import { isTenantAgenticToolEnabled, resolveApiKey } from '@agor/core/config';
import { runWithTenantContext } from '@agor/core/db';
import { Claude } from '@agor/core/sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readCodexAuthFile } from '../utils/codex-auth-file.js';
import { createCheckAuthService } from './check-auth';
import { resolveCodexUnixIdentity } from './codex-auth-import.js';

vi.mock('@agor/core/config', async () => {
  const actual = await vi.importActual<typeof import('@agor/core/config')>('@agor/core/config');
  return {
    ...actual,
    resolveApiKey: vi.fn(),
    isTenantAgenticToolEnabled: vi.fn(),
  };
});

vi.mock('@agor/core/sdk', () => ({
  Claude: {
    query: vi.fn(),
  },
}));

vi.mock('../utils/codex-auth-file.js', async () => {
  const actual = await vi.importActual<typeof import('../utils/codex-auth-file.js')>(
    '../utils/codex-auth-file.js'
  );
  return {
    ...actual,
    readCodexAuthFile: vi.fn(),
  };
});

vi.mock('./codex-auth-import.js', () => ({
  resolveCodexUnixIdentity: vi.fn(),
}));

const resolveApiKeyMock = vi.mocked(resolveApiKey);
const isTenantAgenticToolEnabledMock = vi.mocked(isTenantAgenticToolEnabled);
const claudeQueryMock = vi.mocked(Claude.query);
const readCodexAuthFileMock = vi.mocked(readCodexAuthFile);
const resolveCodexUnixIdentityMock = vi.mocked(resolveCodexUnixIdentity);
const TEST_DB = { run: vi.fn() } as never;

function mockClaudeAccount(account: Record<string, unknown> | null) {
  claudeQueryMock.mockReturnValue({
    accountInfo: vi.fn(async () => account),
    close: vi.fn(),
  } as never);
}

const service = () => {
  const delegate = createCheckAuthService(TEST_DB);
  return {
    create: (...args: Parameters<typeof delegate.create>) =>
      runWithTenantContext('tenant-test', () => delegate.create(...args)),
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.ANTHROPIC_API_KEY;
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
    resolveApiKeyMock
      .mockResolvedValueOnce({ apiKey: undefined, source: 'none', useNativeAuth: false })
      .mockResolvedValueOnce({
        apiKey: 'sk-ant-oat01-stored',
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
    expect(resolveApiKeyMock).toHaveBeenNthCalledWith(1, 'ANTHROPIC_API_KEY', {
      userId: 'user-1',
      db: TEST_DB,
      tool: 'claude-code',
    });
    expect(resolveApiKeyMock).toHaveBeenNthCalledWith(2, 'CLAUDE_CODE_OAUTH_TOKEN', {
      userId: 'user-1',
      db: TEST_DB,
      tool: 'claude-code',
    });
  });

  it('treats missing subscription account metadata as unknown, not rejected', async () => {
    resolveApiKeyMock
      .mockResolvedValueOnce({ apiKey: undefined, source: 'none', useNativeAuth: false })
      .mockResolvedValueOnce({
        apiKey: 'sk-ant-oat01-stored',
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

  it('claude stored API key rejected with 401 → unauthenticated', async () => {
    resolveApiKeyMock.mockResolvedValue({ apiKey: 'sk-bad', source: 'user', useNativeAuth: false });
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({ ok: false, status: 401 } as Response);

    const result = await service().create({ tool: 'claude-code' }, params);
    expect(result.status).toBe('unauthenticated');
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

  function fakeJwt(payload: Record<string, unknown>): string {
    const enc = (obj: Record<string, unknown>) =>
      Buffer.from(JSON.stringify(obj)).toString('base64url');
    return `${enc({ alg: 'RS256' })}.${enc(payload)}.sig`;
  }

  beforeEach(() => {
    resolveApiKeyMock.mockResolvedValue({ apiKey: undefined, source: 'user', useNativeAuth: true });
    resolveCodexUnixIdentityMock.mockResolvedValue({ ok: true, unixUser: null });
  });

  it('valid ChatGPT tokens → authenticated via oauth with a plan hint', async () => {
    readCodexAuthFileMock.mockReturnValue({
      ok: true,
      content: JSON.stringify({
        OPENAI_API_KEY: null,
        tokens: {
          id_token: fakeJwt({ 'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' } }),
          access_token: 'a',
          refresh_token: 'r',
        },
      }),
    });

    const result = await service().create({ tool: 'codex' }, params);
    expect(result).toMatchObject({ status: 'authenticated', method: 'oauth' });
    expect(result.hint).toContain('plus');
  });

  it('genuinely absent auth.json → unauthenticated', async () => {
    readCodexAuthFileMock.mockReturnValue({ ok: false, reason: 'not-found' });
    const result = await service().create({ tool: 'codex' }, params);
    expect(result.status).toBe('unauthenticated');
  });

  it('unreadable auth.json (sudo/permission failure) → unknown, never unauthenticated', async () => {
    readCodexAuthFileMock.mockReturnValue({ ok: false, reason: 'unreadable' });
    const result = await service().create({ tool: 'codex' }, params);
    expect(result.status).toBe('unknown');
  });

  it('malformed auth.json → unauthenticated (positive evidence of a broken login)', async () => {
    readCodexAuthFileMock.mockReturnValue({ ok: true, content: 'not json at all' });
    const result = await service().create({ tool: 'codex' }, params);
    expect(result.status).toBe('unauthenticated');
  });

  it('identity resolution failure → unknown; missing unix_username → unauthenticated', async () => {
    resolveCodexUnixIdentityMock.mockResolvedValue({
      ok: false,
      reason: 'resolve-failed',
      message: 'x',
    });
    expect((await service().create({ tool: 'codex' }, params)).status).toBe('unknown');

    resolveCodexUnixIdentityMock.mockResolvedValue({
      ok: false,
      reason: 'missing-username',
      message: 'x',
    });
    expect((await service().create({ tool: 'codex' }, params)).status).toBe('unauthenticated');
  });
});
