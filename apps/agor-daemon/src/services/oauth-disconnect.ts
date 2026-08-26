/**
 * OAuth disconnect logic extracted from daemon index.ts for testability.
 *
 * Handles deleting per-user and shared OAuth token rows.
 */

import { shortId } from '@agor/core/db';
import { sanitizeMCPExternalError } from '@agor/core/mcp';
import type { MCPAuth } from '@agor/core/types';

export interface OAuthDisconnectDeps {
  userId: string | undefined;
  mcpServerId: string;
  isAdmin: boolean;
  userTokenRepo: {
    /**
     * `userId` may be null to target the shared-mode row for this server.
     * Unified token storage lives in `user_mcp_oauth_tokens` for both modes.
     */
    deleteToken(userId: string | null, serverId: string): Promise<boolean>;
  };
  mcpServerRepo: {
    findById(id: string): Promise<{ url?: string; auth?: MCPAuth } | null>;
  };
}

export interface OAuthDisconnectResult {
  success: boolean;
  message?: string;
  error?: string;
  oauthMode?: 'per_user' | 'shared';
}

/**
 * Perform OAuth disconnect: delete DB token, clear caches, remove shared token.
 */
export async function performOAuthDisconnect(
  deps: OAuthDisconnectDeps
): Promise<OAuthDisconnectResult> {
  const { userId, mcpServerId, userTokenRepo, mcpServerRepo } = deps;

  if (!userId) {
    return { success: false, error: 'User not authenticated' };
  }

  if (!mcpServerId) {
    return { success: false, error: 'MCP server ID is required' };
  }

  console.log(
    `[OAuth Disconnect] Deleting token for user ${shortId(userId)}, server ${shortId(mcpServerId)}`
  );

  try {
    const server = await mcpServerRepo.findById(mcpServerId);
    if (server?.auth?.oauth_mode === 'shared') {
      if (!deps.isAdmin) {
        return {
          success: false,
          error: 'Shared OAuth grants can only be disconnected by an admin',
        };
      }
      await userTokenRepo.deleteToken(null, mcpServerId);
    } else {
      await userTokenRepo.deleteToken(userId, mcpServerId);
    }

    console.log('[OAuth Disconnect] Local grant row removed');
    return {
      success: true,
      message: 'OAuth connection removed locally; provider access was not revoked',
      oauthMode: server?.auth?.oauth_mode ?? 'per_user',
    };
  } catch (error) {
    const safe = sanitizeMCPExternalError(error, { stage: 'oauth' });
    console.error(
      `[OAuth Disconnect] event=mcp_external_failure category=${safe.category} type=${safe.diagnostic.type}`
    );
    return {
      success: false,
      error: 'OAuth connection could not be removed',
    };
  }
}
