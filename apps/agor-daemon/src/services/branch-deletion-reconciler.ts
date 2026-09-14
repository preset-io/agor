import {
  BranchMaintenanceRepository,
  BranchRepository,
  branches,
  eq,
  executeRaw,
  rawRows,
  runWithSystemDatabaseScope,
  runWithTenantDatabaseScope,
  select,
  sql,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { BranchID, TenantID } from '@agor/core/types';
import { emitServiceEvent } from '../utils/emit-service-event.js';

/** Observer only: scheduling belongs to the existing runtime loop, not a new process/worker. */
export class BranchDeletionReconciler {
  private cursor: { tenant: string; branch: string } | undefined;
  constructor(
    private readonly db: TenantScopeAwareDatabase,
    private readonly app: Application,
    private readonly tenantId?: string
  ) {}

  async checkOnce(): Promise<void> {
    const after = this.cursor ?? { tenant: '', branch: '' };
    const candidates = this.tenantId
      ? await runWithTenantDatabaseScope(this.db, this.tenantId, (db) =>
          executeRaw(
            db,
            sql`SELECT branch_id, ${this.tenantId} AS tenant_id FROM branches WHERE deletion_status = 'deleting' AND branch_id > ${after.branch} ORDER BY branch_id LIMIT 25`
          ).then(rawRows)
        )
      : await runWithSystemDatabaseScope(
          this.db,
          'branch deletion runtime routing discovery',
          (db) =>
            executeRaw(
              db,
              sql`SELECT branch_id, tenant_id FROM branches WHERE deletion_status = 'deleting' AND (tenant_id, branch_id) > (${after.tenant}, ${after.branch}) ORDER BY tenant_id, branch_id LIMIT 25`
            ).then(rawRows),
          { capability: 'branch_maintenance_discovery' }
        );
    const last = candidates[candidates.length - 1];
    this.cursor =
      candidates.length === 25 && last
        ? { tenant: String(last.tenant_id), branch: String(last.branch_id) }
        : undefined;
    for (const ref of candidates) {
      const tenantId = String(ref.tenant_id) as TenantID;
      const branchId = String(ref.branch_id) as BranchID;
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
