import {
  isPostgresDatabaseHandle,
  type MCPOAuthGrantAuthorityRecord,
  MCPServerRepository,
  type TenantScopeAwareDatabase,
  type TenantScopedDatabase,
  type UserMCPOAuthToken,
  type UserMCPOAuthTokenRepository,
} from '@agor/core/db';
import type { MCPServer, MCPServerID, UserID } from '@agor/core/types';
import { resolveMCPOAuthCompatibilityPolicy } from './mcp-oauth-compatibility.js';
import {
  isMCPOAuthGrantBoundToServer,
  lockMCPOAuthGrantConfiguration,
  shouldVerifyMCPOAuthGrantBinding,
} from './mcp-oauth-grant-binding.js';

type GrantAuthorityDatabase = TenantScopeAwareDatabase | TenantScopedDatabase;

/**
 * Shared authoritative grant decision used by execution, status, refresh, and
 * gateway warning surfaces. Only an actually absent standalone binding is
 * grandfathered; any present unsupported version reaches the verifier and is
 * rejected.
 */
export async function isMCPOAuthGrantAuthorizedForServer(
  db: GrantAuthorityDatabase,
  server: MCPServer,
  grant: UserMCPOAuthToken
): Promise<boolean> {
  if (!server.enabled) return false;
  return isMCPOAuthGrantIdentityAuthorizedForServer(db, server, grant);
}

/**
 * Credential identity/binding authority independent of whether execution is
 * currently enabled. Marketplace uses this to describe a healthy saved grant
 * without turning a disabled server into a false revocation/reconnect prompt.
 */
export async function isMCPOAuthGrantIdentityAuthorizedForServer(
  db: GrantAuthorityDatabase,
  server: MCPServer,
  grant: MCPOAuthGrantAuthorityRecord
): Promise<boolean> {
  if (server.auth?.type !== 'oauth') return false;
  const mode = server.auth.oauth_mode ?? 'per_user';
  if ((mode === 'shared') !== (grant.user_id === null)) return false;

  if (
    !shouldVerifyMCPOAuthGrantBinding(isPostgresDatabaseHandle(db), grant.grant_binding_version)
  ) {
    return true;
  }
  return isMCPOAuthGrantBoundToServer(
    process.env.AGOR_MASTER_SECRET!,
    server,
    grant,
    (await resolveMCPOAuthCompatibilityPolicy(server)).mode
  );
}

/**
 * Resolve the caller's closed Marketplace authority projection with bounded
 * repository reads. The subject choice remains here beside the canonical
 * mode/binding check rather than being duplicated in the UI or overview SQL.
 */
export async function resolveMCPMarketplaceOAuthGrantAuthority(options: {
  db: GrantAuthorityDatabase;
  userId: UserID;
  serverIds: readonly MCPServerID[];
  serverRepository: MCPServerRepository;
  tokenRepository: UserMCPOAuthTokenRepository;
}): Promise<ReadonlyMap<MCPServerID, boolean>> {
  const authority = new Map<MCPServerID, boolean>();
  if (options.serverIds.length === 0) return authority;

  const [servers, grants] = await Promise.all([
    options.serverRepository.findOwnedByIds(options.userId, options.serverIds),
    options.tokenRepository.listAuthorityForUserAndSharedByServerIds(
      options.userId,
      options.serverIds
    ),
  ]);
  const grantsBySubject = new Map<string, MCPOAuthGrantAuthorityRecord>();
  for (const grant of grants) {
    grantsBySubject.set(`${grant.user_id ?? '<shared>'}\0${grant.mcp_server_id}`, grant);
  }

  // Verification stays inside this one bounded batch instead of creating an
  // unbounded per-row HMAC promise fanout on every overview refresh.
  for (const server of servers) {
    if (server.auth?.type !== 'oauth') continue;
    const subject = server.auth.oauth_mode === 'shared' ? '<shared>' : options.userId;
    const grant = grantsBySubject.get(`${subject}\0${server.mcp_server_id}`);
    authority.set(
      server.mcp_server_id,
      Boolean(
        grant && (await isMCPOAuthGrantIdentityAuthorizedForServer(options.db, server, grant))
      )
    );
  }
  return authority;
}

/** Re-read the saved row, optionally fencing a PostgreSQL refresh completion. */
export async function isCurrentMCPOAuthGrantAuthorized(options: {
  db: GrantAuthorityDatabase;
  serverId: MCPServerID;
  grant: UserMCPOAuthToken;
  tenantId?: string;
  lockConfiguration?: boolean;
}): Promise<boolean> {
  if (options.lockConfiguration && isPostgresDatabaseHandle(options.db)) {
    if (!options.tenantId) return false;
    await lockMCPOAuthGrantConfiguration(options.db, options.tenantId, options.serverId);
  }
  const server = await new MCPServerRepository(options.db).findById(options.serverId);
  return !!server && isMCPOAuthGrantAuthorizedForServer(options.db, server, options.grant);
}
