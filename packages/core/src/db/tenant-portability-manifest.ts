/**
 * Runtime-owned ordering for moving one tenant's database rows in and out of a
 * portable archive (inspect / export / import / verify).
 *
 * Tenant deletion needs a *child-before-parent* order so a row is removed before
 * the row it references. Restoring an export needs the mirror image: a
 * *parent-before-child* insert order so every foreign-key target already exists
 * when a referencing row is written. Rather than maintain a second list, this
 * module reuses the single runtime-owned ownership source —
 * {@link buildTenantDeletionManifest} (which fails closed if any schema table is
 * unclassified) plus {@link IMPERATIVE_TENANT_TABLES} — and reverses it.
 *
 * Imperative tenant tables (created lazily outside the Drizzle schema, e.g.
 * `kb_unit_embeddings`) are leaf tables; the deletion engine places them first
 * (deleted first). For insertion they must therefore come last, after every
 * table they could reference. They are only ever acted on when the live catalog
 * proves them present with the full tenant contract, so callers pass the set of
 * present imperative tables discovered from the live catalog.
 *
 * Multi-tenancy is PostgreSQL-only in Agor, so this ordering is derived from the
 * PostgreSQL schema exclusively. It does not assert row-level foreign-key tenant
 * consistency — that remains the same documented precondition the deletion
 * engine relies on.
 */

import { buildTenantDeletionManifest } from './tenant-deletion-manifest';
import { IMPERATIVE_TENANT_TABLES } from './tenant-imperative-tables';

/** A tenant table together with the column that scopes it to a tenant. */
export interface TenantPortabilityTable {
  /** Physical table name in the `public` schema. */
  readonly name: string;
  /** Column carrying the tenant discriminator (always `tenant_id`). */
  readonly tenantColumn: string;
}

/**
 * The parent-before-child order used to move tenant rows: it drives both the
 * EXPORT read order and, most importantly, the IMPORT insert order so that every
 * foreign-key target already exists when a referencing row is written.
 *
 * Only the compiled manifest tables carry movable rows. Imperative tenant tables
 * (e.g. `kb_unit_embeddings`) hold a derived embedding cache with a non-portable
 * column type; they are reported in the inventory but never exported or imported
 * as rows — the runtime regenerates them from the Knowledge content that *is*
 * moved. See {@link IMPERATIVE_TENANT_TABLES}.
 */
export function buildTenantInsertOrder(): TenantPortabilityTable[] {
  const deletionOrder = buildTenantDeletionManifest();
  // Deletion order is child-first; reversing yields parent-first insert order.
  return [...deletionOrder]
    .reverse()
    .map((entry) => ({ name: entry.name, tenantColumn: entry.tenantColumn.name }));
}

/** Movable tenant tables (compiled manifest), in a stable sorted order. */
export function tenantPortabilityTableNames(): string[] {
  return buildTenantDeletionManifest()
    .map((entry) => entry.name)
    .sort();
}

/**
 * Registered imperative tenant tables whose rows are intentionally NOT moved by
 * export/import (derived, regenerable). Reported in the inventory for
 * completeness so an operator can see they exist.
 */
export function derivedImperativeTableNames(): string[] {
  return IMPERATIVE_TENANT_TABLES.map((table) => table.name).sort();
}
