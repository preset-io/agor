import type { MCPServer } from '@agor-live/client';

/**
 * Determine if an MCP server needs authentication from the current user.
 *
 * A server is considered authenticated if EITHER:
 * - It has a shared token (oauth_access_token) — works regardless of mode
 * - The current user has a per-user token
 *
 * This avoids a regression where servers with a shared token but no explicit
 * oauth_mode would be treated as unauthenticated.
 *
 * Non-OAuth servers always return false (no auth needed).
 */
export function mcpServerNeedsAuth(
  server: MCPServer | undefined,
  userAuthenticatedMcpServerIds: Set<string>
): boolean {
  if (!server || server.auth?.type !== 'oauth') return false;

  // A shared token always means the server is authenticated
  if (server.auth.oauth_access_token) return false;

  // For per_user mode (or unset mode), check the user's token set
  if (userAuthenticatedMcpServerIds.has(server.mcp_server_id)) return false;

  return true;
}
