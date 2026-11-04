/**
 * `exportTenant` — write a deterministic, versioned archive of one tenant's
 * database rows and configured filesystem tree, plus a manifest that binds the
 * archive to the tenant and the operation, records the runtime database
 * identity, and hashes every payload.
 *
 * The archive is a directory the caller owns; Agor never decides how it is
 * transported or stored. The database read happens inside a single tenant
 * database scope so all tables reflect one consistent point (the same
 * operator-quiescence precondition the deletion engine documents applies: no
 * concurrent tenant writes for the duration).
 *
 * Nothing but tenant-owned rows and tenant filesystem files is written, and the
 * manifest contains only identifiers, counts, hashes, and safe relative paths.
 */

import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { relative, sep } from 'node:path';
import { sql } from 'drizzle-orm';
import { generateId } from '../lib/ids';
import type { Database } from './client';
import { executeRaw, isSQLiteDatabase } from './database-wrapper';
import {
  assertSafeOperationId,
  computeContentFingerprint,
  databaseDir,
  filesDir,
  MalformedArchiveError,
  sha256Hex,
  TENANT_ARCHIVE_MANIFEST_VERSION,
  type TenantArchiveManifest,
  type TenantArchiveTable,
  tableJsonlPath,
  writeManifest,
} from './tenant-archive';
import {
  resolveSqliteTenantDatabaseIdentity,
  resolveTenantDatabaseIdentity,
} from './tenant-catalog';
import { countTenantRowsWithValue, exportTenantTableRows } from './tenant-database-io';
import { assertValidTenantId } from './tenant-deletion';
import { copyTenantFilesystemInto, type TenantFilesystemEntry } from './tenant-filesystem';
import {
  buildTenantInsertOrder,
  TENANT_IN_FLIGHT_PAYLOAD_COLUMN,
} from './tenant-portability-manifest';
import { runWithTenantDatabaseScope } from './tenant-scope';
import {
  emptySecretRewrapCounts,
  rewrapEnvelopesInText,
  type SecretRewrapCounts,
} from './tenant-secret-rewrap';
import { exportSqliteTenantTableRows, sqliteTableExists } from './tenant-sqlite-export';

/** Bounded, secret-free summary returned by {@link exportTenant}. */
export interface TenantExportResult {
  operationId: string;
  tenantId: string;
  manifestVersion: number;
  schemaVersion: string;
  contentFingerprint: string;
  database: { tableCount: number; totalRows: number };
  filesystem: { included: boolean; fileCount: number; totalBytes: number };
  archivePath: string;
  /** Present when secrets were resealed under a transfer key. */
  secrets?: SecretRewrapCounts;
}

export interface TenantExportOptions {
  /** Destination archive directory. Must be empty or not yet exist. */
  archivePath: string;
  /** Operation id bound into the manifest. Generated when omitted. */
  operationId?: string;
  /**
   * Absolute tenant filesystem root to include (as resolved by
   * `getTenantDataRoot(tenantId)`). Omit to export the database only.
   */
  filesystemRoot?: string;
  /** Human-readable audit sink (secret-safe). Defaults to a no-op. */
  log?: (message: string) => void;
  /** Agor release recorded in the manifest (informational). */
  agorRelease?: string;
  /**
   * Reseal every secret from the source key to a one-time transfer key while
   * writing rows, so the archive never carries the source install's key.
   */
  transferKey?: { fromKey: string; toKey: string };
  /**
   * Export only what a move needs from the filesystem: branch SDK homes,
   * uploads, and the working trees of local-home teammates (which have no
   * remote). Repositories and other checkouts are re-cloned at the destination.
   */
  filesSubset?: boolean;
}

const SEEDED_KNOWLEDGE_NAMESPACE_IDS = [
  '00000000-0000-7000-8000-000000000001',
  '00000000-0000-7000-8000-000000000002',
] as const;

/** Deterministic UUID-shaped id for `seed` within `tenantId`. */
function tenantScopedId(tenantId: string, seed: string): string {
  const hex = sha256Hex(`${tenantId}:${seed}`);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Export refused because queued provider payloads have not drained yet. */
export class TenantExportInFlightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantExportInFlightError';
  }
}

