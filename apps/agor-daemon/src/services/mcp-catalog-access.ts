import { type TenantScopeAwareDatabase, UsersRepository } from '@agor/core/db';
import { BadRequest, NotAuthenticated } from '@agor/core/feathers';
import type { AuthenticatedParams, MCPCatalogSharing } from '@agor/core/types';
import { assertMcpCapabilityRole } from '../utils/mcp-server-authorization.js';

export function readCatalogSharing(value: unknown): MCPCatalogSharing {
  if (value === undefined) return 'private';
  if (value === 'private' || value === 'shared') return value;
  throw new BadRequest('sharing must be private or shared');
}

/** Called in a short trusted tenant unit, again after the external probe. */
export async function authorizeCatalogCaller(
  db: TenantScopeAwareDatabase,
  params: AuthenticatedParams
): Promise<AuthenticatedParams> {
  const user = params.user?.user_id
    ? await new UsersRepository(db).findById(params.user.user_id)
    : undefined;
  if (!user) throw new NotAuthenticated('Authentication required');
  const current = { ...params, user: { ...params.user, role: user.role } } as AuthenticatedParams;
  assertMcpCapabilityRole(current, 'connect MCP servers');
  // Using a canonical shared row does not publish or configure it. Connect
  // validates the actual selected row; any create/repair still goes through
  // mcp-servers' current-policy write authorizer. Viewers cannot mint use/OAuth
  // capabilities even when a row already exists.
  return current;
}
