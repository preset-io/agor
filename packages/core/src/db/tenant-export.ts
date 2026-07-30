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
import { generateId } from '../lib/ids';
import type { Database } from './client';
import {
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
import { resolveTenantDatabaseIdentity } from './tenant-catalog';
import { exportTenantTableRows } from './tenant-database-io';
import { assertValidTenantId } from './tenant-deletion';
import { copyTenantFilesystemInto, type TenantFilesystemEntry } from './tenant-filesystem';
import { buildTenantInsertOrder } from './tenant-portability-manifest';
import { runWithTenantDatabaseScope } from './tenant-scope';

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

  const identity = await resolveTenantDatabaseIdentity(db);
  await assertEmptyArchiveDestination(options.archivePath);
  await mkdir(databaseDir(options.archivePath), { recursive: true });

  const insertOrder = buildTenantInsertOrder();
  const tables: TenantArchiveTable[] = [];
  let totalRows = 0;

  log(`exporting tenant ${tenantId} (schemaVersion=${identity.schemaVersion})`);
  await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
    for (const table of insertOrder) {
      const { jsonl, rowCount } = await exportTenantTableRows(
        scoped,
        table.name,
        tenantId,
        table.tenantColumn
      );
      const bytes = Buffer.from(jsonl, 'utf8');
      await writeFile(tableJsonlPath(options.archivePath, table.name), bytes);
      tables.push({
        name: table.name,
        rowCount,
        sha256: sha256Hex(bytes),
        bytes: bytes.byteLength,
      });
      totalRows += rowCount;
      if (rowCount > 0) log(`exported ${rowCount} row(s) from ${table.name}`);
    }
  });

  let filesystemEntries: TenantFilesystemEntry[] = [];
  let skippedSpecialCount = 0;
  let unsafeSymlinkCount = 0;
  const includeFilesystem = typeof options.filesystemRoot === 'string';
  if (includeFilesystem) {
    const walk = await copyTenantFilesystemInto(
      options.filesystemRoot as string,
      filesDir(options.archivePath)
    );
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
  };
}
