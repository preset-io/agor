/**
 * Is there a usable OAuth grant for this server, right now, for this user?
 *
 * One question with one answer, because three callers ask it and a drifting
 * copy would each fail differently: `agor_mcp_servers_auth_status` reports it
 * to an agent, the `oauth` widget's already-connected short-circuit decides
 * whether to render a Connect button at all, and that widget's resolution
 * decides whether a browser's "I signed in" claim is true. The last of those
 * is a security boundary — it is the only thing standing between a POST and a
 * widget resolving — so it must not be a looser reimplementation of the read
 * the other two do.
 *
 * "Usable" is deliberately stricter than "a row exists". A grant that is
 * mid-refresh (`refreshing`), of unknown outcome (`ambiguous`), expired, or no
 * longer bound to the server's current OAuth configuration is not something an
 * agent's next turn can spend, so none of them count.
 *
 * The lookup key is the *credential* user, never the Session owner: shared-mode
 * servers key on `null`, per-user servers on whoever is actually prompting. See
 * `context/explorations/session-sharing.md`.
 */

import {
  MCPServerRepository,
  type TenantScopeAwareDatabase,
  type TenantScopedDatabase,
  UserMCPOAuthTokenRepository,
} from '@agor/core/db';
import type { MCPServer, MCPServerID, UserID } from '@agor/core/types';
import { isMCPOAuthGrantAuthorizedForServer } from './mcp-oauth-grant-authority.js';

/** Either tenant-scoped database handle the callers already hold. */
type GrantLivenessDatabase = TenantScopeAwareDatabase | TenantScopedDatabase;

export interface MCPOAuthGrantLiveness {
  /** True only when a grant exists, is idle, unexpired, and still bound. */
  live: boolean;
  /** Expiry of the live grant, when it has one. Absent for non-expiring grants. */
  expiresAt?: Date;
}

/**
 * The stored user key for a server's OAuth mode.
 *
 * Shared rows live under `user_id = NULL` (migration 0038 sqlite / 0027
 * postgres); per-user rows under the credential user. Getting this backwards
 * silently reads the wrong grant, so it is derived in one place.
 */
export function mcpOAuthGrantLookupUserId(
  server: Pick<MCPServer, 'auth'>,
  credentialUserId: UserID
): UserID | null {
  return (server.auth?.oauth_mode ?? 'per_user') === 'shared' ? null : credentialUserId;
}

/**
 * Whether `credentialUserId` currently holds a spendable grant for `serverId`.
 *
 * Re-reads the server row from the database rather than trusting the one the
 * caller holds: MCP service responses have already been through token
 * injection and secret redaction, and binding authority has to come from the
 * stored row. A disabled server, or one that is no longer `auth.type ===
 * 'oauth'`, is never live.
 */
export async function resolveMCPOAuthGrantLiveness(
  db: GrantLivenessDatabase,
  serverId: MCPServerID | string,
  credentialUserId: UserID
): Promise<MCPOAuthGrantLiveness> {
  const server = await new MCPServerRepository(db).findById(serverId);
  if (!server?.enabled || server.auth?.type !== 'oauth') return { live: false };

  const grant = await new UserMCPOAuthTokenRepository(db).getToken(
    mcpOAuthGrantLookupUserId(server, credentialUserId),
    serverId as MCPServerID
  );
  if (!grant) return { live: false };
  if (!(await isMCPOAuthGrantAuthorizedForServer(db, server, grant))) return { live: false };

  // A refresh in flight or of unknown outcome is not a credential the next
  // turn can spend, and neither is one that has already expired.
  if (grant.refresh_status !== 'idle') return { live: false };
  if (grant.oauth_token_expires_at && grant.oauth_token_expires_at <= new Date()) {
    return { live: false };
  }
  return { live: true, expiresAt: grant.oauth_token_expires_at };
}
