import { eq } from 'drizzle-orm';
import type {
  Branch,
  BranchID,
  BranchMaintenanceClaim,
  BranchWorkspaceOperation,
  BranchWorkspaceSnapshot,
  UUID,
} from '../../types';
import {
  canDismissBranchWorkspaceNotification,
  getBranchCleanupBlockReason,
  resolveRepoCleanupPolicy,
} from '../../types/branch-cleanup';
import type { Database } from '../client';
import { lockRowForUpdate, runDatabaseTransaction, select, update } from '../database-wrapper';
import { branches } from '../schema';
import { EntityNotFoundError, RepositoryError } from './base';
import { BranchMaintenanceRepository } from './branch-maintenance';
import { BranchRepository } from './branches';
import { RepoRepository } from './repos';

/** Cleanup/archive data only. The shared maintenance repository owns admission and invocation identity. */
export class BranchWorkspaceOperationRepository {
  constructor(private readonly db: Database) {}

  /** Forget only the requested settled notification, never runtime ownership.
   * Shares the Branch row lock with admission/completion; a stale close cannot
   * erase a replacement operation. Authorization is rechecked under that lock.
   */
  async dismissNotification(
    branchId: BranchID,
    operationId: UUID,
    authorize: (db: Database, branch: Branch) => Promise<void>
  ): Promise<Branch> {
    return runDatabaseTransaction(
      this.db,
      async (tx) => {
        await lockRowForUpdate(tx, this.db, branches, eq(branches.branch_id, branchId));
        const repository = new BranchRepository(tx);
        const branch = await repository.findById(branchId);
        if (!branch) throw new EntityNotFoundError('Branch', branchId);
        await authorize(tx, branch);
        const row = await select(tx).from(branches).where(eq(branches.branch_id, branchId)).one();
        if (!row) throw new EntityNotFoundError('Branch', branchId);
        if (!branch.workspace_operation) return branch; // Repeated acknowledgement is harmless.
        if (branch.workspace_operation.operation_id !== operationId)
          throw new RepositoryError(
            'The workspace notification has changed. Refresh and try again.'
          );
        if (row.data.maintenance || !canDismissBranchWorkspaceNotification(branch))
          throw new RepositoryError(
            'Resolve the branch operation or recover its workspace before dismissing this notification.'
          );
        const {
          workspace_operation: _operation,
          workspace_snapshot: _snapshot,
          cleanup_last_error: _error,
          ...data
        } = row.data;
        await update(tx, branches)
          .set({ data, updated_at: new Date() })
          .where(eq(branches.branch_id, branchId))
          .run();
        return (await repository.findById(branchId))!;
      },
      { sqliteImmediate: true, sqliteBusyRetries: 9 }
    );
  }

  async prepare(
    claim: BranchMaintenanceClaim,
    operation: BranchWorkspaceOperation,
    snapshot: BranchWorkspaceSnapshot
  ) {
    await new BranchMaintenanceRepository(this.db).withClaim(claim, async (tx, row) => {
      await update(tx, branches)
        .set({
          data: { ...row.data, workspace_operation: operation, workspace_snapshot: snapshot },
        })
        .where(eq(branches.branch_id, claim.branch_id))
        .run();
    });
  }

  /** A local admission failure is releasable only before any durable dispatch intent. */
  async failBeforeExecution(claim: BranchMaintenanceClaim) {
    await new BranchMaintenanceRepository(this.db).withClaim(claim, async (tx, row) => {
      const operation = row.data.workspace_operation;
      if (operation?.operation_id === claim.operation_id) {
        await update(tx, branches)
          .set({
            data: {
              ...row.data,
              workspace_operation: {
                ...operation,
                status: 'failed',
                finished_at: new Date().toISOString(),
                error:
                  'Workspace operation stopped before filesystem execution. Archive metadata may already have changed.',
              },
            },
          })
          .where(eq(branches.branch_id, claim.branch_id))
          .run();
      }
      await new BranchMaintenanceRepository(tx).release(claim);
    });
  }

