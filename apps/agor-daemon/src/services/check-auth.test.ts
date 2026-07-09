import { resolveApiKey, resolveUserEnvironment } from '@agor/core/config';
import { Claude } from '@agor/core/sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createCheckAuthService } from './check-auth';

vi.mock('@agor/core/config', async () => {
  const actual = await vi.importActual<typeof import('@agor/core/config')>('@agor/core/config');
  return {
    ...actual,
    resolveApiKey: vi.fn(),
    resolveUserEnvironment: vi.fn(),
  };
});

vi.mock('@agor/core/sdk', () => ({
  Claude: {
    query: vi.fn(),
  },
}));

const resolveApiKeyMock = vi.mocked(resolveApiKey);
const resolveUserEnvironmentMock = vi.mocked(resolveUserEnvironment);
const claudeQueryMock = vi.mocked(Claude.query);

function mockClaudeAccount(account: Record<string, unknown> | null) {
  claudeQueryMock.mockReturnValue({
    accountInfo: vi.fn(async () => account),
    close: vi.fn(),
  } as never);
}

describe('check-auth Claude subscription tokens', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
    resolveUserEnvironmentMock.mockResolvedValue({});
  });

  it('validates a raw claude setup-token as OAuth instead of an Anthropic API key', async () => {
    mockClaudeAccount({ tokenSource: 'CLAUDE_CODE_OAUTH_TOKEN' });
    const service = createCheckAuthService({} as never);

    const result = await service.create({ tool: 'claude-code', apiKey: 'sk-ant-oat01-test' });

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
      .mockResolvedValueOnce({ apiKey: undefined, source: 'none', useNativeAuth: true })
      .mockResolvedValueOnce({
        apiKey: 'sk-ant-oat01-stored',
        source: 'user',
        useNativeAuth: false,
      });
    mockClaudeAccount({ tokenSource: 'CLAUDE_CODE_OAUTH_TOKEN' });
    const service = createCheckAuthService({} as never);

    const result = await service.create({ tool: 'claude-code' }, {
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
      db: {},
      tool: 'claude-code',
    });
    expect(resolveApiKeyMock).toHaveBeenNthCalledWith(2, 'CLAUDE_CODE_OAUTH_TOKEN', {
      userId: 'user-1',
      db: {},
      tool: 'claude-code',
    });
  });

  it('validates an Anthropic API key stored as a user env var', async () => {
    resolveApiKeyMock.mockResolvedValue({ apiKey: undefined, source: 'none', useNativeAuth: true });
    resolveUserEnvironmentMock.mockResolvedValue({ ANTHROPIC_API_KEY: 'sk-ant-api03-env' });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true } as Response);
    const service = createCheckAuthService({} as never);

    const result = await service.create({ tool: 'claude-code' }, {
      user: { user_id: 'user-1' },
    } as never);

    expect(result).toMatchObject({ authenticated: true, method: 'api-key' });
    expect(resolveUserEnvironmentMock).toHaveBeenCalledWith('user-1', {}, { tool: 'claude-code' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({ 'x-api-key': 'sk-ant-api03-env' }),
      })
    );
    fetchMock.mockRestore();
  });

  it('validates a Claude subscription token stored as a user env var', async () => {
    resolveApiKeyMock
      .mockResolvedValueOnce({ apiKey: undefined, source: 'none', useNativeAuth: true })
      .mockResolvedValueOnce({ apiKey: undefined, source: 'none', useNativeAuth: true });
    resolveUserEnvironmentMock.mockResolvedValue({
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-env',
    });
    mockClaudeAccount({ tokenSource: 'CLAUDE_CODE_OAUTH_TOKEN' });
    const service = createCheckAuthService({} as never);

    const result = await service.create({ tool: 'claude-code' }, {
      user: { user_id: 'user-1' },
    } as never);

    expect(result).toMatchObject({ authenticated: true, method: 'oauth' });
    expect(claudeQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          env: expect.objectContaining({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-env' }),
        }),
      })
    );
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(resolveUserEnvironmentMock).toHaveBeenCalledWith('user-1', {}, { tool: 'claude-code' });
  });
});
