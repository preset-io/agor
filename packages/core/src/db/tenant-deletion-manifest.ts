/**
 * Runtime-owned manifest of tenant-scoped database tables.
 *
 * A standalone multi-tenant PostgreSQL runtime occasionally needs to
 * permanently remove every trace of a single tenant (offboarding, data-removal
 * requests, regulatory erasure). This module supplies an exhaustive,
 * machine-derived list of tenant tables and a defensive order based on the
 * compiled schema's foreign keys.
 *
 * The order is not proof of foreign-key tenant consistency. PostgreSQL RLS does
 * not prevent a row from creating a cross-tenant reference and does not limit
 * referential actions such as cascades. The live schema and data must maintain
 * the deletion engine's tenant-consistent foreign-key precondition.
 *
 * This module derives that manifest directly from the PostgreSQL schema
 * definitions (`schema.postgres.ts`) rather than hand-maintaining a list, so a
 * newly added table is picked up automatically. Every table is classified as:
 *
 *   - `direct`     — carries a `tenant_id` column and is deleted with
 *                    `WHERE tenant_id = $1`.
 *   - `transitive` — has no `tenant_id` column but reaches a scoped table via a
 *                    foreign-key chain; detected so deletion can fail closed
 *                    until that shape has an orphan-safe implementation.
 *   - `global`     — explicitly declared as holding no tenant data (see
 *                    {@link GLOBAL_TABLES}); left untouched.
 *
 * The companion exhaustiveness test fails the build if any schema table falls
 * into none of those buckets, so a future table cannot silently escape
 * tenant deletion.
 *
 * Multi-tenancy is a PostgreSQL-only feature in Agor (the SQLite schema is
 * single-tenant and has no `tenant_id` columns), so this manifest is built from
 * the PostgreSQL schema exclusively.
 */

