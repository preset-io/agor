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
 *      applied import is a no-op success — idempotency by operation. Identity is
 *      proven against the transformed archive: the per-table hashes the
 *      destination will hold once the archive's rows are rewritten to the target
 *      tenant, so the check holds for both same-tenant imports and re-homes.
 *   3. Restore the database transactionally: rows are inserted in deterministic
 *      parent-first order with movable PostgreSQL FKs deferred, inside one
 *      tenant-scoped transaction that commits atomically or rolls back.
 *   4. Restore the filesystem through staging plus atomic publication: the tree
 *      is materialised in a staging directory and published to the tenant root
 *      with a single atomic rename, preserving safe file modes.
 *
 * Re-homing to a different destination tenant id is supported. Classification
 * compares the live destination against hashes re-derived from the archive under
 * the destination tenant id (not the source-bound archive hashes), so a re-home
 * interrupted after the database commit but before the filesystem tail is
 * recognised as already-applied on retry and completes the filesystem portion,
 * and a fully-applied re-home re-runs as a no-op — the same per-portion
 * idempotency the same-tenant path has.
 */

import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { sql } from 'drizzle-orm';
import { assertValidArchivedMCPServerRow } from '../tools/mcp/server-validation';
import type { Database } from './client';
import { executeRaw, isPostgresDatabase } from './database-wrapper';
import { isDatabaseUniqueConstraintError } from './sanitize-error';
import {
  assertManifestTablesMatchCatalog,
  filesDir,
  MalformedArchiveError,
  readManifest,
  readTableJsonl,
  type TenantArchiveManifest,
  verifyArchiveIntegrity,
} from './tenant-archive';
import { resolveTenantDatabaseIdentity } from './tenant-catalog';
import {
  countTenantTableRows,
  deriveExpectedTenantTableSnapshots,
  insertTenantTableRows,
  snapshotTenantTableHashes,
  splitTenantJsonlLines,
} from './tenant-database-io';
import { assertValidTenantId } from './tenant-deletion';
import {
  assertSymlinkTargetWithinRoot,
  publishTenantFilesystemAtomically,
  stageTenantFilesystem,
  summarizeTenantFilesystem,
  type TenantFilesystemEntry,
  tenantFilesystemEntriesEqual,
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
 * Catalog trust is deployment-local review authority, not portable tenant
 * data. Validate archived public OAuth values and header identity before any
 * write; the database rewrite later marks every restored MCP row `imported`
 * and removes its catalog stamp.
 */
export async function validateArchivedMCPCompatibilityModes(
  archivePath: string,
  manifest: TenantArchiveManifest
): Promise<void> {
  const table = manifest.database.tables.find((candidate) => candidate.name === 'mcp_servers');
  if (!table || table.rowCount === 0) return;
  const lines = splitTenantJsonlLines(await readTableJsonl(archivePath, table.name));
  for (const line of lines) {
    try {
      assertValidArchivedMCPServerRow(JSON.parse(line));
    } catch (error) {
      throw new MalformedArchiveError(
        `Refusing to import mcp_servers: ${
          error instanceof Error ? error.message : 'invalid MCP server row'
        }`
      );
    }
  }
}

/**
 * Classify the live database for the destination tenant relative to the archive:
 * empty (no rows), matches (already holds exactly this archive's rows), or
 * conflict (holds different data). Comparison is against `expectedByName` —
 * the per-table snapshots the destination will hold once the archive's rows are
 * rewritten to the destination tenant and restored (see
 * {@link deriveExpectedTenantTableSnapshots}). Because the expected hashes are
 * bound to the destination tenant id, a fully-applied re-home is recognised as
 * `matches` exactly as a same-tenant import is, while any divergence — a foreign
 * tenant's rows, a partial restore, or altered data — stays a fail-closed
 * `conflict`.
 */
async function classifyDatabase(
  db: Database,
  tenantId: string,
  expectedByName: Map<string, { rowCount: number; sha256: string }>,
  nonPortableTableNames: readonly string[]
): Promise<{ state: PortionState; totalRows: number }> {
  return runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
    const snapshots = await snapshotTenantTableHashes(scoped, tenantId);
    let totalRows = 0;
    let anyMismatch = false;
    // Non-portable authority rows are intentionally absent from the archive,
    // but they still prove the destination tenant is occupied. Silently
    // retaining one could reactivate a source-independent bearer after an
    // otherwise successful import/re-home, so any such row is a conflict.
    for (const tableName of nonPortableTableNames) {
      const rowCount = await countTenantTableRows(scoped, tableName, tenantId);
      totalRows += rowCount;
      if (rowCount > 0) anyMismatch = true;
    }
    for (const snapshot of snapshots) {
      totalRows += snapshot.rowCount;
      const expected = expectedByName.get(snapshot.name);
      if (
        !expected ||
        expected.rowCount !== snapshot.rowCount ||
        expected.sha256 !== snapshot.sha256
      ) {
        anyMismatch = true;
      }
    }
    if (totalRows === 0) return { state: 'empty' as PortionState, totalRows };
    if (!anyMismatch) return { state: 'matches' as PortionState, totalRows };
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
    // The portability FK migration leaves normal transactions initially
    // immediate. Only the import transaction opts into commit-time checking so
    // complete, valid cycles can be inserted atomically and invalid archives
    // still roll the whole tenant restore back at commit.
    if (isPostgresDatabase(db)) {
      await executeRaw(scoped, sql`SET CONSTRAINTS ALL DEFERRED`);
    }
    let inserted = 0;
    for (const table of insertOrder) {
      const archived = archivedByName.get(table.name);
      if (!archived || archived.rowCount === 0) continue;
      const lines = splitTenantJsonlLines(await readTableJsonl(archivePath, table.name));
      if (lines.length !== archived.rowCount) {
        throw new MalformedArchiveError(
          `Archive table ${table.name} declares ${archived.rowCount} row(s) but contains ${lines.length}`
        );
      }
      let count: number;
      try {
        count = await insertTenantTableRows(scoped, table.name, lines, tenantId);
      } catch (error) {
        if (isDatabaseUniqueConstraintError(error)) {
          // Row identifiers (UUID primary keys) are globally unique across a
          // runtime, not just within a tenant. A collision here means the
          // destination runtime already holds these ids — the usual cause is
          // re-homing (a `--tenant-id` different from the archive) into the SAME
          // runtime the archive came from. Re-homing must target a DIFFERENT
          // runtime whose global key space is empty for these ids; it does not
          // clone a tenant within one runtime.
          throw new MalformedArchiveError(
            `Refusing to import: unique/primary-key collision while restoring ${table.name}. ` +
              'Re-homing to a different --tenant-id must target a separate destination runtime ' +
              'with a globally-empty key space, not the runtime the archive was exported from. ' +
              'Import into a fresh runtime instead.'
          );
        }
        throw error;
      }
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

  // Validate the archive's own integrity before touching the live system.
  const integrity = await verifyArchiveIntegrity(options.archivePath, manifest);
  if (!integrity.ok) {
    throw new MalformedArchiveError(
      `Refusing to import: archive failed integrity check (${integrity.problemCount} problem(s)); first: ${integrity.problems[0] ?? 'unknown'}`
    );
  }

  // Prove every stored symlink target is root-contained BEFORE any database
  // write. Structural manifest validation checks each entry's own path but not
  // its symlink target, so a self-consistent (correctly-fingerprinted) archive
  // could otherwise carry an escaping link that is only caught later by staging
  // — after the database has already been mutated. Validating targets here keeps
  // the "rejected before any data was modified" guarantee honest for this class
  // of crafted archive; staging re-checks as a last line of defense.
  for (const entry of manifest.filesystem.entries) {
    if (entry.type === 'symlink') {
      assertSymlinkTargetWithinRoot(entry.path, entry.linkTarget ?? '');
    }
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

  // The archive must carry exactly the live catalog's movable tenant tables —
  // no missing, extra, or duplicate — before we read or restore any of them.
  assertManifestTablesMatchCatalog(manifest, identity.tenantTables);

  await validateArchivedMCPCompatibilityModes(options.archivePath, manifest);

  // Derive the exact per-table snapshots the destination will hold once the
  // archive's rows are rewritten to `tenantId` and restored. Comparing the live
  // database against these — rather than against the source-bound archive hashes
  // — lets a same-tenant import AND a re-home both recognise an already-applied
  // restore, so a database committed before a filesystem-tail failure is not
  // stranded as an unretryable conflict.
  const expectedSnapshots = await deriveExpectedTenantTableSnapshots(
    db,
    options.archivePath,
    manifest.database.tables,
    tenantId
  );
  const expectedByName = new Map(
    expectedSnapshots.map((snapshot) => [
      snapshot.name,
      { rowCount: snapshot.rowCount, sha256: snapshot.sha256 },
    ])
  );

  // Classify each destination portion.
  const dbClassification = await classifyDatabase(
    db,
    tenantId,
    expectedByName,
    identity.nonPortableTenantTables
  );
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
    } else {
      // A populated destination is only acceptable if it already matches the
      // manifest exactly. Filesystem content is independent of the tenant-id
      // rewrite (paths and bytes are not tenant-bound), so a re-home whose tree
      // was fully published is recognised here just as a same-tenant import is —
      // letting a filesystem-tail retry finish as a no-op rather than conflict.
      const { walkTenantFilesystemTree } = await import('./tenant-filesystem');
      const walk = await walkTenantFilesystemTree(options.filesystemRoot as string);
      fsState = filesystemMatches(manifest, walk.entries) ? 'matches' : 'conflict';
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
  live: TenantFilesystemEntry[]
): boolean {
  if (live.length !== manifest.filesystem.entries.length) return false;
  const archived = new Map(manifest.filesystem.entries.map((entry) => [entry.path, entry]));
  for (const entry of live) {
    const match = archived.get(entry.path);
    if (!match || !tenantFilesystemEntriesEqual(match, entry)) return false;
  }
  return true;
}
