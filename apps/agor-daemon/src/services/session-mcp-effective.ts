/**
 * The one daemon assembly of a session's effective MCP set. It loads the
 * inputs of `resolveSessionMcpEntries` (`@agor/core/mcp/effective-set`): the
 * session's links and their servers, the enabled global servers, which servers
 * the acting user has connected, and which global servers they hid. The
 * session MCP route (runtime + pill), OAuth header issuance, and the egress
 * gateway all ask it whether a server is `active` (the latter two in
 * membership-only mode).
 */

import {
  MCPServerRepository,
  SessionMCPServerRepository,
  type TenantScopeAwareDatabase,
  type TenantScopedDatabase,
  UserMCPOAuthTokenRepository,
  UsersRepository,
} from '@agor/core/db';
import {
  isMCPServerUsableInSession,
  readHiddenMcpServerIds,
  resolveSessionMcpEntries,
  type SessionMcpEntry,
} from '@agor/core/mcp';
import type { MCPServerID, Session, UserID } from '@agor/core/types';

type SessionMcpDatabase = TenantScopeAwareDatabase | TenantScopedDatabase;

import { isMCPOAuthGrantAuthorizedForServer } from './mcp-oauth-grant-authority.js';
import { type OAuthStatusViewer, resolveAuthenticatedServerIds } from './mcp-oauth-status.js';

/** The `/mcp-servers/oauth-status` answer, from durable grant state. */
export function loadAuthenticatedMcpServerIds(
  db: SessionMcpDatabase,
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

async function loadSessionMcpUserContext(
  db: SessionMcpDatabase,
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

/**
 * `membershipOnly` answers session membership for scope checks: it skips the
 * connection/hide lookup and filters (see `resolveSessionMcpEntries`).
 */
export async function resolveSessionMcpViewForSession(
  db: SessionMcpDatabase,
  session: Pick<Session, 'session_id' | 'created_by' | 'mcp_selection_explicit'>,
  actingUserId: string,
  options: { membershipOnly?: boolean } = {}
): Promise<SessionMcpEntry[]> {
  const servers = new MCPServerRepository(db);
  const noUserContext = {
    connectedServerIds: new Set<string>(),
    hiddenServerIds: new Set<string>(),
  };
  const [links, globalServers, userContext] = await Promise.all([
    new SessionMCPServerRepository(db).listLinks(session.session_id),
    servers.findAll({ scope: 'global', enabled: true, usableByUserId: actingUserId }),
    options.membershipOnly
      ? noUserContext
      : loadSessionMcpUserContext(db, actingUserId).catch(() => {
          console.warn('[mcp-runtime] session_mcp_user_context_unavailable');
          return noUserContext;
        }),
  ]);
  // Stale links may predate ownership enforcement; never resolve them.
  const linkedServers = (await servers.findByIds(links.map((link) => link.mcp_server_id))).filter(
    (server) => isMCPServerUsableInSession(server, session)
  );
  return resolveSessionMcpEntries({
    selectionExplicit: session.mcp_selection_explicit,
    links,
    linkedServers,
    globalServers,
    ...userContext,
    forUserId: actingUserId,
    membershipOnly: options.membershipOnly,
  });
}

/**
 * Enforcement scope for credential issuance and egress: the server is part of
 * this session for the acting user, i.e. linked or inherited and not switched
 * off. Whether the user is connected is the credential path's own decision.
 */
export async function sessionMcpScopeServerIds(
  db: SessionMcpDatabase,
  session: Pick<Session, 'session_id' | 'created_by' | 'mcp_selection_explicit'>,
  actingUserId: string
): Promise<Set<string>> {
  const entries = await resolveSessionMcpViewForSession(db, session, actingUserId, {
    membershipOnly: true,
  });
  return new Set(
    entries.filter((entry) => entry.state === 'active').map((entry) => entry.server.mcp_server_id)
  );
}
