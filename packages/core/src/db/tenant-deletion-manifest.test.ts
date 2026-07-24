import { is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import * as postgresSchema from './schema.postgres';
import {
  buildTenantDeletionManifest,
  classifyPostgresTables,
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

/** Blocking `ON DELETE` actions constrain deletion order (see manifest module). */
function isBlocking(onDelete: string | undefined): boolean {
  return onDelete === undefined || onDelete === 'no action' || onDelete === 'restrict';
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

  it('treats every current application table as directly tenant-scoped', () => {
    const { direct, transitive, global } = classifyPostgresTables();
    // Every table in the PostgreSQL schema currently carries a tenant_id column.
    expect(transitive).toEqual([]);
    expect(global).toEqual([]);
    expect(direct).toEqual(allPostgresTableNames());
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

  it('orders children before parents for every blocking foreign key', () => {
    for (const value of Object.values(postgresSchema)) {
      if (!is(value, PgTable)) continue;
      const config = getTableConfig(value);
      const childName = config.name;
      const childIndex = orderIndex.get(childName);
      if (childIndex === undefined) continue; // not a tenant-scoped table
      for (const fk of config.foreignKeys) {
        if (!isBlocking(fk.onDelete)) continue;
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
