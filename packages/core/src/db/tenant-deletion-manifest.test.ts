import { is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import * as postgresSchema from './schema.postgres';
import {
  buildTenantDeletionManifest,
  classifyPostgresTables,
  GLOBAL_BLOB_KEY_SOURCES,
  GLOBAL_TABLE_COLUMN_SOURCES,
  GLOBAL_TABLES,
  type TableMeta,
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

  it('keeps GLOBAL_TABLES and the column-source map describing the same tables', () => {
    // Column-level exhaustiveness is a `satisfies` constraint on the compiled
    // Drizzle table, so an unclassified column is a `tsc` error rather than a
    // test failure. What types cannot express is the correspondence between this
    // map's keys and the GLOBAL_TABLES set, which is what this checks.
    const sources = GLOBAL_TABLE_COLUMN_SOURCES as Record<string, Record<string, string>>;
    expect(Object.keys(sources).sort()).toEqual([...GLOBAL_TABLES].sort());

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
      const classified = Object.keys(sources[tableName] ?? {}).sort();

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

describe('global tables and tenant references', () => {
  it('classifies the blob keys of every composite column', () => {
    // The column-level `satisfies` cannot see inside a JSON column: a key added
    // to the blob needs no migration and changes no Drizzle table. This asserts
    // the two maps describe the same columns; the key-level exhaustiveness is a
    // `satisfies` against `MCPCatalogEntryData`, so an unclassified key is a
    // tsc error rather than a failure here.
    const columnSources = GLOBAL_TABLE_COLUMN_SOURCES as Record<string, Record<string, string>>;
    const blobSources = GLOBAL_BLOB_KEY_SOURCES as Record<
      string,
      Record<string, Record<string, string>>
    >;

    for (const [table, columns] of Object.entries(columnSources)) {
      const composite = Object.entries(columns)
        .filter(([, source]) => source === 'composite')
        .map(([column]) => column)
        .sort();
      expect(Object.keys(blobSources[table] ?? {}).sort()).toEqual(composite);
    }
  });

  it('never labels a blob key with a source a tenant counter could take', () => {
    // Same reasoning as the column vocabulary: every label names what the value
    // was computed *from*, so a usage counter finds none that fits.
    const permitted = new Set([
      'registry',
      'repo',
      'computed-from-registry',
      'computed-from-repo',
      'row-identity',
      'probe',
    ]);
    for (const columns of Object.values(
      GLOBAL_BLOB_KEY_SOURCES as Record<string, Record<string, Record<string, string>>>
    )) {
      for (const keys of Object.values(columns)) {
        for (const source of Object.values(keys)) expect(permitted.has(source)).toBe(true);
      }
    }
  });

  it('refuses a declared-global table that references tenant space', () => {
    // A global table is skipped before the transitive fixpoint, so it can never
    // be classified transitive no matter what it points at. An FK into a tenant
    // table would leave deletion blocking on the constraint or cascading rows
    // out of a table declared untouchable, with every other guard still passing.
    const { direct, transitive, global } = classifyPostgresTables();
    const scoped = new Set([...direct, ...transitive]);

    for (const name of global) {
      const table = Object.values(postgresSchema).find(
        (value) => is(value, PgTable) && getTableConfig(value).name === name
      );
      for (const fk of getTableConfig(table as PgTable).foreignKeys) {
        const parent = getTableConfig(fk.reference().foreignTable).name;
        expect(scoped.has(parent), `${name} references tenant-scoped ${parent}`).toBe(false);
      }
    }
  });
});

describe('a declared-global table that acquires a tenant column', () => {
  /** The real schema is guarded against this, so the shape is built by hand. */
  function metasWith(columnNames: string[]): ReadonlyMap<string, TableMeta> {
    const real = classifyPostgresTables();
    const globalName = real.global[0];
    const table = Object.values(postgresSchema).find(
      (value) => is(value, PgTable) && getTableConfig(value).name === globalName
    ) as PgTable;
    return new Map([
      [
        globalName,
        {
          table,
          columns: columnNames.map((name) => ({ name })) as TableMeta['columns'],
          foreignKeys: [],
        },
      ],
    ]);
  }

  it('refuses to classify it global instead of silently exempting it', () => {
    // The declaration is checked, not trusted. Granting the exemption first and
    // testing the column afterwards would drop the table out of the deletion
    // plan while every other guard still passed: a column-source label accepts
    // any value, the manifest test compares names rather than sources, and the
    // migration test reads the text of one migration.
    expect(() => classifyPostgresTables(metasWith(['name', TENANT_SCOPE_COLUMN]))).toThrow(
      /declared global but has a tenant_id column/
    );
  });

  it('still classifies it global while it holds no tenant column', () => {
    const { global } = classifyPostgresTables(metasWith(['name', 'title']));
    expect(global).toEqual(['mcp_catalog_entries']);
  });
});
