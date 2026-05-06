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

  it('returns false for non-OAuth server', () => {
    const server = makeOAuthServer();
    (server.auth as { type: string }).type = 'bearer';
    expect(mcpServerNeedsAuth(server, new Set())).toBe(false);
  });

  it('returns false when token present and no expiry', () => {
    const server = makeOAuthServer({ oauth_access_token: 'tok-123' });
    expect(mcpServerNeedsAuth(server, new Set())).toBe(false);
  });

  it('returns false when token present and expiry is in the future', () => {
    const server = makeOAuthServer({
      oauth_access_token: 'tok-123',
      oauth_token_expires_at: Date.now() + 60_000,
    });
    expect(mcpServerNeedsAuth(server, new Set())).toBe(false);
  });

  it('returns true when token present but expired', () => {
    const server = makeOAuthServer({
      oauth_access_token: 'tok-123',
      oauth_token_expires_at: Date.now() - 1000,
    });
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

  it('returns true when no token, server in Set, but expiry is in the past', () => {
    const server = makeOAuthServer({
      oauth_token_expires_at: Date.now() - 1000,
    });
    const set = new Set(['test-server-id']);
    expect(mcpServerNeedsAuth(server, set)).toBe(true);
  });

  // This is the bug scenario: after disconnect, token was stripped but the
  // Set was also updated — both sources agree "needs auth".
  it('returns true when token is undefined and server removed from Set', () => {
    const server = makeOAuthServer({ oauth_access_token: undefined });
    expect(mcpServerNeedsAuth(server, new Set())).toBe(true);
  });
});
