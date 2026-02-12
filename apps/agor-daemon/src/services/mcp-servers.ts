/**
 * MCP Servers Service
 *
 * Provides REST + WebSocket API for MCP server management.
 * Uses DrizzleService adapter with MCPServerRepository.
 */

import { PAGINATION } from '@agor/core/config';
import { type Database, MCPServerRepository } from '@agor/core/db';
import type {
  CreateMCPServerInput,
  MCPScope,
  MCPServer,
  MCPServerFilters,
  MCPSource,
  MCPTransport,
  Paginated,
  QueryParams,
  UpdateMCPServerInput,
} from '@agor/core/types';
import { DrizzleService } from '../adapters/drizzle';

/**
 * MCP Server service params
 */
export type MCPServerParams = QueryParams<{
  scope?: string;
  scopeId?: string;
  transport?: string;
  enabled?: boolean;
  source?: string;
}>;

/**
 * Extended MCP servers service with custom methods
 */
export class MCPServersService extends DrizzleService<
  MCPServer,
  CreateMCPServerInput | UpdateMCPServerInput,
  MCPServerParams
> {
  private mcpServerRepo: MCPServerRepository;

  constructor(db: Database) {
    const mcpServerRepo = new MCPServerRepository(db);
    super(mcpServerRepo, {
      id: 'mcp_server_id',
      resourceType: 'McpServer',
      paginate: {
        default: PAGINATION.DEFAULT_LIMIT,
        max: PAGINATION.MAX_LIMIT,
      },
    });

    this.mcpServerRepo = mcpServerRepo;
  }

  /**
   * Override find to support filter params
   */
  async find(params?: MCPServerParams) {
    // Debug logging to trace auth context
    const paramsRecord = params as Record<string, unknown> | undefined;
    const userRecord = paramsRecord?.user as Record<string, unknown> | undefined;
    const userId = userRecord?.user_id as string | undefined;
    console.log(
      `[MCPServersService.find] Called with userId: ${userId || 'NONE'}, ` +
        `provider: ${params?.provider || 'internal'}, ` +
        `hasConnection: ${!!paramsRecord?.connection}`
    );

    const filters: MCPServerFilters = {};

    if (params?.query) {
      if (params.query.scope) filters.scope = params.query.scope as MCPScope;
      if (params.query.scopeId) filters.scopeId = params.query.scopeId;
      if (params.query.transport) filters.transport = params.query.transport as MCPTransport;
      if (params.query.enabled !== undefined) filters.enabled = params.query.enabled;
      if (params.query.source) filters.source = params.query.source as MCPSource;
    }

    const servers = await this.mcpServerRepo.findAll(filters);

    // Apply pagination if requested
    const limit = params?.query?.$limit ?? this.paginate?.default ?? 50;
    const skip = params?.query?.$skip ?? 0;

    const total = servers.length;
    const data = servers.slice(skip, skip + limit);

    if (this.paginate) {
      return {
        total,
        limit,
        skip,
        data,
      };
    }

    return data as MCPServer[] | Paginated<MCPServer>;
  }

  /**
   * Custom method: Find by scope
   */
  async findByScope(
    scope: string,
    scopeId?: string,
    _params?: MCPServerParams
  ): Promise<MCPServer[]> {
    return this.mcpServerRepo.findByScope(scope, scopeId);
  }
}

/**
 * Service factory function
 */
export function createMCPServersService(db: Database): MCPServersService {
  return new MCPServersService(db);
}
