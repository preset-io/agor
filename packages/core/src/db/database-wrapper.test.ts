import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { dateTruncUtc, rawRows, rawRowsAffected } from './database-wrapper';
import { tasks } from './schema.postgres';

describe('dateTruncUtc', () => {
  it('inlines validated PostgreSQL bucket units so SELECT/GROUP BY expressions match', () => {
    const fakePostgresDb = {} as Parameters<typeof dateTruncUtc>[0];
    const bucketExpr = dateTruncUtc(fakePostgresDb, tasks.created_at, 'week');
    const query = sql`select ${bucketExpr} as bucket from ${tasks} group by ${bucketExpr}`;

    const rendered = new PgDialect().sqlToQuery(query);

    expect(rendered.params).toEqual([]);
    expect(rendered.sql).toContain("date_trunc('week'");
    expect(rendered.sql).not.toContain('date_trunc($');
  });
});

describe('raw query result normalization', () => {
  it('normalizes direct arrays and wrapped rows', () => {
    expect(rawRows([{ id: 'direct' }])).toEqual([{ id: 'direct' }]);
    expect(rawRows({ rows: [{ id: 'wrapped' }] })).toEqual([{ id: 'wrapped' }]);
    expect(rawRows(undefined)).toEqual([]);
  });

  it('normalizes mutation metadata before falling back to returned row count', () => {
    expect(rawRowsAffected({ rowCount: 3 })).toBe(3);
    expect(rawRowsAffected({ rowsAffected: 2 })).toBe(2);
    expect(rawRowsAffected(Object.assign([{ id: 'returned' }], { count: 4 }))).toBe(4);
    expect(rawRowsAffected([{ id: 'returned' }])).toBe(1);
  });
});
