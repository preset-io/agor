import { getTableConfig, type PgColumn, PgDialect, QueryBuilder } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import * as pg from './schema.postgres';
import {
  assertNoRemainingTenantRows,
  assertValidTenantId,
  deleteTenantData,
  InvalidTenantIdError,
  TenantDeletionUnsupportedError,
  TenantDeletionVerificationError,
} from './tenant-deletion';
import { buildTenantScopeCondition, type TenantDeletionTable } from './tenant-deletion-manifest';
import { runWithTenantDatabaseScope } from './tenant-scope';
import { dbTest } from './test-helpers';

describe('assertValidTenantId', () => {
  it.each([
    'acme-corp',
    'default',
    '0192f0c4-6f1e-7a2b-9c3d-4e5f60718293',
    'tenant_42',
  ])('accepts concrete id %s', (id) => {
    expect(() => assertValidTenantId(id)).not.toThrow();
  });

  it.each([
    ['', 'empty'],
    ['   ', 'blank'],
    [' padded', 'leading whitespace'],
    ['padded ', 'trailing whitespace'],
    ['*', 'wildcard star'],
    ['%', 'wildcard percent'],
    ['ten%ant', 'embedded percent'],
    ['ten*ant', 'embedded star'],
  ])('rejects %s (%s)', (id) => {
    expect(() => assertValidTenantId(id)).toThrow(InvalidTenantIdError);
  });

  it('rejects non-string input', () => {
    expect(() => assertValidTenantId(undefined)).toThrow(InvalidTenantIdError);
    expect(() => assertValidTenantId(123 as unknown)).toThrow(InvalidTenantIdError);
  });
});

describe('assertNoRemainingTenantRows', () => {
  it('does nothing when no rows remain', () => {
    expect(() => assertNoRemainingTenantRows([])).not.toThrow();
  });

  it('throws a verification error carrying the offending table names', () => {
    try {
      assertNoRemainingTenantRows(['sessions', 'tasks']);
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(TenantDeletionVerificationError);
      expect((error as TenantDeletionVerificationError).tables).toEqual(['sessions', 'tasks']);
    }
  });
});

describe('buildTenantScopeCondition', () => {
  const dialect = new PgDialect();
  const queryBuilder = new QueryBuilder();

  function column(table: unknown, name: string): PgColumn {
    const found = getTableConfig(table as never).columns.find((c) => c.name === name);
    if (!found) throw new Error(`missing column ${name}`);
    return found as PgColumn;
  }

  const directEntry: TenantDeletionTable = {
    name: 'sessions',
    table: pg.sessions,
    scope: 'direct',
    tenantColumn: column(pg.sessions, 'tenant_id'),
  };
  const byName = new Map<string, TenantDeletionTable>([['sessions', directEntry]]);

  it('scopes a direct table with tenant_id = $1', () => {
    const { sql, params } = dialect.sqlToQuery(
      buildTenantScopeCondition(queryBuilder, directEntry, 'acme', byName)
    );
    expect(sql).toContain('"sessions"."tenant_id" =');
    expect(params).toEqual(['acme']);
  });
});

describe('deleteTenantData guards', () => {
  dbTest('refuses to run against a single-tenant SQLite database', async ({ db }) => {
    await expect(deleteTenantData(db, 'acme-corp')).rejects.toBeInstanceOf(
      TenantDeletionUnsupportedError
    );
  });

  dbTest('refuses to run inside an ambient tenant database scope', async ({ db }) => {
    // runWithTenantDatabaseScope sets the scope store even on SQLite, so the
    // ambient-scope guard fires before the PostgreSQL-only check.
    await expect(
      runWithTenantDatabaseScope(db, 'acme-corp', async () => deleteTenantData(db, 'acme-corp'))
    ).rejects.toThrow(/fresh connection/);
  });
});
