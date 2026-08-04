/**
 * `verifyTenant` — prove that a tenant's live data matches a saved archive
 * proof. It re-derives the tenant's database and filesystem hashes from the
 * running system and compares them against the manifest, emitting strict,
 * bounded, machine-readable evidence suitable for automation. It uses only
 * generic runtime-derived identities (the migration ledger and the tenant-table
 * manifest) and never prints row or file contents.
 *
 * Because a row's tenant discriminator is part of its hashed content, a proof
 * can only be verified against the tenant it was exported from; verifying a
 * re-homed tenant against another tenant's proof is rejected up front.
 */

import type { Database } from './client';
import {
  assertManifestTablesMatchCatalog,
  readManifest,
  type TenantArchiveManifest,
  verifyArchiveIntegrity,
} from './tenant-archive';
import { resolveTenantDatabaseIdentity } from './tenant-catalog';
import { snapshotTenantTableHashes } from './tenant-database-io';
import { assertValidTenantId } from './tenant-deletion';
import {
  type TenantFilesystemEntry,
  tenantFilesystemEntriesEqual,
  walkTenantFilesystemTree,
} from './tenant-filesystem';
import { runWithTenantDatabaseScope } from './tenant-scope';

/**
 * Which categories a verification was asked to check. `full` (the default)
 * verifies the database and — when the archive carries one — the filesystem tree;
 * `database` verifies only the database and treats the filesystem as
 * intentionally skipped. This is an explicit request, never inferred from which
 * paths a caller happened to supply, so an omitted filesystem root can stay
 * fail-closed under `full` while being a deliberate skip under `database`.
 */
export type TenantVerificationScope = 'full' | 'database';

/** Strict, bounded evidence produced by {@link verifyTenant}. */
export interface TenantVerificationResult {
  tenantId: string;
  /** The scope that was requested (echoed so evidence is self-describing). */
  scope: TenantVerificationScope;
  /** True only when every REQUESTED category matched exactly. */
  match: boolean;
  contentFingerprint: string;
  archiveIntegrity: { ok: boolean; problemCount: number; problems: string[] };
  identity: {
    matched: boolean;
    liveSchemaVersion: string;
    archiveSchemaVersion: string;
  };
  database: {
    checked: boolean;
    matched: boolean;
    tableCount: number;
    mismatchCount: number;
    /** Bounded list of mismatched table names. */
    mismatchedTables: string[];
  };
  filesystem: {
    /**
     * Whether the filesystem was in scope: true only under `full` verification of
     * an archive that includes a filesystem tree. When `requested` is true but
     * `checked` is false the category could not be verified and `match` is
     * fail-closed to false; when `requested` is false the filesystem was
     * legitimately skipped and does not affect `match`.
     */
    requested: boolean;
    checked: boolean;
    matched: boolean;
    mismatchCount: number;
    /** Bounded list of mismatched relative paths. */
    mismatchedPaths: string[];
  };
}

export interface TenantVerificationOptions {
  /** Archive directory containing the saved proof. */
  archivePath: string;
  /**
   * Tenant id to verify. Defaults to the archive's tenant. When supplied it must
   * equal the archive's tenant.
   */
  tenantId?: string;
  /**
   * Categories to verify. Defaults to `full` (database + filesystem when the
   * archive carries one). Pass `database` to verify only the database and skip
   * the filesystem tree deliberately.
   */
  scope?: TenantVerificationScope;
  /**
   * Absolute tenant filesystem root to compare (as resolved by
   * `getTenantDataRoot(tenantId)`). Required to verify the filesystem portion
   * under `full` scope; ignored under `database` scope.
   */
  filesystemRoot?: string;
  /** Cap on the number of mismatch descriptions emitted per category. */
  maxEvidence?: number;
}

function compareFilesystem(
  manifest: TenantArchiveManifest,
  live: TenantFilesystemEntry[],
  maxEvidence: number
): { mismatchCount: number; mismatchedPaths: string[] } {
  const archived = new Map(manifest.filesystem.entries.map((entry) => [entry.path, entry]));
  const liveByPath = new Map(live.map((entry) => [entry.path, entry]));
  const mismatchedPaths: string[] = [];
  let mismatchCount = 0;
  const record = (path: string): void => {
    mismatchCount += 1;
    if (mismatchedPaths.length < maxEvidence) mismatchedPaths.push(path);
  };

  for (const [path, entry] of archived) {
    const liveEntry = liveByPath.get(path);
    if (!liveEntry || !tenantFilesystemEntriesEqual(entry, liveEntry)) record(path);
  }
  for (const path of liveByPath.keys()) {
    if (!archived.has(path)) record(path);
  }
  return { mismatchCount, mismatchedPaths };
}

