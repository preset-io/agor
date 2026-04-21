import { resolveApiKey, resolveCodexHomeForUser } from '@agor/core/config';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolvePromptAuthContext } from './prompt-auth-context.js';

vi.mock('@agor/core/config', async () => {
  const actual = await vi.importActual<typeof import('@agor/core/config')>('@agor/core/config');
  return {
    ...actual,
    resolveApiKey: vi.fn(),
    resolveCodexHomeForUser: vi.fn(),
  };
});

describe('resolvePromptAuthContext', () => {
  const resolveApiKeyMock = vi.mocked(resolveApiKey);
  const resolveCodexHomeForUserMock = vi.mocked(resolveCodexHomeForUser);

  beforeEach(() => {
    resolveApiKeyMock.mockReset();
    resolveCodexHomeForUserMock.mockReset();
  });

  it('resolves the configured API key for prompt tools', async () => {
    resolveApiKeyMock.mockResolvedValueOnce({
      apiKey: 'sk-user',
      source: 'user',
      useNativeAuth: false,
      decryptionFailed: false,
    });

    await expect(
      resolvePromptAuthContext({} as never, {
        userId: 'user-123' as never,
        tool: 'claude-code',
      })
    ).resolves.toEqual({
      apiKeyEnvVar: 'ANTHROPIC_API_KEY',
      apiKey: 'sk-user',
      source: 'user',
      useNativeAuth: false,
    });

    expect(resolveApiKeyMock).toHaveBeenCalledWith('ANTHROPIC_API_KEY', {
      userId: 'user-123',
      db: expect.anything(),
    });
    expect(resolveCodexHomeForUserMock).not.toHaveBeenCalled();
  });

  it('includes the stable per-user Codex home for native Codex auth', async () => {
    resolveApiKeyMock.mockResolvedValueOnce({
      apiKey: undefined,
      source: 'none',
      useNativeAuth: true,
      decryptionFailed: false,
    });
    resolveCodexHomeForUserMock.mockReturnValue('/tmp/.agor/codex/users/user-123');

    await expect(
      resolvePromptAuthContext({} as never, {
        userId: 'user-123' as never,
        tool: 'codex',
      })
    ).resolves.toEqual({
      apiKeyEnvVar: 'OPENAI_API_KEY',
      apiKey: undefined,
      source: 'none',
      useNativeAuth: true,
      nativeAuthContext: {
        stableCodexHome: '/tmp/.agor/codex/users/user-123',
      },
    });
  });
});
