/**
 * Type-faithful, deterministic, LOSSLESS movement of a single tenant's rows in
 * and out of the archive, one table at a time.
 *
 * Every row is rendered to canonical JSON *text* by PostgreSQL itself
 * (`to_jsonb(row)::text`) and that text is what the archive stores, what the
 * content hash covers, what verification re-derives, and what restore feeds back
 * to the server. The persisted JSON never passes through a JavaScript `Number`,
 * so JSON/numeric content beyond `2^53` (bigint columns, arbitrary-precision
 * numbers inside jsonb) round-trips byte-for-byte. The only JavaScript parsing of
 * an archived line is a discard-only structural check (is it a JSON object?); the
 * exact bytes are never reconstructed in JS.
 *
 * The tenant-id rewrite a re-home needs is likewise performed server-side with
 * `jsonb_set`, so it too is lossless and cannot drift from what the database
 * actually stores. `restoreDatabase` and re-home classification share the SAME
 * rewrite expression ({@link rewrittenRowJsonb}) so their bytes cannot diverge.
 *
 * All statements are tenant-scoped: an explicit `WHERE tenant_id = $1` predicate
 * plus the ambient row-level-security policy, and — on restore — every row's
 * tenant discriminator is rewritten to the destination tenant so the RLS
 * `WITH CHECK` clause admits it. Reads are ordered by the canonical text of each
 * row so an unchanged table exports to identical bytes every time.
 *
 * These helpers must run inside an active tenant database scope
 * (`runWithTenantDatabaseScope`); the caller owns the transaction boundary.
 */

import { type SQL, sql } from 'drizzle-orm';
import type { Database } from './client';
import { executeRaw } from './database-wrapper';
import { readTableJsonl, sha256Hex, type TenantArchiveTable } from './tenant-archive';
import { buildTenantInsertOrder } from './tenant-portability-manifest';
import { TENANT_WRITE_GATE_KEY, TENANT_WRITE_GATE_NAMESPACE } from './tenant-write-gate';

const TENANT_SCHEMA = 'public';
const TENANT_SCOPE_COLUMN = 'tenant_id';

/** Rows are inserted in batches to bound statement/parameter size. */
const IMPORT_BATCH_SIZE = 500;

/**
 * Lossless, deterministic canonical text of the aliased row `t`: PostgreSQL
 * renders `to_jsonb(t)` to text on the server, so arbitrary-precision numeric and
 * JSON content is never coerced through a JavaScript `Number`. This is the single
 * expression that defines both the exported bytes and their ordering.
 */
const TENANT_ROW_CANONICAL_TEXT = sql`pg_catalog.to_jsonb(t)::pg_catalog.text`;

/**
 * Deterministic, cross-runtime ordering key for a tenant table export. Rows are
 * ordered by the canonical text of `to_jsonb(row)` under the byte-wise
 * `COLLATE "C"` collation. The explicit collation is load-bearing: without it,
 * PostgreSQL orders text under the database's default locale/ICU collation, so
 * two runtimes with different `lc_collate` (or ICU versions) could order the
 * same rows differently and produce diverging per-table content hashes for
 * identical data. Pinning `COLLATE "C"` makes the export byte order — and thus
 * the archive fingerprint — depend only on the row bytes, never on the server
 * locale. Exported so a test can assert the collation is present in the query.
 */
export const TENANT_EXPORT_ORDER_BY = sql`ORDER BY ${TENANT_ROW_CANONICAL_TEXT} COLLATE "C"`;

/** Top-level jsonb path of the tenant discriminator, as a `text[]` for `jsonb_set`. */
const TENANT_ID_JSONB_PATH = sql.raw(`'{${TENANT_SCOPE_COLUMN}}'`);

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  const rows = (result as { rows?: unknown[] } | undefined)?.rows;
  return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
}

function qualifiedTable(name: string) {
  return sql`${sql.identifier(TENANT_SCHEMA)}.${sql.identifier(name)}`;
}

