import type { UserMCPOAuthToken } from '@agor/core/db';
import type { MCPServer, MCPServerID } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import {
  fingerprintMCPOAuthGrantConfiguration,
  grantBindingVersionForCompatibilityMode,
  hasMCPOAuthRelevantServerConfigurationChanged,
  isMCPOAuthGrantBoundToServer,
  MCP_OAUTH_GRANT_BINDING_VERSION,
  type MCPOAuthResolvedGrantBinding,
} from './mcp-oauth-grant-binding.js';

const masterSecret = 'test-master-secret-that-is-not-a-provider-secret';

type ServerBinding = Pick<
  MCPServer,
  'mcp_server_id' | 'enabled' | 'transport' | 'url' | 'source' | 'catalog_entry_name' | 'auth'
>;

const server: ServerBinding = {
  mcp_server_id: '019f-server-a' as MCPServerID,
  enabled: true,
  transport: 'http',
  source: 'user',
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
  compatibilityMode: 'strict',
} satisfies MCPOAuthResolvedGrantBinding;

function tokenFor(
  fingerprint: string,
  version: UserMCPOAuthToken['grant_binding_version'] = 2
): UserMCPOAuthToken {
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
    grant_binding_version: version,
    grant_binding_fingerprint: fingerprint,
    refresh_status: 'idle',
    refresh_generation: 0,
    refresh_success_generation: 0,
    created_at: new Date(0),
  };
}

