/**
 * MCP Catalog Service
 *
 * Read-only browse surface over `mcp_catalog_entries`. `create`, `update`,
 * `patch`, and `remove` are deliberately absent: the catalog's only writers are
 * the registry ingestion job and the `curated.yaml` seeder, both of which run
 * under the `mcp_catalog_ingestion` system database capability.
 *
 * This does not extend `DrizzleService`. That adapter models a CRUD table whose
 * `find` reads a candidate row set and then filters, sorts, counts, and
 * paginates it in memory; its `fetchData` seam narrows the read but leaves the
 * rest in JS. The catalog is the opposite shape — thousands of registry rows,
 * a search box that fires on every keystroke, and no writes at all — so every
 * predicate, the ordering, the page bounds, and the total resolve in SQL, and
 * the repository has no create/update/delete to adapt.
 */

import { PAGINATION } from '@agor/core/config';
import {
  getCurrentTenantId,
  MCPCatalogRepository,
  runWithTenantDatabaseScope,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import type {
  AuthenticatedParams,
  Id,
  MCPCatalogCategory,
  MCPCatalogEntry,
  MCPCatalogFilters,
  MCPCatalogProbedAuthType,
  MCPCatalogSort,
  Paginated,
  QueryParams,
} from '@agor/core/types';
import { NotFoundError } from '@agor/core/utils/errors';
import type { Query } from '../adapters/drizzle';

export type MCPCatalogParams = QueryParams<{
  name?: string;
  search?: string;
  category?: MCPCatalogCategory;
  capability?: string;
  verified?: boolean;
  curated?: boolean;
  has_remote?: boolean;
  probed_auth_type?: MCPCatalogProbedAuthType;
  sort?: MCPCatalogSort;
}> &
  AuthenticatedParams;

export class MCPCatalogService {
  constructor(private db: TenantScopeAwareDatabase) {}

  /**
   * Map a validated Feathers query onto repository filters.
   *
   * Every key here becomes a SQL predicate. The query validator has already
   * dropped anything outside `mcpCatalogQuerySchema`, so no unvalidated value
   * reaches a LIKE pattern or an ORDER BY.
   */
  private filtersFor(query: Query): MCPCatalogFilters {
    const filters: MCPCatalogFilters = {};

    if (typeof query.name === 'string') filters.names = [query.name];
    if (typeof query.search === 'string') filters.search = query.search;
    if (typeof query.category === 'string') {
      filters.category = query.category as MCPCatalogCategory;
    }
    if (typeof query.capability === 'string') filters.capability = query.capability;
    if (typeof query.verified === 'boolean') filters.verified = query.verified;
    if (typeof query.curated === 'boolean') filters.curated = query.curated;
    if (typeof query.has_remote === 'boolean') filters.has_remote = query.has_remote;
    if (typeof query.probed_auth_type === 'string') {
      filters.probed_auth_type = query.probed_auth_type as MCPCatalogProbedAuthType;
    }
    if (typeof query.sort === 'string') filters.sort = query.sort as MCPCatalogSort;

    return filters;
  }

  /**
   * Open a short tenant database unit around a catalog read.
   *
   * The catalog is registered as tenant-identity-only — it has no `tenant_id`
   * to scope or stamp — so no hook opens a database scope for it. In
   * `required_from_auth` mode the daemon's database proxy is built with
   * `requireScope: true` and refuses every read taken outside one, so the
   * service opens its own, the same way the scheduler and Knowledge indexer do
   * for their non-request work. On Postgres this sets `agor.tenant_id`, which
   * the catalog's open SELECT policy ignores; the scope exists to satisfy the
   * fail-closed guard, not to filter rows.
   */
  private withTenantDatabase<T>(
    work: (repository: MCPCatalogRepository) => Promise<T>
  ): Promise<T> {
    return runWithTenantDatabaseScope(this.db, getCurrentTenantId(), (scopedDb) =>
      work(new MCPCatalogRepository(scopedDb))
    );
  }

  async find(params?: MCPCatalogParams): Promise<Paginated<MCPCatalogEntry>> {
    const query = (params?.query ?? {}) as Query;
    const filters = this.filtersFor(query);

    const limit = Math.min(query.$limit ?? PAGINATION.DEFAULT_LIMIT, PAGINATION.MAX_LIMIT);
    const skip = query.$skip ?? 0;

    return this.withTenantDatabase(async (repository) => {
      const [data, total] = await Promise.all([
        repository.findAll({ ...filters, limit, offset: skip }),
        repository.count(filters),
      ]);
      return { total, limit, skip, data };
    });
  }

  /** Fetch one entry by catalog entry ID or by its reverse-DNS registry name. */
  async get(id: Id): Promise<MCPCatalogEntry> {
    const key = String(id);
    const entry = await this.withTenantDatabase(
      async (repository) => (await repository.findById(key)) ?? (await repository.findByName(key))
    );
    if (!entry) throw new NotFoundError('MCPCatalogEntry', key);
    return entry;
  }
}

export function createMCPCatalogService(db: TenantScopeAwareDatabase): MCPCatalogService {
  return new MCPCatalogService(db);
}
