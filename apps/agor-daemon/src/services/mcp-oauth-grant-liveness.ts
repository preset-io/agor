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
 * Two surfaces want a looser answer, and both take it from this same read
 * rather than from their own. The gateway's "not authenticated" warning
 * suppresses itself for a grant that is one JIT refresh away from usable,
 * because a spurious warning on a connection that will work is the costlier
 * error on a warning surface. `agor_mcp_servers_auth_status` reports that same
 * grant as authenticated, because its `oauth_authenticated: false` is exactly
 * what tells an agent to offer a Connect button, and offering one for a server
 * the next refresh will make work is the same costly error. It is also the
 * rule `mcp-oauth-status.ts` applies to the UI's auth badge, through
 * `oauthGrantCanAuthenticate`; badge and agent must not disagree about one
 * grant.
 *
 * That widening is `refreshable` below — a named field on the one answer, not
 * a second rule. `live || refreshable` is precisely
 * `oauthGrantCanAuthenticate`. No surface that *grants* anything reads it: the
 * `oauth` widget's mint short-circuit and its resolution gate both still
 * require `live`.
 *
 * Which leaves one known residual disagreement, in exactly one state: a bound,
 * expired, still-refreshable grant, which the agent-facing read now calls
 * authenticated while the mint short-circuit would still render a Connect
 * button for it. Closing that means widening the short-circuit, which is a
 * change to a gate and belongs in its own reviewed commit with its own test.
 * See `docs/internal/slack-mcp-oauth-connect-2026-09-16.md`.
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
   * Only the two *reporting* surfaces may act on this: the gateway's
   * pre-prompt warning, to stay quiet, and `agor_mcp_servers_auth_status`, to
   * answer `oauth_authenticated`. Neither grants anything. It is never
   * evidence that a sign-in completed — a refresh that has not happened yet
   * cannot resolve a widget, and treating it as a grant would let a POST
   * resolve against a credential nobody has re-obtained.
   */
  refreshable: boolean;
  /**
   * The grant's stored `oauth_token_expires_at`, when it has one.
   *
   * Present whenever a grant row was found, including one that is not `live`:
   * a `refreshable` grant's expiry is already in the past, and the agent-facing
   * status surface reports it as-is rather than hiding it. Absent for a
   * non-expiring grant, and for every verdict reached without a grant row.
   */
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

  // Carried on every verdict from here down, not just the live one: a caller
  // that reports a `refreshable` grant as authenticated still wants to say
  // when the access token lapsed.
  const expiresAt = grant.oauth_token_expires_at ?? undefined;

  // A refresh in flight or of unknown outcome is not a credential the next
  // turn can spend, and neither is one that has already expired.
  if (grant.refresh_status !== 'idle') {
    return { live: false, reason: 'refreshing', refreshable, expiresAt };
  }
  if (grant.oauth_token_expires_at && grant.oauth_token_expires_at <= new Date()) {
    return { live: false, reason: 'expired', refreshable, expiresAt };
  }
  return { live: true, reason: 'live', refreshable: false, expiresAt };
}
