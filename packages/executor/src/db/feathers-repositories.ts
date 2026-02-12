/**
 * Feathers-Backed Repositories
 *
 * Thin repository wrappers that proxy to daemon services via Feathers client.
 * This allows executor code (especially ClaudeTool) to use the repository pattern
 * while actually communicating with the daemon over Feathers/WebSocket.
 */

import type { AgorClient } from '@agor/core/api';
import type {
  MCPServer,
  MCPServerFilters,
  MCPServerID,
  Message,
  MessageID,
  Repo,
  Session,
  SessionID,
  SessionMCPServer,
  Worktree,
  WorktreeID,
} from '@agor/core/types';

/**
 * Messages Repository - proxies to 'messages' Feathers service
 */
export class FeathersMessagesRepository {
  constructor(private client: AgorClient) {}

  async findBySessionId(sessionId: SessionID): Promise<Message[]> {
    const service = this.client.service('messages');
    const result = await service.find({
      query: {
        session_id: sessionId,
        $sort: { index: 1 },
        $limit: 10000,
      },
    });
    return Array.isArray(result) ? result : result.data;
  }

  async findById(messageId: MessageID): Promise<Message | null> {
    try {
      const service = this.client.service('messages');
      return await service.get(messageId);
    } catch (_error) {
      return null;
    }
  }

  async create(message: Omit<Message, 'message_id'>): Promise<Message> {
    const service = this.client.service('messages');
    return await service.create(message as Partial<Message>);
  }
}

/**
 * Sessions Repository - proxies to 'sessions' Feathers service
 */
export class FeathersSessionsRepository {
  constructor(private client: AgorClient) {}

  async findById(sessionId: SessionID): Promise<Session | null> {
    try {
      const service = this.client.service('sessions');
      return await service.get(sessionId);
    } catch (_error) {
      return null;
    }
  }

  async update(sessionId: SessionID, data: Partial<Session>): Promise<Session> {
    const service = this.client.service('sessions');
    return await service.patch(sessionId, data);
  }
}

/**
 * Worktrees Repository - proxies to 'worktrees' Feathers service
 */
export class FeathersWorktreesRepository {
  constructor(private client: AgorClient) {}

  async findById(worktreeId: WorktreeID): Promise<Worktree | null> {
    try {
      const service = this.client.service('worktrees');
      return await service.get(worktreeId);
    } catch (_error) {
      return null;
    }
  }
}

/**
 * Repos Repository - proxies to 'repos' Feathers service
 */
export class FeathersReposRepository {
  constructor(private client: AgorClient) {}

  async findById(repoId: string): Promise<Repo | null> {
    try {
      const service = this.client.service('repos');
      return await service.get(repoId);
    } catch (_error) {
      return null;
    }
  }
}

/**
 * MCP Servers Repository - proxies to 'mcp-servers' Feathers service
 */
export class FeathersMCPServersRepository {
  constructor(private client: AgorClient) {}

  async findById(mcpServerId: MCPServerID): Promise<MCPServer | null> {
    try {
      const service = this.client.service('mcp-servers');
      return await service.get(mcpServerId);
    } catch (_error) {
      return null;
    }
  }

  async findAll(filters?: MCPServerFilters, forUserId?: string): Promise<MCPServer[]> {
    const service = this.client.service('mcp-servers');
    const query: Record<string, unknown> = { $limit: 1000 };

    // Apply filters
    if (filters?.scope) {
      query.scope = filters.scope;
    }
    if (filters?.scopeId) {
      query.scopeId = filters.scopeId;
    }
    if (filters?.transport) {
      query.transport = filters.transport;
    }
    if (filters?.enabled !== undefined) {
      query.enabled = filters.enabled;
    }

    // Pass user ID for per-user OAuth token injection
    // This allows the daemon to inject per-user tokens even when socket auth isn't available
    if (forUserId) {
      query.forUserId = forUserId;
      console.log(`[MCP Repo] Adding forUserId to query: ${forUserId}`);
    } else {
      console.log(`[MCP Repo] No forUserId provided`);
    }

    console.log(`[MCP Repo] Query to daemon:`, JSON.stringify(query));
    const result = await service.find({ query });
    return Array.isArray(result) ? result : result.data;
  }
}

/**
 * Session MCP Servers Repository - proxies to 'session-mcp-servers' Feathers service
 */
export class FeathersSessionMCPServersRepository {
  constructor(private client: AgorClient) {}

