import type { MCPServer } from '@agor-live/client';
import { describe, expect, it } from 'vitest';

import { mcpServerNeedsAuth } from './mcpAuth';

/** Helper: build a minimal MCPServer with OAuth auth fields. */
function makeOAuthServer(
  overrides: { oauth_access_token?: string; oauth_token_expires_at?: number } = {}
): MCPServer {
  return {
    mcp_server_id: 'test-server-id',
    name: 'test',
    transport: 'http',
    scope: 'global',
    enabled: true,
    source: 'user',
    created_at: new Date(),
    updated_at: new Date(),
    auth: {
      type: 'oauth',
      oauth_access_token: overrides.oauth_access_token,
      oauth_token_expires_at: overrides.oauth_token_expires_at,
    },
  } as unknown as MCPServer;
}

describe('mcpServerNeedsAuth', () => {
  it('returns false for undefined server', () => {
    expect(mcpServerNeedsAuth(undefined, new Set())).toBe(false);
  });

  it('returns false for a configured bearer server', () => {
    const server = makeOAuthServer();
    (server.auth as { type: string }).type = 'bearer';
    server.auth!.token = 'saved-token';
    expect(mcpServerNeedsAuth(server, new Set())).toBe(false);
  });

  it('reports explicitly cleared bearer and JWT credentials as needs-auth', () => {
    const bearer = makeOAuthServer();
    bearer.auth = { type: 'bearer' };
    expect(mcpServerNeedsAuth(bearer, new Set())).toBe(true);

    const jwt = makeOAuthServer();
    jwt.auth = { type: 'jwt', api_url: 'https://auth.example.test/token' };
    expect(mcpServerNeedsAuth(jwt, new Set())).toBe(true);
    jwt.auth.api_token = 'saved-token';
    jwt.auth.api_secret = 'saved-secret';
    expect(mcpServerNeedsAuth(jwt, new Set())).toBe(false);
  });

  it('does not trust OAuth credentials projected onto an ordinary server read', () => {
    const server = makeOAuthServer({ oauth_access_token: 'tok-123' });
    expect(mcpServerNeedsAuth(server, new Set())).toBe(true);
  });

  it('returns false when no token but server is in authenticated Set (no expiry)', () => {
    const server = makeOAuthServer();
    const set = new Set(['test-server-id']);
    expect(mcpServerNeedsAuth(server, set)).toBe(false);
  });

  it('returns true when no token and server is NOT in Set', () => {
    const server = makeOAuthServer();
    expect(mcpServerNeedsAuth(server, new Set())).toBe(true);
  });

  // This is the bug scenario: after disconnect, token was stripped but the
  // Set was also updated — both sources agree "needs auth".
  it('returns true when token is undefined and server removed from Set', () => {
    const server = makeOAuthServer({ oauth_access_token: undefined });
    expect(mcpServerNeedsAuth(server, new Set())).toBe(true);
  });
});
