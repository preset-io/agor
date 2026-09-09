/**
 * MCP Servers Service
 *
 * Provides REST + WebSocket API for MCP server management.
 * Uses DrizzleService adapter with MCPServerRepository.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { PAGINATION } from '@agor/core/config';
import {
  MCPServerConfigConflictError,
  MCPServerRepository,
  type TenantScopeAwareDatabase,
  type TenantScopedDatabase,
} from '@agor/core/db';
import { BadRequest, Conflict } from '@agor/core/feathers';
import { MCPAuthValidationError, MCPServerWriteValidationError } from '@agor/core/mcp';
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
import { DrizzleService, type Repository } from '../adapters/drizzle';

/**
 * MCP Server service params
 */
export type MCPServerParams = QueryParams<{
  scope?: string;
  transport?: string;
  enabled?: boolean;
  source?: string;
  usableByUserId?: string;
  ownerless?: boolean;
  catalogEntryName?: string;
}> & {
  mcpCatalogConnectGeneration?: {
    ownerUserId: string;
    catalogEntryName: string;
    value: number;
  };
};

// Transaction handles are server-internal request state, never part of the
// public Feathers params contract. Async-local context makes them impossible
// for a REST/Socket.IO caller to manufacture or serialize.
const mutationDatabaseContext = new AsyncLocalStorage<TenantScopedDatabase>();

/**
 * Run a coordinated mutation with a transaction database that survives
 * Feathers before hooks replacing/cloning `params`. AsyncLocalStorage is
 * request-local and naturally supports overlapping and nested requests.
 */
export function runWithMCPServerMutationDatabase<T>(
  db: TenantScopedDatabase,
  operation: () => T
): T {
  return mutationDatabaseContext.run(db, operation);
}

function mutationDatabase(): TenantScopedDatabase | undefined {
  return mutationDatabaseContext.getStore();
}

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
    // DrizzleService's legacy adapter contract accepts Partial<T>, while this
    // repository deliberately exposes the narrower, validated CREATE DTO
    // (including auth:null). Both the transport hook and repository validate
    // that DTO before persistence.
    super(mcpServerRepo as unknown as Repository<MCPServer>, {
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
      if (params.query.transport) filters.transport = params.query.transport as MCPTransport;
      if (params.query.enabled !== undefined) filters.enabled = params.query.enabled;
      if (params.query.source) filters.source = params.query.source as MCPSource;
      if (params.query.usableByUserId) filters.usableByUserId = params.query.usableByUserId;
      if (params.query.ownerless !== undefined) filters.ownerless = params.query.ownerless;
      if (params.query.catalogEntryName) filters.catalogEntryName = params.query.catalogEntryName;
    }

    const sort = params?.query?.$sort as Record<string, 1 | -1> | undefined;
    const limit = params?.query?.$limit ?? this.paginate?.default ?? 50;
    const skip = params?.query?.$skip ?? 0;
    const pageFilters: MCPServerFilters = { ...filters, limit, offset: skip, sort };
    const [total, data] = await Promise.all([
      this.mcpServerRepo.count(filters),
      this.mcpServerRepo.findAll(pageFilters),
    ]);

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

  override async update(
    id: string,
    data: CreateMCPServerInput | UpdateMCPServerInput,
    _params?: MCPServerParams
  ): Promise<MCPServer> {
    try {
      // Preserve Feathers PUT replacement semantics while PATCH remains the
      // safe nested merge. Callers may opt out explicitly for compatibility.
      const replacement = data;
      const transactionDb = mutationDatabase();
      if (transactionDb) {
        return await new MCPServerRepository(transactionDb).update(id, replacement, {
          replace: true,
        });
      }
      return await this.mcpServerRepo.update(id, replacement, { replace: true });
    } catch (error) {
      if (
        error instanceof MCPAuthValidationError ||
        error instanceof MCPServerWriteValidationError
      ) {
        throw new BadRequest(error.message);
      }
      if (error instanceof MCPServerConfigConflictError) {
        throw new Conflict(error.message, {
          mcp_server_id: error.mcpServerId,
          expected_config_version: error.expectedVersion,
          current_config_version: error.actualVersion,
        });
      }
      throw error;
    }
  }

  override async patch(
    id: string | null,
    data: Partial<UpdateMCPServerInput>,
    params?: MCPServerParams
  ): Promise<MCPServer | MCPServer[]> {
    try {
      const transactionDb = mutationDatabase();
      const repository = transactionDb
        ? new MCPServerRepository(transactionDb)
        : this.mcpServerRepo;
      const generation = params?.mcpCatalogConnectGeneration;
      if (!generation || id === null) {
        if (id !== null && transactionDb) return repository.update(id, data);
        return await super.patch(id, data, params);
      }
      if (transactionDb) {
        const existing = await repository.findById(id);
        if (!existing) throw new Error(`MCP server ${id} not found`);
      } else {
        await this.get(id, params);
      }
      const updated = await repository.updateIfCatalogConnectGeneration(
        id,
        generation.ownerUserId,
        generation.catalogEntryName,
        generation.value,
        data
      );
      if (!updated) throw new Conflict('A newer marketplace connect superseded this request');
      return updated;
    } catch (error) {
      if (
        error instanceof MCPAuthValidationError ||
        error instanceof MCPServerWriteValidationError
      ) {
        throw new BadRequest(error.message);
      }
      if (error instanceof MCPServerConfigConflictError) {
        throw new Conflict(error.message, {
          mcp_server_id: error.mcpServerId,
          expected_config_version: error.expectedVersion,
          current_config_version: error.actualVersion,
        });
      }
      throw error;
    }
  }

  /** Internal compensation primitive; deliberately not registered as a REST method. */
  async removeIfUnattached(
    id: string,
    generation?: { ownerUserId: string; catalogEntryName: string; value: number }
  ): Promise<boolean> {
    return this.mcpServerRepo.deleteIfUnattached(id, generation);
  }

  /** Internal request-order claim; not registered as a REST method. */
  async claimCatalogConnectGeneration(
    ownerUserId: string,
    catalogEntryName: string
  ): Promise<number> {
    return this.mcpServerRepo.claimCatalogConnectGeneration(ownerUserId, catalogEntryName);
  }
}

/**
 * Service factory function
 */
export function createMCPServersService(db: TenantScopeAwareDatabase): MCPServersService {
  return new MCPServersService(db);
}
