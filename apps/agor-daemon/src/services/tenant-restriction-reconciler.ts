import {
  isPostgresDatabaseHandle,
  listRestrictedTenantIds,
  runWithSystemDatabaseScope,
  runWithTenantContext,
  runWithTenantDatabaseScope,
  TaskRepository,
  type TaskRuntimeDiscoveryCursor,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import type { AuthenticatedParams, TenantID } from '@agor/core/types';
import {
  isCurrentTenantRuntimeActive,
  TENANT_RESTRICTION_OBSERVATION_MS,
} from '../auth/tenant-access.js';
import type { Application } from '../declarations.js';
import { beginExecutorTermination } from '../termination-coordinator.js';
import { withFreshTenantWrite } from '../utils/tenant-db-scope.js';

const PAGE_SIZE = 50;
const STOP_WARNING_INTERVAL_MS = 60_000;

/** One pass spans consecutive saturated pages; its memo never outlives one observation tick. */
interface RestrictionPass {
  expiresAt: number;
  restricted?: Promise<string[]>;
  activeByTenant: Map<string, Promise<boolean>>;
}

/** Page-bounded, restart-safe Stop initiation; the existing coordinator owns containment proof. */
export class TenantRestrictionReconciler {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;
  private running = false;
  private cursor: TaskRuntimeDiscoveryCursor | undefined;
  private pass: RestrictionPass | undefined;
  private lastStopWarningAt = Number.NEGATIVE_INFINITY;
  private suppressedStopWarnings = 0;
  constructor(
    private readonly db: TenantScopeAwareDatabase,
    private readonly app: Application,
    private readonly tenantId?: string,
    private readonly now: () => number = Date.now
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
        saturated = (await this.checkOnce()).candidates === PAGE_SIZE;
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

  private currentPass(): RestrictionPass {
    if (!this.pass || this.now() >= this.pass.expiresAt) {
      this.pass = {
        expiresAt: this.now() + TENANT_RESTRICTION_OBSERVATION_MS,
        activeByTenant: new Map(),
      };
    }
    return this.pass;
  }

  private tenantActive(pass: RestrictionPass, tenantId: string): Promise<boolean> {
    let active = pass.activeByTenant.get(tenantId);
    if (!active) {
      active = runWithTenantContext(tenantId, () => isCurrentTenantRuntimeActive(this.db));
      pass.activeByTenant.set(tenantId, active);
    }
    return active;
  }

  /** Tenants worth paging: a single system read of closed ids, or the static tenant's own state. */
  private async restrictedTenants(pass: RestrictionPass): Promise<string[]> {
    if (this.tenantId) {
      return (await this.tenantActive(pass, this.tenantId)) ? [] : [this.tenantId];
    }
    pass.restricted ??= runWithSystemDatabaseScope(
      this.db,
      'tenant restriction discovery',
      (scoped) => listRestrictedTenantIds(scoped),
      { capability: 'tenant_restriction_discovery' }
    );
    return pass.restricted;
  }

  private async restrictedTenantsOrReset(pass: RestrictionPass): Promise<string[]> {
    try {
      return await this.restrictedTenants(pass);
    } catch (error) {
      // A failed read is never memoized as an answer.
      this.pass = undefined;
      throw error;
    }
  }

  private warnStopFailure(): void {
    const at = this.now();
    if (at - this.lastStopWarningAt < STOP_WARNING_INTERVAL_MS) {
      this.suppressedStopWarnings++;
      return;
    }
    console.warn(
      '[tenant-restriction] Task stop request failed; containment remains unverified' +
        (this.suppressedStopWarnings ? ` (suppressed=${this.suppressedStopWarnings})` : '')
    );
    this.lastStopWarningAt = at;
    this.suppressedStopWarnings = 0;
  }

  async checkOnce(): Promise<{ candidates: number; stopping: number; failures: number }> {
    if (this.running || !isPostgresDatabaseHandle(this.db))
      return { candidates: 0, stopping: 0, failures: 0 };
    this.running = true;
    try {
      const pass = this.currentPass();
      const restricted = await this.restrictedTenantsOrReset(pass);
      if (restricted.length === 0) {
        // Nothing is closed: page no tasks and restart the sweep when something closes.
        this.cursor = undefined;
        this.pass = undefined;
        return { candidates: 0, stopping: 0, failures: 0 };
      }
      const options = { limit: PAGE_SIZE, ...(this.cursor ? { after: this.cursor } : {}) };
      const refs = this.tenantId
        ? await runWithTenantDatabaseScope(this.db, this.tenantId, (scoped) =>
            new TaskRepository(scoped).findRestrictionRuntimeRefs(options)
          )
        : await runWithSystemDatabaseScope(
            this.db,
            'tenant restriction live task routing',
            (scoped) => new TaskRepository(scoped).findRestrictionRuntimeRefs(options, restricted),
            { capability: 'task_runtime_discovery' }
          );
      this.cursor = refs.at(-1)?.cursor;
      if (refs.length < PAGE_SIZE) this.pass = undefined;
      let stopping = 0;
      let failures = 0;
      for (const ref of refs) {
        try {
          const tenantId = this.tenantId ?? ref.tenant_id;
          if (!tenantId) throw new Error('Restriction candidate omitted tenant authority');
          // Discovery only narrows; the tenant's own scoped read decides.
          if (await this.tenantActive(pass, tenantId)) continue;
          await runWithTenantContext(tenantId, async () => {
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
          });
          stopping++;
        } catch {
          failures++;
          this.warnStopFailure();
        }
      }
      return { candidates: refs.length, stopping, failures };
    } finally {
      this.running = false;
    }
  }
}
