import { MCPServerRepository, type TenantScopeAwareDatabase } from '@agor/core/db';
import { NotAuthenticated, NotFound } from '@agor/core/feathers';
import { isMCPServerUsableBy } from '@agor/core/mcp';
import type { AuthenticatedParams, MCPServer } from '@agor/core/types';
import { hasMinimumRole, ROLES } from '@agor/core/types';

export interface SessionMcpServerVisibilityRow {
  owner_user_id?: string | null;
  session_created_by: string;
}

/**
 * A visible session is not enough to disclose every attached server ID. A
 * collaborator may read a session while its creator's private MCP definition
 * remains out of scope. Internal/service callers and admins retain the
 * existing control-plane visibility.
 */
export function isSessionMcpServerLinkVisibleToCaller(
  row: SessionMcpServerVisibilityRow,
  params: AuthenticatedParams | undefined
): boolean {
  if (!params?.provider) return true;
  const user = params.user;
  if (!user) return false;
  if ((user as { _isServiceAccount?: boolean })._isServiceAccount) return true;
  if (hasMinimumRole(user.role, ROLES.ADMIN)) return true;
  return isMCPServerUsableBy(row, row.session_created_by) && isMCPServerUsableBy(row, user.user_id);
}

export function isMcpServerUsableByCaller(
  server: MCPServer,
  params: AuthenticatedParams | undefined
): boolean {
  if (!params?.provider) return true;
  const user = params.user;
  if (!user) return false;
  if ((user as { _isServiceAccount?: boolean })._isServiceAccount) return true;
  return hasMinimumRole(user.role, ROLES.ADMIN) || isMCPServerUsableBy(server, user.user_id);
}

/**
 * Load a server named by a caller-supplied ID and enforce the direct-use
 * boundary. OAuth and discovery endpoints act on the saved configuration or
 * shared credential, so they cannot rely on session attachment checks.
 */
export async function loadMcpServerForCaller(
  db: TenantScopeAwareDatabase,
  serverId: string,
  params: AuthenticatedParams | undefined
): Promise<MCPServer> {
  const server = await new MCPServerRepository(db).findById(serverId);
  if (!server) throw new NotFound(`MCP server not found: ${serverId}`);

  if (!params?.provider) return server;
  if (!params.user) throw new NotAuthenticated('Authentication required');
  if (isMcpServerUsableByCaller(server, params)) return server;

  // Avoid an existence oracle for private server definitions.
  throw new NotFound(`MCP server not found: ${serverId}`);
}
