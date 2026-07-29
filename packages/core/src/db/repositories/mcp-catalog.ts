/**
 * MCP Catalog Repository
 *
 * Reads and writes the shared `mcp_catalog_entries` mirror. Every list filter
 * is expressed as SQL: the marketplace searches on every keystroke over a table
 * holding thousands of registry rows, so narrowing in memory is not an option.
 *
 * Write access is split by owner: `upsertRegistryEntry` only ever touches
 * registry-sourced columns and `upsertCuration` only ever touches curation
 * columns. Neither can clobber the other, so an ingestion run and a
 * `curated.yaml` reseed are order-independent.
 */

import type {
  MCPCatalogCurationUpsert,
  MCPCatalogEntry,
  MCPCatalogEntryID,
  MCPCatalogFilters,
  MCPCatalogProbeResult,
  MCPCatalogRegistryUpsert,
  MCPCatalogSort,
} from '@agor/core/types';
import { and, asc, eq, inArray, type SQL, sql } from 'drizzle-orm';
import { generateId } from '../../lib/ids';
import type { Database } from '../client';
import { deleteFrom, insert, select, update } from '../database-wrapper';
import { type MCPCatalogEntryInsert, type MCPCatalogEntryRow, mcpCatalogEntries } from '../schema';
import { RepositoryError } from './base';

/**
 * Delimiter wrapping every materialized capability tag, so `LIKE '%|ci|%'`
 * cannot match the `ci` inside `cicd`.
 */
const CAPABILITY_DELIMITER = '|';

/** Escape character used for every LIKE pattern this repository builds. */
const LIKE_ESCAPE = '\\';

/**
 * Escape a user-supplied LIKE operand so `%`, `_`, and the escape character
 * itself match literally instead of acting as wildcards.
 */
function escapeLikeOperand(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `${LIKE_ESCAPE}${char}`);
}

/** Build a case-insensitive `contains` predicate against a text column. */
function containsInsensitive(column: SQL | unknown, value: string): SQL {
  const pattern = `%${escapeLikeOperand(value.toLowerCase())}%`;
  return sql`lower(${column}) LIKE ${pattern} ESCAPE ${LIKE_ESCAPE}`;
}

/**
 * Serialize capability tags into the materialized `capability_tags` column.
 * Returns null for an empty list so the column stays NULL rather than `||`.
 */
export function serializeCapabilityTags(capabilities: string[] | undefined): string | null {
  const normalized = [
    ...new Set((capabilities ?? []).map((tag) => tag.trim().toLowerCase()).filter(Boolean)),
  ];
  if (normalized.length === 0) return null;
  return `${CAPABILITY_DELIMITER}${normalized.join(CAPABILITY_DELIMITER)}${CAPABILITY_DELIMITER}`;
}

/**
 * Order rows for a given sort key.
 *
 * `popularity_rank` is null for the thousands of uncurated registry rows, so
 * every ordering pushes nulls last with a portable CASE rather than `NULLS
 * LAST`, and breaks ties on `name` so pagination is stable.
 */
function orderFor(sort: MCPCatalogSort | undefined): SQL[] {
  const rankedFirst = sql`CASE WHEN ${mcpCatalogEntries.popularity_rank} IS NULL THEN 1 ELSE 0 END`;
  switch (sort) {
    case 'name':
      return [sql`lower(${mcpCatalogEntries.name}) ASC`];
    case 'recently_updated':
      return [
        sql`CASE WHEN ${mcpCatalogEntries.registry_updated_at} IS NULL THEN 1 ELSE 0 END`,
        sql`${mcpCatalogEntries.registry_updated_at} DESC`,
        sql`lower(${mcpCatalogEntries.name}) ASC`,
      ];
    // `relevance` has no server-side scoring yet; curated-then-popular is a
    // better default than registry insertion order, and matches `popularity`.
    default:
      return [
        sql`CASE WHEN ${mcpCatalogEntries.curated} THEN 0 ELSE 1 END`,
        rankedFirst,
        asc(mcpCatalogEntries.popularity_rank),
        sql`lower(${mcpCatalogEntries.name}) ASC`,
      ];
  }
}

