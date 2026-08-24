import { describe, expect, it } from 'vitest';
import { assertValidMCPAuthPatch, mergeMCPAuth, replaceMCPAuth } from './auth-patch';
import { MCP_HEADER_REDACTED_SENTINEL } from './http-headers';

const stored = {
  type: 'oauth' as const,
  oauth_client_id: 'client-id',
  oauth_client_secret: 'client-secret',
  oauth_scope: 'calendar.readonly',
  oauth_compatibility_mode: 'legacy' as const,
};

describe('mergeMCPAuth', () => {
  it('preserves omitted OAuth settings on a narrow scope patch', () => {
    expect(mergeMCPAuth(stored, { oauth_scope: 'calendar.events' })).toEqual({
      ...stored,
      oauth_scope: 'calendar.events',
    });
  });

  it('distinguishes explicit clear, redacted preservation, and omission', () => {
    expect(
      mergeMCPAuth(stored, {
        oauth_client_id: null,
        oauth_client_secret: MCP_HEADER_REDACTED_SENTINEL,
      })
    ).toEqual({
      type: 'oauth',
      oauth_client_secret: 'client-secret',
      oauth_scope: 'calendar.readonly',
      oauth_compatibility_mode: 'legacy',
    });
  });

  it('replaces wholesale when the auth type changes', () => {
    expect(mergeMCPAuth(stored, { type: 'bearer', token: 'next' })).toEqual({
      type: 'bearer',
      token: 'next',
    });
  });

  it('clears the whole auth object with null', () => {
    expect(mergeMCPAuth(stored, null)).toBeUndefined();
    expect(replaceMCPAuth(stored, null)).toBeUndefined();
    expect(() => assertValidMCPAuthPatch(null, { create: true })).not.toThrow();
  });

  it('round-trips redacted PUT secrets from the current row while replacing non-secrets', () => {
    expect(
      replaceMCPAuth(stored, {
        type: 'oauth',
        oauth_client_secret: MCP_HEADER_REDACTED_SENTINEL,
        oauth_scope: 'calendar.events',
      })
    ).toEqual({
      type: 'oauth',
      oauth_client_secret: 'client-secret',
      oauth_scope: 'calendar.events',
    });
  });

  it('rejects every create-time secret sentinel', () => {
    for (const input of [
      { type: 'bearer', token: MCP_HEADER_REDACTED_SENTINEL },
      { type: 'jwt', api_secret: MCP_HEADER_REDACTED_SENTINEL },
      { type: 'oauth', oauth_refresh_token: MCP_HEADER_REDACTED_SENTINEL },
    ]) {
      expect(() => assertValidMCPAuthPatch(input, { create: true })).toThrow(/redaction sentinel/);
    }
  });

  it('separates public CREATE credential requirements from valid incomplete saved rows', () => {
    expect(() => assertValidMCPAuthPatch({ type: 'bearer' }, { create: true })).not.toThrow();
    expect(() =>
      assertValidMCPAuthPatch(
        { type: 'bearer' },
        { create: true, requireConfiguredCredentials: true }
      )
    ).toThrow(/auth\.token is required/);
    expect(() => assertValidMCPAuthPatch({ type: 'jwt' }, { create: true })).not.toThrow();
    expect(() =>
      assertValidMCPAuthPatch({ type: 'jwt' }, { create: true, requireConfiguredCredentials: true })
    ).toThrow(/auth\.api_url is required/);
  });

  it('allows an explicit secret clear to leave a closed incomplete saved mode', () => {
    expect(mergeMCPAuth({ type: 'bearer', token: 'secret' }, { token: null })).toEqual({
      type: 'bearer',
    });
    expect(
      mergeMCPAuth(
        {
          type: 'jwt',
          api_url: 'https://auth.example.test/token',
          api_token: 'token',
          api_secret: 'secret',
        },
        { api_token: null, api_secret: null }
      )
    ).toEqual({ type: 'jwt', api_url: 'https://auth.example.test/token' });
  });

  it('rejects field-level null on create while allowing auth:null to mean no auth', () => {
    expect(() =>
      assertValidMCPAuthPatch({ type: 'oauth', oauth_mode: null }, { create: true })
    ).toThrow('auth.oauth_mode cannot be null on create');
    expect(() => assertValidMCPAuthPatch(null, { create: true })).not.toThrow();
  });

  it('never persists a sentinel when there is no same-mode secret to restore', () => {
    expect(
      mergeMCPAuth(undefined, {
        type: 'oauth',
        oauth_client_secret: MCP_HEADER_REDACTED_SENTINEL,
      })
    ).toEqual({ type: 'oauth' });
  });

  it('rejects unknown fields before a misspelled secret can be persisted', () => {
    expect(() =>
      assertValidMCPAuthPatch({
        type: 'oauth',
        oauth_client_secert: 'would-escape-redaction',
      })
    ).toThrow('Unknown auth field: oauth_client_secert');
  });

  it('rejects fields from the wrong authentication mode and mixed partial families', () => {
    expect(() => assertValidMCPAuthPatch({ type: 'none', token: 'must-not-survive' })).toThrow(
      "auth.token does not apply when auth.type is 'none'"
    );
    expect(() => assertValidMCPAuthPatch({ type: 'none', insecure: true })).toThrow(
      "auth.insecure does not apply when auth.type is 'none'"
    );
    expect(() =>
      assertValidMCPAuthPatch({ type: 'bearer', token: 'ok', insecure: true })
    ).not.toThrow();
    expect(() =>
      assertValidMCPAuthPatch({ type: 'bearer', api_secret: 'must-not-survive' })
    ).toThrow("auth.api_secret does not apply when auth.type is 'bearer'");
    expect(() =>
      assertValidMCPAuthPatch({ type: 'jwt', oauth_client_secret: 'must-not-survive' })
    ).toThrow("auth.oauth_client_secret does not apply when auth.type is 'jwt'");
    expect(() => assertValidMCPAuthPatch({ token: 'one', oauth_scope: 'two' })).toThrow(
      'auth patch cannot combine fields from different authentication modes'
    );
    expect(() => mergeMCPAuth(stored, { token: 'wrong-mode' })).toThrow(
      "auth.token does not apply when auth.type is 'oauth'"
    );
    expect(() => assertValidMCPAuthPatch({ oauth_grant_type: 'password' })).toThrow(
      /oauth_grant_type/
    );
  });

  it('validates bounded URL and scalar auth fields', () => {
    expect(() =>
      assertValidMCPAuthPatch({ type: 'jwt', api_url: 'file:///tmp/token' }, { create: true })
    ).toThrow(/HTTP\(S\)/);
    expect(() =>
      assertValidMCPAuthPatch(
        { type: 'oauth', oauth_token_url: 'https://user:pass@provider.example/token' },
        { create: true }
      )
    ).toThrow(/embedded credentials/);
    expect(() =>
      assertValidMCPAuthPatch({ type: 'bearer', token: `secret\nheader` }, { create: true })
    ).toThrow(/control characters/);
    expect(() =>
      assertValidMCPAuthPatch(
        { type: 'oauth', oauth_token_expires_at: Number.MAX_SAFE_INTEGER + 1 },
        { create: true }
      )
    ).toThrow(/safe integer/);
  });

  it('clears static OAuth tokens when switching credential authority modes', () => {
    expect(
      mergeMCPAuth(
        {
          type: 'oauth',
          oauth_mode: 'shared',
          oauth_access_token: 'shared-access',
          oauth_refresh_token: 'shared-refresh',
          oauth_token_expires_at: 123,
          oauth_client_id: 'client',
        },
        { oauth_mode: 'per_user' }
      )
    ).toEqual({ type: 'oauth', oauth_mode: 'per_user', oauth_client_id: 'client' });
    expect(
      mergeMCPAuth(
        {
          type: 'oauth',
          oauth_mode: 'shared',
          oauth_access_token: 'shared-access',
          oauth_refresh_token: 'shared-refresh',
        },
        { oauth_mode: null }
      )
    ).toEqual({ type: 'oauth' });
  });
});
