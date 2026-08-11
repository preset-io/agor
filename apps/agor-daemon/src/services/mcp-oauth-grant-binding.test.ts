import type { UserMCPOAuthToken } from '@agor/core/db';
import type { MCPServer, MCPServerID } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import {
  fingerprintMCPOAuthGrantConfiguration,
  hasMCPOAuthRelevantServerConfigurationChanged,
  isMCPOAuthGrantBoundToServer,
  MCP_OAUTH_GRANT_BINDING_VERSION,
  type MCPOAuthResolvedGrantBinding,
} from './mcp-oauth-grant-binding.js';

const masterSecret = 'test-master-secret-that-is-not-a-provider-secret';

type ServerBinding = Pick<MCPServer, 'mcp_server_id' | 'enabled' | 'transport' | 'url' | 'auth'>;

const server: ServerBinding = {
  mcp_server_id: '019f-server-a' as MCPServerID,
  enabled: true,
  transport: 'http',
  url: 'https://resource.example/mcp',
  auth: {
    type: 'oauth',
    oauth_mode: 'per_user',
    oauth_compatibility_mode: 'strict',
    oauth_dcr_mode: 'disabled',
    oauth_authorization_url: 'https://issuer.example/authorize',
    oauth_token_url: 'https://issuer.example/token',
    oauth_client_id: 'configured-client',
    oauth_client_secret: 'configured-secret',
    oauth_scope: 'read write',
    oauth_grant_type: 'authorization_code',
  },
};

const resolved = {
  resourceUri: 'https://resource.example/mcp',
  metadataUrl: 'https://resource.example/.well-known/oauth-protected-resource/mcp',
  issuer: 'https://issuer.example',
  authorizationEndpoint: 'https://issuer.example/authorize',
  tokenEndpoint: 'https://issuer.example/token',
  redirectUri: 'https://agor.example/oauth/callback',
  clientId: 'registered-client',
  clientSecret: 'registered-secret',
} satisfies MCPOAuthResolvedGrantBinding;

function tokenFor(fingerprint: string): UserMCPOAuthToken {
  return {
    user_id: null,
    mcp_server_id: server.mcp_server_id,
    oauth_access_token: 'access-token',
    oauth_client_id: resolved.clientId,
    oauth_client_secret: resolved.clientSecret,
    oauth_metadata_uri: resolved.metadataUrl,
    oauth_resource_uri: resolved.resourceUri,
    oauth_issuer: resolved.issuer,
    oauth_authorization_endpoint: resolved.authorizationEndpoint,
    oauth_token_endpoint: resolved.tokenEndpoint,
    oauth_redirect_uri: resolved.redirectUri,
    grant_generation: 7,
    grant_binding_version: MCP_OAUTH_GRANT_BINDING_VERSION,
    grant_binding_fingerprint: fingerprint,
    refresh_status: 'idle',
    refresh_generation: 0,
    refresh_success_generation: 0,
    created_at: new Date(0),
  };
}

