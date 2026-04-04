import type { MCPServer } from '@agor/core/types';

/**
 * Determine if an MCP server needs authentication from the current user.
 *
 * Branches by oauth_mode:
 * - 'shared': only checks for a shared token on the server record
 * - 'per_user' (default): only checks per-user token status
 *
 * Non-OAuth servers always return false (no auth needed).
 */
export function mcpServerNeedsAuth(
  server: MCPServer | undefined,
  userAuthenticatedMcpServerIds: Set<string>
): boolean {
  if (!server || server.auth?.type !== 'oauth') return false;

  const oauthMode = server.auth.oauth_mode || 'per_user';

  if (oauthMode === 'shared') {
    return !server.auth.oauth_access_token;
  }

  // per_user mode: check the user's token set
  return !userAuthenticatedMcpServerIds.has(server.mcp_server_id);
}
