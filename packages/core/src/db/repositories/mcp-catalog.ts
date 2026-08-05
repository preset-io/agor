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
  MCPCatalogEntryData,
  MCPCatalogEntryID,
  MCPCatalogFilters,
  MCPCatalogProbeResult,
  MCPCatalogRegistryUpsert,
  MCPCatalogSort,
  MCPCatalogSourceValues,
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
 * Columns both writers can fill, derived from what each side last published.
 *
 * Deriving rather than accumulating is what makes a withdrawal recoverable. A
 * row that stored only the winning value could not answer "what should this be
 * now that curation stopped supplying it" — the registry's copy would be gone,
 * and nothing would rewrite it until that server happened to republish.
 *
 * Editorial copy prefers curation because that is the point of the overlay. The
 * connect surface prefers the registry because it is the authority on its own
 * endpoints, and `transport` travels with whichever `remote_url` won: a registry
 * `stdio` beside a curated HTTPS remote would describe the row as unconnectable
 * over HTTP when it is not.
 */
function deriveSharedColumns(
  registry: MCPCatalogSourceValues,
  curation: MCPCatalogSourceValues
): {
  title: string | null;
  description: string | null;
  website_url: string | null;
  remote_url: string | null;
  transport: MCPCatalogEntry['transport'] | null;
} {
  const surface = registry.remote_url ? registry : curation.remote_url ? curation : null;
  return {
    title: curation.title ?? registry.title ?? null,
    description: curation.description ?? registry.description ?? null,
    website_url: curation.website_url ?? registry.website_url ?? null,
    remote_url: surface?.remote_url ?? null,
    // With no remote at all the registry may still describe a package-only
    // release, which is a real transport for a row nothing can dial over HTTP.
    transport: (surface ? surface.transport : registry.transport) ?? null,
  };
}

/** Strip undefined members so an absent value is absent from the stored blob. */
function sourceValues(values: MCPCatalogSourceValues): MCPCatalogSourceValues {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined)
  ) as MCPCatalogSourceValues;
}

/**
 * Probe columns to rewrite when a row's endpoint moves.
 *
 * A verdict describes the endpoint it was collected from, not the row it is
 * stored on. Left in place across a URL change, a replacement endpoint inherits
 * the previous one's answer until the staleness window expires — including
 * `none`, the one verdict that renders a connect-directly button. Returns null
 * when the endpoint did not move.
 *
 * Written rather than resolved at read time because the marketplace filters on
 * `probed_auth_type` in SQL: a verdict only the read path knew to ignore would
 * still match `WHERE probed_auth_type = 'none'`.
 */
function probeInvalidation(previousUrl: string | null, nextUrl: string | null) {
  if ((previousUrl ?? null) === (nextUrl ?? null)) return null;
  return { probed_auth_type: 'unknown' as const, probed_at: null, auth_server_origin: null };
}