  async findBySessionId(sessionId: SessionID): Promise<SessionMCPServer[]> {
    const service = this.client.service('session-mcp-servers');
    const result = await service.find({
      query: {
        session_id: sessionId,
        $limit: 1000,
      },
    });
    return (Array.isArray(result) ? result : result.data) as SessionMCPServer[];
  }

  async findByMCPServerId(mcpServerId: MCPServerID): Promise<SessionMCPServer[]> {
    const service = this.client.service('session-mcp-servers');
    const result = await service.find({
      query: {
        mcp_server_id: mcpServerId,
        $limit: 1000,
      },
    });
    return (Array.isArray(result) ? result : result.data) as SessionMCPServer[];
  }

  /**
   * List MCP servers for a session with optional enabled filter
   * @param sessionId - Session ID
   * @param enabledOnly - If true, only return enabled servers
   * @returns Array of MCPServer objects
   */
  async listServers(sessionId: SessionID, enabledOnly?: boolean): Promise<MCPServer[]> {
    // Get session-mcp-server join records
    const query: Record<string, unknown> = {
      session_id: sessionId,
      $limit: 1000,
    };

    if (enabledOnly) {
      query.enabled = true;
    }

    const sessionMCPService = this.client.service('session-mcp-servers');
    const result = await sessionMCPService.find({ query });
    const sessionMCPServers = (Array.isArray(result) ? result : result.data) as SessionMCPServer[];

    // Get full MCPServer objects for each join record
    const mcpServerService = this.client.service('mcp-servers');
    const servers: MCPServer[] = [];

    for (const link of sessionMCPServers) {
      try {
        const server = await mcpServerService.get(link.mcp_server_id);
        servers.push(server);
      } catch (_error) {}
    }

    return servers;
  }

  /**
   * List MCP servers for a session with relationship metadata (added_at timestamp)
   * Used to detect if servers were added after session creation
   * @param sessionId - Session ID
   * @param enabledOnly - If true, only return enabled servers
   * @returns Array of objects with server and metadata
   */
  async listServersWithMetadata(
    sessionId: SessionID,
    enabledOnly = false
  ): Promise<Array<{ server: MCPServer; added_at: number; enabled: boolean }>> {
    // Get session-mcp-server join records
    const query: Record<string, unknown> = {
      session_id: sessionId,
      $limit: 1000,
    };

    if (enabledOnly) {
      query.enabled = true;
    }

    const sessionMCPService = this.client.service('session-mcp-servers');
    const result = await sessionMCPService.find({ query });
    const sessionMCPServers = (Array.isArray(result) ? result : result.data) as SessionMCPServer[];

    // Get full MCPServer objects with metadata for each join record
    const mcpServerService = this.client.service('mcp-servers');
    const results: Array<{ server: MCPServer; added_at: number; enabled: boolean }> = [];

    for (const link of sessionMCPServers) {
      try {
        const server = await mcpServerService.get(link.mcp_server_id);
        results.push({
          server,
          added_at: new Date(link.added_at).getTime(), // Convert to timestamp
          enabled: Boolean(link.enabled),
        });
      } catch (_error) {
        // Skip servers that can't be fetched
      }
    }

    return results;
  }
}

// ═══════════════════════════════════════════════════════════
// Type Aliases for Backward Compatibility
// ═══════════════════════════════════════════════════════════

/**
 * Repository type aliases matching old architecture patterns
 * These allow sdk-handlers to use familiar types during migration
 */
export type MessagesRepository = FeathersMessagesRepository;
export type SessionRepository = FeathersSessionsRepository;
export type WorktreeRepository = FeathersWorktreesRepository;
export type RepoRepository = FeathersReposRepository;
export type MCPServerRepository = FeathersMCPServersRepository;
export type SessionMCPServerRepository = FeathersSessionMCPServersRepository;

/**
 * Create all Feathers-backed repositories and services
 */
export function createFeathersBackedRepositories(client: AgorClient) {
  return {
    // Repositories
    messages: new FeathersMessagesRepository(client),
    sessions: new FeathersSessionsRepository(client),
    worktrees: new FeathersWorktreesRepository(client),
    repos: new FeathersReposRepository(client),
    mcpServers: new FeathersMCPServersRepository(client),
    sessionMCP: new FeathersSessionMCPServersRepository(client),

    // Services (direct Feathers service access)
    // SDK handlers can use these services directly with proper typing
    messagesService: client.service('messages'),
    tasksService: client.service('tasks'),
    sessionsService: client.service('sessions'),
    // Service for notifying UI about OAuth authentication requirements
    mcpOAuthNotifyService: client.service('mcp-servers/oauth-notify'),
  };
}
