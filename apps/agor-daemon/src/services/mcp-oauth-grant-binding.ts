import { createHmac } from 'node:crypto';
import {
  executeRaw,
  type MCPOAuthGrantAuthorityRecord,
  sql,
  type TenantScopeAwareDatabase,
  type TenantScopedDatabase,
} from '@agor/core/db';
import { canonicalMCPCustomHeaderEntries } from '@agor/core/tools/mcp/http-headers';
import type {
  MCPAuth,
  MCPOAuthGrantBindingVersion,
  MCPOAuthRuntimeCompatibilityMode,
  MCPServer,
  MCPServerID,
} from '@agor/core/types';
import { isMCPOAuthGrantBindingVersion } from '@agor/core/types';

/** Latest format; v4 binds the complete saved remote-server authority. */
export const MCP_OAUTH_GRANT_BINDING_VERSION = 4 as const;

/**
 * PostgreSQL requires binding for every row. Standalone keeps historical
 * unbound grants usable, while every newly issued versioned grant verifies.
 */
export function shouldVerifyMCPOAuthGrantBinding(requireAll: boolean, version: unknown): boolean {
  // Only a truly absent standalone/SQLite version is historical. Any present
  // but unsupported value (0, a future version, NaN/malformed storage) must
  // reach the verifier and fail closed rather than masquerade as unbound.
  return requireAll || (version !== null && version !== undefined);
}

export function grantBindingVersionForCompatibilityMode(
  _mode: MCPOAuthRuntimeCompatibilityMode
): MCPOAuthGrantBindingVersion {
  // Existing v1/v2 strict/legacy and v3 marketplace fingerprints remain
  // verifiable with their own stored version, so issuing v4 never forces
  // reauthorization. New grants bind headers and current catalog provenance
  // in addition to the v3 effective-policy envelope.
  return MCP_OAUTH_GRANT_BINDING_VERSION;
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
    ...(version >= 4
      ? {
          insecure: auth?.insecure ?? false,
          configuredAccessToken: auth?.oauth_access_token ?? null,
          configuredAccessTokenExpiresAt: auth?.oauth_token_expires_at ?? null,
          configuredRefreshToken: auth?.oauth_refresh_token ?? null,
        }
      : {}),
  };
}

/** HMAC prevents a fingerprint from becoming a client-secret guessing oracle. */
export function fingerprintMCPOAuthGrantConfiguration(
  masterSecret: string,
  server: Pick<
    MCPServer,
    | 'mcp_server_id'
    | 'transport'
    | 'url'
    | 'enabled'
    | 'source'
    | 'catalog_entry_name'
    | 'headers'
    | 'auth'
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
    ...(version >= 4
      ? {
          source: server.source,
          catalogEntryName: server.catalog_entry_name ?? null,
          headers: canonicalMCPCustomHeaderEntries(server.headers),
        }
      : {}),
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
    source: server.source ?? null,
    catalogEntryName: server.catalog_entry_name ?? null,
    headers: canonicalMCPCustomHeaderEntries(server.headers),
    // Mutation invalidation compares public row data. Current catalog policy
    // is independently re-resolved at start, callback, and grant-use time.
    auth: authBinding(server, 4, server.auth?.oauth_compatibility_mode ?? 'strict'),
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
    | 'mcp_server_id'
    | 'transport'
    | 'url'
    | 'enabled'
    | 'source'
    | 'catalog_entry_name'
    | 'headers'
    | 'auth'
  >,
  grant: MCPOAuthGrantAuthorityRecord,
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