/** Join canonical JSON lines into JSONL bytes: one line each, trailing newline. */
function joinJsonlLines(lines: string[]): string {
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

/**
 * Server-side, lossless rewrite of one archived row's tenant discriminator to
 * `destinationTenantId`, applied to the jsonb value referenced by `elem`. Shared
 * by restore (populate + insert) and re-home derivation (populate + re-emit) so
 * the transformed bytes each produces cannot drift.
 */
function rewrittenRowJsonb(elem: SQL, destinationTenantId: string, tableName: string): SQL {
  const tenantRewritten = sql`pg_catalog.jsonb_set(${elem}, ${TENANT_ID_JSONB_PATH}::pg_catalog.text[], pg_catalog.to_jsonb(${destinationTenantId}::pg_catalog.text))`;
  if (tableName !== 'mcp_servers') return tenantRewritten;

  // A catalog stamp proves that this deployment's marketplace install path
  // created a row. It cannot survive an archive crossing the import boundary:
  // the destination must treat the restored definition like any other imported
  // server and re-establish catalog trust only through Connect.
  const imported = sql`pg_catalog.jsonb_set(
    ((${tenantRewritten} #- '{data,catalog_entry_name}'::pg_catalog.text[])
      #- '{catalog_entry_name}'::pg_catalog.text[]),
    '{source}'::pg_catalog.text[],
    '"imported"'::pg_catalog.jsonb
  )`;
  // Archive revisions are evidence about the source daemon, not authority in
  // the destination. Validation rejects malformed/exhausted values before any
  // write; every accepted row starts a fresh bounded editor-CAS sequence.
  return sql`pg_catalog.jsonb_set(
    ${imported},
    '{data,config_version}'::pg_catalog.text[],
    '1'::pg_catalog.jsonb,
    true
  )`;
}

/**
 * Wrap validated archived lines as a single jsonb array *text* — purely by string
 * concatenation, so no line's numeric content is parsed through JavaScript. Each
 * line is already a valid JSON object, so `[line,line,…]` is valid JSON array
 * text the server re-parses losslessly into arbitrary-precision jsonb.
 */
function linesToJsonbArrayText(lines: string[]): string {
  return `[${lines.join(',')}]`;
}

/** Count the rows a table holds for one tenant. */
export async function countTenantTableRows(
  db: Database,
  tableName: string,
  tenantId: string,
  tenantColumn: string = TENANT_SCOPE_COLUMN
): Promise<number> {
  const column = sql.identifier(tenantColumn);
  // Exclude the reserved write-gate record so inspect's inventory matches what
  // export/verify account for (both drop this row); see exportTenantTableRows.
  const excludeGateRow =
    tableName === 'app_variables'
      ? sql` AND NOT (namespace = ${TENANT_WRITE_GATE_NAMESPACE} AND key = ${TENANT_WRITE_GATE_KEY})`
      : sql``;
  const result = await executeRaw(
    db,
    sql`SELECT pg_catalog.count(*) AS n FROM ${qualifiedTable(tableName)} WHERE ${column} = ${tenantId}${excludeGateRow}`
  );
  return Number(rowsOf(result)[0]?.n ?? 0);
}

/**
 * Read every row a table holds for one tenant as canonical JSON lines (JSONL),
 * ordered deterministically. PostgreSQL produces each line's text
 * ({@link TENANT_ROW_CANONICAL_TEXT}); JavaScript only concatenates the strings,
 * so the bytes are lossless. Returns the serialized text and the row count.
 */
export async function exportTenantTableRows(
  db: Database,
  tableName: string,
  tenantId: string,
  tenantColumn: string = TENANT_SCOPE_COLUMN
): Promise<{ jsonl: string; rowCount: number }> {
  const column = sql.identifier(tenantColumn);
  // The reserved per-tenant write-gate record (a single row in `app_variables`)
  // is live orchestration state, not tenant data: it carries a wall-clock
  // `acquiredAt` and a per-run `generation`, so archiving it would break
  // export determinism, and restoring it would leave the destination frozen at
  // the source's generation. Exclude it here so export, verify (live re-export
  // compare), and import classification — all of which call this function —
  // agree that the gate row is never part of the archive.
  const excludeGateRow =
    tableName === 'app_variables'
      ? sql` AND NOT (namespace = ${TENANT_WRITE_GATE_NAMESPACE} AND key = ${TENANT_WRITE_GATE_KEY})`
      : sql``;
  const result = await executeRaw(
    db,
    sql`
      SELECT ${TENANT_ROW_CANONICAL_TEXT} AS row
      FROM ${qualifiedTable(tableName)} t
      WHERE ${column} = ${tenantId}${excludeGateRow}
      ${TENANT_EXPORT_ORDER_BY}
    `
  );
  const lines = rowsOf(result).map((record) => String(record.row));
  return { jsonl: joinJsonlLines(lines), rowCount: lines.length };
}

/** One live tenant table's re-derived row count and content hash. */
export interface TenantTableSnapshot {
  name: string;
  rowCount: number;
  /** SHA-256 hex of the canonical JSONL bytes of this table's tenant rows. */
  sha256: string;
}

/**
 * Re-derive every movable tenant table's row count and content hash from the
 * live database for one tenant, in deterministic insert order — the minimal
 * shared basis both import (destination classification) and verify (drift
 * detection) build on. Must run inside an active tenant database scope; the
 * caller owns comparison and evidence aggregation.
 */
export async function snapshotTenantTableHashes(
  scoped: Database,
  tenantId: string
): Promise<TenantTableSnapshot[]> {
  const snapshots: TenantTableSnapshot[] = [];
  for (const table of buildTenantInsertOrder()) {
    const { jsonl, rowCount } = await exportTenantTableRows(
      scoped,
      table.name,
      tenantId,
      table.tenantColumn
    );
    snapshots.push({ name: table.name, rowCount, sha256: sha256Hex(Buffer.from(jsonl, 'utf8')) });
  }
  return snapshots;
}

/**
 * The SHA-256 of an empty (zero-row) table export — the hash
 * {@link snapshotTenantTableHashes} yields for a table with no tenant rows.
 */
const EMPTY_TABLE_SHA256 = sha256Hex(Buffer.from('', 'utf8'));

/**
 * Split JSONL text into its non-empty lines, validating that each is a JSON
 * object and returning the RAW line strings unchanged. The `JSON.parse` here is
 * a structural gate only — its result is discarded — so a line's numeric content
 * is never reconstructed through a JavaScript `Number`; the exact server-produced
 * bytes flow onward untouched. Splitting on `\n` is safe because a JSON string
 * escapes any embedded newline.
 */
export function splitTenantJsonlLines(jsonl: string): string[] {
  const lines: string[] = [];
  for (const line of jsonl.split('\n')) {
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error('Archive database file contains a line that is not valid JSON');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('Archive database file contains a row that is not a JSON object');
    }
    lines.push(line);
  }
  return lines;
}

