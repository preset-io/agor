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

  it('preserves {{ }} auth templates so downstream env resolution can run', () => {
    const redacted = redactMCPAuthSecrets({
      type: 'bearer',
      token: '{{ user.env.GARMIN_TOKEN }}',
      api_token: '{{ user.env.GARMIN_API_TOKEN }}',
    });

    expect(redacted).toEqual({
      type: 'bearer',
      token: '{{ user.env.GARMIN_TOKEN }}',
      api_token: '{{ user.env.GARMIN_API_TOKEN }}',
    });
  });

  it('redacts raw secret tokens even alongside a template field', () => {
    const redacted = redactMCPAuthSecrets({
      type: 'bearer',
      token: 'gmcp_abc123rawsecret',
      api_token: '{{ user.env.GARMIN_API_TOKEN }}',
    });

    expect(redacted).toEqual({
      type: 'bearer',
      token: MCP_HEADER_REDACTED_SENTINEL,
      api_token: '{{ user.env.GARMIN_API_TOKEN }}',
    });
  });

  it('redacts a raw secret that merely contains braces in a resolvable field', () => {
    const redacted = redactMCPAuthSecrets({
      type: 'bearer',
      token: 'sk-live-{{oops}}-tail',
      api_token: '{{a}}{{b}}',
    });

    // Only a bare `{{ user.env.NAME }}` placeholder is preserved; partial or
    // multiple brace expressions are raw secrets and must be redacted.
    expect(redacted).toEqual({
      type: 'bearer',
      token: MCP_HEADER_REDACTED_SENTINEL,
      api_token: MCP_HEADER_REDACTED_SENTINEL,
    });
  });

  it('always redacts OAuth runtime-token fields, even template-looking values', () => {
    const redacted = redactMCPAuthSecrets({
      type: 'oauth',
      oauth_client_secret: '{{ user.env.OAUTH_CLIENT_SECRET }}',
      oauth_access_token: '{{ user.env.SHOULD_NOT_RESOLVE }}',
      oauth_refresh_token: '{{ user.env.SHOULD_NOT_RESOLVE }}',
    });

    // The resolver never substitutes oauth_access_token / oauth_refresh_token,
    // so a template-looking value there must not escape redaction.
    expect(redacted).toEqual({
      type: 'oauth',
      oauth_client_secret: '{{ user.env.OAUTH_CLIENT_SECRET }}',
      oauth_access_token: MCP_HEADER_REDACTED_SENTINEL,
      oauth_refresh_token: MCP_HEADER_REDACTED_SENTINEL,
    });
  });

  it('redacts raw non-template secrets in every field', () => {
    const redacted = redactMCPAuthSecrets({
      type: 'oauth',
      oauth_client_secret: 'raw-client-secret',
      oauth_access_token: 'raw-access',
      oauth_refresh_token: 'raw-refresh',
    });

    expect(redacted).toEqual({
      type: 'oauth',
      oauth_client_secret: MCP_HEADER_REDACTED_SENTINEL,
      oauth_access_token: MCP_HEADER_REDACTED_SENTINEL,
      oauth_refresh_token: MCP_HEADER_REDACTED_SENTINEL,
    });
  });

  it('redacts a single non-user.env Handlebars expression in a resolvable field', () => {
    // `{{secret}}` is one whole-value expression but references an arbitrary
    // variable, not a user-env placeholder — it must not escape redaction.
    const redacted = redactMCPAuthSecrets({
      type: 'bearer',
      token: '{{secret}}',
    });

    expect(redacted).toEqual({
      type: 'bearer',
      token: MCP_HEADER_REDACTED_SENTINEL,
    });
  });

  it('redacts helper/fallback expressions that can embed a literal secret', () => {
    // A single Handlebars helper expression (default/lookup/…) is still not a
    // bare user-env placeholder and can carry secret material in a literal
    // fallback, so it must redact rather than survive to resolution.
    const redacted = redactMCPAuthSecrets({
      type: 'bearer',
      token: '{{default user.env.MISSING "sk-live-shouldnotleak"}}',
      api_secret: '{{ lookup user.env "SECRET" }}',
    });

    expect(redacted).toEqual({
      type: 'bearer',
      token: MCP_HEADER_REDACTED_SENTINEL,
      api_secret: MCP_HEADER_REDACTED_SENTINEL,
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
