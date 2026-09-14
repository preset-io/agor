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
  shouldVerifyMCPOAuthGrantBinding,
} from './mcp-oauth-grant-binding.js';

const masterSecret = 'test-master-secret-that-is-not-a-provider-secret';

type ServerBinding = Pick<
  MCPServer,
  | 'mcp_server_id'
  | 'enabled'
  | 'transport'
  | 'url'
  | 'source'
  | 'catalog_entry_name'
  | 'headers'
  | 'auth'
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
  version: UserMCPOAuthToken['grant_binding_version'] = MCP_OAUTH_GRANT_BINDING_VERSION
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
  it('grandfathers only historical standalone unbound grants', () => {
    expect(shouldVerifyMCPOAuthGrantBinding(false, undefined)).toBe(false);
    expect(shouldVerifyMCPOAuthGrantBinding(false, null)).toBe(false);
    expect(shouldVerifyMCPOAuthGrantBinding(false, 0)).toBe(true);
    expect(shouldVerifyMCPOAuthGrantBinding(false, 4)).toBe(true);
    expect(shouldVerifyMCPOAuthGrantBinding(false, 5)).toBe(true);
    expect(shouldVerifyMCPOAuthGrantBinding(false, Number.NaN)).toBe(true);
    expect(shouldVerifyMCPOAuthGrantBinding(false, 'malformed')).toBe(true);
    expect(shouldVerifyMCPOAuthGrantBinding(true, undefined)).toBe(true);

    const fingerprint = fingerprintMCPOAuthGrantConfiguration(masterSecret, server, resolved);
    for (const version of [0, 5, Number.NaN]) {
      expect(
        isMCPOAuthGrantBoundToServer(masterSecret, server, tokenFor(fingerprint, version), 'strict')
      ).toBe(false);
    }
  });

  it('uses one case-insensitive header representation for wire, mutation, and binding', () => {
    const ordered = { ...server, headers: { 'X-Route': 'a', 'X-Tenant': 'b' } };
    const reorderedAndRecased = {
      ...server,
      headers: { 'x-tenant': 'b', 'x-route': 'a' },
    };
    expect(fingerprintMCPOAuthGrantConfiguration(masterSecret, ordered, resolved)).toBe(
      fingerprintMCPOAuthGrantConfiguration(masterSecret, reorderedAndRecased, resolved)
    );
    expect(hasMCPOAuthRelevantServerConfigurationChanged(ordered, reorderedAndRecased)).toBe(false);

    const duplicate = { ...server, headers: { 'X-Route': 'a', 'x-route': 'b' } };
    expect(() => fingerprintMCPOAuthGrantConfiguration(masterSecret, duplicate, resolved)).toThrow(
      /Duplicate custom HTTP header names/
    );
    expect(() => hasMCPOAuthRelevantServerConfigurationChanged(server, duplicate)).toThrow(
      /Duplicate custom HTTP header names/
    );
  });
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
    expect(grantBindingVersionForCompatibilityMode('strict')).toBe(4);
    expect(grantBindingVersionForCompatibilityMode('legacy')).toBe(4);
    expect(grantBindingVersionForCompatibilityMode('marketplace')).toBe(4);
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
    const marketplaceV3Fingerprint = fingerprintMCPOAuthGrantConfiguration(
      masterSecret,
      catalogDefault,
      marketplaceResolved,
      3
    );
    expect(
      isMCPOAuthGrantBoundToServer(
        masterSecret,
        catalogDefault,
        tokenFor(marketplaceV3Fingerprint, 3),
        'marketplace'
      )
    ).toBe(true);
    expect(
      isMCPOAuthGrantBoundToServer(
        masterSecret,
        catalogDefault,
        tokenFor(marketplaceV3Fingerprint, 3),
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
      ['custom headers', { ...server, headers: { 'X-Resource': 'other' } }, resolved],
      ['catalog provenance', { ...server, source: 'catalog' }, resolved],
      ['insecure auth', { ...server, auth: { ...server.auth, insecure: true } }, resolved],
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
    expect(MCP_OAUTH_GRANT_BINDING_VERSION).toBe(4);
  });

  it('treats disabling a server as an OAuth grant-invalidating configuration change', () => {
    expect(
      hasMCPOAuthRelevantServerConfigurationChanged(server, { ...server, enabled: false })
    ).toBe(true);
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
    expect(
      hasMCPOAuthRelevantServerConfigurationChanged(server, {
        ...server,
        headers: { 'X-Resource': 'changed' },
      })
    ).toBe(true);
    expect(
      hasMCPOAuthRelevantServerConfigurationChanged(server, {
        ...server,
        source: 'catalog',
        catalog_entry_name: 'com.example/provider',
      })
    ).toBe(true);
  });
});
