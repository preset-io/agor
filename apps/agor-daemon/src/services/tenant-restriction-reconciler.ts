import {
  isPostgresDatabaseHandle,
  runWithSystemDatabaseScope,
  runWithTenantContext,
  runWithTenantDatabaseScope,
  TaskRepository,
  type TaskRuntimeDiscoveryCursor,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import type { AuthenticatedParams, TenantID } from '@agor/core/types';
import { isCurrentTenantRuntimeActive } from '../auth/tenant-access.js';
import type { Application } from '../declarations.js';
import { beginExecutorTermination } from '../termination-coordinator.js';
import { withFreshTenantWrite } from '../utils/tenant-db-scope.js';

/** Page-bounded, restart-safe Stop initiation; the existing coordinator owns containment proof. */
export class TenantRestrictionReconciler {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;
  private running = false;
  private cursor: TaskRuntimeDiscoveryCursor | undefined;
  constructor(
    private readonly db: TenantScopeAwareDatabase,
    private readonly app: Application,
    private readonly tenantId?: string
  ) {}

  start(): void {
    if (!this.stopped || !isPostgresDatabaseHandle(this.db)) return;
    this.stopped = false;
    this.schedule(0);
  }
  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
  private schedule(delay: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(async () => {
      let saturated = false;
      try {
        saturated = (await this.checkOnce()).candidates === 50;
      } catch {
        console.warn(
          '[tenant-restriction] Task observation failed; containment remains unverified'
        );
      } finally {
        this.schedule(saturated ? 150 : 1000);
      }
    }, delay);
    this.timer.unref();
  }

  async checkOnce(): Promise<{ candidates: number; stopping: number; failures: number }> {
    if (this.running || !isPostgresDatabaseHandle(this.db))
      return { candidates: 0, stopping: 0, failures: 0 };
    this.running = true;
    try {
      const options = { limit: 50, ...(this.cursor ? { after: this.cursor } : {}) };
      const refs = this.tenantId
        ? await runWithTenantDatabaseScope(this.db, this.tenantId, (scoped) =>
            new TaskRepository(scoped).findRestrictionRuntimeRefs(options)
          )
        : await runWithSystemDatabaseScope(
            this.db,
            'tenant restriction live task routing',
            (scoped) => new TaskRepository(scoped).findRestrictionRuntimeRefs(options),
            { capability: 'task_runtime_discovery' }
          );
      this.cursor = refs.at(-1)?.cursor;
      let stopping = 0;
      let failures = 0;
      for (const ref of refs) {
        const tenantId = this.tenantId ?? ref.tenant_id;
        if (!tenantId) throw new Error('Restriction candidate omitted tenant authority');
        try {
          await runWithTenantContext(tenantId, async () => {
            if (await isCurrentTenantRuntimeActive(this.db)) return;
            const params: AuthenticatedParams = {
              provider: undefined,
              tenant: { tenant_id: tenantId as TenantID, source: 'explicit' },
            };
            await beginExecutorTermination({
              app: this.app,
              taskId: ref.task_id,
              cause: 'tenant_suspension',
              errorMessage: 'Tenant access is restricted.',
              params,
              runInFreshTenantWriteDatabase: (work) =>
                withFreshTenantWrite(this.db, tenantId, work),
            });
            stopping++;
          });
        } catch {
          failures++;
          console.warn(
            '[tenant-restriction] Task stop request failed; containment remains unverified'
          );
        }
      }
      return { candidates: refs.length, stopping, failures };
    } finally {
      this.running = false;
    }
  }
}