import type { MCPCatalogEntryData } from '@agor/core/types';
import { is } from 'drizzle-orm';
import { getTableConfig, type PgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { mcpCatalogEntries } from './schema.postgres';
import * as postgresSchema from './schema.postgres';

/** Name of the column that scopes a row to a tenant. */
export const TENANT_SCOPE_COLUMN = 'tenant_id';

/**
 * Tables that legitimately hold no tenant-scoped data and must therefore be
 * left untouched by tenant deletion.
 *
 * This list is intentionally explicit: the exhaustiveness test fails if a schema
 * table is neither tenant-scoped, transitively tenant-scoped, nor named here, so
 * a new global table cannot be introduced without a conscious decision recorded
 * in this set.
 *
 * `mcp_catalog_entries` mirrors the public MCP registry and joins a curated
 * overlay checked into this repository onto it. Every field originates outside
 * any tenant, and Agor has no tenant registry to enumerate, so a per-tenant copy
 * of the mirror could never be kept in sync. Its Postgres RLS policies keep
 * reads open to all tenants and confine writes to the `mcp_catalog_ingestion`
 * system capability.
 *
 * **The invariant is per column, not per table.** A table qualifies only while
 * every one of its columns is sourced from outside every tenant — a public
 * registry, or a file in this repository. Adding a column derived from tenant
 * activity (a connect counter, a rating, a last-used timestamp) silently breaks
 * the justification above even though the table stays in this set: the value
 * aggregates across tenants on read, and its only writer would be a tenant
 * request path, which the write policy correctly refuses. Such a column belongs
 * in its own tenant-scoped table. `GLOBAL_TABLE_COLUMN_SOURCES` records the
 * per-column decision so the companion test can hold a reviewer to it.
 *
 * Note: Drizzle's own migration bookkeeping table (`drizzle.__drizzle_migrations`)
 * is not part of the application schema exports and is never enumerated by this
 * manifest.
 */
export const GLOBAL_TABLES: ReadonlySet<string> = new Set<string>(['mcp_catalog_entries']);

/**
 * Where a column of a global table gets its value.
 *
 * The vocabulary is deliberately narrow. The invariant a global table has to
 * hold is "no column derives from tenant activity", and a broad label like
 * `derived` cannot express that — it reads as "Agor computed it", which is
 * exactly what a usage counter is, so the next person adding one finds a label
 * that appears to fit and the guard passes. Naming what each value is computed
 * *from* leaves no label a counter can honestly take:
 *
 * - `registry` — mirrored verbatim from the public MCP registry.
 * - `repo` — supplied by `curated.yaml`, checked into this repository.
 * - `computed-from-registry` — Agor computed it, from registry data alone.
 * - `computed-from-repo` — Agor computed it, from repository data alone.
 * - `row-identity` — this row's own identity and write timestamps.
 * - `probe` — discovered by probing a public endpoint the registry named.
 * - `composite` — a JSON column whose keys have different sources, classified
 *   one level down in {@link GLOBAL_BLOB_KEY_SOURCES}. Not a licence to skip
 *   the question: a `composite` column with no entry there is a type error.
 *
 * A column fed by user behaviour fits none of these. It belongs in its own
 * tenant-scoped table, and the absence of a label is the prompt to build one.
 */
export type GlobalColumnSource =
  | 'registry'
  | 'repo'
  | 'computed-from-registry'
  | 'computed-from-repo'
  | 'row-identity'
  | 'probe'
  | 'composite';

/**
 * Every column of every global table, classified.
 *
 * `satisfies` against the compiled Drizzle table is what makes this binding:
 * adding a column to the schema without classifying it is a type error in the
 * editor and in `tsc`, not a test failure someone sees after pushing.
 */
type ColumnsOf<T extends PgTable> = keyof T['_']['columns'] & string;

export const GLOBAL_TABLE_COLUMN_SOURCES = {
  mcp_catalog_entries: {
    catalog_entry_id: 'row-identity',
    created_at: 'row-identity',
    updated_at: 'row-identity',
    name: 'registry',
    version: 'registry',
    registry_updated_at: 'registry',
    title: 'registry',
    description: 'registry',
    website_url: 'registry',
    repository_url: 'registry',
    transport: 'registry',
    remote_url: 'registry',
    has_remote: 'computed-from-registry',
    has_package: 'computed-from-registry',
    curated: 'computed-from-repo',
    category: 'repo',
    capability_tags: 'repo',
    benefit: 'repo',
    starter_prompt: 'repo',
    permission_disclosure: 'repo',
    icon_url: 'repo',
    verified: 'repo',
    popularity_rank: 'repo',
    probed_auth_type: 'probe',
    probed_at: 'probe',
    auth_server_origin: 'probe',
    registry_status: 'registry',
    data: 'composite',
  },
  // One key per table in GLOBAL_TABLES, spelled out rather than `Record<string,
  // ...>` so each table is checked against its own columns.
} satisfies {
  mcp_catalog_entries: Record<ColumnsOf<typeof mcpCatalogEntries>, GlobalColumnSource>;
};

/**
 * Every key of every `composite` column, classified.
 *
 * The column-level guard is airtight against the easy mistake and blind to the
 * likely one. A JSON column is schemaless in the database: a `connect_count` or
 * a `last_used_by_tenant` key needs no migration, changes no Drizzle table, and
 * so trips nothing at the column level — while breaking the same invariant a new
 * column would. The `satisfies` below closes that by binding to the TypeScript
 * interface the blob is written through, which is the one place such a key has
 * to be declared.
 *
 * Keys are optional on the interface but required here: `Required<...>` is what
 * makes an unclassified key a compile error rather than a silently absent entry.
 */
export const GLOBAL_BLOB_KEY_SOURCES = {
  mcp_catalog_entries: {
    data: {
      remotes: 'registry',
      packages: 'registry',
      registry_icons: 'registry',
      registry_mirrored: 'computed-from-registry',
      registry: 'registry',
      capabilities: 'repo',
      curation: 'repo',
      repository_source: 'registry',
      probed_auth_scheme: 'probe',
      probed_url: 'probe',
    },
  },
} satisfies {
  mcp_catalog_entries: {
    data: Record<keyof Required<MCPCatalogEntryData>, GlobalColumnSource>;
  };
};

/** Full classification of a table, including non-tenant tables. */
export type TableClassification = 'direct' | 'transitive' | 'global';

/** A table that holds tenant data and must be included in deletion. */
export interface TenantDeletionTable {
  /** Physical table name. */
  name: string;
  /** Drizzle table object, used to build type-safe queries. */
  table: PgTable;
  /** Deletion entries are always scoped directly by this tenant column. */
  scope: 'direct';
  tenantColumn: PgColumn;
}

interface ForeignKeyMeta {
  parentTable: string;
  onDelete?: string;
}

interface TableMeta {
  table: PgTable;
  columns: PgColumn[];
  foreignKeys: ForeignKeyMeta[];
}

/**
 * An `ON DELETE` action blocks deletion of the referenced (parent) row while a
 * referencing (child) row still exists. Only `restrict` and `no action` (the
 * default when unspecified) block; `cascade`, `set null`, and `set default`
 * never do. Blocking edges are the only ones that constrain deletion order.
 */
function isBlockingOnDelete(onDelete: string | undefined): boolean {
  return onDelete === undefined || onDelete === 'no action' || onDelete === 'restrict';
}

/**
 * Blocking and cascading edges both order a child before its parent. SET NULL
 * and SET DEFAULT edges are deliberately excluded: they do not block deletion,
 * and the schema contains cycles through those actions.
 */
function isOrderingOnDelete(onDelete: string | undefined): boolean {
  return isBlockingOnDelete(onDelete) || onDelete === 'cascade';
}

let cachedTableMetas: Map<string, TableMeta> | null = null;

function discoverTableMetas(): Map<string, TableMeta> {
  if (cachedTableMetas) return cachedTableMetas;
  const metas = new Map<string, TableMeta>();
  for (const value of Object.values(postgresSchema)) {
    if (!is(value, PgTable)) continue;
    const config = getTableConfig(value);
    const foreignKeys: ForeignKeyMeta[] = config.foreignKeys.map((fk) => {
      const reference = fk.reference();
      return {
        parentTable: getTableConfig(reference.foreignTable).name,
        onDelete: fk.onDelete,
      };
    });
    metas.set(config.name, {
      table: value,
      columns: config.columns as PgColumn[],
      foreignKeys,
    });
  }
  cachedTableMetas = metas;
  return metas;
}

function hasTenantColumn(meta: TableMeta): boolean {
  return meta.columns.some((column) => column.name === TENANT_SCOPE_COLUMN);
}

export interface TableClassificationResult {
  direct: string[];
  transitive: string[];
  global: string[];
  /** Tables that could not be classified — a bug that must fail the build. */
  unclassified: string[];
}

/**
 * Classify every PostgreSQL table into direct / transitive / global, computing
 * the transitive set to a fixpoint over foreign-key chains.
 */
export function classifyPostgresTables(): TableClassificationResult {
  const metas = discoverTableMetas();

  const global = new Set<string>();
  const direct = new Set<string>();
  for (const [name, meta] of metas) {
    if (GLOBAL_TABLES.has(name)) {
      global.add(name);
      continue;
    }
    if (hasTenantColumn(meta)) direct.add(name);
  }

  const transitive = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, meta] of metas) {
      if (global.has(name) || direct.has(name) || transitive.has(name)) continue;
      const reachesScoped = meta.foreignKeys.some(
        (fk) => direct.has(fk.parentTable) || transitive.has(fk.parentTable)
      );
      if (reachesScoped) {
        transitive.add(name);
        changed = true;
      }
    }
  }

  // Checked once the fixpoint has settled, so `transitive` is complete. A global
  // table is skipped by the loop above and can never be classified transitive no
  // matter what it references, which makes the exemption honest only while the
  // table reaches no tenant-scoped row. An FK from here into tenant space would
  // leave deletion either blocking on the constraint or cascading rows out of a
  // table declared untouchable — and every other guard would still pass.
  for (const name of global) {
    for (const fk of metas.get(name)?.foreignKeys ?? []) {
      if (direct.has(fk.parentTable) || transitive.has(fk.parentTable)) {
        throw new Error(
          `${name} is declared global but has a foreign key into tenant-scoped ${fk.parentTable}`
        );
      }
    }
  }

  const unclassified: string[] = [];
  for (const name of metas.keys()) {
    if (!global.has(name) && !direct.has(name) && !transitive.has(name)) unclassified.push(name);
  }

  return {
    direct: [...direct].sort(),
    transitive: [...transitive].sort(),
    global: [...global].sort(),
    unclassified: unclassified.sort(),
  };
}

