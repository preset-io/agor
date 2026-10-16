import {
  BranchMaintenanceDiscoveryRepository,
  BranchMaintenanceRepository,
  BranchRepository,
  branches,
  eq,
  runWithSystemDatabaseScope,
  runWithTenantDatabaseScope,
  select,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import {
  BRANCH_MAINTENANCE_DISCOVERY_PAGE_SIZE,
  type BranchID,
  type BranchMaintenanceRoutingRef,
  type TenantID,
} from '@agor/core/types';
import { verifyRecordedProcessGroupAbsent } from '../executor-tracking.js';
import { emitServiceEvent } from '../utils/emit-service-event.js';

export const INTERRUPTED_DELETION_SUMMARY =
  'Deletion was interrupted (for example by a daemon restart) before it settled. Agor verified the deletion executor has exited; retry permanent deletion to continue.';

export function exitedDeletionSummary(code: number | null, signal?: NodeJS.Signals | null) {
  return `Deletion executor exited (${signal ? `signal ${signal}` : `code ${code}`}) before it settled. Agor verified it has exited; retry permanent deletion to continue.`;
}

/**
 * Release a deletion invocation whose recorded local executor process group
 * this daemon verifies absent. Probing happens outside any transaction; the
 * release rechecks the exact invocation under the Branch lock. Returns false
 * when there is nothing to release or absence cannot be verified from here.
 */
export async function releaseDeletionIfExecutorAbsent(
  db: TenantScopeAwareDatabase,
  app: Application,
  tenantId: string,
  branchId: BranchID,
  summary: string,
  waitMs = 0
): Promise<boolean> {
  const maintenance = await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
    const row = await select(scoped).from(branches).where(eq(branches.branch_id, branchId)).one();
    return row?.deletion_status ? row.data.maintenance : undefined;
  });
  if (maintenance?.kind !== 'delete' || !maintenance.execution_id || !maintenance.execution_process)
    return false;
  const absence = await verifyRecordedProcessGroupAbsent(maintenance.execution_process, { waitMs });
  if (absence.status !== 'verified_absent') return false;
  return runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
    const released = await new BranchMaintenanceRepository(scoped).releaseVerifiedExitedDeletion(
      branchId,
      maintenance.execution_id!,
      summary
    );
    if (!released) return false;
    console.info(
      `[branch.delete] event=released_after_verified_exit branch_id=${branchId} operation_id=${maintenance.operation_id} generation=${maintenance.generation} invocation_id=${maintenance.execution_id}`
    );
    const branch = await new BranchRepository(scoped).findById(branchId);
    if (branch)
      emitServiceEvent(app, {
        path: 'branches',
        event: 'patched',
        data: branch,
        params: { tenant: { tenant_id: tenantId as TenantID, source: 'explicit' } },
        id: branchId,
      });
    return true;
  });
}

/** Observer only: scheduling belongs to the existing runtime loop, not a new process/worker. */
export class BranchDeletionReconciler {
  private cursor: BranchMaintenanceRoutingRef | undefined;
  private processCursor: BranchMaintenanceRoutingRef | undefined;
  constructor(
    private readonly db: TenantScopeAwareDatabase,
    private readonly app: Application,
    private readonly tenantId?: string
  ) {}

  private discover(
    find: (
      repository: BranchMaintenanceDiscoveryRepository,
      after: BranchMaintenanceRoutingRef | undefined
    ) => Promise<BranchMaintenanceRoutingRef[]>,
    after: BranchMaintenanceRoutingRef | undefined
  ) {
    return this.tenantId
      ? runWithTenantDatabaseScope(this.db, this.tenantId, (db) =>
          find(new BranchMaintenanceDiscoveryRepository(db), after)
        )
      : runWithSystemDatabaseScope(
          this.db,
          'branch deletion runtime routing discovery',
          (db) => find(new BranchMaintenanceDiscoveryRepository(db), after),
          { capability: 'branch_maintenance_discovery' }
        );
  }

  async checkOnce(): Promise<void> {
    // Prefer the verified-exit diagnosis, but correctness does not depend on
    // this ordering: recorded invocations remain discoverable after any
    // replica marks them failed, until the executor host can verify absence.
    await this.releaseExitedOnce();
    const candidates = await this.discover(
      (repository, after) => repository.findDeletingRefs({ tenantId: this.tenantId, after }),
      this.cursor
    );
    this.cursor =
      candidates.length === BRANCH_MAINTENANCE_DISCOVERY_PAGE_SIZE
        ? candidates[candidates.length - 1]
        : undefined;
    for (const ref of candidates) {
      const tenantId = ref.tenant_id;
      const branchId = ref.branch_id;
      try {
        await runWithTenantDatabaseScope(this.db, tenantId, async (db) => {
          const row = await select(db).from(branches).where(eq(branches.branch_id, branchId)).one();
          if (!row?.data.maintenance) return;
          if (
            !(await new BranchMaintenanceRepository(db).markStaleDeletion(
              row.data.maintenance,
              120_000
            ))
          )
            return;
          const branch = await new BranchRepository(db).findById(branchId);
          if (branch)
            emitServiceEvent(this.app, {
              path: 'branches',
              event: 'patched',
              data: branch,
              params: { tenant: { tenant_id: tenantId, source: 'explicit' } },
              id: branchId,
            });
        });
      } catch (error) {
        // Tenant freeze, deletion by another replica, or a generation change is
        // not permission to release the invocation. Keep future scans possible.
        console.warn('[branch-deletion.reconcile] candidate failed', {
          branchId,
          error: error instanceof Error ? error.name : 'unknown',
        });
      }
    }
  }

  /**
   * Executors interrupted with their daemon (restart, deploy, crash) never
   * report settlement. Any daemon sharing their boot and PID namespace can
   * verify the recorded process group is gone and make the failure retryable.
   * Live executors and other hosts' executors are skipped without side effects.
   */
  private async releaseExitedOnce(): Promise<void> {
    const candidates = await this.discover(
      (repository, after) =>
        repository.findExecutionProcessRefs({ tenantId: this.tenantId, after }),
      this.processCursor
    );
    this.processCursor =
      candidates.length === BRANCH_MAINTENANCE_DISCOVERY_PAGE_SIZE
        ? candidates[candidates.length - 1]
        : undefined;
    for (const ref of candidates) {
      try {
        await releaseDeletionIfExecutorAbsent(
          this.db,
          this.app,
          ref.tenant_id,
          ref.branch_id,
          INTERRUPTED_DELETION_SUMMARY
        );
      } catch (error) {
        console.warn('[branch-deletion.reconcile] release candidate failed', {
          branchId: ref.branch_id,
          error: error instanceof Error ? error.name : 'unknown',
        });
      }
    }
  }
}