export class MCPCatalogRepository {
  constructor(private db: Database) {}

  private rowToEntry(row: MCPCatalogEntryRow): MCPCatalogEntry {
    const data = row.data ?? {};
    return {
      catalog_entry_id: row.catalog_entry_id as MCPCatalogEntryID,
      created_at: new Date(row.created_at),
      updated_at: new Date(row.updated_at),

      name: row.name,
      version: row.version ?? undefined,
      registry_updated_at: row.registry_updated_at ? new Date(row.registry_updated_at) : undefined,

      title: row.title ?? undefined,
      description: row.description ?? undefined,
      website_url: row.website_url ?? undefined,
      repository_url: row.repository_url ?? undefined,

      transport: row.transport ?? undefined,
      remote_url: row.remote_url ?? undefined,
      has_remote: Boolean(row.has_remote),
      has_package: Boolean(row.has_package),

      curated: Boolean(row.curated),
      category: (row.category as MCPCatalogEntry['category']) ?? undefined,
      capabilities: data.capabilities,
      benefit: row.benefit ?? undefined,
      starter_prompt: row.starter_prompt ?? undefined,
      permission_disclosure: row.permission_disclosure ?? undefined,
      icon_url: row.icon_url ?? undefined,
      verified: Boolean(row.verified),
      popularity_rank: row.popularity_rank ?? undefined,

      probed_auth_type: row.probed_auth_type,
      probed_at: row.probed_at ? new Date(row.probed_at) : undefined,
      auth_server_origin: row.auth_server_origin ?? undefined,

      remotes: data.remotes,
      packages: data.packages,
      registry_icons: data.registry_icons,
      registry_status: data.registry_status,
      repository_source: data.repository_source,
      probed_auth_scheme: data.probed_auth_scheme,
    };
  }

  /** Translate list filters into SQL predicates. */
  private conditionsFor(filters: MCPCatalogFilters): SQL[] {
    const conditions: SQL[] = [];

    if (filters.search?.trim()) {
      const term = filters.search.trim();
      conditions.push(
        sql`(${containsInsensitive(mcpCatalogEntries.name, term)} OR ${containsInsensitive(
          mcpCatalogEntries.title,
          term
        )} OR ${containsInsensitive(mcpCatalogEntries.description, term)})`
      );
    }
    if (filters.category) {
      conditions.push(eq(mcpCatalogEntries.category, filters.category));
    }
    if (filters.capability?.trim()) {
      const tag = filters.capability.trim().toLowerCase();
      const pattern = `%${CAPABILITY_DELIMITER}${escapeLikeOperand(tag)}${CAPABILITY_DELIMITER}%`;
      conditions.push(
        sql`${mcpCatalogEntries.capability_tags} LIKE ${pattern} ESCAPE ${LIKE_ESCAPE}`
      );
    }
    if (filters.verified !== undefined) {
      conditions.push(eq(mcpCatalogEntries.verified, filters.verified));
    }
    if (filters.curated !== undefined) {
      conditions.push(eq(mcpCatalogEntries.curated, filters.curated));
    }
    if (filters.has_remote !== undefined) {
      conditions.push(eq(mcpCatalogEntries.has_remote, filters.has_remote));
    }
    if (filters.probed_auth_type) {
      conditions.push(eq(mcpCatalogEntries.probed_auth_type, filters.probed_auth_type));
    }
    if (filters.names) {
      // An empty allowlist means "nothing matches", which `inArray` cannot express.
      if (filters.names.length === 0) return [sql`1 = 0`];
      conditions.push(inArray(mcpCatalogEntries.name, filters.names));
    }

    return conditions;
  }

