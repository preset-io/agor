/**
 * MCP Server Repository
 *
 * Type-safe CRUD operations for MCP servers with short ID support.
 */

import type {
  CreateMCPServerInput,
  MCPScope,
  MCPServer,
  MCPServerFilters,
  MCPServerID,
  SessionID,
  TeamID,
  UpdateMCPServerInput,
  UserID,
  UUID,
} from '@agor/core/types';
import { and, eq, like } from 'drizzle-orm';
import { formatShortId, generateId } from '../../lib/ids';
import type { Database } from '../client';
import { deleteFrom, insert, select, update } from '../database-wrapper';
import { type MCPServerInsert, type MCPServerRow, mcpServers } from '../schema';
import {
  AmbiguousIdError,
  type BaseRepository,
  EntityNotFoundError,
  RepositoryError,
} from './base';

/**
 * MCP Server repository implementation
 */
export class MCPServerRepository
  implements BaseRepository<MCPServer, CreateMCPServerInput | UpdateMCPServerInput>
{
  constructor(private db: Database) {}

  /**
   * Convert database row to MCPServer type
   */
  private rowToMCPServer(row: MCPServerRow): MCPServer {
    return {
      mcp_server_id: row.mcp_server_id as MCPServerID,
      name: row.name,
      transport: row.transport,
      scope: row.scope,
      enabled: Boolean(row.enabled),
      source: row.source,
      created_at: new Date(row.created_at),
      updated_at: row.updated_at ? new Date(row.updated_at) : new Date(row.created_at),

      // Optional fields from JSON data
      display_name: row.data.display_name,
      description: row.data.description,
      import_path: row.data.import_path,

      // Transport config
      command: row.data.command,
      args: row.data.args,
      url: row.data.url,
      env: row.data.env,
      auth: row.data.auth,

      // Scope foreign keys (nullable UUID strings - DB stores null, types expect undefined)
      owner_user_id: (row.owner_user_id as UserID | null) ?? undefined,
      team_id: (row.team_id as TeamID | null) ?? undefined,
      repo_id: (row.repo_id as UUID | null) ?? undefined,
      session_id: (row.session_id as SessionID | null) ?? undefined,

      // Capabilities
      tools: row.data.tools,
      resources: row.data.resources,
      prompts: row.data.prompts,
    };
  }

  /**
   * Convert MCPServer to database insert format
   */
  private mcpServerToInsert(data: CreateMCPServerInput | Partial<MCPServer>): MCPServerInsert {
    const now = Date.now();
    const serverId =
      'mcp_server_id' in data && data.mcp_server_id ? data.mcp_server_id : generateId();

    return {
      mcp_server_id: serverId as string,
      created_at:
        'created_at' in data && data.created_at ? new Date(data.created_at) : new Date(now),
      updated_at:
        'updated_at' in data && data.updated_at ? new Date(data.updated_at) : new Date(now),

      // Materialized columns
      name: data.name!,
      transport: data.transport!,
      scope: data.scope!,
      enabled: data.enabled ?? true,
      source: data.source ?? 'user',

      // Scope foreign keys
      owner_user_id: data.owner_user_id ?? null,
      team_id: data.team_id ?? null,
      repo_id: data.repo_id ?? null,
      session_id: data.session_id ?? null,

      // JSON blob
      data: {
        display_name: data.display_name,
        description: data.description,
        import_path: data.import_path,
        command: data.command,
        args: data.args,
        url: data.url,
        env: data.env,
        auth: 'auth' in data ? data.auth : undefined,
        tools: 'tools' in data ? data.tools : undefined,
        resources: 'resources' in data ? data.resources : undefined,
        prompts: 'prompts' in data ? data.prompts : undefined,
      },
    };
  }

  /**
   * Resolve short ID to full ID
   */
  private async resolveId(id: string): Promise<string> {
    // If already a full UUID, return as-is
    if (id.length === 36 && id.includes('-')) {
      return id;
    }

    // Short ID - need to resolve
    const normalized = id.replace(/-/g, '').toLowerCase();
    const pattern = `${normalized}%`;

    const results = await select(this.db)
      .from(mcpServers)
      .where(like(mcpServers.mcp_server_id, pattern))
      .all();

    if (results.length === 0) {
      throw new EntityNotFoundError('MCPServer', id);
    }

    if (results.length > 1) {
      throw new AmbiguousIdError(
        'MCPServer',
        id,
        results.map((r: { mcp_server_id: string }) => formatShortId(r.mcp_server_id as UUID))
      );
    }

    return results[0].mcp_server_id as UUID;
  }

  /**
   * Create a new MCP server
   */
  async create(data: CreateMCPServerInput): Promise<MCPServer> {
    try {
      const insertData = this.mcpServerToInsert(data);
      await insert(this.db, mcpServers).values(insertData).run();

      const row = await select(this.db)
        .from(mcpServers)
        .where(eq(mcpServers.mcp_server_id, insertData.mcp_server_id))
        .one();

      if (!row) {
        throw new RepositoryError('Failed to retrieve created MCP server');
      }

      return this.rowToMCPServer(row);
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      throw new RepositoryError(
        `Failed to create MCP server: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find MCP server by ID (supports short ID)
   */
  async findById(id: string): Promise<MCPServer | null> {
    try {
      const fullId = await this.resolveId(id);
      const row = await select(this.db)
        .from(mcpServers)
        .where(eq(mcpServers.mcp_server_id, fullId))
        .one();

      return row ? this.rowToMCPServer(row) : null;
    } catch (error) {
      if (error instanceof EntityNotFoundError) return null;
      if (error instanceof AmbiguousIdError) throw error;
      throw new RepositoryError(
        `Failed to find MCP server: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find all MCP servers
   */
  async findAll(filters?: MCPServerFilters): Promise<MCPServer[]> {
    try {
      let query = select(this.db).from(mcpServers);

      // Apply filters
      const conditions = [];

      if (filters?.scope) {
        conditions.push(eq(mcpServers.scope, filters.scope));
      }

      if (filters?.scopeId) {
        // Match against the appropriate scope foreign key
        if (filters.scope === 'global') {
          conditions.push(eq(mcpServers.owner_user_id, filters.scopeId));
        } else if (filters.scope === 'team') {
          conditions.push(eq(mcpServers.team_id, filters.scopeId));
        } else if (filters.scope === 'repo') {
          conditions.push(eq(mcpServers.repo_id, filters.scopeId));
        } else if (filters.scope === 'session') {
          conditions.push(eq(mcpServers.session_id, filters.scopeId));
        }
      }

      if (filters?.transport) {
        conditions.push(eq(mcpServers.transport, filters.transport));
      }

      if (filters?.enabled !== undefined) {
        conditions.push(eq(mcpServers.enabled, filters.enabled));
      }

      if (filters?.source) {
        conditions.push(eq(mcpServers.source, filters.source));
      }

      if (conditions.length > 0) {
        // biome-ignore lint/suspicious/noExplicitAny: Drizzle query builder type
        query = query.where(and(...conditions)) as any;
      }

      const rows = await query.all();
      return rows.map((row: MCPServerRow) => this.rowToMCPServer(row));
    } catch (error) {
      throw new RepositoryError(
        `Failed to find MCP servers: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find MCP servers by scope
   */
  async findByScope(scope: string, scopeId?: string): Promise<MCPServer[]> {
    return this.findAll({ scope: scope as MCPScope, scopeId });
  }

  /**
   * Update MCP server by ID
   */
  async update(id: string, updates: UpdateMCPServerInput): Promise<MCPServer> {
    try {
      const fullId = await this.resolveId(id);

      // Get current server to merge updates
      const current = await this.findById(fullId);
      if (!current) {
        throw new EntityNotFoundError('MCPServer', id);
      }

      const merged = { ...current, ...updates };
      const insertData = this.mcpServerToInsert(merged);

      await update(this.db, mcpServers)
        .set({
          enabled: insertData.enabled,
          scope: insertData.scope,
          updated_at: new Date(),
          data: insertData.data,
        })
        .where(eq(mcpServers.mcp_server_id, fullId))
        .run();

      const updated = await this.findById(fullId);
      if (!updated) {
        throw new RepositoryError('Failed to retrieve updated MCP server');
      }

      return updated;
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      if (error instanceof EntityNotFoundError) throw error;
      throw new RepositoryError(
        `Failed to update MCP server: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Delete MCP server by ID
   */
  async delete(id: string): Promise<void> {
    try {
      const fullId = await this.resolveId(id);

      const result = await deleteFrom(this.db, mcpServers)
        .where(eq(mcpServers.mcp_server_id, fullId))
        .run();

      if (result.rowsAffected === 0) {
        throw new EntityNotFoundError('MCPServer', id);
      }
    } catch (error) {
      if (error instanceof EntityNotFoundError) throw error;
      throw new RepositoryError(
        `Failed to delete MCP server: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Count total MCP servers
   */
  async count(filters?: MCPServerFilters): Promise<number> {
    try {
      const servers = await this.findAll(filters);
      return servers.length;
    } catch (error) {
      throw new RepositoryError(
        `Failed to count MCP servers: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }
}
