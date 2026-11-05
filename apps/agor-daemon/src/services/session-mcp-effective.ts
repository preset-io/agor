/**
 * Per-user inputs of the session effective MCP set (`@agor/core/mcp`
 * `resolveSessionMcpEntries`): which servers the acting user has connected,
 * and which global servers they hid from their connect rows.
 */

import {
  MCPServerRepository,
  type TenantScopeAwareDatabase,
  UserMCPOAuthTokenRepository,
  UsersRepository,
} from '@agor/core/db';
import { readHiddenMcpServerIds } from '@agor/core/mcp';
import type { MCPServerID, UserID } from '@agor/core/types';
import { isMCPOAuthGrantAuthorizedForServer } from './mcp-oauth-grant-authority.js';
import { type OAuthStatusViewer, resolveAuthenticatedServerIds } from './mcp-oauth-status.js';

/** The `/mcp-servers/oauth-status` answer, from durable grant state. */
export function loadAuthenticatedMcpServerIds(
  db: TenantScopeAwareDatabase,
  viewer: OAuthStatusViewer
): Promise<MCPServerID[]> {
  const userTokenRepo = new UserMCPOAuthTokenRepository(db);
  const serverRepo = new MCPServerRepository(db);
  return resolveAuthenticatedServerIds({
    viewer,
    listForUser: (id) => userTokenRepo.listStatusForSubject(id),
    listShared: () => userTokenRepo.listStatusForSubject(null),
    findServers: (serverIds) => serverRepo.findByIds(serverIds),
    requireGrantBinding: true,
    isGrantBoundToServer: (server, grant) => isMCPOAuthGrantAuthorizedForServer(db, server, grant),
  });
}

export async function loadSessionMcpUserContext(
  db: TenantScopeAwareDatabase,
  userId: string
): Promise<{ connectedServerIds: Set<string>; hiddenServerIds: Set<string> }> {
  const [connected, user] = await Promise.all([
    // Not an admin view: the set is the acting user's own grants.
    loadAuthenticatedMcpServerIds(db, { user_id: userId as UserID }),
    new UsersRepository(db).findById(userId),
  ]);
  return {
    connectedServerIds: new Set(connected),
    hiddenServerIds: readHiddenMcpServerIds(user?.preferences),
  };
}