describe('MCP OAuth grant configuration binding', () => {
  it('records advertised as the effective default while preserving version-1 fingerprints', () => {
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

    const currentFingerprint = (candidate: ServerBinding) =>
      fingerprintMCPOAuthGrantConfiguration(masterSecret, candidate, resolved);
    expect(currentFingerprint(withoutPolicy)).toBe(currentFingerprint(advertised));
    expect(currentFingerprint(withoutPolicy)).not.toBe(currentFingerprint(disabled));

    const legacyFingerprint = (candidate: ServerBinding) =>
      fingerprintMCPOAuthGrantConfiguration(masterSecret, candidate, resolved, 1);
    expect(legacyFingerprint(withoutPolicy)).toBe(legacyFingerprint(disabled));
    expect(legacyFingerprint(withoutPolicy)).not.toBe(legacyFingerprint(advertised));
    expect(
      isMCPOAuthGrantBoundToServer(
        masterSecret,
        withoutPolicy,
        tokenFor(legacyFingerprint(withoutPolicy), 1),
        'strict'
      )
    ).toBe(true);
  });

  it('versions and binds a marketplace policy transition explicitly', () => {
    const catalogDefault: ServerBinding = {
      ...server,
      source: 'catalog',
      catalog_entry_name: 'com.example/provider',
      auth: { ...server.auth, oauth_compatibility_mode: undefined },
    };
    const catalogStrict: ServerBinding = {
      ...catalogDefault,
      auth: { ...catalogDefault.auth, oauth_compatibility_mode: 'strict' },
    };

    const marketplaceResolved = { ...resolved, compatibilityMode: 'marketplace' as const };
    const strictFingerprint = fingerprintMCPOAuthGrantConfiguration(
      masterSecret,
      catalogStrict,
      resolved
    );
    const marketplaceFingerprint = fingerprintMCPOAuthGrantConfiguration(
      masterSecret,
      catalogDefault,
      marketplaceResolved
    );
    expect(strictFingerprint).not.toBe(marketplaceFingerprint);
    expect(grantBindingVersionForCompatibilityMode('strict')).toBe(2);
    expect(grantBindingVersionForCompatibilityMode('legacy')).toBe(2);
    expect(grantBindingVersionForCompatibilityMode('marketplace')).toBe(3);
    // A pre-marketplace v2 strict grant cannot silently cross into the new
    // policy even though both formats share the historical version number.
    expect(
      isMCPOAuthGrantBoundToServer(
        masterSecret,
        catalogDefault,
        tokenFor(
          fingerprintMCPOAuthGrantConfiguration(masterSecret, catalogDefault, resolved, 2),
          2
        ),
        'marketplace'
      )
    ).toBe(false);
    // A v2 grant actually issued by the merged #2377 implementation did bind
    // marketplace into its HMAC. Keep it when the row still satisfies today's
    // canonical catalog policy; edited/removed rows resolve strict upstream.
    const mergedPrFingerprint = fingerprintMCPOAuthGrantConfiguration(
      masterSecret,
      catalogDefault,
      marketplaceResolved,
      2
    );
    expect(
      isMCPOAuthGrantBoundToServer(
        masterSecret,
        catalogDefault,
        tokenFor(mergedPrFingerprint, 2),
        'marketplace'
      )
    ).toBe(true);
    expect(
      isMCPOAuthGrantBoundToServer(
        masterSecret,
        catalogDefault,
        tokenFor(marketplaceFingerprint, 3),
        'marketplace'
      )
    ).toBe(true);
    expect(
      isMCPOAuthGrantBoundToServer(
        masterSecret,
        catalogDefault,
        tokenFor(marketplaceFingerprint, 3),
        'strict'
      )
    ).toBe(false);
    expect(hasMCPOAuthRelevantServerConfigurationChanged(catalogDefault, catalogStrict)).toBe(true);
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
        { ...resolved, compatibilityMode: 'legacy' },
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
      ['effective compatibility mode', server, { ...resolved, compatibilityMode: 'marketplace' }],
    ];

    for (const [label, changedServer, changedResolved] of variants) {
      expect(
        fingerprintMCPOAuthGrantConfiguration(masterSecret, changedServer, changedResolved),
        label
      ).not.toBe(original);
    }
    expect(MCP_OAUTH_GRANT_BINDING_VERSION).toBe(3);
  });

  it('revalidates a stored grant and rejects a configuration change', () => {
    const fingerprint = fingerprintMCPOAuthGrantConfiguration(masterSecret, server, resolved);
    const grant = tokenFor(fingerprint);
    expect(isMCPOAuthGrantBoundToServer(masterSecret, server, grant, 'strict')).toBe(true);
    expect(
      isMCPOAuthGrantBoundToServer(
        masterSecret,
        { ...server, url: 'https://replacement.example/mcp' },
        grant,
        'strict'
      )
    ).toBe(false);
    expect(isMCPOAuthGrantBoundToServer('other-master', server, grant, 'strict')).toBe(false);
  });

  it('keeps a v2 strict grant for an existing catalog row whose stored mode was absent', () => {
    const existingStrictCatalogServer: ServerBinding = {
      ...server,
      source: 'catalog',
      catalog_entry_name: 'com.example/strict-provider',
      auth: { ...server.auth, oauth_compatibility_mode: undefined },
    };
    const fingerprint = fingerprintMCPOAuthGrantConfiguration(
      masterSecret,
      existingStrictCatalogServer,
      resolved,
      2
    );

    expect(
      isMCPOAuthGrantBoundToServer(
        masterSecret,
        existingStrictCatalogServer,
        tokenFor(fingerprint, 2),
        'strict'
      )
    ).toBe(true);
  });

  it('detects all server-side OAuth configuration changes for invalidation', () => {
    expect(hasMCPOAuthRelevantServerConfigurationChanged(server, { ...server })).toBe(false);
    expect(
      hasMCPOAuthRelevantServerConfigurationChanged(server, {
        ...server,
        auth: { ...server.auth, oauth_mode: 'shared' },
      })
    ).toBe(true);

    const withoutPolicy: ServerBinding = {
      ...server,
      auth: { ...server.auth, oauth_dcr_mode: undefined },
    };
    expect(
      hasMCPOAuthRelevantServerConfigurationChanged(withoutPolicy, {
        ...withoutPolicy,
        auth: { ...withoutPolicy.auth, oauth_dcr_mode: 'disabled' },
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
