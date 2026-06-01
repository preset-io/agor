import { describe, expect, it } from 'vitest';
import { resolveProbeServerTemplates } from './mcp-probe-templates';

/**
 * Behavior tests for the MCP discover-endpoint template resolution helper.
 *
 * Direct exercise of the recipe used by `/mcp-servers/discover`: synthetic
 * env tagged with AGOR_USER_ENV_KEYS → buildMCPTemplateContextFromEnv →
 * resolveMcpServerTemplates → typed result. The bug this PR fixed (literal
 * `{{ user.env.X }}` strings reaching the upstream MCP server) regresses
 * here if any of those steps stops composing correctly.
 */
describe('resolveProbeServerTemplates', () => {
  it('resolves {{ user.env.X }} in bearer tokens to the actual value', () => {
    const result = resolveProbeServerTemplates(
      {
        url: 'https://api.example.com/mcp',
        transport: 'http',
        auth: { type: 'bearer', token: '{{ user.env.MY_API_TOKEN }}' },
        name: 'example',
      },
      { MY_API_TOKEN: 'real-secret-abc123' }
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolved.auth?.token).toBe('real-secret-abc123');
    }
  });

  it('passes plain (non-templated) bearer tokens through unchanged', () => {
    const result = resolveProbeServerTemplates(
      {
        url: 'https://api.example.com/mcp',
        transport: 'http',
        auth: { type: 'bearer', token: 'pasted-raw-token' },
        name: 'plain',
      },
      {}
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolved.auth?.token).toBe('pasted-raw-token');
    }
  });

  it('returns an actionable error when an auth template references a missing var', () => {
    const result = resolveProbeServerTemplates(
      {
        url: 'https://api.example.com/mcp',
        transport: 'http',
        auth: { type: 'bearer', token: '{{ user.env.MISSING }}' },
        name: 'example',
      },
      {} // no env vars defined
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Error must point at the failing field AND tell the user where to fix it.
      expect(result.error).toContain('auth.token');
      expect(result.error).toContain('Settings');
    }
  });

  it('returns an actionable error when only some auth templates resolve', () => {
    const result = resolveProbeServerTemplates(
      {
        url: 'https://api.example.com/mcp',
        transport: 'http',
        auth: {
          type: 'jwt',
          api_url: 'https://auth.example.com/jwt',
          api_token: '{{ user.env.JWT_KEY }}',
          api_secret: '{{ user.env.JWT_SECRET_MISSING }}',
        },
        name: 'jwt-server',
      },
      { JWT_KEY: 'present' } // JWT_SECRET_MISSING absent
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('auth.api_secret');
      // Resolved fields should NOT be mentioned in the error.
      expect(result.error).not.toContain('auth.api_token');
    }
  });

  it('resolves URL templates and returns the expanded URL', () => {
    const result = resolveProbeServerTemplates(
      {
        url: 'https://{{ user.env.HOST }}/mcp',
        transport: 'http',
        auth: { type: 'none' },
        name: 'host-templated',
      },
      { HOST: 'api.example.com' }
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolved.url).toBe('https://api.example.com/mcp');
    }
  });

  it('resolves all templated JWT fields together', () => {
    const result = resolveProbeServerTemplates(
      {
        url: 'https://api.example.com/mcp',
        transport: 'http',
        auth: {
          type: 'jwt',
          api_url: 'https://auth.example.com/jwt',
          api_token: '{{ user.env.JWT_KEY }}',
          api_secret: '{{ user.env.JWT_SECRET }}',
        },
        name: 'jwt-server',
      },
      { JWT_KEY: 'key-value', JWT_SECRET: 'secret-value' }
    );

    expect(result.ok).toBe(true);
    if (result.ok && result.resolved.auth?.type === 'jwt') {
      expect(result.resolved.auth.api_token).toBe('key-value');
      expect(result.resolved.auth.api_secret).toBe('secret-value');
    }
  });

  it('handles an empty userEnv when there are no templates to resolve', () => {
    // Realistic scenario: user with no env vars set, server uses pasted raw token.
    // Must not error out — many users never need the templating feature.
    const result = resolveProbeServerTemplates(
      {
        url: 'https://api.example.com/mcp',
        transport: 'http',
        auth: { type: 'bearer', token: 'literal' },
        name: 'no-user-env',
      },
      {}
    );

    expect(result.ok).toBe(true);
  });

  it('surfaces missing OAuth template variables that the core resolver would silently drop', () => {
    // The shared resolver treats OAuth fields as optional and does not add
    // them to `unresolvedFields` (template-resolver.ts:287-335). For Test
    // Connection that's the wrong call: a templated `oauth_client_secret`
    // resolving to empty leads to a confusing upstream OAuth failure
    // instead of a local "set the env var" message. The helper compensates.
    const result = resolveProbeServerTemplates(
      {
        url: 'https://api.example.com/mcp',
        transport: 'http',
        auth: {
          type: 'oauth',
          oauth_token_url: 'https://auth.example.com/token',
          oauth_client_id: 'public-id',
          oauth_client_secret: '{{ user.env.OAUTH_SECRET_MISSING }}',
        },
        name: 'oauth-server',
      },
      {} // no env vars defined
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('auth.oauth_client_secret');
      expect(result.error).toContain('Settings');
      // Resolved fields must NOT appear in the error.
      expect(result.error).not.toContain('auth.oauth_client_id');
      expect(result.error).not.toContain('auth.oauth_token_url');
    }
  });

  it('resolves OAuth templates to actual values when env vars are present', () => {
    const result = resolveProbeServerTemplates(
      {
        url: 'https://api.example.com/mcp',
        transport: 'http',
        auth: {
          type: 'oauth',
          oauth_token_url: '{{ user.env.OAUTH_TOKEN_URL }}',
          oauth_client_id: '{{ user.env.OAUTH_CLIENT_ID }}',
          oauth_client_secret: '{{ user.env.OAUTH_CLIENT_SECRET }}',
          oauth_scope: '{{ user.env.OAUTH_SCOPE }}',
        },
        name: 'oauth-templated',
      },
      {
        OAUTH_TOKEN_URL: 'https://auth.example.com/token',
        OAUTH_CLIENT_ID: 'client-abc',
        OAUTH_CLIENT_SECRET: 'secret-xyz',
        OAUTH_SCOPE: 'read write',
      }
    );

    expect(result.ok).toBe(true);
    if (result.ok && result.resolved.auth?.type === 'oauth') {
      expect(result.resolved.auth.oauth_token_url).toBe('https://auth.example.com/token');
      expect(result.resolved.auth.oauth_client_id).toBe('client-abc');
      expect(result.resolved.auth.oauth_client_secret).toBe('secret-xyz');
      expect(result.resolved.auth.oauth_scope).toBe('read write');
    }
  });

  it('lists multiple missing OAuth fields together', () => {
    const result = resolveProbeServerTemplates(
      {
        url: 'https://api.example.com/mcp',
        transport: 'http',
        auth: {
          type: 'oauth',
          oauth_token_url: '{{ user.env.OAUTH_TOKEN_URL_MISSING }}',
          oauth_client_id: 'public-id',
          oauth_client_secret: '{{ user.env.OAUTH_SECRET_MISSING }}',
        },
        name: 'oauth-server',
      },
      {}
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('auth.oauth_token_url');
      expect(result.error).toContain('auth.oauth_client_secret');
    }
  });
});
