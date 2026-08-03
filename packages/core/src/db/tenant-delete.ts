/**
 * Public, combined tenant deletion operation.
 *
 * The audited PostgreSQL deletion engine commits and verifies the database
 * first, then this operation removes the explicitly configured tenant
 * filesystem tree. That ordering is intentional: if the filesystem tail
 * fails, the error carries bounded proof that the database committed and the
 * files are still pending, and the whole operation can be retried safely.
 *
 * Filesystem locations are explicit absolute roots. Configuration and mount
 * resolution remain the caller's responsibility, keeping this contract
 * generic across OSS runtimes.
 */

import type { Database } from './client';
import {
  deleteTenantData,
  type TenantDeletionDryRunResult,
  type TenantDeletionOptions,
  type TenantDeletionResult,
} from './tenant-deletion';
import { deleteTenantFilesystemTree, summarizeTenantFilesystem } from './tenant-filesystem';

/** Explicit tenant filesystem target resolved from the runtime configuration. */
export interface TenantDeletionFilesystemTarget {
  /** Absolute tenant-specific root. */
  root: string;
  /** Absolute configured base folder that must strictly contain `root`. */
  base: string;
}

export type TenantFilesystemDeletionStatus =
  | 'deleted'
  | 'already-absent'
  | 'would-delete'
  | 'not-configured'
  | 'not-requested'
  | 'pending';

/** Bounded proof of how the configured tenant filesystem was handled. */
export interface TenantFilesystemDeletionProof {
  /** False only for the explicit database-only escape hatch. */
  requested: boolean;
  /** Whether the caller supplied an isolated tenant filesystem target. */
  isolationEnabled: boolean;
  /** Whether the tenant root existed before the filesystem phase; unknown on an early tail failure. */
  present: boolean | null;
  /** Whether this invocation actually removed a present tenant root. */
  deleted: boolean;
  /** True only after proving that the configured tenant root is absent. */
  verifiedAbsent: boolean;
  status: TenantFilesystemDeletionStatus;
}

interface TenantDeleteContract {
  tenantId: string;
  tenantDeletionComplete: boolean;
  databaseCommitted: boolean;
  filesPending: boolean;
  filesystem: TenantFilesystemDeletionProof;
}

/** Successful, non-dry-run proof for the combined database + filesystem operation. */
export interface TenantDeleteResult extends TenantDeletionResult, TenantDeleteContract {
  tenantDeletionComplete: true;
  databaseCommitted: true;
  filesPending: false;
}

/** Machine-readable dry-run result; no data has been committed or removed. */
export interface TenantDeleteDryRunResult extends TenantDeletionDryRunResult, TenantDeleteContract {
  tenantDeletionComplete: false;
  databaseCommitted: false;
  filesPending: false;
}

/**
 * Machine-readable recovery proof for a filesystem-tail failure after the
 * database transaction committed and its independent verification succeeded.
 */
export interface TenantDeleteFilesPendingResult extends TenantDeletionResult, TenantDeleteContract {
  tenantDeletionComplete: false;
  databaseCommitted: true;
  filesPending: true;
  filesystem: TenantFilesystemDeletionProof & { status: 'pending'; verifiedAbsent: false };
}

/**
 * Thrown only after database deletion committed but the configured filesystem
 * tail did not produce absence proof. `result` is safe to serialize for retry
 * automation; retry the combined operation without a now-deleted gate token.
 */
export class TenantFilesystemDeletionPendingError extends Error {
  constructor(
    public readonly result: TenantDeleteFilesPendingResult,
    public readonly cause?: unknown
  ) {
    const detail = cause instanceof Error ? `: ${cause.message}` : '';
    super(`Tenant database deletion committed, but tenant filesystem deletion is pending${detail}`);
    this.name = 'TenantFilesystemDeletionPendingError';
  }
}

export interface DeleteTenantOptions extends TenantDeletionOptions {
  /** Runtime-resolved isolated tenant root. Omit when isolation is disabled. */
  filesystem?: TenantDeletionFilesystemTarget | null;
  /** Explicitly skip filesystem deletion, even if a target is supplied. */
  databaseOnly?: boolean;
}

function skippedFilesystemProof(databaseOnly: boolean): TenantFilesystemDeletionProof {
  if (databaseOnly) {
    return {
      requested: false,
      isolationEnabled: false,
      present: false,
      deleted: false,
      verifiedAbsent: false,
      status: 'not-requested',
    };
  }
  return {
    requested: true,
    isolationEnabled: false,
    present: false,
    deleted: false,
    verifiedAbsent: false,
    status: 'not-configured',
  };
}

/**
 * Permanently delete and prove absence of a tenant's database data and, when
 * configured, its isolated filesystem tree. The database phase is the existing
 * audited {@link deleteTenantData} implementation; no second deletion path is
 * introduced.
 */
export async function deleteTenant(
  db: Database,
  tenantId: string,
  options: DeleteTenantOptions = {}
): Promise<TenantDeleteResult | TenantDeleteDryRunResult> {
  const dryRun = options.dryRun ?? false;
  const database = await deleteTenantData(db, tenantId, {
    dryRun,
    ...(options.log ? { log: options.log } : {}),
    ...(options.assertGateGeneration !== undefined
      ? { assertGateGeneration: options.assertGateGeneration }
      : {}),
  });

  const target = options.databaseOnly ? null : options.filesystem;
  if ('dryRun' in database) {
    let filesystem = skippedFilesystemProof(options.databaseOnly ?? false);
    if (target) {
      const inventory = await summarizeTenantFilesystem(target.root);
      filesystem = {
        requested: true,
        isolationEnabled: true,
        present: inventory.present,
        deleted: false,
        verifiedAbsent: !inventory.present,
        status: inventory.present ? 'would-delete' : 'already-absent',
      };
    }
    return {
      ...database,
      tenantId,
      tenantDeletionComplete: false,
      databaseCommitted: false,
      filesPending: false,
      filesystem,
    };
  }

  if (!target) {
    return {
      ...database,
      tenantId,
      tenantDeletionComplete: true,
      databaseCommitted: true,
      filesPending: false,
      filesystem: skippedFilesystemProof(options.databaseOnly ?? false),
    };
  }

  let present: boolean | null = null;
  let deleted = false;
  try {
    const inventory = await summarizeTenantFilesystem(target.root);
    present = inventory.present;
    ({ deleted } = await deleteTenantFilesystemTree(target.root, target.base));
    const verification = await summarizeTenantFilesystem(target.root);
    if (verification.present) {
      throw new Error('tenant filesystem root still exists after deletion');
    }
  } catch (cause) {
    throw new TenantFilesystemDeletionPendingError(
      {
        ...database,
        tenantId,
        tenantDeletionComplete: false,
        databaseCommitted: true,
        filesPending: true,
        filesystem: {
          requested: true,
          isolationEnabled: true,
          present,
          deleted,
          verifiedAbsent: false,
          status: 'pending',
        },
      },
      cause
    );
  }

  return {
    ...database,
    tenantId,
    tenantDeletionComplete: true,
    databaseCommitted: true,
    filesPending: false,
    filesystem: {
      requested: true,
      isolationEnabled: true,
      present,
      deleted,
      verifiedAbsent: true,
      status: deleted ? 'deleted' : 'already-absent',
    },
  };
}
