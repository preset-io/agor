import type { TenantScopeAwareDatabase, UserMCPOAuthToken } from '@agor/core/db';
import type { MCPServer, MCPServerID } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import {
  isMCPOAuthGrantAuthorizedForServer,
  isMCPOAuthGrantIdentityAuthorizedForServer,
} from './mcp-oauth-grant-authority.js';
import { fingerprintMCPOAuthGrantConfiguration } from './mcp-oauth-grant-binding.js';

const db = { run: () => undefined } as unknown as TenantScopeAwareDatabase;
const masterSecret = 'grant-authority-test-master-secret';
const server: MCPServer = {
  mcp_server_id: 'authority-server' as MCPServerID,
  name: 'authority-server',
  transport: 'http',
  scope: 'global',
  enabled: true,
  source: 'user',
  url: 'https://mcp.example.test',
  auth: { type: 'oauth', oauth_mode: 'per_user', oauth_compatibility_mode: 'strict' },
  created_at: new Date(0),
  updated_at: new Date(0),
};
const resolved = {
  resourceUri: server.url!,
  metadataUrl: 'https://mcp.example.test/.well-known/oauth-protected-resource',
  issuer: 'https://auth.example.test',
  authorizationEndpoint: 'https://auth.example.test/authorize',
  tokenEndpoint: 'https://auth.example.test/token',
  redirectUri: 'https://agor.example.test/mcp-servers/oauth-callback',
  clientId: 'client',
  compatibilityMode: 'strict' as const,
};

function grant(version: number | undefined): UserMCPOAuthToken {
  return {
    user_id: 'user-1' as never,
    mcp_server_id: server.mcp_server_id,
    oauth_access_token: 'access',
    oauth_client_id: resolved.clientId,
    oauth_metadata_uri: resolved.metadataUrl,
    oauth_resource_uri: resolved.resourceUri,
    oauth_issuer: resolved.issuer,
    oauth_authorization_endpoint: resolved.authorizationEndpoint,
    oauth_token_endpoint: resolved.tokenEndpoint,
    oauth_redirect_uri: resolved.redirectUri,
    grant_generation: version === undefined ? 0 : 1,
    grant_binding_version: version,
    grant_binding_fingerprint:
      version === 4
        ? fingerprintMCPOAuthGrantConfiguration(masterSecret, server, resolved, 4)
        : undefined,
    refresh_status: 'idle',
    refresh_generation: 0,
    refresh_success_generation: 0,
    created_at: new Date(0),
  };
}

describe('MCP OAuth grant authority', () => {
  it('grandfathers only an absent SQLite binding and accepts a valid current binding', async () => {
    const previous = process.env.AGOR_MASTER_SECRET;
    process.env.AGOR_MASTER_SECRET = masterSecret;
    try {
      await expect(isMCPOAuthGrantAuthorizedForServer(db, server, grant(undefined))).resolves.toBe(
        true
      );
      await expect(isMCPOAuthGrantAuthorizedForServer(db, server, grant(4))).resolves.toBe(true);
    } finally {
      if (previous === undefined) delete process.env.AGOR_MASTER_SECRET;
      else process.env.AGOR_MASTER_SECRET = previous;
    }
  });

  it.each([0, 5, Number.NaN])(
    'rejects unsupported non-null binding version %s',
    async (version) => {
      await expect(isMCPOAuthGrantAuthorizedForServer(db, server, grant(version))).resolves.toBe(
        false
      );
    }
  );

  it('rejects a grant subject inconsistent with the current OAuth mode', async () => {
    await expect(
      isMCPOAuthGrantAuthorizedForServer(db, server, { ...grant(undefined), user_id: null })
    ).resolves.toBe(false);
  });

  it('keeps credential identity authoritative while a server is disabled', async () => {
    const disabled = { ...server, enabled: false };
    await expect(
      isMCPOAuthGrantIdentityAuthorizedForServer(db, disabled, grant(undefined))
    ).resolves.toBe(true);
    await expect(isMCPOAuthGrantAuthorizedForServer(db, disabled, grant(undefined))).resolves.toBe(
      false
    );
  });

  it('accepts only the shared subject for shared OAuth mode', async () => {
    const shared = { ...server, auth: { ...server.auth!, oauth_mode: 'shared' as const } };
    await expect(
      isMCPOAuthGrantIdentityAuthorizedForServer(db, shared, {
        ...grant(undefined),
        user_id: null,
      })
    ).resolves.toBe(true);
    await expect(
      isMCPOAuthGrantIdentityAuthorizedForServer(db, shared, grant(undefined))
    ).resolves.toBe(false);
  });
});
