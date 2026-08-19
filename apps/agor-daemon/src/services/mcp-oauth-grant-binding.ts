import { createHmac } from 'node:crypto';
import {
  executeRaw,
  sql,
  type TenantScopeAwareDatabase,
  type TenantScopedDatabase,
  type UserMCPOAuthToken,
} from '@agor/core/db';
import type {
  MCPAuth,
  MCPOAuthGrantBindingVersion,
  MCPServer,
  MCPServerID,
} from '@agor/core/types';
import { isMCPOAuthGrantBindingVersion } from '@agor/core/types';
import { resolveMCPOAuthCompatibilityMode } from './mcp-oauth-compatibility.js';

export const MCP_OAUTH_GRANT_BINDING_VERSION = 2 as const;

/**
 * Serialize an MCP server's OAuth configuration with grant creation and
 * replacement. This must be acquired inside the caller's PostgreSQL
 * transaction; transaction-scoped advisory locks are automatically released
 * on commit/rollback and work across independent daemon connection pools.
 */
export async function lockMCPOAuthGrantConfiguration(
  db: TenantScopeAwareDatabase | TenantScopedDatabase,
  tenantId: string,
  serverId: MCPServerID
): Promise<void> {
  await executeRaw(
    db,
    sql`SELECT pg_advisory_xact_lock(
      hashtextextended(${[tenantId, serverId, 'mcp-oauth-grant-config'].join('\u001f')}, 3)
    )`
  );
}

export interface MCPOAuthResolvedGrantBinding {
  resourceUri: string;
  metadataUrl: string;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  redirectUri: string;
  clientId: string;
  clientSecret?: string;
}

function authBinding(
  server: { source?: MCPServer['source']; auth?: MCPAuth },
  version: MCPOAuthGrantBindingVersion
): Record<string, unknown> {
  const auth = server.auth;
  return {
    type: auth?.type ?? 'none',
    mode: auth?.oauth_mode ?? 'per_user',
    compatibility: resolveMCPOAuthCompatibilityMode(server),
    // Preserve version 1 for existing grants and pending flows. New bindings
    // record the effective default so an explicit switch to disabled revokes a
    // DCR-created grant just like any other relevant policy change.
    dcr: auth?.oauth_dcr_mode ?? (version === 1 ? 'disabled' : 'advertised'),
    authorizationOverride: auth?.oauth_authorization_url ?? null,
    tokenOverride: auth?.oauth_token_url ?? null,
    configuredClientId: auth?.oauth_client_id ?? null,
    configuredClientSecret: auth?.oauth_client_secret ?? null,
    scope: auth?.oauth_scope ?? null,
    grantType: auth?.oauth_grant_type ?? null,
  };
}

/** HMAC prevents a fingerprint from becoming a client-secret guessing oracle. */
export function fingerprintMCPOAuthGrantConfiguration(
  masterSecret: string,
  server: Pick<
    MCPServer,
    'mcp_server_id' | 'transport' | 'url' | 'enabled' | 'source' | 'catalog_entry_name' | 'auth'
  >,
  resolved: MCPOAuthResolvedGrantBinding,
  version: MCPOAuthGrantBindingVersion = MCP_OAUTH_GRANT_BINDING_VERSION
): string {
  if (!masterSecret) throw new Error('MCP OAuth grant binding requires AGOR_MASTER_SECRET');
  const canonical = JSON.stringify({
    version,
    serverId: server.mcp_server_id,
    enabled: server.enabled,
    transport: server.transport,
    serverUrl: server.url ?? null,
    auth: authBinding(server, version),
    resolved,
  });
  return createHmac('sha256', masterSecret)
    .update(`agor:mcp-oauth:grant-configuration:v${version}\0`, 'utf8')
    .update(canonical, 'utf8')
    .digest('hex');
}

function relevantServerConfiguration(server: Partial<MCPServer> | null | undefined): string {
  if (!server) return '';
  return JSON.stringify({
    id: server.mcp_server_id as MCPServerID | undefined,
    enabled: server.enabled,
    transport: server.transport,
    url: server.url ?? null,
    auth: authBinding(server, MCP_OAUTH_GRANT_BINDING_VERSION),
  });
}

export function hasMCPOAuthRelevantServerConfigurationChanged(
  before: Partial<MCPServer> | null | undefined,
  after: Partial<MCPServer> | null | undefined
): boolean {
  return relevantServerConfiguration(before) !== relevantServerConfiguration(after);
}

/**
 * Recompute the binding before a durable grant is exposed or refreshed. This
 * is a defense-in-depth backstop for configuration mutations that did not pass
 * through the normal service invalidation hook.
 */
export function isMCPOAuthGrantBoundToServer(
  masterSecret: string,
  server: Pick<
    MCPServer,
    'mcp_server_id' | 'transport' | 'url' | 'enabled' | 'source' | 'catalog_entry_name' | 'auth'
  >,
  grant: UserMCPOAuthToken
): boolean {
  if (
    !isMCPOAuthGrantBindingVersion(grant.grant_binding_version) ||
    !grant.grant_binding_fingerprint ||
    !grant.oauth_metadata_uri ||
    !grant.oauth_resource_uri ||
    !grant.oauth_issuer ||
    !grant.oauth_authorization_endpoint ||
    !grant.oauth_token_endpoint ||
    !grant.oauth_redirect_uri ||
    !grant.oauth_client_id
  ) {
    return false;
  }
  try {
    return (
      fingerprintMCPOAuthGrantConfiguration(
        masterSecret,
        server,
        {
          resourceUri: grant.oauth_resource_uri,
          metadataUrl: grant.oauth_metadata_uri,
          issuer: grant.oauth_issuer,
          authorizationEndpoint: grant.oauth_authorization_endpoint,
          tokenEndpoint: grant.oauth_token_endpoint,
          redirectUri: grant.oauth_redirect_uri,
          clientId: grant.oauth_client_id,
          clientSecret: grant.oauth_client_secret,
        },
        grant.grant_binding_version
      ) === grant.grant_binding_fingerprint
    );
  } catch {
    return false;
  }
}