/**
 * Derive, from the validated archive, the per-table row count and content hash
 * the destination database will hold once every row is rewritten to
 * `destinationTenantId` and restored. The rewrite and canonicalisation run
 * ENTIRELY in PostgreSQL — each archived line is re-parsed to jsonb, its tenant
 * discriminator rewritten with {@link rewrittenRowJsonb}, populated into the
 * table's own row type, and re-emitted as canonical text — the exact transform
 * {@link restoreDatabase} applies, so the result is byte-identical to the
 * snapshot a post-restore {@link snapshotTenantTableHashes} re-derives. For a
 * same-tenant import the rewrite is the identity, so it equals the archive's own
 * per-table hashes; for a re-home it is the hash bound to the destination tenant.
 * Import classification compares live snapshots against these to prove an exact
 * (possibly re-homed) restore, so a database committed before a filesystem-tail
 * failure is recognised as already applied on retry.
 *
 * Row ORDER is preserved from the archive, which the export ordered by the
 * server's `to_jsonb(row)::text COLLATE "C"`. Rewriting the tenant discriminator
 * to a single destination value uniformly (an equal contribution to every row's
 * ordering key) cannot reorder two distinct rows, so the archive order equals the
 * order a live re-export of the rewritten rows produces — the bytes, and thus the
 * hash, match exactly. Any mismatch is fail-closed: it classifies as a conflict.
 *
 * Requires a PostgreSQL database; it constructs the destination row type but
 * reads no tenant rows, so it needs no tenant scope.
 */
