/**
 * Registry of tenant-scoped tables that are created *imperatively* at runtime
 * rather than declared in the Drizzle schema (`schema.postgres.ts`).
 *
 * The Drizzle-derived {@link buildTenantDeletionManifest tenant manifest} only
 * sees tables that are exported from the compiled schema. Some tenant-scoped
 * tables, however, are created lazily by application code — most notably
 * `kb_unit_embeddings`, which the Knowledge pgvector layer creates on demand
 * (see `apps/agor-daemon/src/knowledge/pgvector.ts`). Such a table carries the
 * full tenant contract (a `tenant_id` discriminator, FORCE ROW LEVEL SECURITY,
 * and a `tenant_isolation_*` policy) but is invisible to the schema exports, so
 * it would silently escape deletion and verification.
 *
 * This registry closes that gap by describing those tables by *name and
 * contract only* — never by importing daemon code (core must not depend on the
 * daemon). Each entry is included in the deletion plan, the pre-delete count
 * snapshot, and phase-2 verification ONLY when the live catalog shows the table
 * present with the full tenant contract (it may not exist yet, since it is
 * created lazily).
 *
 * Because these tables are referenced by a constant name here — not by a
 * catalog-sourced string — the executed DELETE/COUNT statements can safely quote
 * the identifier (`sql.identifier`) and bind the tenant id as a parameter.
 */

/** The column that scopes an imperative table's rows to a tenant. */
export const IMPERATIVE_TENANT_SCOPE_COLUMN = 'tenant_id';

/**
 * A tenant-scoped table created imperatively (outside the Drizzle schema) and
 * therefore not derivable from `schema.postgres.ts`. Entries describe only the
 * relation used for explicit public-qualified tenant DML. They do not claim to
 * validate row-level foreign-key tenant consistency.
 */
export interface ImperativeTenantTable {
  /** Physical table name (constant — never sourced from the live catalog). */
  readonly name: string;
  /** Tenant discriminator column (always deleted with `WHERE <col> = $1`). */
  readonly tenantColumn: string;
}

/**
 * The imperative tenant tables Agor may create at runtime.
 *
 * `kb_unit_embeddings` (Knowledge pgvector storage) is created lazily by
 * `ensureKnowledgePgvectorStorage`. The engine places registered imperative
 * tables before the compiled manifest. The standalone PostgreSQL schema and its
 * data must still satisfy the documented tenant-consistent foreign-key
 * precondition.
 */
export const IMPERATIVE_TENANT_TABLES: readonly ImperativeTenantTable[] = [
  {
    name: 'kb_unit_embeddings',
    tenantColumn: IMPERATIVE_TENANT_SCOPE_COLUMN,
  },
];
