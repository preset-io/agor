/**
 * OAuth 2.1 Token Cache
 *
 * Daemon-level token cache shared between test-oauth and discover endpoints.
 * Tokens are also persisted to the database for cross-process access.
 */

import { MCPServerRepository, UserMCPOAuthTokenRepository } from '@agor/core/db';
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
 * Save OAuth 2.1 token to the database for a specific MCP server.
 * Allows tokens to persist across daemon restarts and be used by other processes.
 */
export async function saveOAuth21TokenToDB(
  mcpServerRepo: MCPServerRepository,
  serverId: string,
  token: string,
  expiresInSeconds: number,
  refreshToken?: string
): Promise<void> {
  const expiresAt = Date.now() + (expiresInSeconds - 60) * 1000; // 60s buffer
  const server = await mcpServerRepo.findById(serverId);
  if (!server) {
    console.log(`[OAuth 2.1 DB] Server ${serverId} not found, skipping token save`);
    return;
  }

  const currentAuth = server.auth || { type: 'oauth' as const };

  await mcpServerRepo.update(serverId, {
    auth: {
      ...currentAuth,
      type: 'oauth',
      oauth_access_token: token,
      oauth_token_expires_at: expiresAt,
      ...(refreshToken ? { oauth_refresh_token: refreshToken } : {}),
    },
  });
  console.log(
    `[OAuth 2.1 DB] Token saved for server ${serverId}, expires at ${new Date(expiresAt).toISOString()}${refreshToken ? ', with refresh token' : ''}`
  );
}

/**
 * Get OAuth 2.1 token from database for a specific MCP server.
 */
export async function getOAuth21TokenFromDB(
  mcpServerRepo: MCPServerRepository,
  serverId: string
): Promise<string | undefined> {
  const server = await mcpServerRepo.findById(serverId);
  if (!server) {
    console.log(`[OAuth 2.1 DB] Server ${serverId} not found`);
    return undefined;
  }

  const auth = server.auth;
  if (!auth || auth.type !== 'oauth') {
    console.log(`[OAuth 2.1 DB] Server ${serverId} is not OAuth type`);
    return undefined;
  }

  const token = auth.oauth_access_token;
  const expiresAt = auth.oauth_token_expires_at;

  if (!token) {
    console.log(`[OAuth 2.1 DB] No token stored for server ${serverId}`);
    return undefined;
  }

  if (expiresAt && expiresAt <= Date.now()) {
    console.log(`[OAuth 2.1 DB] Token expired for server ${serverId}`);
    return undefined;
  }

  console.log(`[OAuth 2.1 DB] Found valid token for server ${serverId}`);
  return token;
}

/**
 * Get OAuth 2.1 token from database by MCP URL (searches all servers).
 */
export async function getOAuth21TokenFromDBByUrl(
  mcpServerRepo: MCPServerRepository,
  mcpUrl: string
): Promise<{ token: string; serverId: string } | undefined> {
  const servers = await mcpServerRepo.findAll();
  const targetOrigin = new URL(mcpUrl).origin;

  for (const server of servers) {
    const serverUrl = server.url;
    if (!serverUrl) continue;

    try {
      const serverOrigin = new URL(serverUrl).origin;
      if (serverOrigin === targetOrigin) {
        const token = await getOAuth21TokenFromDB(mcpServerRepo, server.mcp_server_id);
        if (token) {
          return { token, serverId: server.mcp_server_id };
        }
      }
    } catch {
      // Invalid URL, skip
    }
  }

  console.log(`[OAuth 2.1 DB] No valid token found for URL ${mcpUrl}`);
  return undefined;
}

/**
 * Cache + persist an OAuth token after a successful flow completion.
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
  },
  logPrefix: string
): Promise<void> {
  const expiresIn = tokenResponse.expires_in ?? 3600;

  // Cache the token at daemon level
  cacheOAuth21Token(cacheKey, tokenResponse.access_token, expiresIn);

  // Save to database based on OAuth mode
  if (pendingFlow.mcpServerId) {
    const oauthMode = pendingFlow.oauthMode || 'per_user';

    if (oauthMode === 'per_user' && pendingFlow.userId) {
      const userTokenRepo = new UserMCPOAuthTokenRepository(db);
      await userTokenRepo.saveToken(
        pendingFlow.userId as UserID,
        pendingFlow.mcpServerId as MCPServerID,
        tokenResponse.access_token,
        expiresIn,
        tokenResponse.refresh_token
      );
      console.log(
        `[${logPrefix}] Per-user token saved for user ${pendingFlow.userId}, server ${pendingFlow.mcpServerId}`
      );
    } else {
      const mcpServerRepo = new MCPServerRepository(db);
      await saveOAuth21TokenToDB(
        mcpServerRepo,
        pendingFlow.mcpServerId,
        tokenResponse.access_token,
        expiresIn,
        tokenResponse.refresh_token
      );
      console.log(`[${logPrefix}] Shared token saved for server ${pendingFlow.mcpServerId}`);
    }
  }
}
