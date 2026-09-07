/**
 * Which MCP servers a caller already holds a usable OAuth grant for.
 *
 * The answer drives an auth badge in the UI, so it is a read of durable state
 * rather than of whatever a realtime hint last said: a grant is advertised only
 * if it has a usable access token or a durable refresh token capable of
 * renewing it, is not in an ambiguous refresh state, and still binds to the
 * server it was issued against. Historical standalone grants
 * predate binding and are intentionally grandfathered; newly issued SQLite
 * grants carry the same versioned configuration envelope.
 *
 * Grants come from two places and only one of them is the caller's. Shared
 * grants belong to a server, not to a user, so the set they contribute is
 * tenant-wide and has to be narrowed to what this caller may see before any id
 * leaves here.
 */

import type { UserMCPOAuthToken } from '@agor/core/db';
import { isMCPServerUsableBy } from '@agor/core/mcp';
import { oauthGrantCanAuthenticate } from '@agor/core/tools/mcp/oauth-refresh';
import type { MCPServer, MCPServerID, UserID } from '@agor/core/types';
import { hasMinimumRole, ROLES } from '@agor/core/types';

export interface OAuthStatusViewer {
  user_id: UserID;
  role?: string;
}

export interface OAuthStatusDeps {
  viewer: OAuthStatusViewer;
  listForUser(userId: UserID): Promise<UserMCPOAuthToken[]>;
  listShared(): Promise<UserMCPOAuthToken[]>;
  findServer(serverId: string): Promise<MCPServer | null>;
  /**
   * Whether to recompute each grant's binding to its server's configuration.
   * The daemon may keep this false for a legacy caller; production enables it
   * and lets the verifier grandfather only historical unbound SQLite rows.
   */
  requireGrantBinding: boolean;
  isGrantBoundToServer(server: MCPServer, grant: UserMCPOAuthToken): boolean | Promise<boolean>;
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

  const authenticatedServerIds = new Set<MCPServerID>();
  for (const token of [...perUserTokens, ...sharedTokens]) {
    if (!oauthGrantCanAuthenticate(token, now)) continue;

    const server = await deps.findServer(token.mcp_server_id);
    if (!server || !isVisibleTo(server, deps.viewer)) continue;

    // Durable status is authoritative. A realtime hint or stale row must never
    // make the UI advertise a grant which the request path would refuse to use.
    if (deps.requireGrantBinding && !(await deps.isGrantBoundToServer(server, token))) continue;

    authenticatedServerIds.add(token.mcp_server_id);
  }

  return [...authenticatedServerIds];
}
