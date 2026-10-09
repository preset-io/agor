import type { ProviderOAuthGrant } from '@agor/core/db';
import { describe, expect, it, vi } from 'vitest';
import { ClaudeBackendOAuth } from './claude-backend-oauth.js';
import { CLAUDE_OAUTH_BINDING } from './claude-oauth-policy.js';

const NOW = Date.parse('2026-10-08T12:00:00Z');

function statusFor(overrides: Partial<ProviderOAuthGrant>) {
  const backend = new ClaudeBackendOAuth(
    {} as never,
    () => ({ available: true, storage: 'backend' }),
    {
      now: () => NOW,
    }
  );
  vi.spyOn(backend, 'get').mockResolvedValue({
    binding_version: 1,
    binding_fingerprint: CLAUDE_OAUTH_BINDING,
    sealed_access_token: 'sealed-access',
    sealed_refresh_token: 'sealed-refresh',
    state: 'idle',
    failure_code: null,
    expires_at: new Date(NOW + 60_000),
    ...overrides,
  } as ProviderOAuthGrant);
  return backend.status('tenant-a', 'user-a' as never);
}

describe('ClaudeBackendOAuth.status', () => {
  it('keeps an idle login with an expired access token usable for the next refresh', async () => {
    await expect(statusFor({ expires_at: new Date(NOW - 60_000) })).resolves.toMatchObject({
      saved: true,
      usable: true,
    });
  });

  it('reports an expired login whose last refresh failed as unusable', async () => {
    await expect(
      statusFor({ expires_at: new Date(NOW - 60_000), failure_code: 'refresh_not_completed' })
    ).resolves.toMatchObject({ saved: true, usable: false });
  });

  it.each(['ambiguous', 'reauth_required'] as const)(
    'reports a %s login as unusable',
    async (state) => {
      await expect(statusFor({ state, expires_at: new Date(NOW - 60_000) })).resolves.toMatchObject(
        { saved: true, usable: false }
      );
    }
  );
});