/** Drop the blob half of a probe verdict, alongside {@link probeInvalidation}. */
function withoutProbeMetadata(data: MCPCatalogEntryData): MCPCatalogEntryData {
  const { probed_url, probed_auth_scheme, ...rest } = data;
  return rest;
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
      probed_url: data.probed_url,
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

    if (filters.catalog_entry_id) {
      conditions.push(eq(mcpCatalogEntries.catalog_entry_id, filters.catalog_entry_id));
    }
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

    const registrySide = sourceValues({
      title: entry.title,
      description: entry.description,
      website_url: entry.website_url,
      remote_url: entry.remote_url,
      transport: entry.transport,
    });

    if (!existing) {
      const shared = deriveSharedColumns(registrySide, {});
      const row: MCPCatalogEntryInsert = {
        catalog_entry_id: generateId(),
        created_at: now,
        name: entry.name,
        ...shared,
        has_remote: Boolean(shared.remote_url),
        data: {
          registry_mirrored: true,
          registry: registrySide,
          remotes: entry.remotes,
          packages: entry.packages,
          registry_icons: entry.registry_icons,
          registry_status: entry.registry_status,
          repository_source: entry.repository_source,
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

    const existingData = existing.data ?? {};
    const shared = deriveSharedColumns(registrySide, existingData.curation ?? {});
    const probeReset = probeInvalidation(existing.remote_url, shared.remote_url);

    await update(this.db, mcpCatalogEntries)
      .set({
        ...registryColumns,
        ...shared,
        has_remote: Boolean(shared.remote_url),
        ...(probeReset ?? {}),
        data: {
          ...(probeReset ? withoutProbeMetadata(existingData) : existingData),
          registry_mirrored: true,
          registry: registrySide,
          remotes: entry.remotes,
          packages: entry.packages,
          registry_icons: entry.registry_icons,
          registry_status: entry.registry_status,
          repository_source: entry.repository_source,
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

    // Rewritten in full each seed rather than merged into what is already
    // stored: dropping `title` from `curated.yaml` has to hand that field back
    // to the registry, and an additive update could never express a removal.
    const curationSide = sourceValues({
      title: entry.title,
      description: entry.description,
      website_url: entry.website_url,
      remote_url: entry.remote_url,
      transport: entry.transport,
    });

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
      const shared = deriveSharedColumns({}, curationSide);
      await insert(this.db, mcpCatalogEntries)
        .values({
          catalog_entry_id: generateId(),
          created_at: now,
          name: entry.name,
          ...shared,
          has_remote: Boolean(shared.remote_url),
          data: { capabilities: entry.capabilities, curation: curationSide },
          ...curationColumns,
        } satisfies MCPCatalogEntryInsert)
        .run();
      return 'created';
    }

    const existingData = existing.data ?? {};
    const shared = deriveSharedColumns(existingData.registry ?? {}, curationSide);
    const probeReset = probeInvalidation(existing.remote_url, shared.remote_url);

    await update(this.db, mcpCatalogEntries)
      .set({
        ...curationColumns,
        ...shared,
        has_remote: Boolean(shared.remote_url),
        ...(probeReset ?? {}),
        data: {
          ...(probeReset ? withoutProbeMetadata(existingData) : existingData),
          capabilities: entry.capabilities,
          curation: curationSide,
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
   * record that no longer exists.
   *
   * A curated row keeps its curation and is re-derived from it. The registry
   * source stops being live — its stored values, its mirror marker, and its
   * identity columns all go — so an endpoint the registry published is
   * withdrawn while one `curated.yaml` supplies stays on offer. The curator is
   * told through the returned outcome and decides whether to drop the entry;
   * until they do, the file remains the source of truth for what is offered.
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

    // The registry source stops being live, not merely loses its endpoint. Every
    // signal that says "the registry publishes this" has to go together —
    // `data.registry`, the mirror marker, and the `version` / `registry_updated_at`
    // columns — because a curation withdrawal later reads all of them to decide
    // whether anything is left underneath the overlay. Leaving any one behind
    // turns a withdrawn server into a browsable uncurated row.
    const data = existing.data ?? {};
    const { registry, ...remaining } = withoutProbeMetadata(data);
    // Re-derived from whatever source is still live rather than blanked: only
    // the registry withdrew, so an endpoint curation still supplies is still the
    // file's answer and stays on offer.
    const shared = deriveSharedColumns({}, data.curation ?? {});
    const probeReset = probeInvalidation(existing.remote_url, shared.remote_url);

    await update(this.db, mcpCatalogEntries)
      .set({
        ...shared,
        has_remote: Boolean(shared.remote_url),
        version: null,
        registry_updated_at: null,
        ...(probeReset ?? {}),
        updated_at: new Date(),
        data: {
          ...remaining,
          registry_mirrored: false,
          registry_status: 'deleted',
        },
      })
      .where(eq(mcpCatalogEntries.catalog_entry_id, existing.catalog_entry_id))
      .run();
    return 'retired-curated';
  }

  /**
   * Cache an auth probe verdict on the row.
   *
   * Discarded when the row's endpoint moved while the probe was in flight —
   * probing happens outside any database unit, so the URL read at selection time
   * is not guaranteed to still be the row's, and writing anyway would recreate
   * exactly the stale-verdict-on-a-new-endpoint case the invalidation prevents.
   */
  async recordProbeResult(name: string, result: MCPCatalogProbeResult): Promise<void> {
    const existing = await this.rawByName(name);
    if (!existing) return;
    if (existing.remote_url !== result.probed_url) return;

    await update(this.db, mcpCatalogEntries)
      .set({
        probed_auth_type: result.probed_auth_type,
        probed_at: result.probed_at,
        auth_server_origin: result.auth_server_origin ?? null,
        data: {
          ...(existing.data ?? {}),
          probed_url: result.probed_url,
          probed_auth_scheme: result.probed_auth_scheme,
        },
        updated_at: new Date(),
      })
      .where(eq(mcpCatalogEntries.catalog_entry_id, existing.catalog_entry_id))
      .run();
  }

  /** Names of every row currently carrying a curation overlay. */
  async listCuratedNames(): Promise<string[]> {
    const rows = await select(this.db, { name: mcpCatalogEntries.name })
      .from(mcpCatalogEntries)
      .where(eq(mcpCatalogEntries.curated, true))
      .all();
    return rows.map((row: { name: string }) => row.name);
  }

  /**
   * Withdraw the curation overlay from a row `curated.yaml` no longer names.
   *
   * The seed is otherwise additive, which makes the file the source of truth
   * only for entries it still contains: a deleted entry keeps its shelf and its
   * benefit copy forever, and a rename orphans the old name behind the new one.
   *
   * A row the registry also mirrors keeps its registry half and simply stops
   * being curated. A row that existed only because the file named it is deleted
   * outright — there is nothing underneath it to fall back to.
   */
  async retireCuration(name: string): Promise<'deleted' | 'uncurated' | 'absent'> {
    const existing = await this.rawByName(name);
    if (!existing?.curated) return 'absent';

    const data = existing.data ?? {};
    // "Live", not "ever mirrored": a withdrawn registry source clears all three
    // of these together, so a row whose registry half is gone is deleted rather
    // than left browsable with nothing behind it. The version and timestamp
    // columns are the fallback for rows mirrored before the marker existed;
    // both are registry-only, so neither can be true of a curation-created row.
    const registryIsLive =
      data.registry_mirrored === true ||
      existing.version !== null ||
      existing.registry_updated_at !== null;

    if (!registryIsLive) {
      await deleteFrom(this.db, mcpCatalogEntries)
        .where(eq(mcpCatalogEntries.catalog_entry_id, existing.catalog_entry_id))
        .run();
      return 'deleted';
    }

    // Withdrawing the overlay re-derives the row from the registry side alone,
    // which is what restores registry copy the overlay had been covering. A row
    // that stored only the winning value would keep hand-written text on an
    // uncurated row, attributed to a registry that never published it.
    const { capabilities, curation, ...registryData } = data;
    const shared = deriveSharedColumns(registryData.registry ?? {}, {});
    const probeReset = probeInvalidation(existing.remote_url, shared.remote_url);

    await update(this.db, mcpCatalogEntries)
      .set({
        curated: false,
        category: null,
        capability_tags: null,
        benefit: null,
        starter_prompt: null,
        permission_disclosure: null,
        icon_url: null,
        // `verified` is a curation claim; without the overlay there is nobody
        // making it.
        verified: false,
        popularity_rank: null,
        ...shared,
        has_remote: Boolean(shared.remote_url),
        ...(probeReset ?? {}),
        updated_at: new Date(),
        data: probeReset ? withoutProbeMetadata(registryData) : registryData,
      })
      .where(eq(mcpCatalogEntries.catalog_entry_id, existing.catalog_entry_id))
      .run();
    return 'uncurated';
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
