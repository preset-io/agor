/**
 * OAuth 2.1 Token Persistence
 *
 * PostgreSQL/SQLite token rows are the only daemon authority. The former
 * origin-only in-memory bearer cache was removed because it could return one
 * tenant/user/server grant to another lookup for the same MCP origin.
 */

import {
  type SaveTokenInput,
  type TenantScopeAwareDatabase,
  UserMCPOAuthTokenRepository,
} from '@agor/core/db';
import { assertMcpGrantSubjectEntitled } from '@agor/core/tools/mcp/grant-entitlement';
import type { OAuthTokenResponse } from '@agor/core/tools/mcp/oauth-mcp-transport';
import { resolveTokenExpiry } from '@agor/core/tools/mcp/oauth-token-expiry';
import type { MCPServerID, UserID } from '@agor/core/types';

// ============================================================================
// Database Token Storage
// ============================================================================

/**
 * Persist an OAuth token after a successful flow completion.
 *
 * Writes to `user_mcp_oauth_tokens` for BOTH modes:
 *   - per_user → row keyed by (userId, serverId)
 *   - shared   → row keyed by (NULL, serverId)
 *
 * Co-locates `client_id` / `client_secret` (from DCR or pre-registration) on
 * the token row. Refresh requires the exact credentials the grant was issued
 * under, and DCR clients otherwise only live in the daemon's in-memory cache,
 * which doesn't survive a restart.
 *
 * Shared by both the callback handler and the manual oauth-complete service.
 */
export async function persistOAuthToken(
  db: TenantScopeAwareDatabase,
  tokenResponse: Pick<OAuthTokenResponse, 'access_token' | 'expires_in' | 'refresh_token'>,
  pendingFlow: {
    mcpServerId?: string;
    userId?: string;
    oauthMode?: 'per_user' | 'shared';
    /** client_id used for the grant — needed later for refresh. */
    clientId?: string;
    /** client_secret used for the grant (absent for public clients). */
    clientSecret?: string;
    /**
     * Token endpoint discovered/used for this grant. Standalone SQLite grants
     * retain it on the grant row so later refreshes do not have to guess from
     * the MCP resource URL or mutate server configuration.
     */
    tokenEndpoint?: SaveTokenInput['tokenEndpoint'];
    /**
     * Client-authentication method the code exchange used. Persisted so the
     * refresh grant authenticates the same way the provider accepts.
     */
    tokenAuthMethod?: SaveTokenInput['tokenAuthMethod'];
    resourceUri?: SaveTokenInput['resourceUri'];
    grantBinding?: SaveTokenInput['grantBinding'];
  },
  logPrefix: string
): Promise<void> {
  // Walk the precedence cascade for the token TTL — see Phase 3.5 of
  // `context/explorations/mcp-oauth-token-lifecycle.md`. Replaces the prior
  // `tokenResponse.expires_in ?? 3600` defaulting that was asymmetric with
  // the refresh path and lied to the DB for providers like Notion that omit
  // `expires_in` entirely.
  const expiry = resolveTokenExpiry(tokenResponse, tokenResponse.access_token);

  if (!pendingFlow.mcpServerId) {
    return;
  }

  const oauthMode = pendingFlow.oauthMode || 'per_user';
  const userTokenRepo = new UserMCPOAuthTokenRepository(db);

  // Shared tokens use user_id=NULL in the same table as per-user tokens — see
  // migration 0038_mcp_oauth_token_refresh (sqlite) / 0027_ (postgres).
  const tokenUserId: UserID | null =
    oauthMode === 'per_user' && pendingFlow.userId ? (pendingFlow.userId as UserID) : null;

  if (oauthMode === 'per_user' && !pendingFlow.userId) {
    console.warn(
      `[${logPrefix}] per_user pending flow has no user binding; refusing implicit shared fallback`
    );
    throw new Error('Per-user OAuth flow is missing its user binding');
  }

  // The moment the grant becomes durable, and so the moment the subject's
  // standing has to hold. Enforced here rather than at the endpoints that reach
  // it: the OAuth callback is an unauthenticated browser redirect, and a check
  // on one endpoint's caller says nothing about the next endpoint, an aliased
  // import, or a wrapper. Everything that persists a grant this way arrives at
  // this line.
  //
  // The flow's initiator is the subject even for a `shared` grant, which keeps
  // the admin floor `oauth-start` applies. See `assertMcpGrantSubjectEntitled`
  // for the residual window between this check and the write.
  await assertMcpGrantSubjectEntitled({
    db,
    subjectUserId: pendingFlow.userId ?? null,
    oauthMode,
  });

  await userTokenRepo.saveToken(tokenUserId, pendingFlow.mcpServerId as MCPServerID, {
    accessToken: tokenResponse.access_token,
    expiresAt: expiry.expiresAt, // Date | null — null means "unknown"
    refreshToken: tokenResponse.refresh_token,
    clientId: pendingFlow.clientId,
    clientSecret: pendingFlow.clientSecret,
    tokenEndpoint: pendingFlow.tokenEndpoint,
    tokenAuthMethod: pendingFlow.tokenAuthMethod,
    resourceUri: pendingFlow.resourceUri,
    grantBinding: pendingFlow.grantBinding,
  });

  console.log(
    `[${logPrefix}] OAuth token persisted mode=${oauthMode} ` +
      `binding_version=${pendingFlow.grantBinding?.version ?? 'legacy_unbound'} expiry=${expiry.source}`
  );
}
