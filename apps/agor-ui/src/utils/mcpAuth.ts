import type { MCPServer } from '@agor-live/client';

/**
 * Determine if an MCP server needs authentication from the current user.
 *
 * OAuth authentication has one non-secret source of truth:
 * `userAuthenticatedMcpServerIds`, populated from the dedicated
 * `/mcp-servers/oauth-status` resource. Generic server reads deliberately do
 * not load per-user grants. Bootstrap, reconnect and explicit OAuth events
 * refresh this last-observed snapshot. It is not a live provider-health check
 * or execution authorization; execution resolves credentials independently.
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
