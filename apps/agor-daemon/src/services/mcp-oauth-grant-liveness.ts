/**
 * Is there a usable OAuth grant for this server, right now, for this user?
 *
 * One question with one answer, because four callers ask it and a drifting
 * copy would each fail differently: `agor_mcp_servers_auth_status` reports it
 * to an agent, the `oauth` widget's already-connected short-circuit decides
 * whether to render a Connect button at all, that widget's resolution decides
 * whether a browser's "I signed in" claim is true, and the gateway decides
 * whether to warn a Slack thread that a server will be unavailable. The third
 * of those is a security boundary — it is the only thing standing between a
 * POST and a widget resolving — so it must not be a looser reimplementation of
 * the read the others do.
 *
 * "Usable" is deliberately stricter than "a row exists". A grant that is
 * mid-refresh (`refreshing`), of unknown outcome (`ambiguous`), expired, or no
 * longer bound to the server's current OAuth configuration is not something an
 * agent's next turn can spend, so none of them count.
 *
 * Exactly one surface wants a looser answer, and it gets it from this same
 * read rather than from its own: the gateway's "not authenticated" warning
 * suppresses itself for a grant that is one JIT refresh away from usable,
 * because a spurious warning on a connection that will work is the costlier
 * error on a warning surface. That widening is `refreshable` below — a named
 * field on the one answer, not a second rule. Nothing that grants anything
 * reads it.
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

/**
 * Why the answer came out the way it did.
 *
 * Callers that merely gate on `live` ignore this. It exists because "no grant
 * at all" and "a refresh this daemon started is still in flight" are the same
 * verdict and completely different advice: telling the user who just finished
 * signing in to "finish the provider sign-in" is false.
 */
export type MCPOAuthGrantLivenessReason =
  /** A spendable grant. */
  | 'live'
  /** No server row, or it is disabled or no longer an OAuth server. */
  | 'server_unusable'
  /** No grant row for this lookup key. */
  | 'no_grant'
  /** A grant exists but no longer binds to the server's current configuration. */
  | 'unbound'
  /** `refresh_status` is `refreshing` or `ambiguous` — outcome not yet known. */
  | 'refreshing'
  /** Bound and idle, but `oauth_token_expires_at` has passed. */
  | 'expired';

export interface MCPOAuthGrantLiveness {
  /** True only when a grant exists, is idle, unexpired, and still bound. */
  live: boolean;
  /** Which of the rules decided. See {@link MCPOAuthGrantLivenessReason}. */
  reason: MCPOAuthGrantLivenessReason;
  /**
   * Not live now, but a bound grant with a refresh token of known outcome is
   * on file, so the inject hook's JIT refresh is expected to make it usable.
   *
   * ONLY the gateway's pre-prompt warning may act on this, and only to stay
   * quiet. It is never evidence that a sign-in completed: a refresh that has
   * not happened yet cannot resolve a widget, and treating it as a grant would
   * let a POST resolve against a credential nobody has re-obtained.
   */
  refreshable: boolean;
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
  const dead = (reason: MCPOAuthGrantLivenessReason): MCPOAuthGrantLiveness => ({
    live: false,
    reason,
    refreshable: false,
  });

  const server = await new MCPServerRepository(db).findById(serverId);
  if (!server?.enabled || server.auth?.type !== 'oauth') return dead('server_unusable');

  const grant = await new UserMCPOAuthTokenRepository(db).getToken(
    mcpOAuthGrantLookupUserId(server, credentialUserId),
    serverId as MCPServerID
  );
  if (!grant) return dead('no_grant');
  if (!(await isMCPOAuthGrantAuthorizedForServer(db, server, grant))) return dead('unbound');

  // Past this point the grant is real and still bound to this server, so a
  // refresh token on it is one the JIT refresh could actually spend. An
  // `ambiguous` row is excluded: nobody knows whether its refresh token was
  // already consumed.
  const refreshable = grant.refresh_status !== 'ambiguous' && !!grant.oauth_refresh_token;

  // A refresh in flight or of unknown outcome is not a credential the next
  // turn can spend, and neither is one that has already expired.
  if (grant.refresh_status !== 'idle') return { live: false, reason: 'refreshing', refreshable };
  if (grant.oauth_token_expires_at && grant.oauth_token_expires_at <= new Date()) {
    return { live: false, reason: 'expired', refreshable };
  }
  return {
    live: true,
    reason: 'live',
    refreshable: false,
    expiresAt: grant.oauth_token_expires_at,
  };
}