  /** Revalidate the admitted snapshot before the one executor winner touches files. */
  async validateLaunch(tx: Database, claim: BranchMaintenanceClaim) {
    const row = await select(tx)
      .from(branches)
      .where(eq(branches.branch_id, claim.branch_id))
      .one();
    const snapshot = row?.data.workspace_snapshot;
    const operation = row?.data.workspace_operation;
    if (
      !row ||
      !snapshot ||
      !operation ||
      operation.operation_id !== claim.operation_id ||
      Date.now() >= Date.parse(operation.deadline_at) ||
      operation.status !== 'accepted'
    )
      throw new RepositoryError('Workspace invocation is no longer eligible to start');
    const repo = await new RepoRepository(tx).findById(row.repo_id);
    if (
      !repo ||
      row.repo_id !== snapshot.repo_id ||
      row.data.path !== snapshot.path ||
      (snapshot.storage_mode !== undefined && row.storage_mode !== snapshot.storage_mode) ||
      repo.local_path !== snapshot.repo_path
    )
      throw new RepositoryError('Workspace location changed before execution');
    if (snapshot.policy) {
      const current = resolveRepoCleanupPolicy(repo.cleanup_policy);
      if (
        getBranchCleanupBlockReason(current, row.cleanup_protected) ||
        Object.entries(snapshot.policy).some(
          ([key, value]) => current[key as keyof typeof current] !== value
        )
      )
        throw new RepositoryError('Cleanup policy changed before execution');
    }
  }

  async started(claim: BranchMaintenanceClaim, executionId: UUID) {
    await new BranchMaintenanceRepository(this.db).withExecution(
      claim,
      executionId,
      async (tx, row) => {
        const operation = row.data.workspace_operation!;
        await update(tx, branches)
          .set({
            data: {
              ...row.data,
              workspace_operation: {
                ...operation,
                status: 'running',
                started_at: new Date().toISOString(),
              },
            },
          })
          .where(eq(branches.branch_id, claim.branch_id))
          .run();
      }
    );
  }

  /** Save archival metadata under the same owner, without claiming filesystem completion. */
  async archiveMetadata(claim: BranchMaintenanceClaim) {
    await new BranchMaintenanceRepository(this.db).withClaim(claim, async (tx, row) => {
      const operation = row.data.workspace_operation;
      if (operation?.operation_id !== claim.operation_id || operation.action !== 'archive')
        throw new RepositoryError('An admitted archive operation is required');
      await update(tx, branches)
        .set({
          archived: true,
          archived_at: new Date(operation.requested_at),
          archived_by: operation.requested_by,
        })
        .where(eq(branches.branch_id, claim.branch_id))
        .run();
    });
  }

  /** Metadata-only archive has no filesystem invocation to supervise. */
  async finishPreserve(claim: BranchMaintenanceClaim) {
    await new BranchMaintenanceRepository(this.db).withClaim(claim, async (tx, row) => {
      const operation = row.data.workspace_operation;
      if (operation?.action !== 'archive' || operation.filesystem_action !== 'preserved')
        throw new RepositoryError('Only metadata-only archival may complete without an executor');
      await update(tx, branches)
        .set({
          data: {
            ...row.data,
            workspace_operation: {
              ...operation,
              status: 'succeeded',
              finished_at: new Date().toISOString(),
            },
          },
        })
        .where(eq(branches.branch_id, claim.branch_id))
        .run();
      await new BranchMaintenanceRepository(tx).release(claim);
    });
  }

  /** Only an authenticated worker may report, after its storage owner has settled. */
  async finish(
    claim: BranchMaintenanceClaim,
    executionId: UUID,
    outcome: 'succeeded' | 'failed' | 'unknown'
  ) {
    await new BranchMaintenanceRepository(this.db).withExecution(
      claim,
      executionId,
      async (tx, row) => {
        const operation = row.data.workspace_operation;
        if (!operation || operation.operation_id !== claim.operation_id)
          throw new RepositoryError('Workspace operation changed');
        const at = new Date().toISOString();
        const error =
          outcome === 'succeeded'
            ? undefined
            : outcome === 'unknown'
              ? 'Workspace command outcome is unknown. The branch remains fenced pending reconciliation.'
              : 'Workspace command failed. Check executor storage mounts, checkout type and cleanup policy before retrying. Files may already have changed; there is no undo.';
        const cleanup = operation.filesystem_action === 'cleaned';
        await update(tx, branches)
          .set({
            ...(outcome === 'succeeded' && operation.action === 'archive'
              ? { filesystem_status: operation.filesystem_action }
              : {}),
            data: {
              ...row.data,
              workspace_operation: {
                ...operation,
                status: outcome,
                finished_at: outcome === 'unknown' ? undefined : at,
                error,
              },
              ...(cleanup
                ? {
                    cleanup_last_error:
                      outcome === 'succeeded'
                        ? undefined
                        : { operation_id: claim.operation_id, at, message: error! },
                    ...(outcome === 'succeeded'
                      ? {
                          last_cleanup_succeeded_at: at,
                          last_cleanup_operation_id: claim.operation_id,
                        }
                      : {}),
                  }
                : {}),
            },
          })
          .where(eq(branches.branch_id, claim.branch_id))
          .run();
        if (outcome !== 'unknown') {
          await new BranchMaintenanceRepository(tx).settleExecution(claim, executionId);
          await new BranchMaintenanceRepository(tx).release(claim);
        }
      }
    );
  }
}
