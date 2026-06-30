/**
 * Session-MCP Servers Service
 *
 * Manages the many-to-many relationship between sessions and MCP servers.
 * Provides API for adding/removing/toggling MCP servers for sessions.
 */

import { SessionMCPServerRepository, type TenantScopeAwareDatabase } from '@agor/core/db';
import type { MCPServer, MCPServerID, QueryParams, SessionID } from '@agor/core/types';

/**
 * Session-MCP service params
 */
export type SessionMCPParams = QueryParams<{
  sessionId?: SessionID;
  serverId?: MCPServerID;
  enabled?: boolean;
  enabledOnly?: boolean;
}>;

/**
 * Session-MCP Servers service
 */
export class SessionMCPServersService {
  private sessionMCPRepo: SessionMCPServerRepository;

  constructor(db: TenantScopeAwareDatabase) {
    this.sessionMCPRepo = new SessionMCPServerRepository(db);
  }

  /**
   * Add MCP server to session
   */
  async addServer(
    sessionId: SessionID,
    serverId: MCPServerID,
    _params?: SessionMCPParams
  ): Promise<void> {
    return this.sessionMCPRepo.addServer(sessionId, serverId);
  }

  /**
   * Remove MCP server from session
   */
  async removeServer(
    sessionId: SessionID,
    serverId: MCPServerID,
    _params?: SessionMCPParams
  ): Promise<void> {
    return this.sessionMCPRepo.removeServer(sessionId, serverId);
  }

  /**
   * Toggle MCP server enabled state for session
   */
  async toggleServer(
    sessionId: SessionID,
    serverId: MCPServerID,
    enabled: boolean,
    _params?: SessionMCPParams
  ): Promise<void> {
    return this.sessionMCPRepo.toggleServer(sessionId, serverId, enabled);
  }

  /**
   * List MCP servers for a session
   */
  async listServers(
    sessionId: SessionID,
    enabledOnly = false,
    _params?: SessionMCPParams
  ): Promise<MCPServer[]> {
    return this.sessionMCPRepo.listServers(sessionId, enabledOnly);
  }

  /**
   * Set MCP servers for a session (bulk operation)
   */
  async setServers(
    sessionId: SessionID,
    serverIds: MCPServerID[],
    _params?: SessionMCPParams
  ): Promise<void> {
    return this.sessionMCPRepo.setServers(sessionId, serverIds);
  }

  /**
   * Count MCP servers for a session
   */
  async count(
    sessionId: SessionID,
    enabledOnly = false,
    _params?: SessionMCPParams
  ): Promise<number> {
    return this.sessionMCPRepo.count(sessionId, enabledOnly);
  }
}

/**
 * Service factory function
 */
export function createSessionMCPServersService(
  db: TenantScopeAwareDatabase
): SessionMCPServersService {
  return new SessionMCPServersService(db);
}
