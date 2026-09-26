import { is } from 'drizzle-orm';
import { PgTable, getTableConfig as pgConfig } from 'drizzle-orm/pg-core';
import { SQLiteTable, getTableConfig as sqliteConfig } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';
import {
  BRANCH_DELETION_NON_FK_RELATIONS,
  BRANCH_DELETION_RELATIONS,
  BRANCH_DELETION_RESOURCE_FAMILIES,
} from './branch-deletion-manifest';
import * as pg from './schema.postgres';
import * as sqlite from './schema.sqlite';
import { IMPERATIVE_TENANT_TABLES } from './tenant-imperative-tables';

describe('branch deletion ownership review coverage', () => {
  const owned = new Set<string>(BRANCH_DELETION_RESOURCE_FAMILIES);

  it.each(['sqlite', 'postgres'] as const)(
    'classifies every inbound FK to an owned/mixed family in %s',
    (dialect) => {
      const keys = new Set<string>();
      if (dialect === 'sqlite') {
        for (const table of Object.values(sqlite)) {
          if (!is(table, SQLiteTable)) continue;
          const config = sqliteConfig(table);
          for (const fk of config.foreignKeys) {
            const ref = fk.reference();
            if (!owned.has(sqliteConfig(ref.foreignTable).name)) continue;
            for (const column of ref.columns) keys.add(`${config.name}.${column.name}`);
          }
        }
      } else {
        for (const table of Object.values(pg)) {
          if (!is(table, PgTable)) continue;
          const config = pgConfig(table);
          for (const fk of config.foreignKeys) {
            const ref = fk.reference();
            if (!owned.has(pgConfig(ref.foreignTable).name)) continue;
            for (const column of ref.columns) {
              if (column.name !== 'tenant_id') keys.add(`${config.name}.${column.name}`);
            }
          }
        }
      }
      // Exact equality catches both newly unclassified relations and stale claims.
      const expected = Object.keys(BRANCH_DELETION_RELATIONS).filter(
        (key) => dialect !== 'postgres' || key !== 'boards.primary_assistant_id'
      );
      // The retired assistant pointer exists only in SQLite to avoid a rebuild.
      if (dialect === 'postgres')
        expect(pgConfig(pg.boards).columns.map((column) => column.name)).not.toContain(
          'primary_assistant_id'
        );
      expect([...keys].sort()).toEqual(expected.sort());
    }
  );

  it('audits descendants of every declared owned or mixed relation', () => {
    expect(owned.has('board_comments')).toBe(true);
    expect(owned.has('gateway_outbound_messages')).toBe(true);
    for (const [relation, policy] of Object.entries(BRANCH_DELETION_RELATIONS)) {
      if (['delete_owned', 'classify'].includes(policy.disposition)) {
        expect(owned.has(relation.split('.')[0]!)).toBe(true);
      }
    }
  });

  it('pins non-FK uploads and token authorities instead of trusting cascade deletion', () => {
    for (const table of [sqlite.uploads, sqlite.executorSessionTokenAuthorities]) {
      const config = sqliteConfig(table);
      expect(config.foreignKeys).toEqual([]);
      for (const column of config.columns) {
        if (!['branch_id', 'session_id', 'task_id'].includes(column.name)) continue;
        expect(BRANCH_DELETION_NON_FK_RELATIONS[`${config.name}.${column.name}`]).toBeDefined();
      }
    }
    expect(BRANCH_DELETION_NON_FK_RELATIONS['kb_unit_embeddings.unit_id']).toBeDefined();
    expect(IMPERATIVE_TENANT_TABLES.map((table) => table.name)).toEqual(['kb_unit_embeddings']);
  });

  it('does not reinterpret SET NULL knowledge and artifact provenance as ownership', () => {
    expect(BRANCH_DELETION_RELATIONS['kb_namespaces.branch_id'].disposition).toBe('classify');
    expect(BRANCH_DELETION_RELATIONS['artifacts.branch_id'].disposition).toBe('clear_reference');
    expect(BRANCH_DELETION_RELATIONS['artifacts.source_session_id'].disposition).toBe(
      'clear_reference'
    );
    expect(BRANCH_DELETION_RELATIONS['boards.primary_teammate_id'].disposition).toBe(
      'clear_reference'
    );
    expect(BRANCH_DELETION_NON_FK_RELATIONS['sessions.parent_session_id'].disposition).toBe(
      'clear_reference'
    );
    expect(BRANCH_DELETION_NON_FK_RELATIONS['artifact_trust_grants.scope_value'].disposition).toBe(
      'retain'
    );
  });
});
