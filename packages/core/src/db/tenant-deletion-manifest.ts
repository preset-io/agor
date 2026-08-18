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

import { is } from 'drizzle-orm';
import { getTableConfig, type PgColumn, PgTable } from 'drizzle-orm/pg-core';
import * as postgresSchema from './schema.postgres';

/** Name of the column that scopes a row to a tenant. */
export const TENANT_SCOPE_COLUMN = 'tenant_id';

/**
 * Tables that legitimately hold no tenant-scoped data and must therefore be
 * left untouched by tenant deletion.
 *
 * Currently empty: every application table carries tenant data. The machinery
 * is kept rather than deleted with its last member, because it is what a future
 * global table has to be declared through. Removing it would leave the next one
 * to be classified by whichever guard noticed first — and the exhaustiveness
 * test would then fail with "unclassified table" and no explanation of what the
 * author is being asked to decide.
 *
 * The list is deliberately explicit: the exhaustiveness test fails if a schema
 * table is neither tenant-scoped, transitively tenant-scoped, nor named here, so
 * a global table cannot be introduced without a conscious decision recorded in
 * this set. A name added here needs a paragraph saying why every one of its
 * columns originates outside every tenant, and an entry in
 * {@link GLOBAL_TABLE_COLUMN_SOURCES}, which will not compile without one.
 *
 * **The invariant is per column, not per table.** A table qualifies only while
 * every one of its columns is sourced from outside every tenant — a public
 * service, or a file in this repository. A column derived from tenant activity
 * (a connect counter, a rating, a last-used timestamp) silently breaks the
 * justification even though the table stays in this set: the value aggregates
 * across tenants on read, and its only writer would be a tenant request path.
 * Such a column belongs in its own tenant-scoped table.
 *
 * Note: Drizzle's own migration bookkeeping table (`drizzle.__drizzle_migrations`)
 * is not part of the application schema exports and is never enumerated by this
 * manifest.
 */
export const GLOBAL_TABLE_NAMES = [] as const satisfies readonly string[];

export type GlobalTableName = (typeof GLOBAL_TABLE_NAMES)[number];

export const GLOBAL_TABLES: ReadonlySet<string> = new Set<string>(GLOBAL_TABLE_NAMES);

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
 * - `public-service` — mirrored verbatim from a public third-party service.
 * - `repo` — supplied by a file checked into this repository.
 * - `computed-from-public-service` — Agor computed it, from such a mirror alone.
 * - `computed-from-repo` — Agor computed it, from repository data alone.
 * - `row-identity` — this row's own identity and write timestamps.
 * - `probe` — discovered by contacting a public endpoint.
 * - `composite` — a JSON column whose keys have different sources, classified
 *   one level down in {@link GLOBAL_BLOB_KEY_SOURCES}. Not a licence to skip
 *   the question: a `composite` column with no entry there is a type error.
 *
 * A column fed by user behaviour fits none of these. It belongs in its own
 * tenant-scoped table, and the absence of a label is the prompt to build one.
 */
export type GlobalColumnSource =
  | 'public-service'
  | 'repo'
  | 'computed-from-public-service'
  | 'computed-from-repo'
  | 'row-identity'
  | 'probe'
  | 'composite';

/** The PostgreSQL tables the schema module exports, keyed by table name. */
type SchemaTablesByName = {
  [K in keyof typeof postgresSchema as (typeof postgresSchema)[K] extends PgTable
    ? (typeof postgresSchema)[K]['_']['name']
    : never]: (typeof postgresSchema)[K];
};

type ColumnsOf<N extends keyof SchemaTablesByName> = SchemaTablesByName[N] extends PgTable
  ? keyof SchemaTablesByName[N]['_']['columns'] & string
  : never;

/**
 * Every column of every global table, classified.
 *
 * `satisfies` is what makes this binding rather than documentation. The
 * required shape is derived from {@link GLOBAL_TABLE_NAMES} and, for each name
 * in it, from that table's own compiled Drizzle columns — so declaring a table
 * global without classifying its columns, or leaving one column out, is a type
 * error in the editor and in `tsc`, not a test failure someone sees after
 * pushing.
 *
 * With no global tables the required shape is empty and so is this. That is not
 * the guard going quiet: the moment a name is added above, this stops
 * compiling until every one of that table's columns is accounted for.
 */
export const GLOBAL_TABLE_COLUMN_SOURCES = {} satisfies {
  [N in GlobalTableName]: Record<ColumnsOf<N>, GlobalColumnSource>;
};

/**
 * Every key of every `composite` column, classified.
 *
 * The column-level guard is airtight against the easy mistake and blind to the
 * likely one. A JSON column is schemaless in the database: a `connect_count` or
 * a `last_used_by_tenant` key needs no migration, changes no Drizzle table, and
 * so trips nothing at the column level — while breaking the same invariant a new
 * column would.
 *
 * Only the presence of an entry can be required generically; a column's keys
 * live in the TypeScript interface the blob is written through, and nothing
 * connects a table name to that interface automatically. So a `composite`
 * column takes a `satisfies Record<keyof Required<TheBlobInterface>, ...>` on
 * its own entry, which is what makes an unclassified key a compile error. The
 * companion test fails if a `composite` column has no entry here at all.
 */
export const GLOBAL_BLOB_KEY_SOURCES = {} satisfies {
  [N in GlobalTableName]: Record<string, Record<string, GlobalColumnSource>>;
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

export interface TableMeta {
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
export function classifyPostgresTables(
  /**
   * Override the discovered schema. Only tests pass this, to assert what the
   * classifier does with a shape the real schema is guarded against ever having.
   */
  metas: ReadonlyMap<string, TableMeta> = discoverTableMetas(),
  /**
   * Override the declared global set. Only tests pass this.
   *
   * {@link GLOBAL_TABLES} is empty, so the guards below — a global table that
   * grows a `tenant_id`, or one pointing a foreign key into tenant space —
   * cannot fire against the real schema and would otherwise go untested until
   * the next global table arrived and needed them. They protect a decision made
   * rarely and reviewed once, which is the kind of code that has to be exercised
   * deliberately or not at all.
   */
  declaredGlobal: ReadonlySet<string> = GLOBAL_TABLES
): TableClassificationResult {
  const global = new Set<string>();
  const direct = new Set<string>();
  for (const [name, meta] of metas) {
    if (declaredGlobal.has(name)) {
      // Checked before the exemption is granted, not after. A declaration is
      // not evidence: adding `tenant_id` to a table already named here would
      // otherwise be classified global and drop out of the deletion plan
      // silently, since every other guard accepts it — the column-source map
      // takes any label, the manifest test compares names rather than sources,
      // and the migration test reads one migration's text. The live-catalog
      // audit does catch it, but only on Postgres at deletion time.
      if (hasTenantColumn(meta)) {
        throw new Error(
          `${name} is declared global but has a ${TENANT_SCOPE_COLUMN} column; ` +
            'a table holding tenant rows cannot be exempt from tenant deletion'
        );
      }
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
