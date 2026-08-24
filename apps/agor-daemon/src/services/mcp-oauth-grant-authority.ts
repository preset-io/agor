import {
  isPostgresDatabaseHandle,
  MCPServerRepository,
  type TenantScopeAwareDatabase,
  type TenantScopedDatabase,
  type UserMCPOAuthToken,
} from '@agor/core/db';
import type { MCPServer, MCPServerID } from '@agor/core/types';
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
  if (!server.enabled || server.auth?.type !== 'oauth') return false;
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
