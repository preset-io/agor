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
    /**
     * `userId` may be null to target the shared-mode row for this server.
     * Unified token storage lives in `user_mcp_oauth_tokens` for both modes.
     */
    deleteToken(userId: string | null, serverId: string): Promise<boolean>;
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
    // 1. Delete the caller's per-user token row (if any).
    const deletedPerUser = await userTokenRepo.deleteToken(userId, mcpServerId);

    // 2. Also delete the shared-mode row (user_id = NULL) so the server is
    //    fully disconnected. Shared tokens no longer live on
    //    `mcp_servers.data.auth` — they moved to `user_mcp_oauth_tokens` in
    //    migration 0038/0027.
    let deletedShared = false;
    const server = await mcpServerRepo.findById(mcpServerId);
    if (server?.auth?.oauth_mode === 'shared') {
      deletedShared = await userTokenRepo.deleteToken(null, mcpServerId);
      if (deletedShared) {
        console.log('[OAuth Disconnect] Deleted shared-mode token row');
      }
    }

    // 3. Clear in-memory caches (daemon-level + core-level)
    if (server?.url) {
      try {
        const origin = new URL(server.url).origin;
        oauthTokenCache.delete(origin);
        console.log(`[OAuth Disconnect] Cleared daemon cache for origin: ${origin}`);
      } catch {
        // Invalid URL, skip cache clear
      }

      clearCoreTokenCache();
      console.log('[OAuth Disconnect] Cleared core OAuth token cache');
    }

    if (deletedPerUser || deletedShared) {
      console.log('[OAuth Disconnect] Token deleted successfully');
      return { success: true, message: 'OAuth connection removed' };
    } else {
      console.log('[OAuth Disconnect] No token found, caches cleared');
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