async function assertEmptyArchiveDestination(archivePath: string): Promise<void> {
  let existing: string[] | null = null;
  try {
    existing = await readdir(archivePath);
  } catch {
    existing = null; // Does not exist yet — fine.
  }
  if (existing && existing.length > 0) {
    throw new MalformedArchiveError(
      `Refusing to export: archive destination is not empty: ${archivePath}`
    );
  }
}

/**
 * Export a tenant to an archive directory and return the bounded result. The
 * database is read in a single tenant scope; the filesystem tree, if requested,
 * is copied afterward.
 */
export async function exportTenant(
  db: Database,
  tenantId: string,
  options: TenantExportOptions
): Promise<TenantExportResult> {
  assertValidTenantId(tenantId);
  const log = options.log ?? (() => {});
  const operationId = options.operationId ?? generateId();
  // Reject a caller-supplied operation id that could escape the importer's
  // staging-directory path (covers the CLI `--operation-id` flag and the API).
  assertSafeOperationId(operationId);

  const sqlite = isSQLiteDatabase(db);
  const identity = sqlite
    ? await resolveSqliteTenantDatabaseIdentity(db, { agorRelease: options.agorRelease })
    : {
        ...(await resolveTenantDatabaseIdentity(db)),
        ...(options.agorRelease ? { agorRelease: options.agorRelease } : {}),
      };
  await assertEmptyArchiveDestination(options.archivePath);
  await mkdir(databaseDir(options.archivePath), { recursive: true });

  const insertOrder = buildTenantInsertOrder();
  const tables: TenantArchiveTable[] = [];
  let totalRows = 0;
  const secrets = options.transferKey ? emptySecretRewrapCounts() : undefined;
  const branchLines: string[] = [];

  const writeTable = async (name: string, lines: string[]) => {
    const resealed =
      options.transferKey && secrets
        ? lines.map((line) => rewrapEnvelopesInText(line, options.transferKey!, secrets))
        : lines;
    if (name === 'branches') branchLines.push(...resealed);
    const bytes = Buffer.from(resealed.length === 0 ? '' : `${resealed.join('\n')}\n`, 'utf8');
    await writeFile(tableJsonlPath(options.archivePath, name), bytes);
    tables.push({
      name,
      rowCount: resealed.length,
      sha256: sha256Hex(bytes),
      bytes: bytes.byteLength,
    });
    totalRows += resealed.length;
    if (resealed.length > 0) log(`exported ${resealed.length} row(s) from ${name}`);
  };

  log(
    `exporting tenant ${tenantId} (${identity.dialect}, schemaVersion=${identity.schemaVersion})`
  );
  const { table: inFlightTable, column: inFlightColumn } = TENANT_IN_FLIGHT_PAYLOAD_COLUMN;
  const refuseInFlight = (pending: number) => {
    if (pending > 0) {
      throw new TenantExportInFlightError(
        `Refusing to export: ${pending} queued ${inFlightTable} payload(s) are still in flight; retry after the gateway worker processes or expires them`
      );
    }
  };
  if (sqlite) {
    // A single-tenant SQLite install: every row belongs to the exported tenant.
    if (await sqliteTableExists(db, inFlightTable)) {
      const result = await executeRaw(
        db,
        sql`SELECT count(*) AS n FROM ${sql.identifier(inFlightTable)} WHERE ${sql.identifier(inFlightColumn)} IS NOT NULL`
      );
      const rows = (result as { rows?: Array<Record<string, unknown>> }).rows ?? [];
      refuseInFlight(Number(rows[0]?.n ?? 0));
    }
    // SQLite migrations seed the built-in Global/Skills Knowledge namespaces
    // with fixed ids that PostgreSQL already holds for its default tenant;
    // give this tenant its own stable ids so the import cannot collide.
    const seeded = SEEDED_KNOWLEDGE_NAMESPACE_IDS.map((id) => [id, tenantScopedId(tenantId, id)]);
    for (const table of insertOrder) {
      const lines = (await sqliteTableExists(db, table.name))
        ? (await exportSqliteTenantTableRows(db, table.name, tenantId)).lines
        : [];
      await writeTable(
        table.name,
        lines.map((line) => seeded.reduce((text, [from, to]) => text.replaceAll(from, to), line))
      );
    }
  } else {
    await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
      refuseInFlight(
        await countTenantRowsWithValue(scoped, inFlightTable, inFlightColumn, tenantId)
      );
      for (const table of insertOrder) {
        const { jsonl } = await exportTenantTableRows(
          scoped,
          table.name,
          tenantId,
          table.tenantColumn
        );
        await writeTable(
          table.name,
          jsonl.length === 0 ? [] : jsonl.replace(/\n$/, '').split('\n')
        );
      }
    });
  }

  let filesystemEntries: TenantFilesystemEntry[] = [];
  let skippedSpecialCount = 0;
  let unsafeSymlinkCount = 0;
  const includeFilesystem = typeof options.filesystemRoot === 'string';
  if (includeFilesystem) {
    const root = options.filesystemRoot as string;
    const include = options.filesSubset ? filesSubsetFilter(root, branchLines) : undefined;
    const walk = await copyTenantFilesystemInto(root, filesDir(options.archivePath), include);
    filesystemEntries = walk.entries;
    skippedSpecialCount = walk.skippedSpecialCount;
    unsafeSymlinkCount = walk.unsafeSymlinkCount;
    const fileCount = filesystemEntries.filter((entry) => entry.type === 'file').length;
    if (fileCount > 0) log(`exported ${fileCount} filesystem file(s)`);
    if (unsafeSymlinkCount > 0) {
      log(`skipped ${unsafeSymlinkCount} symlink(s) whose target escapes the tenant root`);
    }
  }

  const manifestBase: Pick<
    TenantArchiveManifest,
    'manifestVersion' | 'tenantId' | 'database' | 'filesystem'
  > = {
    manifestVersion: TENANT_ARCHIVE_MANIFEST_VERSION,
    tenantId,
    database: { identity, tables },
    filesystem: {
      included: includeFilesystem,
      entries: filesystemEntries,
      skippedSpecialCount,
      unsafeSymlinkCount,
    },
  };
  const contentFingerprint = computeContentFingerprint(manifestBase);
  const manifest: TenantArchiveManifest = {
    ...manifestBase,
    operationId,
    createdAt: new Date().toISOString(),
    contentFingerprint,
  };
  await writeManifest(options.archivePath, manifest);

  const fileCount = filesystemEntries.filter((entry) => entry.type === 'file').length;
  const totalBytes = filesystemEntries.reduce(
    (sum, entry) => sum + (entry.type === 'file' ? entry.size : 0),
    0
  );
  log(`export complete (${totalRows} row(s), ${fileCount} file(s))`);

  return {
    operationId,
    tenantId,
    manifestVersion: TENANT_ARCHIVE_MANIFEST_VERSION,
    schemaVersion: identity.schemaVersion,
    contentFingerprint,
    database: { tableCount: tables.length, totalRows },
    filesystem: { included: includeFilesystem, fileCount, totalBytes },
    archivePath: options.archivePath,
    ...(secrets ? { secrets } : {}),
  };
}

/**
 * Paths a move needs: SDK homes, uploads, and local-home teammate trees (they
 * have no remote to re-clone from). Everything else is re-provisioned.
 */
function filesSubsetFilter(root: string, branchLines: string[]): (path: string) => boolean {
  const prefixes = ['branch-homes/', 'uploads/'];
  for (const line of branchLines) {
    const row = JSON.parse(line) as {
      data?: { path?: string; custom_context?: { teammate?: { localHome?: boolean } } };
    };
    const path = row.data?.path;
    if (!path || row.data?.custom_context?.teammate?.localHome !== true) continue;
    const rel = relative(root, path).split(sep).join('/');
    if (rel && !rel.startsWith('..')) prefixes.push(`${rel}/`);
  }
  return (path) =>
    prefixes.some((prefix) => `${path}/`.startsWith(prefix) || prefix.startsWith(`${path}/`));
}
