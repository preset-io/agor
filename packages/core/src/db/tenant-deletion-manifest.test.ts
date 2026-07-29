import { is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import * as postgresSchema from './schema.postgres';
import {
  buildTenantDeletionManifest,
  classifyPostgresTables,
  GLOBAL_TABLE_COLUMN_SOURCES,
  GLOBAL_TABLES,
  TENANT_SCOPE_COLUMN,
} from './tenant-deletion-manifest';

/** All physical table names exported by the PostgreSQL schema. */
function allPostgresTableNames(): string[] {
  const names: string[] = [];
  for (const value of Object.values(postgresSchema)) {
    if (is(value, PgTable)) names.push(getTableConfig(value).name);
  }
  return names.sort();
}

/** Blocking and cascading actions constrain the defensive deletion order. */
function isOrderingEdge(onDelete: string | undefined): boolean {
  return (
    onDelete === undefined ||
    onDelete === 'no action' ||
    onDelete === 'restrict' ||
    onDelete === 'cascade'
  );
}

describe('tenant deletion manifest classification', () => {
  it('classifies every schema table (nothing can silently escape deletion)', () => {
    const { direct, transitive, global, unclassified } = classifyPostgresTables();

    // The exhaustiveness guarantee: a future table that is neither tenant-scoped,
    // transitively-scoped, nor explicitly declared global fails this assertion.
    expect(unclassified).toEqual([]);

    const covered = [...direct, ...transitive, ...global].sort();
    expect(covered).toEqual(allPostgresTableNames());
  });

  it('treats every application table except the shared MCP catalog as directly tenant-scoped', () => {
    const { direct, transitive, global } = classifyPostgresTables();
    // The MCP catalog mirrors a public registry plus a repo-checked-in curation
    // file, so it deliberately carries no tenant_id. Every other table does.
    expect(transitive).toEqual([]);
    expect(global).toEqual(['mcp_catalog_entries']);
    expect(direct).toEqual(
      allPostgresTableNames().filter((name) => name !== 'mcp_catalog_entries')
    );
    // Spot-check a few tables spanning the FK hierarchy.
    expect(direct).toContain('sessions');
    expect(direct).toContain('users');
    expect(direct).toContain('kb_graph_edges');
  });

  it('only lists real, tenant-free tables in GLOBAL_TABLES', () => {
    const names = new Set(allPostgresTableNames());
    for (const global of GLOBAL_TABLES) {
      expect(names.has(global)).toBe(true);
    }
  });

  it('excludes the shared MCP catalog from the tenant deletion plan', () => {
    const planned = new Set(buildTenantDeletionManifest().map((entry) => entry.name));
    expect(planned.has('mcp_catalog_entries')).toBe(false);
  });

  it('classifies the source of every column on every global table', () => {
    // A global table is only justified while every column comes from outside
    // every tenant. A column derived from tenant activity aggregates across
    // tenants on read and has no legal writer, so it belongs in its own
    // tenant-scoped table. Failing here is the prompt to make that call.
    for (const tableName of GLOBAL_TABLES) {
      const table = Object.values(postgresSchema).find(
        (value) => is(value, PgTable) && getTableConfig(value).name === tableName
      );
      expect(
        table,
        `${tableName} is in GLOBAL_TABLES but not exported by the schema`
      ).toBeDefined();

      const columns = getTableConfig(table as PgTable)
        .columns.map((column) => column.name)
        .sort();
      const classified = Object.keys(GLOBAL_TABLE_COLUMN_SOURCES[tableName] ?? {}).sort();

      expect(classified, `GLOBAL_TABLE_COLUMN_SOURCES is out of sync with ${tableName}`).toEqual(
        columns
      );
    }
  });
});

describe('tenant deletion manifest ordering', () => {
  const manifest = buildTenantDeletionManifest();
  const orderIndex = new Map(manifest.map((entry, index) => [entry.name, index]));

  it('includes exactly the tenant-scoped tables', () => {
    const { direct, transitive } = classifyPostgresTables();
    const expected = [...direct, ...transitive].sort();
    expect(manifest.map((entry) => entry.name).sort()).toEqual(expected);
  });

  it('exposes a tenant column for every direct entry', () => {
    for (const entry of manifest) {
      if (entry.scope === 'direct') {
        expect(entry.tenantColumn?.name).toBe(TENANT_SCOPE_COLUMN);
      }
    }
  });

  it('orders children before parents for every blocking or cascading foreign key', () => {
    for (const value of Object.values(postgresSchema)) {
      if (!is(value, PgTable)) continue;
      const config = getTableConfig(value);
      const childName = config.name;
      const childIndex = orderIndex.get(childName);
      if (childIndex === undefined) continue; // not a tenant-scoped table
      for (const fk of config.foreignKeys) {
        if (!isOrderingEdge(fk.onDelete)) continue;
        const parentName = getTableConfig(fk.reference().foreignTable).name;
        if (parentName === childName) continue;
        const parentIndex = orderIndex.get(parentName);
        if (parentIndex === undefined) continue; // parent not in manifest
        // The referencing (child) row must be deleted before the referenced row.
        expect(childIndex).toBeLessThan(parentIndex);
      }
    }
  });
});