export async function deriveExpectedTenantTableSnapshots(
  db: Database,
  archivePath: string,
  archivedTables: readonly TenantArchiveTable[],
  destinationTenantId: string
): Promise<TenantTableSnapshot[]> {
  const archivedByName = new Map(archivedTables.map((table) => [table.name, table]));
  const snapshots: TenantTableSnapshot[] = [];
  for (const table of buildTenantInsertOrder()) {
    const archived = archivedByName.get(table.name);
    if (!archived || archived.rowCount === 0) {
      snapshots.push({ name: table.name, rowCount: 0, sha256: EMPTY_TABLE_SHA256 });
      continue;
    }
    const lines = splitTenantJsonlLines(await readTableJsonl(archivePath, table.name));
    const rewritten = await rewriteRowsToCanonicalText(db, table.name, lines, destinationTenantId);
    snapshots.push({
      name: table.name,
      rowCount: rewritten.length,
      sha256: sha256Hex(Buffer.from(joinJsonlLines(rewritten), 'utf8')),
    });
  }
  return snapshots;
}

/**
 * Transform archived lines to the canonical text the destination will hold once
 * restored under `destinationTenantId`, preserving archive order. Each line is
 * re-parsed to jsonb, tenant-rewritten, populated into the table's row type, and
 * re-emitted — the identical expression `restoreDatabase` inserts and a live
 * re-export re-derives — so the two cannot drift.
 */
async function rewriteRowsToCanonicalText(
  db: Database,
  tableName: string,
  lines: string[],
  destinationTenantId: string
): Promise<string[]> {
  const arrayText = linesToJsonbArrayText(lines);
  const result = await executeRaw(
    db,
    sql`
      SELECT pg_catalog.to_jsonb(
        pg_catalog.jsonb_populate_record(
          NULL::${qualifiedTable(tableName)},
          ${rewrittenRowJsonb(sql`element.value`, destinationTenantId, tableName)}
        )
      )::pg_catalog.text AS row
      FROM pg_catalog.jsonb_array_elements(${arrayText}::pg_catalog.jsonb)
        WITH ORDINALITY AS element(value, ord)
      ORDER BY element.ord
    `
  );
  return rowsOf(result).map((record) => String(record.row));
}

/**
 * Insert a table's archived JSONL lines for the destination tenant. The lines are
 * handed to PostgreSQL as jsonb array text and rewritten to `destinationTenantId`
 * server-side ({@link rewrittenRowJsonb}) before being populated into the table's
 * own row type, so no persisted value is coerced through a JavaScript `Number`.
 * Returns the number of rows inserted.
 */
export async function insertTenantTableRows(
  db: Database,
  tableName: string,
  lines: string[],
  destinationTenantId: string
): Promise<number> {
  let inserted = 0;
  for (let offset = 0; offset < lines.length; offset += IMPORT_BATCH_SIZE) {
    const chunk = lines.slice(offset, offset + IMPORT_BATCH_SIZE);
    const arrayText = linesToJsonbArrayText(chunk);
    await executeRaw(
      db,
      sql`
        INSERT INTO ${qualifiedTable(tableName)}
        SELECT * FROM pg_catalog.jsonb_populate_recordset(
          NULL::${qualifiedTable(tableName)},
          (
            SELECT pg_catalog.jsonb_agg(
              ${rewrittenRowJsonb(sql`element.value`, destinationTenantId, tableName)}
            )
            FROM pg_catalog.jsonb_array_elements(${arrayText}::pg_catalog.jsonb) AS element(value)
          )
        )
      `
    );
    inserted += chunk.length;
  }
  return inserted;
}
