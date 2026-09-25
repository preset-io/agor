import { describe, expect, it } from 'vitest';
import { describeOAuthAuthorizeBuilt } from './mcp-oauth-authorize-log.js';

const context = {
  clientSource: 'dcr' as const,
  clientName: 'Agor MCP Client',
  redirectUri: 'https://agor.example.test/mcp-servers/oauth-callback',
  registeredRedirectUri: 'https://agor.example.test/mcp-servers/oauth-callback',
  registrationEndpoint: 'https://provider.example.test/oauth/register?tenant=acme',
  authorizationEndpoint: 'https://provider.example.test/oauth/authorize',
};

describe('describeOAuthAuthorizeBuilt', () => {
  it('states the binding a front-channel rejection would otherwise hide', () => {
    expect(
      describeOAuthAuthorizeBuilt({ mcpServerId: 'server-1', attemptId: 'attempt-1', context })
    ).toBe(
      '[MCP OAuth] event=oauth_authorize_built server=server-1 attempt=attempt-1 ' +
        'client_source=dcr client_name=Agor MCP Client ' +
        'redirect_origin=https://agor.example.test ' +
        'authorize_origin=https://provider.example.test ' +
        'redirect_matches_registered=true ' +
        'registration_endpoint_origin=https://provider.example.test'
    );
  });

  it('carries origins only — never a path, query, or full URL', () => {
    const line = describeOAuthAuthorizeBuilt({
      mcpServerId: 'server-1',
      attemptId: 'attempt-1',
      context,
    });
    expect(line).not.toContain('/mcp-servers/oauth-callback');
    expect(line).not.toContain('/oauth/register');
    expect(line).not.toContain('/oauth/authorize');
    expect(line).not.toContain('tenant=acme');
  });

  it('reports a mismatch rather than asserting agreement', () => {
    expect(
      describeOAuthAuthorizeBuilt({
        attemptId: 'attempt-2',
        context: {
          ...context,
          registeredRedirectUri: 'https://stale-agor.example.test/mcp-servers/oauth-callback',
        },
      })
    ).toContain('redirect_matches_registered=false');
  });

  it('does not claim a match for a configured client it never observed', () => {
    const line = describeOAuthAuthorizeBuilt({
      attemptId: 'attempt-3',
      context: {
        clientSource: 'configured',
        redirectUri: context.redirectUri,
        authorizationEndpoint: context.authorizationEndpoint,
      },
    });
    expect(line).toContain('client_source=configured');
    expect(line).toContain('redirect_matches_registered=unknown');
    expect(line).toContain('registration_endpoint_origin=none');
    expect(line).toContain('server=none');
  });
});
