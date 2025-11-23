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

  async findAll(): Promise<MCPServer[]> {
    const service = this.client.service('mcp-servers');
    const result = await service.find({ query: { $limit: 1000 } });
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
}

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
  };
}
