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
     * Token endpoint discovered/used for this grant. Persisted back onto the
     * server config when it was previously blank so later refreshes do not
     * have to guess from the MCP resource URL.
     */
    tokenEndpoint?: SaveTokenInput['tokenEndpoint'];
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

  await userTokenRepo.saveToken(tokenUserId, pendingFlow.mcpServerId as MCPServerID, {
    accessToken: tokenResponse.access_token,
    expiresAt: expiry.expiresAt, // Date | null — null means "unknown"
    refreshToken: tokenResponse.refresh_token,
    clientId: pendingFlow.clientId,
    clientSecret: pendingFlow.clientSecret,
    tokenEndpoint: pendingFlow.tokenEndpoint,
    resourceUri: pendingFlow.resourceUri,
    grantBinding: pendingFlow.grantBinding,
  });

  console.log(`[${logPrefix}] OAuth token persisted mode=${oauthMode} expiry=${expiry.source}`);
}
