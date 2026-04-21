/**
 * OAuth 2.1 Token Cache
 *
 * Daemon-level token cache shared between test-oauth and discover endpoints.
 * Tokens are also persisted to the database for cross-process access.
 */

import { UserMCPOAuthTokenRepository } from '@agor/core/db';
import type { MCPServerID, UserID } from '@agor/core/types';

// ============================================================================
// In-memory OAuth 2.1 Token Cache
// ============================================================================

interface CachedOAuth21Token {
  token: string;
  expiresAt: number;
  mcpOrigin: string;
}

const oauth21TokenCache = new Map<string, CachedOAuth21Token>();

export function cacheOAuth21Token(mcpUrl: string, token: string, expiresInSeconds: number): void {
  const origin = new URL(mcpUrl).origin;
  const expiresAt = Date.now() + (expiresInSeconds - 60) * 1000; // 60s buffer
  oauth21TokenCache.set(origin, { token, expiresAt, mcpOrigin: origin });
  console.log(`[OAuth 2.1 Cache] Token cached for ${origin}, expires in ${expiresInSeconds}s`);
}

export function getOAuth21Token(mcpUrl: string): string | undefined {
  const origin = new URL(mcpUrl).origin;
  const cached = oauth21TokenCache.get(origin);
  if (!cached) {
    console.log(`[OAuth 2.1 Cache] No token found for ${origin}`);
    return undefined;
  }
  if (cached.expiresAt <= Date.now()) {
    console.log(`[OAuth 2.1 Cache] Token expired for ${origin}`);
    oauth21TokenCache.delete(origin);
    return undefined;
  }
  console.log(`[OAuth 2.1 Cache] Found valid token for ${origin}`);
  return cached.token;
}

export function clearOAuth21Token(mcpUrl: string): void {
  const origin = new URL(mcpUrl).origin;
  oauth21TokenCache.delete(origin);
  console.log(`[OAuth 2.1 Cache] Token cleared for ${origin}`);
}

/** Expose the raw cache map (needed by oauth-disconnect service) */
export { oauth21TokenCache };

// ============================================================================
// Database Token Storage
// ============================================================================

/**
 * Cache + persist an OAuth token after a successful flow completion.
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
  // biome-ignore lint/suspicious/noExplicitAny: db type is complex (Drizzle instance), callers always pass the correct value
  db: any,
  tokenResponse: { access_token: string; expires_in?: number; refresh_token?: string },
  cacheKey: string,
  pendingFlow: {
    mcpServerId?: string;
    userId?: string;
    oauthMode?: 'per_user' | 'shared';
    /** client_id used for the grant — needed later for refresh. */
    clientId?: string;
    /** client_secret used for the grant (absent for public clients). */
    clientSecret?: string;
  },
  logPrefix: string
): Promise<void> {
  const expiresIn = tokenResponse.expires_in ?? 3600;

  // Cache the token at daemon level
  cacheOAuth21Token(cacheKey, tokenResponse.access_token, expiresIn);

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
      `[${logPrefix}] per_user mode but no userId on pending flow — falling back to shared-mode row for server ${pendingFlow.mcpServerId}`
    );
  }

  await userTokenRepo.saveToken(tokenUserId, pendingFlow.mcpServerId as MCPServerID, {
    accessToken: tokenResponse.access_token,
    expiresInSeconds: expiresIn,
    refreshToken: tokenResponse.refresh_token,
    clientId: pendingFlow.clientId,
    clientSecret: pendingFlow.clientSecret,
  });

  console.log(
    `[${logPrefix}] ${oauthMode === 'per_user' ? 'Per-user' : 'Shared'} token saved ` +
      `for user=${tokenUserId ?? '<shared>'} server=${pendingFlow.mcpServerId}` +
      `${pendingFlow.clientId ? ' (with DCR client creds)' : ''}`
  );
}
