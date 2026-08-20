/**
 * MCP Servers Service
 *
 * Provides REST + WebSocket API for MCP server management.
 * Uses DrizzleService adapter with MCPServerRepository.
 */

import { PAGINATION } from '@agor/core/config';
import { MCPServerRepository, type TenantScopeAwareDatabase } from '@agor/core/db';
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
  usableByUserId?: string;
  ownerless?: boolean;
  catalogEntryName?: string;
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

  constructor(db: TenantScopeAwareDatabase) {
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
    const filters: MCPServerFilters = {};

    if (params?.query) {
      if (params.query.scope) filters.scope = params.query.scope as MCPScope;
      if (params.query.scopeId) filters.scopeId = params.query.scopeId;
      if (params.query.transport) filters.transport = params.query.transport as MCPTransport;
      if (params.query.enabled !== undefined) filters.enabled = params.query.enabled;
      if (params.query.source) filters.source = params.query.source as MCPSource;
      if (params.query.usableByUserId) filters.usableByUserId = params.query.usableByUserId;
      if (params.query.ownerless !== undefined) filters.ownerless = params.query.ownerless;
      if (params.query.catalogEntryName) filters.catalogEntryName = params.query.catalogEntryName;
    }

    const servers = await this.mcpServerRepo.findAll(filters);

    const sort = params?.query?.$sort as Record<string, 1 | -1> | undefined;
    if (sort) {
      servers.sort((a, b) => {
        for (const [field, direction] of Object.entries(sort)) {
          const aValue = a[field as keyof MCPServer];
          const bValue = b[field as keyof MCPServer];
          const aComparable = aValue instanceof Date ? aValue.getTime() : aValue;
          const bComparable = bValue instanceof Date ? bValue.getTime() : bValue;
          if (aComparable === bComparable) continue;
          if (aComparable === undefined || aComparable === null) return -1 * direction;
          if (bComparable === undefined || bComparable === null) return 1 * direction;
          return (aComparable < bComparable ? -1 : 1) * direction;
        }
        return 0;
      });
    }

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
export function createMCPServersService(db: TenantScopeAwareDatabase): MCPServersService {
  return new MCPServersService(db);
}