  /** List entries. Every filter, sort, and page bound is applied in SQL. */
  async findAll(filters: MCPCatalogFilters = {}): Promise<MCPCatalogEntry[]> {
    try {
      const conditions = this.conditionsFor(filters);
      let query = select(this.db).from(mcpCatalogEntries);
      if (conditions.length > 0) query = query.where(and(...conditions));
      query = query.orderBy(...orderFor(filters.sort));
      if (filters.limit !== undefined) query = query.limit(filters.limit);
      // Postgres rejects OFFSET without LIMIT in some planners' generated SQL;
      // Drizzle emits both independently, so only chain what the caller asked for.
      if (filters.offset) query = query.offset(filters.offset);

      const rows = await query.all();
      return rows.map((row: MCPCatalogEntryRow) => this.rowToEntry(row));
    } catch (error) {
      throw new RepositoryError(
        `Failed to list MCP catalog entries: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /** Count entries matching the same filters, without reading their columns. */
  async count(filters: MCPCatalogFilters = {}): Promise<number> {
    try {
      const conditions = this.conditionsFor(filters);
      let query = select(this.db, { value: sql<number>`count(*)` }).from(mcpCatalogEntries);
      if (conditions.length > 0) query = query.where(and(...conditions));
      const row = await query.one();
      return Number(row?.value ?? 0);
    } catch (error) {
      throw new RepositoryError(
        `Failed to count MCP catalog entries: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  async findById(catalogEntryId: string): Promise<MCPCatalogEntry | null> {
    const row = await select(this.db)
      .from(mcpCatalogEntries)
      .where(eq(mcpCatalogEntries.catalog_entry_id, catalogEntryId))
      .one();
    return row ? this.rowToEntry(row) : null;
  }

  /** Look up by reverse-DNS registry name, the catalog's natural key. */
  async findByName(name: string): Promise<MCPCatalogEntry | null> {
    const row = await select(this.db)
      .from(mcpCatalogEntries)
      .where(eq(mcpCatalogEntries.name, name))
      .one();
    return row ? this.rowToEntry(row) : null;
  }

  private async rawByName(name: string): Promise<MCPCatalogEntryRow | null> {
    return select(this.db).from(mcpCatalogEntries).where(eq(mcpCatalogEntries.name, name)).one();
  }

  /**
   * Apply one registry record.
   *
   * Returns `'created'`, `'updated'`, or `'unchanged'`. A record whose
   * `registry_updated_at` is not newer than the stored value is skipped, which
   * is what keeps a full re-ingestion of 4,000+ servers cheap: only genuinely
   * republished entries cause a write.
   */
  async upsertRegistryEntry(
    entry: MCPCatalogRegistryUpsert
  ): Promise<'created' | 'updated' | 'unchanged'> {
    const now = new Date();
    const existing = await this.rawByName(entry.name);

    const registryColumns = {
      version: entry.version ?? null,
      registry_updated_at: entry.registry_updated_at ?? null,
      repository_url: entry.repository_url ?? null,
      has_package: (entry.packages?.length ?? 0) > 0,
      updated_at: now,
    };

    if (!existing) {
      const row: MCPCatalogEntryInsert = {
        catalog_entry_id: generateId(),
        created_at: now,
        name: entry.name,
        title: entry.title ?? null,
        description: entry.description ?? null,
        website_url: entry.website_url ?? null,
        transport: entry.transport ?? null,
        remote_url: entry.remote_url ?? null,
        has_remote: Boolean(entry.remote_url),
        data: {
          remotes: entry.remotes,
          packages: entry.packages,
          registry_icons: entry.registry_icons,
          registry_status: entry.registry_status,
          repository_source: entry.repository_source,
          ...(entry.remote_url ? { connect_surface_source: 'registry' as const } : {}),
        },
        ...registryColumns,
      };
      await insert(this.db, mcpCatalogEntries).values(row).run();
      return 'created';
    }

    const storedAt = existing.registry_updated_at
      ? new Date(existing.registry_updated_at).getTime()
      : null;
    const incomingAt = entry.registry_updated_at?.getTime() ?? null;
    // Re-ingesting the same publication is the overwhelmingly common case.
    if (storedAt !== null && incomingAt !== null && incomingAt <= storedAt) return 'unchanged';

    // Two different precedence rules, deliberately:
    //
    // Editorial copy is curation's to own — a hand-written title should not be
    // replaced by the registry's on every republication.
    const preferCurated = <T>(curatedValue: T | null, incoming: T | undefined): T | null =>
      existing.curated && curatedValue !== null && curatedValue !== undefined
        ? curatedValue
        : (incoming ?? null);

    // The connect surface is the registry's wherever it has an opinion, but a
    // registry that publishes a package-only release has no opinion about a
    // remote URL — and nulling the curated one there would silently remove the
    // entry's only way to connect.
    const preferRegistry = <T>(curatedValue: T | null, incoming: T | undefined): T | null =>
      incoming ?? (existing.curated ? curatedValue : null);

    const remoteUrl = preferRegistry(existing.remote_url, entry.remote_url);
    // `transport` describes `remote_url`, so it has to follow whichever one
    // won. Taking the registry's `stdio` while keeping a curated remote URL
    // would describe the row as unconnectable over HTTP when it is not.
    const transport =
      remoteUrl === entry.remote_url
        ? (entry.transport ?? null)
        : (existing.transport ?? entry.transport ?? null);

    await update(this.db, mcpCatalogEntries)
      .set({
        ...registryColumns,
        title: preferCurated(existing.title, entry.title),
        description: preferCurated(existing.description, entry.description),
        website_url: preferRegistry(existing.website_url, entry.website_url),
        transport,
        remote_url: remoteUrl,
        has_remote: Boolean(remoteUrl),
        data: {
          ...(existing.data ?? {}),
          remotes: entry.remotes,
          packages: entry.packages,
          registry_icons: entry.registry_icons,
          registry_status: entry.registry_status,
          repository_source: entry.repository_source,
          // The registry owns the surface whenever it published one; otherwise
          // whatever owned it before still does.
          ...(entry.remote_url ? { connect_surface_source: 'registry' as const } : {}),
        },
      })
      .where(eq(mcpCatalogEntries.catalog_entry_id, existing.catalog_entry_id))
      .run();
    return 'updated';
  }

  /**
   * Apply one `curated.yaml` record onto the row with the same registry name,
   * creating a placeholder row when the registry has not published it yet.
   */
  async upsertCuration(entry: MCPCatalogCurationUpsert): Promise<'created' | 'updated'> {
    const now = new Date();
    const existing = await this.rawByName(entry.name);

    const curationColumns = {
      curated: true,
      category: entry.category,
      capability_tags: serializeCapabilityTags(entry.capabilities),
      benefit: entry.benefit,
      starter_prompt: entry.starter_prompt,
      permission_disclosure: entry.permission_disclosure,
      icon_url: entry.icon_url ?? null,
      verified: entry.verified,
      popularity_rank: entry.popularity_rank ?? null,
      updated_at: now,
    };

    if (!existing) {
      await insert(this.db, mcpCatalogEntries)
        .values({
          catalog_entry_id: generateId(),
          created_at: now,
          name: entry.name,
          title: entry.title ?? null,
          description: entry.description ?? null,
          website_url: entry.website_url ?? null,
          transport: entry.transport ?? null,
          remote_url: entry.remote_url ?? null,
          has_remote: Boolean(entry.remote_url),
          data: {
            capabilities: entry.capabilities,
            ...(entry.remote_url ? { connect_surface_source: 'curation' as const } : {}),
          },
          ...curationColumns,
        } satisfies MCPCatalogEntryInsert)
        .run();
      return 'created';
    }

    // `transport` describes `remote_url`, so the pair moves as a unit from one
    // source or the other, never mixed: a registry package-only row (`stdio`,
    // no remote) keeping its `stdio` while curation supplies an HTTPS remote
    // would describe the row as unconnectable over HTTP when it is not.
    //
    // Ownership is read from recorded provenance rather than inferred from the
    // column being non-null. Inferring it would pin the first curated URL
    // forever, because an edited `curated.yaml` would see its own earlier value
    // sitting there and defer to it.
    const registryOwnsSurface =
      existing.data?.connect_surface_source === 'registry' && Boolean(existing.remote_url);
    const connectSurface = registryOwnsSurface
      ? { remote_url: existing.remote_url, transport: existing.transport }
      : { remote_url: entry.remote_url ?? null, transport: entry.transport ?? null };

    await update(this.db, mcpCatalogEntries)
      .set({
        ...curationColumns,
        title: entry.title ?? existing.title,
        description: entry.description ?? existing.description,
        website_url: entry.website_url ?? existing.website_url,
        transport: connectSurface.transport,
        remote_url: connectSurface.remote_url,
        has_remote: Boolean(connectSurface.remote_url),
        data: {
          ...(existing.data ?? {}),
          capabilities: entry.capabilities,
          ...(registryOwnsSurface ? {} : { connect_surface_source: 'curation' as const }),
        },
      })
      .where(eq(mcpCatalogEntries.catalog_entry_id, existing.catalog_entry_id))
      .run();
    return 'updated';
  }

  /**
   * Retire a row the registry has withdrawn.
   *
   * An uncurated row is deleted outright: it exists only to mirror a registry
   * record that no longer exists. A curated row is kept but has its
   * registry-owned connect surface cleared, so it stops being offered without
   * silently destroying hand-written curation — the curator is told through the
   * returned outcome and decides whether to remove the entry from
   * `curated.yaml`.
   */
  async retireWithdrawnEntry(name: string): Promise<'deleted' | 'retired-curated' | 'absent'> {
    const existing = await this.rawByName(name);
    if (!existing) return 'absent';

    if (!existing.curated) {
      await deleteFrom(this.db, mcpCatalogEntries)
        .where(eq(mcpCatalogEntries.catalog_entry_id, existing.catalog_entry_id))
        .run();
      return 'deleted';
    }

    await update(this.db, mcpCatalogEntries)
      .set({
        remote_url: null,
        has_remote: false,
        transport: null,
        // The verdict described an endpoint that is no longer offered.
        probed_auth_type: 'unknown',
        probed_at: null,
        auth_server_origin: null,
        updated_at: new Date(),
        data: { ...(existing.data ?? {}), registry_status: 'deleted' },
      })
      .where(eq(mcpCatalogEntries.catalog_entry_id, existing.catalog_entry_id))
      .run();
    return 'retired-curated';
  }

  /** Cache an auth probe verdict on the row. */
  async recordProbeResult(name: string, result: MCPCatalogProbeResult): Promise<void> {
    const existing = await this.rawByName(name);
    if (!existing) return;

    await update(this.db, mcpCatalogEntries)
      .set({
        probed_auth_type: result.probed_auth_type,
        probed_at: result.probed_at,
        auth_server_origin: result.auth_server_origin ?? null,
        data: { ...(existing.data ?? {}), probed_auth_scheme: result.probed_auth_scheme },
        updated_at: new Date(),
      })
      .where(eq(mcpCatalogEntries.catalog_entry_id, existing.catalog_entry_id))
      .run();
  }

  /**
   * Entries with a remote URL whose probe is missing or older than `staleBefore`,
   * oldest first, so a bounded per-run probe budget cycles through the catalog
   * instead of re-probing the same head every run.
   */
  async findEntriesNeedingProbe(staleBefore: Date, limit: number): Promise<MCPCatalogEntry[]> {
    const rows = await select(this.db)
      .from(mcpCatalogEntries)
      .where(
        and(
          eq(mcpCatalogEntries.has_remote, true),
          sql`(${mcpCatalogEntries.probed_at} IS NULL OR ${mcpCatalogEntries.probed_at} < ${staleBefore})`
        )
      )
      .orderBy(
        sql`CASE WHEN ${mcpCatalogEntries.probed_at} IS NULL THEN 0 ELSE 1 END`,
        asc(mcpCatalogEntries.probed_at),
        // Curated entries are the ones the UI actually renders a connect button
        // for, so they get the probe budget first.
        sql`CASE WHEN ${mcpCatalogEntries.curated} THEN 0 ELSE 1 END`,
        asc(mcpCatalogEntries.popularity_rank)
      )
      .limit(limit)
      .all();
    return rows.map((row: MCPCatalogEntryRow) => this.rowToEntry(row));
  }
}
