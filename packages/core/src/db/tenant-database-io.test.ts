/**
 * Unit coverage for tenant database-IO query construction that must not depend
 * on a live PostgreSQL server. Renders the exported ORDER BY fragment with the
 * PostgreSQL dialect and asserts the deterministic, locale-independent collation
 * is present — so cross-runtime archive hashes cannot silently start depending
 * on the destination database's default locale/ICU collation.
 */

import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { parseTenantJsonl, TENANT_EXPORT_ORDER_BY } from './tenant-database-io';

describe('TENANT_EXPORT_ORDER_BY', () => {
  it('orders by canonical row text under an explicit byte-wise COLLATE "C"', () => {
    const rendered = new PgDialect().sqlToQuery(sql`SELECT 1 FROM x t ${TENANT_EXPORT_ORDER_BY}`);
    // The collation is spelled out verbatim (no bound parameter) so the export
    // order is fixed by the collation, not by the server locale/ICU version.
    expect(rendered.params).toEqual([]);
    expect(rendered.sql).toContain('to_jsonb(t)::pg_catalog.text COLLATE "C"');
  });
});

describe('parseTenantJsonl', () => {
  it('rewrites each row tenant discriminator to the destination tenant', () => {
    const rows = parseTenantJsonl('{"id":"a","tenant_id":"src"}\n', 'dest');
    expect(rows).toEqual([{ id: 'a', tenant_id: 'dest' }]);
  });

  it('rejects a line that is not a JSON object', () => {
    expect(() => parseTenantJsonl('[1,2]\n', 'dest')).toThrow();
    expect(() => parseTenantJsonl('not json\n', 'dest')).toThrow();
  });
});
