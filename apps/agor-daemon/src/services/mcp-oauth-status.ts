/**
 * Which MCP servers a caller already holds a usable OAuth grant for.
 *
 * The answer drives an auth badge in the UI, so it is a read of durable state
 * rather than of whatever a realtime hint last said: a grant is advertised only
 * if it has not expired, is not mid-refresh in an ambiguous state, and still
 * binds to the server it was issued against. Historical standalone grants
 * predate binding and are intentionally grandfathered; newly issued SQLite
 * grants carry the same versioned configuration envelope.
 *
 * Grants come from two places and only one of them is the caller's. Shared
 * grants belong to a server, not to a user, so the set they contribute is
 * tenant-wide and has to be narrowed to what this caller may see before any id
 * leaves here.
 */

import type { MCPOAuthGrantStatusRecord } from '@agor/core/db';
import { isMCPServerUsableBy } from '@agor/core/mcp';
import type { MCPServer, MCPServerID, UserID } from '@agor/core/types';
import { hasMinimumRole, ROLES } from '@agor/core/types';

export interface OAuthStatusViewer {
  user_id: UserID;
  role?: string;
}

export interface OAuthStatusDeps {
  viewer: OAuthStatusViewer;
  listForUser(userId: UserID): Promise<MCPOAuthGrantStatusRecord[]>;
  listShared(): Promise<MCPOAuthGrantStatusRecord[]>;
  findServers(serverIds: MCPServerID[]): Promise<MCPServer[]>;
  /**
   * Whether to recompute each grant's binding to its server's configuration.
   * The daemon may keep this false for a legacy caller; production enables it
   * and lets the verifier grandfather only historical unbound SQLite rows.
   */
  requireGrantBinding: boolean;
  isGrantBoundToServer(
    server: MCPServer,
    grant: MCPOAuthGrantStatusRecord
  ): boolean | Promise<boolean>;
  now?: Date;
}

/**
 * Whether this caller may be told that `server` exists.
 *
 * The same visibility every other read path applies: a private server belongs
 * to one user, and admins administer the whole tenant. Without it a shared
 * grant on an admin's private server would name that server to every member —
 * the one place a private row is otherwise never mentioned.
 */
function isVisibleTo(server: MCPServer, viewer: OAuthStatusViewer): boolean {
  if (hasMinimumRole(viewer.role, ROLES.ADMIN)) return true;
  return isMCPServerUsableBy(server, viewer.user_id);
}

export async function resolveAuthenticatedServerIds(deps: OAuthStatusDeps): Promise<MCPServerID[]> {
  const now = deps.now ?? new Date();
  const [perUserTokens, sharedTokens] = await Promise.all([
    deps.listForUser(deps.viewer.user_id),
    deps.listShared(),
  ]);

  const tokens = [...perUserTokens, ...sharedTokens].filter(
    (token) =>
      !(token.oauth_token_expires_at && token.oauth_token_expires_at <= now) &&
      token.refresh_status !== 'ambiguous' &&
      token.refresh_status !== 'refreshing'
  );
  const servers = new Map(
    (await deps.findServers([...new Set(tokens.map((token) => token.mcp_server_id))])).map(
      (server) => [server.mcp_server_id, server]
    )
  );
  const authenticatedServerIds = new Set<MCPServerID>();
  for (const token of tokens) {
    const server = servers.get(token.mcp_server_id);
    if (!server || !isVisibleTo(server, deps.viewer)) continue;

    // Verify saved configuration binding rather than trusting realtime hints.
    // Execution separately validates token material and provider acceptance.
    if (deps.requireGrantBinding && !(await deps.isGrantBoundToServer(server, token))) continue;

    authenticatedServerIds.add(token.mcp_server_id);
  }

  return [...authenticatedServerIds];
}