/**
 * Order manifest tables children-first so that, for every blocking or cascading
 * foreign key in the compiled schema, the referencing table is deleted before
 * the table it references. Implemented as a Kahn topological sort;
 * deterministic via name-sorted tie-breaking. This ordering does not validate
 * row-level tenant equality across those references.
 */
function orderChildrenFirst(
  entries: TenantDeletionTable[],
  metas: Map<string, TableMeta>
): TenantDeletionTable[] {
  const inManifest = new Set(entries.map((entry) => entry.name));
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const indegree = new Map<string, number>();
  for (const entry of entries) indegree.set(entry.name, 0);
  // child -> parents that must be deleted after the child.
  const childToParents = new Map<string, Set<string>>();

  for (const entry of entries) {
    const meta = metas.get(entry.name);
    if (!meta) continue;
    for (const fk of meta.foreignKeys) {
      if (!isOrderingOnDelete(fk.onDelete)) continue;
      const parent = fk.parentTable;
      if (parent === entry.name) {
        throw new Error(
          `Self-referential blocking or cascading foreign key on ${entry.name}; tenant deletion order cannot be derived`
        );
      }
      if (!inManifest.has(parent)) continue;
      const parents = childToParents.get(entry.name) ?? new Set<string>();
      if (!parents.has(parent)) {
        parents.add(parent);
        childToParents.set(entry.name, parents);
        indegree.set(parent, (indegree.get(parent) ?? 0) + 1);
      }
    }
  }

  const ready = [...indegree]
    .filter(([, degree]) => degree === 0)
    .map(([name]) => name)
    .sort();
  const order: TenantDeletionTable[] = [];
  while (ready.length > 0) {
    ready.sort();
    const name = ready.shift() as string;
    const entry = byName.get(name);
    if (entry) order.push(entry);
    for (const parent of childToParents.get(name) ?? []) {
      const next = (indegree.get(parent) ?? 0) - 1;
      indegree.set(parent, next);
      if (next === 0) ready.push(parent);
    }
  }

  if (order.length !== entries.length) {
    throw new Error(
      'Cycle among blocking or cascading tenant foreign keys; cannot derive a safe deletion order'
    );
  }
  return order;
}

