/**
 * MCP Catalog Service
 *
 * Read-only browse surface over the checked-in catalog. `create`, `update`,
 * `patch`, and `remove` are deliberately absent: the catalog's contents are a
 * file in this repository, so the way to change them is a pull request.
 *
 * This does not extend `DrizzleService`. There is no table behind it — the
 * catalog is parsed lazily on its first read, cached in the process, and every
 * later read is served from there.
 *
 * Two methods, for two different callers: `find` hands the Marketplace the
 * whole catalog to filter in the browser, and `get` resolves one entry by name
 * for the connect flow, which is given a `catalog_key` and needs the URL and
 * transport behind it.
 */

import { filterCatalog, findCatalogEntry, loadCatalog } from '@agor/core/mcp-catalog';
import type { AuthenticatedParams, Id, MCPCatalogEntry, Paginated } from '@agor/core/types';
import { NotFoundError } from '@agor/core/utils/errors';

export type MCPCatalogParams = AuthenticatedParams;

export class MCPCatalogService {
  /** Overrides the checked-in file. Tests pass this. */
  constructor(private filePath?: string) {}

  /**
   * The whole catalog, every time.
   *
   * There is nothing to narrow here and no page to take. The current static
   * catalog is bounded and small enough to hand to the browser in one response,
   * so it filters, orders and pages what it holds. That makes
   * search a keystroke instead of a debounced round trip, and it is why this
   * takes no query: a `search=` or `$skip=` that reached this method would have
   * to be implemented twice to mean the same thing in both places.
   *
   * The `Paginated` envelope stays because it is the wire shape every client
   * already parses, and because `total` is the count the grid renders.
   */
  async find(_params?: MCPCatalogParams): Promise<Paginated<MCPCatalogEntry>> {
    // Ordered by the default sort rather than handed over in file order. It
    // costs one pass, it makes the response deterministic instead of a
    // consequence of how `curated.yaml` happens to be arranged, and a client
    // from before this change renders `data` as its first page directly — so
    // this is the order it would have been served anyway.
    //
    // `filterCatalog` builds a fresh array, so the held catalog is never handed
    // out to be mutated by whatever serializes it.
    const data = filterCatalog(await loadCatalog(this.filePath));
    return { total: data.length, limit: data.length, skip: 0, data };
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
