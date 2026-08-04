/**
 * Unit coverage for tenant database-IO query construction that must not depend
 * on a live PostgreSQL server. Renders the exported ORDER BY fragment with the
 * PostgreSQL dialect and asserts the deterministic, locale-independent collation
 * is present — so cross-runtime archive hashes cannot silently start depending
 * on the destination database's default locale/ICU collation.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonicalJson, databaseDir, sha256Hex, type TenantArchiveTable } from './tenant-archive';
import {
  deriveExpectedTenantTableSnapshots,
  parseTenantJsonl,
  TENANT_EXPORT_ORDER_BY,
} from './tenant-database-io';
import { buildTenantInsertOrder } from './tenant-portability-manifest';

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

describe('deriveExpectedTenantTableSnapshots', () => {
  let scratch: string;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'agor-derive-'));
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  // Pick a real movable table so the helper's insert-order walk includes it.
  const tableName = buildTenantInsertOrder()[0].name;

  /** Canonical JSONL bytes an export writes for these rows, in the given order. */
  function jsonlBytes(rows: Record<string, unknown>[]): Buffer {
    const text = rows.length === 0 ? '' : `${rows.map((row) => canonicalJson(row)).join('\n')}\n`;
    return Buffer.from(text, 'utf8');
  }

  async function writeArchiveTable(rows: Record<string, unknown>[]): Promise<TenantArchiveTable> {
    await mkdir(databaseDir(scratch), { recursive: true });
    const bytes = jsonlBytes(rows);
    await writeFile(join(databaseDir(scratch), `${tableName}.jsonl`), bytes);
    return {
      name: tableName,
      rowCount: rows.length,
      sha256: sha256Hex(bytes),
      bytes: bytes.byteLength,
    };
  }

  it('derives the destination-bound hash a re-home restore will hold', async () => {
    const sourceRows = [
      { id: 'a', tenant_id: 'src', label: 'one' },
      { id: 'b', tenant_id: 'src', label: 'two' },
    ];
    const table = await writeArchiveTable(sourceRows);

    const snapshots = await deriveExpectedTenantTableSnapshots(scratch, [table], 'dst');
    const snapshot = snapshots.find((entry) => entry.name === tableName);

    // The expected hash equals a manual rewrite-to-dst + canonical re-serialize —
    // the exact bytes restore inserts and a live re-export re-derives.
    const rewritten = sourceRows.map((row) => ({ ...row, tenant_id: 'dst' }));
    expect(snapshot).toEqual({
      name: tableName,
      rowCount: 2,
      sha256: sha256Hex(jsonlBytes(rewritten)),
    });
    // It is NOT the source-bound archive hash — that is the whole point.
    expect(snapshot?.sha256).not.toBe(table.sha256);
  });

  it('reduces to the archive hash for a same-tenant import', async () => {
    const rows = [{ id: 'a', tenant_id: 'acme', label: 'x' }];
    const table = await writeArchiveTable(rows);

    const snapshots = await deriveExpectedTenantTableSnapshots(scratch, [table], 'acme');
    const snapshot = snapshots.find((entry) => entry.name === tableName);
    // Identity rewrite ⇒ the expected hash is exactly the archive's own hash, so
    // the same-tenant classification path is unchanged.
    expect(snapshot?.sha256).toBe(table.sha256);
  });

  it('yields the empty-table hash for every table absent from the archive', async () => {
    const table = await writeArchiveTable([{ id: 'a', tenant_id: 'src' }]);
    const snapshots = await deriveExpectedTenantTableSnapshots(scratch, [table], 'dst');
    const emptyHash = sha256Hex(Buffer.from('', 'utf8'));
    for (const snapshot of snapshots) {
      if (snapshot.name === tableName) continue;
      expect(snapshot).toEqual({ name: snapshot.name, rowCount: 0, sha256: emptyHash });
    }
  });
});
