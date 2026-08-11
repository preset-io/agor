/**
 * Unit coverage for tenant database-IO query construction and lossless line
 * handling that must not depend on a live PostgreSQL server. The full
 * export→verify→import precision round-trip (including the server-side tenant-id
 * rewrite in `deriveExpectedTenantTableSnapshots`) is exercised against a real
 * database in `tenant-portability.postgres.test.ts`.
 */

import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { splitTenantJsonlLines, TENANT_EXPORT_ORDER_BY } from './tenant-database-io';

describe('TENANT_EXPORT_ORDER_BY', () => {
  it('orders by lossless server-produced row text under an explicit COLLATE "C"', () => {
    const rendered = new PgDialect().sqlToQuery(sql`SELECT 1 FROM x t ${TENANT_EXPORT_ORDER_BY}`);
    // The row text is produced by `to_jsonb(t)::text` on the server (never parsed
    // through a JS Number), and the collation is spelled out verbatim (no bound
    // parameter) so the export order is fixed by the bytes, not the server locale.
    expect(rendered.params).toEqual([]);
    expect(rendered.sql).toContain('to_jsonb(t)::pg_catalog.text COLLATE "C"');
  });
});

describe('splitTenantJsonlLines', () => {
  it('returns each row line verbatim, preserving precision beyond 2^53', () => {
    // The line carries an integer larger than Number.MAX_SAFE_INTEGER. A parse +
    // re-serialize would round it; splitTenantJsonlLines must hand back the exact
    // bytes so nothing lossy ever reaches the archive or the restore.
    const big = '{"id":"a","tenant_id":"src","n":9007199254740993}';
    expect(splitTenantJsonlLines(`${big}\n`)).toEqual([big]);
  });

  it('splits multiple rows and ignores the trailing newline', () => {
    const rows = ['{"id":"a"}', '{"id":"b"}'];
    expect(splitTenantJsonlLines(`${rows.join('\n')}\n`)).toEqual(rows);
  });

  it('returns no lines for empty JSONL', () => {
    expect(splitTenantJsonlLines('')).toEqual([]);
  });

  it('rejects a line that is not a JSON object', () => {
    expect(() => splitTenantJsonlLines('[1,2]\n')).toThrow();
    expect(() => splitTenantJsonlLines('not json\n')).toThrow();
    expect(() => splitTenantJsonlLines('"string"\n')).toThrow();
  });
});