describe('MCP OAuth grant configuration binding', () => {
  it('preserves the version-1 missing DCR fingerprint across rolling upgrades', () => {
    const withoutPolicy: ServerBinding = {
      ...server,
      auth: { ...server.auth, oauth_dcr_mode: undefined },
    };
    const advertised: ServerBinding = {
      ...server,
      auth: { ...server.auth, oauth_dcr_mode: 'advertised' },
    };
    const disabled: ServerBinding = {
      ...server,
      auth: { ...server.auth, oauth_dcr_mode: 'disabled' },
    };
    const fallback: ServerBinding = {
      ...server,
      auth: { ...server.auth, oauth_dcr_mode: 'fallback' },
    };

    const fingerprint = (candidate: ServerBinding) =>
      fingerprintMCPOAuthGrantConfiguration(masterSecret, candidate, resolved);
    expect(fingerprint(withoutPolicy)).toBe(fingerprint(disabled));
    expect(fingerprint(withoutPolicy)).not.toBe(fingerprint(advertised));
    expect(fingerprint(withoutPolicy)).not.toBe(fingerprint(fallback));
  });

  it('binds every provider, client, callback, server, mode, and version input', () => {
    const original = fingerprintMCPOAuthGrantConfiguration(masterSecret, server, resolved);
    const variants: Array<[string, ServerBinding, MCPOAuthResolvedGrantBinding]> = [
      ['server id', { ...server, mcp_server_id: '019f-server-b' as MCPServerID }, resolved],
      ['resource URL', { ...server, url: 'https://other-resource.example/mcp' }, resolved],
      ['enabled state', { ...server, enabled: false }, resolved],
      ['transport', { ...server, transport: 'sse' }, resolved],
      ['auth mode', { ...server, auth: { ...server.auth, oauth_mode: 'shared' } }, resolved],
      [
        'compatibility mode',
        { ...server, auth: { ...server.auth, oauth_compatibility_mode: 'legacy' } },
        resolved,
      ],
      ['DCR policy', { ...server, auth: { ...server.auth, oauth_dcr_mode: 'fallback' } }, resolved],
      [
        'configured endpoint',
        { ...server, auth: { ...server.auth, oauth_token_url: 'https://other.example/token' } },
        resolved,
      ],
      [
        'configured client',
        { ...server, auth: { ...server.auth, oauth_client_id: 'other-client' } },
        resolved,
      ],
      [
        'configured client secret',
        { ...server, auth: { ...server.auth, oauth_client_secret: 'other-secret' } },
        resolved,
      ],
      [
        'resolved metadata URL',
        server,
        { ...resolved, metadataUrl: 'https://resource.example/other-metadata' },
      ],
      ['resolved resource', server, { ...resolved, resourceUri: 'https://other.example/mcp' }],
      ['issuer', server, { ...resolved, issuer: 'https://other-issuer.example' }],
      [
        'authorization endpoint',
        server,
        { ...resolved, authorizationEndpoint: 'https://issuer.example/authorize-v2' },
      ],
      ['token endpoint', server, { ...resolved, tokenEndpoint: 'https://issuer.example/token-v2' }],
      ['redirect contract', server, { ...resolved, redirectUri: 'https://other-agor.example/cb' }],
      ['resolved client id', server, { ...resolved, clientId: 'other-registered-client' }],
      ['resolved client secret', server, { ...resolved, clientSecret: 'other-registered-secret' }],
    ];

    for (const [label, changedServer, changedResolved] of variants) {
      expect(
        fingerprintMCPOAuthGrantConfiguration(masterSecret, changedServer, changedResolved),
        label
      ).not.toBe(original);
    }
    expect(MCP_OAUTH_GRANT_BINDING_VERSION).toBe(1);
  });

  it('revalidates a stored grant and rejects a configuration change', () => {
    const fingerprint = fingerprintMCPOAuthGrantConfiguration(masterSecret, server, resolved);
    const grant = tokenFor(fingerprint);
    expect(isMCPOAuthGrantBoundToServer(masterSecret, server, grant)).toBe(true);
    expect(
      isMCPOAuthGrantBoundToServer(
        masterSecret,
        { ...server, url: 'https://replacement.example/mcp' },
        grant
      )
    ).toBe(false);
    expect(isMCPOAuthGrantBoundToServer('other-master', server, grant)).toBe(false);
  });

  it('detects all server-side OAuth configuration changes for invalidation', () => {
    expect(hasMCPOAuthRelevantServerConfigurationChanged(server, { ...server })).toBe(false);
    expect(
      hasMCPOAuthRelevantServerConfigurationChanged(server, {
        ...server,
        auth: { ...server.auth, oauth_mode: 'shared' },
      })
    ).toBe(true);
    expect(
      hasMCPOAuthRelevantServerConfigurationChanged(server, {
        ...server,
        auth: { ...server.auth, oauth_client_secret: 'rotated' },
      })
    ).toBe(true);
    expect(
      hasMCPOAuthRelevantServerConfigurationChanged(server, {
        ...server,
        url: 'https://replacement.example/mcp',
      })
    ).toBe(true);
  });
});
