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
 * Every one of those callers wants the same, looser answer, and they all take
 * it from this read rather than from a copy: `mcpOAuthGrantIsConnected` below,
 * which is `live || refreshable`. That disjunction is precisely
 * `oauthGrantCanAuthenticate`, the rule `mcp-oauth-status.ts` applies to the
 * UI's auth badge, so one grant cannot read connected on the badge and
 * disconnected anywhere here. A grant whose access token has lapsed but whose
 * refresh token is bound and of known outcome is one the inject hook's JIT
 * refresh will spend before the executor ever sees it, so calling it
 * disconnected is the costly error: it warns a Slack thread about a connection
 * that works, tells an agent to offer a Connect button for a server that
 * works, and — until D4.1 was closed — actually rendered that button.
 *
 * The rule that survives is about what a surface DOES, not about which fields
 * it reads. A surface may be optimistic when it reports a connection, or when
 * it decides whether to offer or complete an attach-and-resume, because the
 * credential already exists and the worst case is a refresh that fails at call
 * time into the reactive recovery lane that exists for exactly that. Strict is
 * for issuing or sealing a credential — the callback exchange and the refresh
 * path — and none of this function's callers is one of those. The widget's
 * resolution gate looks like the exception and is not: it attaches an existing
 * grant's server to a session, the same action the mint short-circuit takes,
 * so it cannot correctly answer a stricter question than the mint gate asked.
 * What makes it a security boundary is WHOSE grant it reads and that it reads
 * one at all (D3) — never how recently that grant's access token was minted.
 *
 * `live` and `refreshable` stay separate fields because the rules that produce
 * them are separate and `reason` has to tell them apart for copy. No caller
 * should gate on `live` alone. See
 * `docs/internal/slack-mcp-oauth-connect-2026-09-16.md` (D4, D4.1).
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
 * Callers that merely gate on the verdict ignore this. It exists because "no grant
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
   * Read through {@link mcpOAuthGrantIsConnected} rather than on its own. It
   * is not evidence that a sign-in just happened; it says a credential is on
   * file and expected to work, which is the question every caller here asks.
   * What it must never become is evidence for issuing or sealing a token —
   * nothing in this module's call graph does that.
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
 * The one question every caller of this module actually asks: is a credential
 * on file that this user's next turn can spend?
 *
 * A single named predicate rather than `live || refreshable` written out at
 * six call sites, because the defect this lane keeps producing is two surfaces
 * answering the same question differently — the agent reading "connected"
 * while a card offers to connect, or a card offering a finish the resolver
 * refuses. Divergence now requires editing this function, which a test can
 * see.
 */
export function mcpOAuthGrantIsConnected(liveness: MCPOAuthGrantLiveness): boolean {
  return liveness.live || liveness.refreshable;
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
