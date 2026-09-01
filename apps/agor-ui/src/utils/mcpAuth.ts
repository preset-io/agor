import type { MCPServer } from '@agor-live/client';

/**
 * Determine if an MCP server needs authentication from the current user.
 *
 * OAuth authentication has one non-secret source of truth:
 * `userAuthenticatedMcpServerIds`, populated from the dedicated
 * `/mcp-servers/oauth-status` resource. Generic server reads deliberately do
 * not load per-user grants. Realtime OAuth events and a periodic status poll
 * refresh the Set so an expired or invalid grant is removed without exposing
 * its token or expiry through the ordinary server resource.
 *
 * Bearer/JWT rows can intentionally remain saved after an explicit secret
 * clear. Their redacted sentinel counts as a configured saved value; absence
 * means the server needs configuration before it can be dispatched.
 */
export function mcpServerNeedsAuth(
  server: MCPServer | undefined,
  userAuthenticatedMcpServerIds: Set<string>
): boolean {
  if (!server?.auth || server.auth.type === 'none') return false;
  if (server.auth.type === 'bearer') return !server.auth.token?.trim();
  if (server.auth.type === 'jwt') {
    return !(
      server.auth.api_url?.trim() &&
      server.auth.api_token?.trim() &&
      server.auth.api_secret?.trim()
    );
  }
  if (server.auth.type !== 'oauth') return false;

  return !userAuthenticatedMcpServerIds.has(server.mcp_server_id);
}
