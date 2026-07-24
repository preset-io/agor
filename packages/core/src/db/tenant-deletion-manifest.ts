/**
 * Runtime-owned manifest of tenant-scoped database tables.
 *
 * Operators of a multi-tenant Agor deployment occasionally need to permanently
 * remove every trace of a single tenant (offboarding, data-removal requests,
 * regulatory erasure). Doing that safely requires an exhaustive, machine-derived
 * list of which tables hold tenant data and in what order they must be deleted
 * so foreign keys are never violated.
 *
 * This module derives that manifest directly from the PostgreSQL schema
 * definitions (`schema.postgres.ts`) rather than hand-maintaining a list, so a
 * newly added table is picked up automatically. Every table is classified as:
 *
 *   - `direct`     — carries a `tenant_id` column and is deleted with
 *                    `WHERE tenant_id = $1`.
 *   - `transitive` — has no `tenant_id` column but reaches a scoped table via a
 *                    foreign-key chain; deleted with a subquery predicate that
 *                    resolves down to a scoped ancestor.
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

import { eq, inArray, is, type SQL } from 'drizzle-orm';
import { getTableConfig, type PgColumn, PgTable, type QueryBuilder } from 'drizzle-orm/pg-core';
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
 * in this set. It is currently empty because every application table in the
 * PostgreSQL schema carries a `tenant_id` column.
 *
 * Note: Drizzle's own migration bookkeeping table (`drizzle.__drizzle_migrations`)
 * is not part of the application schema exports and is never enumerated by this
 * manifest.
 */
export const GLOBAL_TABLES: ReadonlySet<string> = new Set<string>([]);

/** How a table is tied to a tenant. */
export type TenantTableScope = 'direct' | 'transitive';

/** Full classification of a table, including non-tenant tables. */
export type TableClassification = TenantTableScope | 'global';

/** Link from a transitively-scoped child table to a scoped ancestor. */
export interface TenantParentLink {
  /** Single-column foreign key on the child table. */
  fkColumn: PgColumn;
  /** Physical name of the scoped (direct or transitive) parent table. */
  parentTable: string;
  /** Referenced primary/unique column on the parent table. */
  parentPkColumn: PgColumn;
}

/** A table that holds tenant data and must be included in deletion. */
export interface TenantDeletionTable {
  /** Physical table name. */
  name: string;
  /** Drizzle table object, used to build type-safe queries. */
  table: PgTable;
  /** How the table is scoped to a tenant. */
  scope: TenantTableScope;
  /** Tenant column (present only for `direct` scope). */
  tenantColumn?: PgColumn;
  /** FK link to a scoped ancestor (present only for `transitive` scope). */
  parentLink?: TenantParentLink;
}

interface ForeignKeyMeta {
  fkColumns: PgColumn[];
  parentTable: string;
  parentColumns: PgColumn[];
  onDelete?: string;
}

interface TableMeta {
  name: string;
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
        fkColumns: reference.columns as PgColumn[],
        parentTable: getTableConfig(reference.foreignTable).name,
        parentColumns: reference.foreignColumns as PgColumn[],
        onDelete: fk.onDelete,
      };
    });
    metas.set(config.name, {
      name: config.name,
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

function requireSingleColumn(columns: PgColumn[], context: string): PgColumn {
  if (columns.length !== 1) {
    throw new Error(
      `Tenant deletion manifest cannot handle composite foreign key (${context}); expected a single column`
    );
  }
  return columns[0];
}

function buildParentLink(
  meta: TableMeta,
  direct: Set<string>,
  scoped: Set<string>
): TenantParentLink {
  // Prefer a foreign key to a directly-scoped parent for the shortest predicate,
  // falling back to any scoped (transitive) parent.
  const candidate =
    meta.foreignKeys.find((fk) => direct.has(fk.parentTable)) ??
    meta.foreignKeys.find((fk) => scoped.has(fk.parentTable));
  if (!candidate) {
    throw new Error(`Transitive table ${meta.name} has no foreign key to a scoped table`);
  }
  return {
    fkColumn: requireSingleColumn(candidate.fkColumns, `${meta.name} -> ${candidate.parentTable}`),
    parentTable: candidate.parentTable,
    parentPkColumn: requireSingleColumn(
      candidate.parentColumns,
      `${candidate.parentTable} referenced by ${meta.name}`
    ),
  };
}

/**
 * Order manifest tables children-first so that, for every blocking foreign key,
 * the referencing table is deleted before the table it references. Implemented
 * as a Kahn topological sort; deterministic via name-sorted tie-breaking.
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
      if (!isBlockingOnDelete(fk.onDelete)) continue;
      const parent = fk.parentTable;
      if (parent === entry.name) {
        throw new Error(
          `Self-referential blocking foreign key on ${entry.name}; tenant deletion order cannot be derived`
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
      'Cycle among blocking tenant foreign keys; cannot derive a safe deletion order'
    );
  }
  return order;
}

let cachedManifest: TenantDeletionTable[] | null = null;

/**
 * Build the ordered tenant-deletion manifest: every direct- and
 * transitively-scoped table, ordered so children are deleted before parents.
 * The result is memoized because the schema is static at runtime.
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

  const directSet = new Set<string>(direct);
  const scoped = new Set<string>([...direct, ...transitive]);

  const entries: TenantDeletionTable[] = [];
  for (const name of direct) {
    const meta = metas.get(name);
    if (!meta) continue;
    const tenantColumn = meta.columns.find((column) => column.name === TENANT_SCOPE_COLUMN);
    if (!tenantColumn) continue;
    entries.push({ name, table: meta.table, scope: 'direct', tenantColumn });
  }
  for (const name of transitive) {
    const meta = metas.get(name);
    if (!meta) continue;
    entries.push({
      name,
      table: meta.table,
      scope: 'transitive',
      parentLink: buildParentLink(meta, directSet, scoped),
    });
  }

  cachedManifest = orderChildrenFirst(entries, metas);
  return cachedManifest;
}

/** Index a manifest by table name (used when resolving transitive predicates). */
export function indexManifest(manifest: TenantDeletionTable[]): Map<string, TenantDeletionTable> {
  return new Map(manifest.map((entry) => [entry.name, entry]));
}

/**
 * Build the boolean condition that scopes a table's rows to a single tenant.
 * Direct tables use `tenant_id = $1`; transitive tables recurse into a subquery
 * that resolves down to a scoped ancestor. The `queryBuilder` is used only to
 * construct subqueries and carries no database connection, so this function is
 * pure and can be rendered/asserted without a live database.
 */
export function buildTenantScopeCondition(
  queryBuilder: QueryBuilder,
  entry: TenantDeletionTable,
  tenantId: string,
  byName: Map<string, TenantDeletionTable>
): SQL {
  if (entry.scope === 'direct') {
    if (!entry.tenantColumn) {
      throw new Error(`Direct tenant table ${entry.name} is missing its tenant column`);
    }
    return eq(entry.tenantColumn, tenantId);
  }

  const link = entry.parentLink;
  if (!link) {
    throw new Error(`Transitive tenant table ${entry.name} is missing its parent link`);
  }
  const parent = byName.get(link.parentTable);
  if (!parent) {
    throw new Error(
      `Transitive tenant table ${entry.name} references unknown parent ${link.parentTable}`
    );
  }
  const parentCondition = buildTenantScopeCondition(queryBuilder, parent, tenantId, byName);
  const subquery = queryBuilder
    .select({ pk: link.parentPkColumn })
    .from(parent.table)
    .where(parentCondition);
  return inArray(link.fkColumn, subquery);
}
