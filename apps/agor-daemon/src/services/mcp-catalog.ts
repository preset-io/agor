/**
 * MCP Catalog Service
 *
 * Read-only browse surface over the checked-in catalog. `create`, `update`,
 * `patch`, and `remove` are deliberately absent: the catalog's contents are a
 * file in this repository, so the way to change them is a pull request.
 *
 * This does not extend `DrizzleService`. There is no table behind it — the
 * catalog is loaded once into the process and every read is served from there.
 */

import { findCatalogEntry, loadCatalog, queryCatalog } from '@agor/core/mcp-catalog';
import type {
  AuthenticatedParams,
  Id,
  MCPCatalogAuthType,
  MCPCatalogCategory,
  MCPCatalogEntry,
  MCPCatalogFilters,
  MCPCatalogSort,
  Paginated,
  QueryParams,
} from '@agor/core/types';
import { NotFoundError } from '@agor/core/utils/errors';
import type { Query } from '../adapters/drizzle';

/**
 * Page bounds for the catalog, deliberately not the shared defaults.
 *
 * The shared bound is 10,000 rows either way. A browse surface shows a
 * screenful at a time, and the ceiling is what a caller may raise it to.
 */
const MCP_CATALOG_PAGINATION = { DEFAULT_LIMIT: 24, MAX_LIMIT: 100 } as const;

export type MCPCatalogParams = QueryParams<{
  name?: string;
  search?: string;
  category?: MCPCatalogCategory;
  capability?: string;
  has_remote?: boolean;
  auth_type?: MCPCatalogAuthType;
  auth_types?: MCPCatalogAuthType[];
  sort?: MCPCatalogSort;
}> &
  AuthenticatedParams;

export class MCPCatalogService {
  /** Overrides the checked-in file. Tests pass this. */
  constructor(private filePath?: string) {}

  /**
   * Map a validated Feathers query onto catalog filters.
   *
   * The query validator has already dropped anything outside
   * `mcpCatalogQuerySchema`, so no unvalidated value reaches a filter.
   */
  private filtersFor(query: Query): MCPCatalogFilters {
    const filters: MCPCatalogFilters = {};

    if (typeof query.name === 'string') filters.names = [query.name];
    if (typeof query.search === 'string') filters.search = query.search;
    if (typeof query.category === 'string') {
      filters.category = query.category as MCPCatalogCategory;
    }
    if (typeof query.capability === 'string') filters.capability = query.capability;
    if (typeof query.has_remote === 'boolean') filters.has_remote = query.has_remote;
    if (typeof query.auth_type === 'string') {
      filters.auth_type = query.auth_type as MCPCatalogAuthType;
    }
    if (Array.isArray(query.auth_types)) {
      filters.auth_types = query.auth_types as MCPCatalogAuthType[];
    }
    if (typeof query.sort === 'string') filters.sort = query.sort as MCPCatalogSort;

    return filters;
  }

  async find(params?: MCPCatalogParams): Promise<Paginated<MCPCatalogEntry>> {
    const query = (params?.query ?? {}) as Query;
    const filters = this.filtersFor(query);

    const limit = Math.min(
      query.$limit ?? MCP_CATALOG_PAGINATION.DEFAULT_LIMIT,
      MCP_CATALOG_PAGINATION.MAX_LIMIT
    );
    const skip = query.$skip ?? 0;

    const entries = await loadCatalog(this.filePath);
    const { data, total } = queryCatalog(entries, { ...filters, limit, offset: skip });
    return { total, limit, skip, data };
  }

  /** Fetch one entry by its catalog name. */
  async get(id: Id): Promise<MCPCatalogEntry> {
    const key = String(id);
    const entry = findCatalogEntry(await loadCatalog(this.filePath), key);
    if (!entry) throw new NotFoundError('MCPCatalogEntry', key);
    return entry;
  }
}

export function createMCPCatalogService(filePath?: string): MCPCatalogService {
  return new MCPCatalogService(filePath);
}
