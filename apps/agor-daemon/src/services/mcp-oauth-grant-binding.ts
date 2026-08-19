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
  MCPOAuthRuntimeCompatibilityMode,
  MCPServer,
  MCPServerID,
} from '@agor/core/types';
import { isMCPOAuthGrantBindingVersion } from '@agor/core/types';

/** Latest format; only the derived marketplace policy needs the v3 envelope. */
export const MCP_OAUTH_GRANT_BINDING_VERSION = 3 as const;

export function grantBindingVersionForCompatibilityMode(
  mode: MCPOAuthRuntimeCompatibilityMode
): MCPOAuthGrantBindingVersion {
  // Keeping strict/legacy on v2 preserves every historically valid fingerprint.
  // New marketplace grants use v3 so their derived policy is explicit in the
  // envelope. A #2377-era v2 marketplace HMAC can still be verified below;
  // pre-marketplace v2 strict HMACs cannot silently cross the policy change.
  return mode === 'marketplace' ? 3 : 2;
}

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
  /** Exact runtime policy used to produce this authorization grant. */
  compatibilityMode: MCPOAuthRuntimeCompatibilityMode;
}

function authBinding(
  server: { auth?: MCPAuth },
  version: MCPOAuthGrantBindingVersion,
  effectiveMode: MCPOAuthRuntimeCompatibilityMode
): Record<string, unknown> {
  const auth = server.auth;
  return {
    type: auth?.type ?? 'none',
    mode: auth?.oauth_mode ?? 'per_user',
    // Version 1 predates derived marketplace policy. Version 2 was emitted by
    // both the pre-marketplace strict implementation and the merged #2377
    // implementation; the HMAC itself disambiguates those values. Version 3
    // additionally records the effective mode in `resolved` for auditability.
    compatibility: version >= 2 ? effectiveMode : (auth?.oauth_compatibility_mode ?? 'strict'),
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
  version: MCPOAuthGrantBindingVersion = grantBindingVersionForCompatibilityMode(
    resolved.compatibilityMode
  )
): string {
  if (!masterSecret) throw new Error('MCP OAuth grant binding requires AGOR_MASTER_SECRET');
  const { compatibilityMode, ...historicalResolved } = resolved;
  const canonical = JSON.stringify({
    version,
    serverId: server.mcp_server_id,
    enabled: server.enabled,
    transport: server.transport,
    serverUrl: server.url ?? null,
    auth: authBinding(server, version, compatibilityMode),
    resolved: version >= 3 ? resolved : historicalResolved,
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
    // Mutation invalidation compares public row data, not a catalog-derived
    // policy. Catalog policy changes are caught by v3 fingerprint checks.
    auth: authBinding(server, 2, server.auth?.oauth_compatibility_mode ?? 'strict'),
    configuredCompatibility: server.auth?.oauth_compatibility_mode ?? null,
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
  grant: UserMCPOAuthToken,
  effectiveMode: MCPOAuthRuntimeCompatibilityMode
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
          compatibilityMode: effectiveMode,
        },
        grant.grant_binding_version
      ) === grant.grant_binding_fingerprint
    );
  } catch {
    return false;
  }
}