let cachedManifest: TenantDeletionTable[] | null = null;

/**
 * Build the ordered tenant-deletion manifest: every directly-scoped table,
 * ordered so children are deleted before parents. Transitively-scoped tables
 * are detected above and rejected until deletion can verify them safely. The
 * result is memoized because the schema is static at runtime.
 */
export function buildTenantDeletionManifest(): TenantDeletionTable[] {
  if (cachedManifest) return cachedManifest;
  const metas = discoverTableMetas();
  const { direct, transitive, unclassified } = classifyPostgresTables();

  // Runtime exhaustiveness invariant: no schema table may silently escape
  // deletion. This is the same guarantee the CI exhaustiveness test asserts,
  // enforced here at runtime so a mis-deployed binary fails loudly instead of
  // certifying an incomplete deletion.
  if (unclassified.length > 0) {
    throw new Error(
      `Tenant deletion cannot classify table(s): ${unclassified.join(', ')}. ` +
        'Every schema table must carry a tenant_id column, reach a scoped table ' +
        'via a foreign key, or be declared in GLOBAL_TABLES.'
    );
  }

  // The transitive deletion path is unproven: the child-first ordering picks a
  // single parent FK, and phase-2 verification resolves scope through parent
  // rows that phase-1 has already deleted, so a surviving transitive row
  // (including ON DELETE SET NULL orphans) cannot be detected. Rather than
  // half-delete such a table and self-certify success, refuse loudly. This
  // branch is dormant today (every application table carries tenant_id) and
  // guards against a future schema addition slipping through unverified.
  if (transitive.length > 0) {
    throw new Error(
      `Tenant deletion does not yet support transitively-scoped tables (${transitive.join(', ')}). ` +
        'Add a tenant_id column to these tables, or extend the deletion engine ' +
        'with orphan-safe verification before deleting them.'
    );
  }

  const entries: TenantDeletionTable[] = [];
  for (const name of direct) {
    const meta = metas.get(name);
    if (!meta) continue;
    const tenantColumn = meta.columns.find((column) => column.name === TENANT_SCOPE_COLUMN);
    if (!tenantColumn) continue;
    entries.push({ name, table: meta.table, scope: 'direct', tenantColumn });
  }

  if (entries.length === 0) {
    throw new Error(
      'Tenant deletion manifest is empty; refusing to certify an empty deletion plan'
    );
  }

  cachedManifest = orderChildrenFirst(entries, metas);
  return cachedManifest;
}
