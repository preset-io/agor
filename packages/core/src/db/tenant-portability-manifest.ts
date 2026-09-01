/**
 * Runtime-owned ordering for moving one tenant's database rows in and out of a
 * portable archive (inspect / export / import / verify).
 *
 * Tenant deletion needs a *child-before-parent* order so a row is removed before
 * the row it references. Restoring an export uses the mirror image as the most
 * useful deterministic insert order. PostgreSQL import additionally defers the
 * exact movable FK set because no linear order can satisfy genuine cycles.
 * Rather than maintain a second table list, this module reuses the single
 * runtime-owned ownership source —
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

import { is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import * as postgresSchema from './schema.postgres';
import { buildTenantDeletionManifest } from './tenant-deletion-manifest';
import { IMPERATIVE_TENANT_TABLES } from './tenant-imperative-tables';

/**
 * Tenant-owned runtime authority that must be deleted with the tenant but must
 * never be exported/imported. Restoring an unexpired token-authority row could
 * reactivate a bearer JWT when source and destination share signing secrets.
 * OAuth grants are also deployment- and tenant-bound ciphertext: their AAD,
 * master secret, configuration fingerprint, and generation sequence cannot be
 * made portable by rewriting only tenant_id. Imports require reauthorization.
 */
export const NON_PORTABLE_TENANT_TABLES: ReadonlySet<string> = new Set([
  'executor_session_token_authorities',
  'mcp_oauth_client_registrations',
  'mcp_oauth_pending_flows',
  'codex_device_auth_attempts',
  'user_mcp_oauth_tokens',
  'github_install_states',
]);

function portableDeletionManifest() {
  return buildTenantDeletionManifest().filter(
    (entry) => !NON_PORTABLE_TENANT_TABLES.has(entry.name)
  );
}

/** A tenant table together with the column that scopes it to a tenant. */
export interface TenantPortabilityTable {
  /** Physical table name in the `public` schema. */
  readonly name: string;
  /** Column carrying the tenant discriminator (always `tenant_id`). */
  readonly tenantColumn: string;
}

/**
 * A PostgreSQL foreign key whose child and parent rows both move with a tenant
 * archive. Imports defer exactly this class of constraints so mutually
 * referencing tenant rows can be restored atomically without weakening normal
 * application transactions.
 */
export interface TenantPortabilityForeignKey {
  readonly childTable: string;
  readonly childColumns: readonly string[];
  readonly parentTable: string;
  readonly parentColumns: readonly string[];
  readonly onUpdate: string;
  readonly onDelete: string;
}

/**
 * The parent-before-child order used to move tenant rows: it drives both the
 * EXPORT read order and the IMPORT insert order. Acyclic references are normally
 * satisfied as they are inserted; the import transaction defers the movable FK
 * set to support cycles and validates all references at commit.
 *
 * Only the compiled manifest tables carry movable rows. Imperative tenant tables
 * (e.g. `kb_unit_embeddings`) hold a derived embedding cache with a non-portable
 * column type; they are reported in the inventory but never exported or imported
 * as rows — the runtime regenerates them from the Knowledge content that *is*
 * moved. See {@link IMPERATIVE_TENANT_TABLES}.
 */
export function buildTenantInsertOrder(): TenantPortabilityTable[] {
  const deletionOrder = portableDeletionManifest();
  // Deletion order is child-first; reversing yields parent-first insert order.
  return [...deletionOrder]
    .reverse()
    .map((entry) => ({ name: entry.name, tenantColumn: entry.tenantColumn.name }));
}

/** Movable tenant tables (compiled manifest), in a stable sorted order. */
export function tenantPortabilityTableNames(): string[] {
  return portableDeletionManifest()
    .map((entry) => entry.name)
    .sort();
}

/** Tenant-owned authority tables deliberately omitted from portable archives. */
export function nonPortableTenantTableNames(): string[] {
  return [...NON_PORTABLE_TENANT_TABLES].sort();
}

let cachedPortabilityForeignKeys: readonly TenantPortabilityForeignKey[] | null = null;

function foreignKeyStructuralKey(foreignKey: TenantPortabilityForeignKey): string {
  return [
    foreignKey.childTable,
    foreignKey.childColumns.join(','),
    foreignKey.parentTable,
    foreignKey.parentColumns.join(','),
  ].join('|');
}

/**
 * Derive and freeze every compiled-schema FK whose endpoints are both movable
 * tenant-manifest tables. The PostgreSQL migration freezes the same exact set
 * as DEFERRABLE INITIALLY IMMEDIATE; the live-catalog invariant test compares
 * this metadata (including columns and actions) to pg_constraint so schema
 * drift fails closed.
 */
export function tenantPortabilityForeignKeys(): readonly TenantPortabilityForeignKey[] {
  if (cachedPortabilityForeignKeys) return cachedPortabilityForeignKeys;
  const movable = new Set(tenantPortabilityTableNames());
  const foreignKeys: TenantPortabilityForeignKey[] = [];

  for (const value of Object.values(postgresSchema)) {
    if (!is(value, PgTable)) continue;
    const child = getTableConfig(value);
    if (!movable.has(child.name)) continue;

    for (const foreignKey of child.foreignKeys) {
      const reference = foreignKey.reference();
      const parentTable = getTableConfig(reference.foreignTable).name;
      if (!movable.has(parentTable)) continue;
      foreignKeys.push(
        Object.freeze({
          childTable: child.name,
          childColumns: Object.freeze(reference.columns.map((column) => column.name)),
          parentTable,
          parentColumns: Object.freeze(reference.foreignColumns.map((column) => column.name)),
          onUpdate: foreignKey.onUpdate ?? 'no action',
          onDelete: foreignKey.onDelete ?? 'no action',
        })
      );
    }
  }

  foreignKeys.sort((a, b) => foreignKeyStructuralKey(a).localeCompare(foreignKeyStructuralKey(b)));
  cachedPortabilityForeignKeys = Object.freeze(foreignKeys);
  return cachedPortabilityForeignKeys;
}

/**
 * Registered imperative tenant tables whose rows are intentionally NOT moved by
 * export/import (derived, regenerable). Reported in the inventory for
 * completeness so an operator can see they exist.
 */
export function derivedImperativeTableNames(): string[] {
  return IMPERATIVE_TENANT_TABLES.map((table) => table.name).sort();
}
