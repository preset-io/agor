/**
 * `importTenant` — restore a tenant from an archive into a destination runtime,
 * validating the archive fully before any mutation and applying changes so the
 * operation is safe to retry.
 *
 * Contract:
 *
 *   1. Validate first: parse and hash-check the archive, and require the live
 *      database's migration ledger and tenant-table identity to match the
 *      archive exactly. A malformed archive, traversal path, unsafe symlink, or
 *      schema mismatch is rejected before anything is written.
 *   2. Require an empty destination or the identical prior operation. Emptiness
 *      and identity are evaluated per portion (database, filesystem) so a run
 *      interrupted between the two can be re-run to completion, and a fully
 *      applied import is a no-op success — idempotency by operation.
 *   3. Restore the database transactionally: all rows are inserted parent-first
 *      inside one tenant-scoped transaction that commits atomically or rolls
 *      back.
 *   4. Restore the filesystem through staging plus atomic publication: the tree
 *      is materialised in a staging directory and published to the tenant root
 *      with a single atomic rename, preserving safe file modes.
 *
 * Re-homing to a different destination tenant id is supported, but only into a
 * genuinely empty destination (the archive's hashes are bound to the source
 * tenant id, so the identical-prior-operation shortcut cannot apply).
 */

import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Database } from './client';
import {
  filesDir,
  MalformedArchiveError,
  readManifest,
  readTableJsonl,
  sha256Hex,
  type TenantArchiveManifest,
  verifyArchiveIntegrity,
} from './tenant-archive';
import { resolveTenantDatabaseIdentity } from './tenant-catalog';
import {
  exportTenantTableRows,
  insertTenantTableRows,
  parseTenantJsonl,
} from './tenant-database-io';
import { assertValidTenantId } from './tenant-deletion';
import {
  publishTenantFilesystemAtomically,
  stageTenantFilesystem,
  summarizeTenantFilesystem,
} from './tenant-filesystem';
import { buildTenantInsertOrder } from './tenant-portability-manifest';
import { runWithTenantDatabaseScope } from './tenant-scope';

/** Bounded, secret-free summary returned by {@link importTenant}. */
export interface TenantImportResult {
  operationId: string;
  tenantId: string;
  contentFingerprint: string;
  /** True when both portions were already applied and nothing changed. */
  alreadyApplied: boolean;
  database: { restored: boolean; tableCount: number; totalRows: number };
  filesystem: { restored: boolean; fileCount: number };
}

export interface TenantImportOptions {
  /** Archive directory to restore from. */
  archivePath: string;
  /**
   * Destination tenant id. Defaults to the archive's tenant. A different id
   * re-homes the tenant and requires an empty destination.
   */
  tenantId?: string;
  /**
   * Absolute destination tenant filesystem root (as resolved by
   * `getTenantDataRoot(tenantId)`). Required to restore the filesystem portion.
   */
  filesystemRoot?: string;
  /** Human-readable audit sink (secret-safe). Defaults to a no-op. */
  log?: (message: string) => void;
}

type PortionState = 'empty' | 'matches' | 'conflict';

/**
 * Classify the live database for the destination tenant relative to the archive:
 * empty (no rows), matches (already holds exactly this archive's rows), or
 * conflict (holds different data). When re-homing, a non-empty destination is
 * always a conflict because the archive hashes are bound to the source tenant.
 */
async function classifyDatabase(
  db: Database,
  tenantId: string,
  manifest: TenantArchiveManifest,
  sameTenant: boolean
): Promise<{ state: PortionState; totalRows: number }> {
  const insertOrder = buildTenantInsertOrder();
  const archivedByName = new Map(manifest.database.tables.map((table) => [table.name, table]));
  return runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
    let totalRows = 0;
    let anyMismatch = false;
    for (const table of insertOrder) {
      const { jsonl, rowCount } = await exportTenantTableRows(
        scoped,
        table.name,
        tenantId,
        table.tenantColumn
      );
      totalRows += rowCount;
      if (sameTenant) {
        const archived = archivedByName.get(table.name);
        const liveHash = sha256Hex(Buffer.from(jsonl, 'utf8'));
        if (!archived || archived.rowCount !== rowCount || archived.sha256 !== liveHash) {
          anyMismatch = true;
        }
      }
    }
    if (totalRows === 0) return { state: 'empty' as PortionState, totalRows };
    if (sameTenant && !anyMismatch) return { state: 'matches' as PortionState, totalRows };
    return { state: 'conflict' as PortionState, totalRows };
  });
}

/** Insert every archived table's rows in parent-first order inside one tx. */
async function restoreDatabase(
  db: Database,
  tenantId: string,
  manifest: TenantArchiveManifest,
  archivePath: string,
  log: (message: string) => void
): Promise<number> {
  const insertOrder = buildTenantInsertOrder();
  const archivedByName = new Map(manifest.database.tables.map((table) => [table.name, table]));
  return runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
    let inserted = 0;
    for (const table of insertOrder) {
      const archived = archivedByName.get(table.name);
      if (!archived || archived.rowCount === 0) continue;
      const jsonl = await readTableJsonl(archivePath, table.name);
      const rows = parseTenantJsonl(jsonl, tenantId);
      if (rows.length !== archived.rowCount) {
        throw new MalformedArchiveError(
          `Archive table ${table.name} declares ${archived.rowCount} row(s) but contains ${rows.length}`
        );
      }
      const count = await insertTenantTableRows(scoped, table.name, rows);
      inserted += count;
      if (count > 0) log(`restored ${count} row(s) into ${table.name}`);
    }
    return inserted;
  });
}

