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
  type BranchMaintenanceRoutingRef,
} from '@agor/core/types';
import { emitServiceEvent } from '../utils/emit-service-event.js';

/** Observer only: scheduling belongs to the existing runtime loop, not a new process/worker. */
export class BranchDeletionReconciler {
  private cursor: BranchMaintenanceRoutingRef | undefined;
  constructor(
    private readonly db: TenantScopeAwareDatabase,
    private readonly app: Application,
    private readonly tenantId?: string
  ) {}

  async checkOnce(): Promise<void> {
    const candidates = this.tenantId
      ? await runWithTenantDatabaseScope(this.db, this.tenantId, (db) =>
          new BranchMaintenanceDiscoveryRepository(db).findDeletingRefs({
            tenantId: this.tenantId,
            after: this.cursor,
          })
        )
      : await runWithSystemDatabaseScope(
          this.db,
          'branch deletion runtime routing discovery',
          (db) =>
            new BranchMaintenanceDiscoveryRepository(db).findDeletingRefs({ after: this.cursor }),
          { capability: 'branch_maintenance_discovery' }
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
}