/**
 * Verify a tenant's live data against a saved archive proof and return bounded
 * evidence. Validates the archive, compares runtime identity, re-hashes every
 * tenant table from the live database, and (when a filesystem root is supplied)
 * compares the live tenant filesystem tree against the manifest.
 */
export async function verifyTenant(
  db: Database,
  options: TenantVerificationOptions
): Promise<TenantVerificationResult> {
  const maxEvidence = options.maxEvidence ?? 50;
  const scope = options.scope ?? 'full';
  const manifest = await readManifest(options.archivePath);
  const tenantId = options.tenantId ?? manifest.tenantId;
  assertValidTenantId(tenantId);
  if (options.tenantId && options.tenantId !== manifest.tenantId) {
    throw new Error(
      `Refusing to verify: requested tenant ${options.tenantId} does not match archive tenant ${manifest.tenantId}`
    );
  }

  const integrity = await verifyArchiveIntegrity(options.archivePath, manifest, {
    maxProblems: maxEvidence,
  });

  const identity = await resolveTenantDatabaseIdentity(db);
  const identityMatched =
    identity.schemaVersion === manifest.database.identity.schemaVersion &&
    identity.fingerprint === manifest.database.identity.fingerprint;

  // Only compare row-level hashes when the schema identity matches; otherwise the
  // comparison is meaningless and the identity mismatch is the finding.
  let dbChecked = false;
  let dbMatched = false;
  let dbMismatchCount = 0;
  const mismatchedTables: string[] = [];
  if (identityMatched) {
    dbChecked = true;
    // With a matching schema, the archive must carry exactly the live catalog's
    // movable tenant tables before any per-table comparison is meaningful.
    assertManifestTablesMatchCatalog(manifest, identity.tenantTables);
    const archivedByName = new Map(manifest.database.tables.map((table) => [table.name, table]));
    await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
      const snapshots = await snapshotTenantTableHashes(scoped, tenantId);
      for (const snapshot of snapshots) {
        const archivedTable = archivedByName.get(snapshot.name);
        const matches =
          archivedTable !== undefined &&
          archivedTable.rowCount === snapshot.rowCount &&
          archivedTable.sha256 === snapshot.sha256;
        if (!matches) {
          dbMismatchCount += 1;
          if (mismatchedTables.length < maxEvidence) mismatchedTables.push(snapshot.name);
        }
      }
    });
    dbMatched = dbMismatchCount === 0;
  }

  // The filesystem is only in scope under `full` verification of an archive that
  // actually carries a tree. A `database` scope skips it by request (not by an
  // absent root), so a database-only verification of a full archive no longer
  // mismatches spuriously.
  const fsRequested = scope === 'full' && manifest.filesystem.included;
  let fsChecked = false;
  let fsMatched = false;
  let fsMismatchCount = 0;
  let fsMismatchedPaths: string[] = [];
  if (fsRequested && typeof options.filesystemRoot === 'string') {
    fsChecked = true;
    const walk = await walkTenantFilesystemTree(options.filesystemRoot);
    const comparison = compareFilesystem(manifest, walk.entries, maxEvidence);
    fsMismatchCount = comparison.mismatchCount;
    fsMismatchedPaths = comparison.mismatchedPaths;
    fsMatched = fsMismatchCount === 0;
  }

  // Overall match is computed from the REQUESTED categories only. The database is
  // always required. The filesystem is required exactly when in scope; if it is
  // in scope but could not be checked (no root supplied), the result stays
  // fail-closed rather than silently passing.
  const filesystemMatched = fsRequested ? fsChecked && fsMatched : true;
  const match = integrity.ok && identityMatched && dbChecked && dbMatched && filesystemMatched;

  return {
    tenantId,
    scope,
    match,
    contentFingerprint: manifest.contentFingerprint,
    archiveIntegrity: {
      ok: integrity.ok,
      problemCount: integrity.problemCount,
      problems: integrity.problems,
    },
    identity: {
      matched: identityMatched,
      liveSchemaVersion: identity.schemaVersion,
      archiveSchemaVersion: manifest.database.identity.schemaVersion,
    },
    database: {
      checked: dbChecked,
      matched: dbMatched,
      tableCount: manifest.database.tables.length,
      mismatchCount: dbMismatchCount,
      mismatchedTables,
    },
    filesystem: {
      requested: fsRequested,
      checked: fsChecked,
      matched: fsMatched,
      mismatchCount: fsMismatchCount,
      mismatchedPaths: fsMismatchedPaths,
    },
  };
}