/**
 * Restore a tenant archive. Validates fully before mutating and applies each
 * portion idempotently.
 */
export async function importTenant(
  db: Database,
  options: TenantImportOptions
): Promise<TenantImportResult> {
  const log = options.log ?? (() => {});
  const manifest = await readManifest(options.archivePath);
  const tenantId = options.tenantId ?? manifest.tenantId;
  assertValidTenantId(tenantId);
  const sameTenant = tenantId === manifest.tenantId;

  // Validate the archive's own integrity before touching the live system.
  const integrity = await verifyArchiveIntegrity(options.archivePath, manifest);
  if (!integrity.ok) {
    throw new MalformedArchiveError(
      `Refusing to import: archive failed integrity check (${integrity.problemCount} problem(s)); first: ${integrity.problems[0] ?? 'unknown'}`
    );
  }

  // The live schema must be exactly the schema the archive was produced against.
  const identity = await resolveTenantDatabaseIdentity(db);
  const archiveMigrations = manifest.database.identity.migrations;
  const sameLedger =
    identity.migrations.length === archiveMigrations.length &&
    identity.migrations.every((tag, index) => tag === archiveMigrations[index]);
  if (!sameLedger || identity.fingerprint !== manifest.database.identity.fingerprint) {
    throw new MalformedArchiveError(
      `Refusing to import: live database identity (schemaVersion=${identity.schemaVersion}) does not match the archive (schemaVersion=${manifest.database.identity.schemaVersion})`
    );
  }

  // Classify each destination portion.
  const dbClassification = await classifyDatabase(db, tenantId, manifest, sameTenant);
  if (dbClassification.state === 'conflict') {
    throw new MalformedArchiveError(
      'Refusing to import: destination database is not empty and does not match this archive'
    );
  }

  const wantFilesystem = manifest.filesystem.included && typeof options.filesystemRoot === 'string';
  let fsState: PortionState | 'skipped' = 'skipped';
  if (wantFilesystem) {
    const inventory = await summarizeTenantFilesystem(options.filesystemRoot as string);
    if (
      !inventory.present ||
      inventory.fileCount + inventory.directoryCount + inventory.symlinkCount === 0
    ) {
      fsState = 'empty';
    } else if (sameTenant) {
      // A populated destination is only acceptable if it already matches.
      const { walkTenantFilesystemTree } = await import('./tenant-filesystem');
      const walk = await walkTenantFilesystemTree(options.filesystemRoot as string);
      const matches = filesystemMatches(manifest, walk.entries);
      fsState = matches ? 'matches' : 'conflict';
    } else {
      fsState = 'conflict';
    }
    if (fsState === 'conflict') {
      throw new MalformedArchiveError(
        'Refusing to import: destination filesystem is not empty and does not match this archive'
      );
    }
  }

  // Apply database portion.
  let databaseRestored = false;
  let restoredRows = 0;
  if (dbClassification.state === 'empty') {
    restoredRows = await restoreDatabase(db, tenantId, manifest, options.archivePath, log);
    databaseRestored = true;
  }

  // Apply filesystem portion via staging + atomic publish.
  let filesystemRestored = false;
  let restoredFileCount = 0;
  if (wantFilesystem && fsState === 'empty') {
    const destinationRoot = options.filesystemRoot as string;
    const stagingRoot = join(dirname(destinationRoot), `.agor-import-${manifest.operationId}`);
    // Clear any leftover staging from a previous interrupted run.
    await rm(stagingRoot, { recursive: true, force: true });
    await stageTenantFilesystem(
      manifest.filesystem.entries,
      filesDir(options.archivePath),
      stagingRoot
    );
    await publishTenantFilesystemAtomically(stagingRoot, destinationRoot);
    filesystemRestored = true;
    restoredFileCount = manifest.filesystem.entries.filter((entry) => entry.type === 'file').length;
    log(`restored ${restoredFileCount} filesystem file(s)`);
  }

  const alreadyApplied =
    !databaseRestored &&
    !filesystemRestored &&
    dbClassification.state === 'matches' &&
    (!wantFilesystem || fsState === 'matches');

  return {
    operationId: manifest.operationId,
    tenantId,
    contentFingerprint: manifest.contentFingerprint,
    alreadyApplied,
    database: {
      restored: databaseRestored,
      tableCount: manifest.database.tables.length,
      totalRows: databaseRestored ? restoredRows : dbClassification.totalRows,
    },
    filesystem: {
      restored: filesystemRestored,
      fileCount: restoredFileCount,
    },
  };
}

/** Whether a live filesystem tree exactly matches the manifest's entries. */
function filesystemMatches(
  manifest: TenantArchiveManifest,
  live: {
    path: string;
    type: string;
    size: number;
    sha256?: string;
    linkTarget?: string;
    mode: number;
  }[]
): boolean {
  if (live.length !== manifest.filesystem.entries.length) return false;
  const archived = new Map(manifest.filesystem.entries.map((entry) => [entry.path, entry]));
  for (const entry of live) {
    const match = archived.get(entry.path);
    if (
      !match ||
      match.type !== entry.type ||
      match.size !== entry.size ||
      match.mode !== entry.mode ||
      (match.sha256 ?? null) !== (entry.sha256 ?? null) ||
      (match.linkTarget ?? null) !== (entry.linkTarget ?? null)
    ) {
      return false;
    }
  }
  return true;
}
