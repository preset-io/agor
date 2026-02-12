import { describe, expect, it } from 'vitest';
import {
  extractOAuthConfig,
  extractOAuthConfigForTesting,
  isTemplateValue,
} from './mcp-oauth-utils';

describe('isTemplateValue', () => {
  it('returns true for template strings', () => {
    expect(isTemplateValue('{{ user.env.CLIENT_ID }}')).toBe(true);
    expect(isTemplateValue('{{env.SECRET}}')).toBe(true);
  });

  it('returns false for regular strings', () => {
    expect(isTemplateValue('my-client-id')).toBe(false);
    expect(isTemplateValue('https://token.example.com')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isTemplateValue('')).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isTemplateValue(undefined)).toBe(false);
  });

  it('returns false for partial template syntax', () => {
    expect(isTemplateValue('{{ missing closing')).toBe(false);
    expect(isTemplateValue('missing opening }}')).toBe(false);
  });
});

describe('extractOAuthConfig', () => {
  it('extracts all provided fields', () => {
    const result = extractOAuthConfig({
      oauth_token_url: 'https://auth.example.com/token',
      oauth_client_id: 'my-client',
      oauth_client_secret: 'my-secret',
      oauth_scope: 'read write',
      oauth_grant_type: 'authorization_code',
      oauth_mode: 'per_user',
    });

    expect(result).toEqual({
      oauth_token_url: 'https://auth.example.com/token',
      oauth_client_id: 'my-client',
      oauth_client_secret: 'my-secret',
      oauth_scope: 'read write',
      oauth_grant_type: 'authorization_code',
      oauth_mode: 'per_user',
    });
  });

  it('defaults oauth_grant_type to client_credentials', () => {
    const result = extractOAuthConfig({});
    expect(result.oauth_grant_type).toBe('client_credentials');
  });

  it('defaults oauth_mode to shared', () => {
    const result = extractOAuthConfig({});
    expect(result.oauth_mode).toBe('shared');
  });

  it('defaults oauth_mode to shared for non-per_user values', () => {
    const result = extractOAuthConfig({ oauth_mode: 'something_else' });
    expect(result.oauth_mode).toBe('shared');
  });

  it('omits falsy string fields', () => {
    const result = extractOAuthConfig({
      oauth_token_url: '',
      oauth_client_id: '',
    });

    expect(result.oauth_token_url).toBeUndefined();
    expect(result.oauth_client_id).toBeUndefined();
  });

  it('omits non-string fields', () => {
    const result = extractOAuthConfig({
      oauth_token_url: 123,
      oauth_client_id: true,
    });

    expect(result.oauth_token_url).toBeUndefined();
    expect(result.oauth_client_id).toBeUndefined();
  });
});

describe('extractOAuthConfigForTesting', () => {
  it('returns null when no url is provided', () => {
    expect(extractOAuthConfigForTesting({})).toBeNull();
    expect(extractOAuthConfigForTesting({ url: '' })).toBeNull();
    expect(extractOAuthConfigForTesting({ url: 123 })).toBeNull();
  });

  it('returns correct mcp_url', () => {
    const result = extractOAuthConfigForTesting({ url: 'https://mcp.example.com' });
    expect(result).not.toBeNull();
    expect(result!.mcp_url).toBe('https://mcp.example.com');
  });

  it('excludes template values from credentials', () => {
    const result = extractOAuthConfigForTesting({
      url: 'https://mcp.example.com',
      oauth_client_id: '{{ user.env.CLIENT_ID }}',
      oauth_client_secret: '{{ user.env.CLIENT_SECRET }}',
    });

    expect(result).not.toBeNull();
    expect(result!.client_id).toBeUndefined();
    expect(result!.client_secret).toBeUndefined();
  });

  it('includes real (non-template) credential values', () => {
    const result = extractOAuthConfigForTesting({
      url: 'https://mcp.example.com',
      oauth_client_id: 'real-client-id',
      oauth_client_secret: 'real-secret',
      oauth_scope: 'api',
      oauth_grant_type: 'client_credentials',
    });

    expect(result).not.toBeNull();
    expect(result!.client_id).toBe('real-client-id');
    expect(result!.client_secret).toBe('real-secret');
    expect(result!.scope).toBe('api');
    expect(result!.grant_type).toBe('client_credentials');
  });

  it('includes token_url even when it is a template', () => {
    const result = extractOAuthConfigForTesting({
      url: 'https://mcp.example.com',
      oauth_token_url: '{{ env.TOKEN_URL }}',
    });

    expect(result).not.toBeNull();
    expect(result!.token_url).toBe('{{ env.TOKEN_URL }}');
  });
});
