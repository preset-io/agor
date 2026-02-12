/**
 * OAuth disconnect logic extracted from daemon index.ts for testability.
 *
 * Handles deleting per-user OAuth tokens, clearing in-memory caches,
 * and removing shared OAuth tokens from server config.
 */

import type { MCPAuth } from '@agor/core/types';

export interface OAuthDisconnectDeps {
  userId: string | undefined;
  mcpServerId: string;
  userTokenRepo: {
    deleteToken(userId: string, serverId: string): Promise<boolean>;
  };
  mcpServerRepo: {
    findById(id: string): Promise<{ url?: string; auth?: MCPAuth } | null>;
    update(id: string, data: { auth: MCPAuth }): Promise<unknown>;
  };
  oauthTokenCache: Map<string, unknown>;
  clearCoreTokenCache: () => void;
}

export interface OAuthDisconnectResult {
  success: boolean;
  message?: string;
  error?: string;
}

/**
 * Perform OAuth disconnect: delete DB token, clear caches, remove shared token.
 */
export async function performOAuthDisconnect(
  deps: OAuthDisconnectDeps
): Promise<OAuthDisconnectResult> {
  const {
    userId,
    mcpServerId,
    userTokenRepo,
    mcpServerRepo,
    oauthTokenCache,
    clearCoreTokenCache,
  } = deps;

  if (!userId) {
    return { success: false, error: 'User not authenticated' };
  }

  if (!mcpServerId) {
    return { success: false, error: 'MCP server ID is required' };
  }

  console.log(
    `[OAuth Disconnect] Deleting token for user ${userId.substring(0, 8)}, server ${mcpServerId.substring(0, 8)}`
  );

  try {
    // 1. Delete per-user token from database
    const deleted = await userTokenRepo.deleteToken(userId, mcpServerId);

    // 2. Clear in-memory caches (daemon-level + core-level)
    const server = await mcpServerRepo.findById(mcpServerId);
    if (server?.url) {
      // Clear daemon-level cache by origin
      try {
        const origin = new URL(server.url).origin;
        oauthTokenCache.delete(origin);
        console.log(`[OAuth Disconnect] Cleared daemon cache for origin: ${origin}`);
      } catch {
        // Invalid URL, skip cache clear
      }

      // Clear core-level authCodeTokenCache
      clearCoreTokenCache();
      console.log('[OAuth Disconnect] Cleared core OAuth token cache');
    }

    // 3. Clear oauth_access_token from server's auth config (shared mode token)
    if (server?.auth?.oauth_access_token) {
      await mcpServerRepo.update(mcpServerId, {
        auth: {
          ...server.auth,
          oauth_access_token: undefined,
          oauth_token_expires_at: undefined,
        },
      });
      console.log('[OAuth Disconnect] Cleared shared OAuth token from server config');
    }

    if (deleted) {
      console.log('[OAuth Disconnect] Token deleted successfully');
      return { success: true, message: 'OAuth connection removed' };
    } else {
      console.log('[OAuth Disconnect] No per-user token found, caches cleared');
      return { success: true, message: 'OAuth connection removed' };
    }
  } catch (error) {
    console.error('[OAuth Disconnect] Error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
