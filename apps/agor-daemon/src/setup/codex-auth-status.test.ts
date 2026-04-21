import type { AgorConfig } from '@agor/core/config';
import { describe, expect, it } from 'vitest';
import { deriveCodexAuthStatus, resolveCodexAuthStatusContext } from './codex-auth-status.js';

describe('resolveCodexAuthStatusContext', () => {
  it('resolves the current user stable home under ~/.agor/codex/users/<userId>', () => {
    const config: AgorConfig = {};

    expect(resolveCodexAuthStatusContext(config, { agorUserId: 'user-123' }).codexHome).toContain(
      '/.agor/codex/users/user-123'
    );
  });
});

describe('deriveCodexAuthStatus', () => {
  it('marks status as using_api_key when a user or app OPENAI_API_KEY is configured', () => {
    expect(
      deriveCodexAuthStatus({
        apiKeySource: 'user',
        authJsonExists: true,
        credentialStore: 'file',
        unixUserMode: 'simple',
        codexHome: '/tmp/.agor/codex/users/user-123',
        scope: 'user',
        executionUnixUser: null,
      }).status
    ).toBe('using_api_key');
  });
});
