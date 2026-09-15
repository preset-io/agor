import { afterEach, describe, expect, it, vi } from 'vitest';
import { type MCPAuth, resolveMCPOAuthClientMode } from '../../types/mcp';
import { assertValidMCPAuthPatch } from './auth-patch';
import { resolveMCPAuthHeaders } from './jwt-auth';
import { resolveMCPOAuthDiscovery, startMCPOAuthFlow } from './oauth-mcp-transport';
import { refreshMCPToken } from './oauth-refresh';
import { assertValidMCPServerWrite } from './server-validation';

const managed: MCPAuth = {
  type: 'oauth',
  oauth_mode: 'per_user',
  oauth_client_mode: 'cloud_managed_v1',
  oauth_managed_profile: {
    profile_id: 'fake-beta',
    semantic_version: '1',
    environment: 'staging',
    region: 'us-west-2',
    registry_digest: 'a'.repeat(64),
  },
};

afterEach(() => vi.unstubAllGlobals());

describe('managed origin cannot be interpreted as direct OAuth', () => {
  it('preserves legacy direct interpretation, rejecting unknown or detached identity', () => {
    expect(resolveMCPOAuthClientMode(undefined)).toBe('direct');
    expect(resolveMCPOAuthClientMode({ type: 'oauth' })).toBe('direct');
    expect(resolveMCPOAuthClientMode(managed)).toBe('cloud_managed_v1');
    for (const mode of [null, '', 'managed', 1, false]) {
      expect(() => resolveMCPOAuthClientMode({ oauth_client_mode: mode })).toThrow();
    }
    expect(() => resolveMCPOAuthClientMode({ ...managed, oauth_client_mode: undefined })).toThrow();
  });

  it('allows only a complete secret-free managed prescription', () => {
    expect(() => assertValidMCPAuthPatch(managed, { create: true })).not.toThrow();
    for (const extra of [
      { oauth_client_secret: 'synthetic-secret' },
      { oauth_client_id: 'caller-client' },
      { oauth_access_token: 'synthetic-token' },
      { oauth_dcr_mode: 'disabled' },
      { oauth_mode: 'shared' },
      { oauth_token_url: 'https://arbitrary.test/token' },
      { insecure: false },
      { oauth_managed_profile: { ...managed.oauth_managed_profile, region: 'eu-west-1' } },
      { oauth_managed_profile: { ...managed.oauth_managed_profile, secret: 'synthetic' } },
    ]) {
      expect(() => assertValidMCPAuthPatch({ ...managed, ...extra }, { create: true })).toThrow();
    }
  });

  it('rejects public selection even when the managed reference is valid', () => {
    expect(() =>
      assertValidMCPServerWrite(
        { auth: managed },
        {
          operation: 'mutation',
          trusted: false,
        }
      )
    ).toThrow(/Catalog Connect/);
  });

  it('rejects managed discovery/start/refresh and raw-token projection before any network', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const mode = 'cloud_managed_v1' as const;
    await expect(
      resolveMCPOAuthDiscovery(null, 'https://fake.test/mcp', {
        oauthClientMode: mode,
      })
    ).rejects.toThrow(/managed authority adapter/);
    await expect(
      startMCPOAuthFlow('', undefined, undefined, {
        oauthClientMode: mode,
      })
    ).rejects.toThrow(/managed authority adapter/);
    await expect(
      refreshMCPToken({
        oauthClientMode: mode,
        tokenEndpoint: 'https://fake.test/token',
        clientId: 'synthetic',
        refreshToken: 'synthetic',
      })
    ).rejects.toThrow(/managed authority adapter/);
    await expect(
      resolveMCPAuthHeaders({ ...managed, oauth_access_token: 'synthetic' })
    ).rejects.toThrow(/managed authority adapter/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
