import { describe, expect, it } from 'vitest';
import { redactMCPAuthSecrets, restoreRedactedMCPAuthSecrets } from './auth-secrets';
import { MCP_HEADER_REDACTED_SENTINEL } from './http-headers';

describe('MCP auth secret helpers', () => {
  it('redacts secret-bearing auth fields while preserving metadata', () => {
    const redacted = redactMCPAuthSecrets({
      type: 'oauth',
      oauth_token_url: 'https://auth.example/token',
      oauth_client_id: 'public-client-id',
      oauth_client_secret: 'raw-client-secret',
      oauth_access_token: 'raw-access',
      oauth_refresh_token: 'raw-refresh',
      oauth_scope: 'read',
      oauth_mode: 'per_user',
      oauth_token_expires_at: 123,
    });

    expect(redacted).toEqual({
      type: 'oauth',
      oauth_token_url: 'https://auth.example/token',
      oauth_client_id: 'public-client-id',
      oauth_client_secret: MCP_HEADER_REDACTED_SENTINEL,
      oauth_access_token: MCP_HEADER_REDACTED_SENTINEL,
      oauth_refresh_token: MCP_HEADER_REDACTED_SENTINEL,
      oauth_scope: 'read',
      oauth_mode: 'per_user',
      oauth_token_expires_at: 123,
    });
  });

  it('restores redacted placeholders from current auth config', () => {
    const restored = restoreRedactedMCPAuthSecrets({
      current: {
        type: 'jwt',
        api_url: 'https://auth.example/token',
        api_token: 'stored-token-name',
        api_secret: 'stored-secret',
      },
      next: {
        type: 'jwt',
        api_url: 'https://auth.example/token',
        api_token: MCP_HEADER_REDACTED_SENTINEL,
        api_secret: MCP_HEADER_REDACTED_SENTINEL,
      },
    });

    expect(restored).toEqual({
      type: 'jwt',
      api_url: 'https://auth.example/token',
      api_token: 'stored-token-name',
      api_secret: 'stored-secret',
    });
  });
});
