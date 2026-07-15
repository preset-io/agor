/**
 * Health Monitor Service
 *
 * Periodically checks health of running branch environments.
 * Runs every 5 seconds and updates environment_instance.last_health_check.
 *
 * Features:
 * - Interval-based polling (5 seconds)
 * - Only monitors branches with status='running'
 * - Automatic start/stop on environment state changes
 * - Graceful cleanup on daemon shutdown
 */

import { ENVIRONMENT } from '@agor/core/config';
import {
  BranchRepository,
  getHiddenTenantId,
  runWithoutTenantDatabaseScope,
  runWithSystemDatabaseScope,
  runWithTenantContext,
  runWithTenantDatabaseScope,
  shortId,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { Branch, BranchID, TenantContext, TenantID } from '@agor/core/types';
import { NotFoundError } from '@agor/core/utils/errors';
import type { BranchesServiceImpl } from '../declarations';

const DEBUG_HEALTH_MONITOR =
  process.env.AGOR_DEBUG_HEALTH_MONITOR === '1' || process.env.DEBUG?.includes('health-monitor');

function healthMonitorDebug(...args: unknown[]): void {
  if (DEBUG_HEALTH_MONITOR) {
    console.debug(...args);
  }
}

/**
 * Health Monitor - Singleton service for periodic health checks
 */
export interface HealthMonitorParams {
  tenant?: TenantContext;
}

export interface HealthMonitorActiveEnvironmentRef {
  branchId: BranchID;
  tenantId?: TenantID | string;
}

export interface HealthMonitorOptions {
  /** Internal params used for startup/background scans when no request context exists. */
  defaultParams?: HealthMonitorParams;
  /** Database used for tenant-aware startup discovery. */
  db?: TenantScopeAwareDatabase;
  /** Static/single-tenant id used for request-less startup scans. Undefined means discover tenant metadata from branch rows. */
  tenantId?: TenantID | string;
  /** Fail closed for event-driven monitoring when branch events do not carry tenant metadata. */
  requireTenantParams?: boolean;
  /** Test seam for startup discovery. Production uses BranchRepository when db is provided. */
  discoverActiveEnvironmentRefs?: () => Promise<HealthMonitorActiveEnvironmentRef[]>;
}

interface HealthMonitorTimer {
  handle: NodeJS.Timeout;
  phase: 'grace' | 'interval';
}

function tenantParamsFromBranch(branch: Branch): HealthMonitorParams | undefined {
  const tenantId = getHiddenTenantId(branch);
  if (!tenantId) return undefined;
  return { tenant: { tenant_id: tenantId as TenantID, source: 'auth_claim' } };
}

export class HealthMonitor {
  private app: Application;
  /**
   * One timer per branch, including the startup grace period.
   *
   * The grace timeout must be registered immediately. Previously a branch had
   * no entry until the grace period elapsed, so every lifecycle patch received
   * during those three seconds scheduled another permanent interval. Only the
   * last interval was retained in the map; the others could never be stopped.
   */
  private timers = new Map<BranchID, HealthMonitorTimer>();
  private checksInFlight = new Set<BranchID>();
  private branchParams = new Map<BranchID, HealthMonitorParams>();
  private isShuttingDown = false;
  private defaultParams?: HealthMonitorParams;
  private db?: TenantScopeAwareDatabase;
  private branchRepo?: BranchRepository;
  private tenantId?: TenantID | string;
  private requireTenantParams: boolean;
  private discoverActiveEnvironmentRefs?: () => Promise<HealthMonitorActiveEnvironmentRef[]>;

  constructor(app: Application, options: HealthMonitorOptions = {}) {
    this.app = app;
    this.defaultParams = options.defaultParams;
    this.db = options.db;
    this.branchRepo = options.db ? new BranchRepository(options.db) : undefined;
    this.tenantId =
      typeof options.tenantId === 'string' && options.tenantId.trim()
        ? options.tenantId.trim()
        : undefined;
    this.requireTenantParams = options.requireTenantParams ?? false;
    this.discoverActiveEnvironmentRefs = options.discoverActiveEnvironmentRefs;
    this.setupBranchListeners();
  }

  private paramsForBranch(branch: Branch): HealthMonitorParams | undefined {
    return (
      tenantParamsFromBranch(branch) ?? (this.requireTenantParams ? undefined : this.defaultParams)
    );
  }

  /**
   * Set up WebSocket listeners for branch changes
   */
  private setupBranchListeners() {
    const branchesService = this.app.service('branches');

    // Listen for branch updates (start/stop/status changes)
    branchesService.on('patched', (branch: Branch) => {
      this.handleBranchUpdate(branch);
    });

    // Listen for branch creation (in case created with running status)
    branchesService.on('created', (branch: Branch) => {
      this.handleBranchUpdate(branch);
    });

    // Listen for branch removal (cleanup monitoring)
    branchesService.on('removed', (branch: Branch) => {
      this.stopMonitoring(branch.branch_id);
      this.branchParams.delete(branch.branch_id);
    });
  }

  /**
   * Handle branch state changes
   */
  private handleBranchUpdate(branch: Branch) {
    if (this.isShuttingDown) return;

    const status = branch.environment_instance?.status;

    if (status === 'running' || status === 'starting') {
      // Start monitoring if not already monitored.
      // Monitor both 'running' and 'starting' - health checks will transition 'starting' → 'running'.
      const params = this.paramsForBranch(branch);
      if (!params && this.requireTenantParams) {
        console.error(
          `❌ Health monitoring skipped for branch ${shortId(branch.branch_id)}: missing tenant metadata`
        );
        return;
      }
      if (params) this.branchParams.set(branch.branch_id, params);
      if (!this.timers.has(branch.branch_id)) {
        healthMonitorDebug(`🏥 Starting health monitoring for branch: ${branch.name}`);
        this.startMonitoring(branch.branch_id, params);
      }
    } else {
      // Stop monitoring if status is not running or starting.
      if (this.timers.has(branch.branch_id)) {
        healthMonitorDebug(`🏥 Stopping health monitoring for branch: ${branch.name}`);
        this.stopMonitoring(branch.branch_id);
      }
      this.branchParams.delete(branch.branch_id);
    }
  }

  /**
   * Start monitoring a branch's health
   */
  private startMonitoring(branchId: BranchID, params = this.branchParams.get(branchId)) {
    // Clear an existing grace timeout or interval before replacing it.
    this.stopMonitoring(branchId);
    if (params) this.branchParams.set(branchId, params);

    // Wait grace period before first check.
    //
    // Health monitoring is often started from inside tenant-scoped service
    // hooks or startup discovery. Timers inherit AsyncLocalStorage, including
    // the active tenant DB transaction; by the time the timer fires that
    // transaction has usually committed. Schedule outside the current tenant
    // DB scope so every check enters a fresh scope through the branches service
    // hooks using the stored tenant params.
    runWithoutTenantDatabaseScope(() => {
      const graceHandle = setTimeout(() => {
        const currentTimer = this.timers.get(branchId);
        if (
          this.isShuttingDown ||
          currentTimer?.phase !== 'grace' ||
          currentTimer.handle !== graceHandle
        ) {
          return;
        }

        // Perform first health check
        void this.checkHealth(branchId);

        // Set up periodic health checks
        const interval = setInterval(() => {
          if (this.isShuttingDown) return;
          void this.checkHealth(branchId);
        }, ENVIRONMENT.HEALTH_CHECK_INTERVAL_MS);

        this.timers.set(branchId, { handle: interval, phase: 'interval' });
      }, ENVIRONMENT.STARTUP_GRACE_PERIOD_MS);

      // Register the grace period synchronously so repeated `patched` events
      // cannot schedule duplicate intervals before this timeout fires.
      this.timers.set(branchId, { handle: graceHandle, phase: 'grace' });
    });
  }

  /**
   * Stop monitoring a branch's health
   */
  private stopMonitoring(branchId: BranchID) {
    const timer = this.timers.get(branchId);
    if (timer) {
      if (timer.phase === 'grace') clearTimeout(timer.handle);
      else clearInterval(timer.handle);
      this.timers.delete(branchId);
    }
  }

  /**
   * Perform health check for a specific branch
   */
  private async checkHealth(branchId: BranchID) {
    // `setInterval` does not await async callbacks. The normal HTTP timeout is
    // shorter than the poll interval, but DB stalls or executor/service delays
    // can exceed it. Never let two observations for one branch race and write a
    // stale healthy/unhealthy result over the newer one.
    if (this.checksInFlight.has(branchId)) return;
    this.checksInFlight.add(branchId);

    try {
      const branchesService = this.app.service('branches') as unknown as BranchesServiceImpl;

      const params =
        this.branchParams.get(branchId) ??
        (this.requireTenantParams ? undefined : this.defaultParams);
      if (!params && this.requireTenantParams) {
        console.error(
          `❌ Health check skipped for branch ${shortId(branchId)}: missing tenant metadata`
        );
        this.stopMonitoring(branchId);
        return;
      }

      const runCheck = async () => {
        // Get current branch state
        const branch =
          this.db && params?.tenant?.tenant_id
            ? await runWithTenantDatabaseScope(this.db, params.tenant.tenant_id, () =>
                branchesService.get(branchId, params as never)
              )
            : await branchesService.get(branchId, params as never);

        // Only check if still running or starting
        const status = branch.environment_instance?.status;
        if (status !== 'running' && status !== 'starting') {
          // Silently stop monitoring (not an error - expected when env stops)
          // Start/stop logs are already handled in handleBranchUpdate()
          this.stopMonitoring(branchId);
          return;
        }

        // Perform health check via the service method. This direct custom
        // service call bypasses Feathers around hooks, so when the monitor has
        // a db handle and tenant params, enter the same tenant DB/ALS scope the
        // scheduler uses before mutating branch environment state and emitting
        // realtime patches.
        await branchesService.checkHealth(branchId, params as never);
      };

      const tenantId = params?.tenant?.tenant_id;
      if (tenantId) {
        await runWithTenantContext(tenantId, runCheck);
      } else {
        await runCheck();
      }
    } catch (error) {
      // If branch was deleted or not found, stop monitoring silently
      // This is expected when branches are deleted while health checks are in progress
      if (error instanceof NotFoundError) {
        this.stopMonitoring(branchId);
        // Only log at debug level - this is normal cleanup, not an error
        if (process.env.DEBUG) {
          console.log(`   Health monitoring stopped for deleted branch ${shortId(branchId)}`);
        }
        return;
      }

      // Log actual errors (not "not found" errors from deleted branches)
      console.error(
        `❌ Health check failed for branch ${shortId(branchId)}:`,
        error instanceof Error ? error.message : error
      );
    } finally {
      this.checksInFlight.delete(branchId);
    }
  }

  /**
   * Initialize monitoring for all currently running branches
   *
   * Called on daemon startup to resume monitoring existing environments
   */
  async initialize() {
    try {
      const activeBranches =
        this.branchRepo || this.discoverActiveEnvironmentRefs
          ? await this.initializeFromTenantAwareDiscovery()
          : await this.initializeFromDefaultParamsScan();

      console.log(`🏥 Health Monitor initialized (${activeBranches} active environment(s))`);
    } catch (error) {
      console.error('❌ Failed to initialize Health Monitor:', error);
    }
  }

  private async initializeFromDefaultParamsScan(): Promise<number> {
    const branchesService = this.app.service('branches');

    // Find all branches with running status in the configured static/startup tenant.
    const result = await branchesService.find({
      ...this.defaultParams,
      query: {
        $limit: 1000,
      },
      paginate: false,
    } as never);

    // Handle both paginated and non-paginated responses
    const branches = (Array.isArray(result) ? result : result.data) as Branch[];

    // Start monitoring running or starting branches
    const activeBranches = branches.filter(
      (w) =>
        w.environment_instance?.status === 'running' ||
        w.environment_instance?.status === 'starting'
    );

    for (const branch of activeBranches) {
      const params = this.paramsForBranch(branch);
      if (!params && this.requireTenantParams) {
        console.error(
          `❌ Health monitoring skipped for branch ${shortId(branch.branch_id)}: missing tenant metadata`
        );
        continue;
      }
      if (params) this.branchParams.set(branch.branch_id, params);
      this.startMonitoring(branch.branch_id, params);
    }

    return activeBranches.length;
  }

  private async initializeFromTenantAwareDiscovery(): Promise<number> {
    const refs = await this.findActiveEnvironmentRefs();
    const branchesService = this.app.service('branches') as unknown as BranchesServiceImpl;
    let activeCount = 0;

    for (const ref of refs) {
      if (!ref.tenantId) {
        console.error(
          `❌ Health monitoring skipped for branch ${shortId(ref.branchId)}: missing tenant metadata`
        );
        continue;
      }

      const params: HealthMonitorParams = {
        tenant: {
          tenant_id: ref.tenantId as TenantID,
          source: this.tenantId ? 'static' : 'explicit',
        },
      };

      try {
        const loadAndStart = async () => {
          const branch = await branchesService.get(ref.branchId, params as never);
          const status = branch.environment_instance?.status;
          if (status !== 'running' && status !== 'starting') return;
          this.branchParams.set(branch.branch_id, tenantParamsFromBranch(branch) ?? params);
          this.startMonitoring(branch.branch_id, this.branchParams.get(branch.branch_id));
          activeCount += 1;
        };

        if (this.db) {
          await runWithTenantDatabaseScope(this.db, ref.tenantId, loadAndStart);
        } else {
          await loadAndStart();
        }
      } catch (error) {
        console.error(
          `❌ Failed to initialize health monitoring for branch ${shortId(ref.branchId)}:`,
          error
        );
      }
    }

    return activeCount;
  }

  private async findActiveEnvironmentRefs(): Promise<HealthMonitorActiveEnvironmentRef[]> {
    type BranchRepositoryActiveEnvironmentRef = Awaited<
      ReturnType<BranchRepository['findActiveEnvironmentRefs']>
    >[number];

    const normalizeRef = (
      ref: HealthMonitorActiveEnvironmentRef | BranchRepositoryActiveEnvironmentRef,
      tenantId?: TenantID | string
    ): HealthMonitorActiveEnvironmentRef => {
      if ('branchId' in ref) {
        return { branchId: ref.branchId, tenantId: tenantId ?? ref.tenantId };
      }
      return { branchId: ref.branch_id, tenantId: tenantId ?? ref.tenant_id };
    };

    const findRefs = async (tenantId?: TenantID | string) => {
      const refs: Array<HealthMonitorActiveEnvironmentRef | BranchRepositoryActiveEnvironmentRef> =
        this.discoverActiveEnvironmentRefs
          ? await this.discoverActiveEnvironmentRefs()
          : await this.branchRepo!.findActiveEnvironmentRefs();
      return refs.map((ref) => normalizeRef(ref, tenantId));
    };

    if (this.tenantId) {
      if (!this.db) return findRefs(this.tenantId);
      return runWithTenantDatabaseScope(this.db, this.tenantId, () => findRefs(this.tenantId));
    }

    if (!this.db) return findRefs();
    return runWithSystemDatabaseScope(this.db, 'health monitor active environment discovery', () =>
      findRefs()
    );
  }

  /**
   * Cleanup all monitoring intervals
   *
   * Called on daemon shutdown
   */
  cleanup() {
    this.isShuttingDown = true;

    // Clear pending grace periods and active intervals.
    const stoppedCount = this.timers.size;
    for (const timer of this.timers.values()) {
      if (timer.phase === 'grace') clearTimeout(timer.handle);
      else clearInterval(timer.handle);
    }

    this.timers.clear();
    this.branchParams.clear();
    console.log(`🏥 Health Monitor cleaned up (${stoppedCount} monitor(s) stopped)`);
  }

  /**
   * Get monitoring status (for debugging)
   */
  getStatus() {
    return {
      isShuttingDown: this.isShuttingDown,
      monitoredBranches: Array.from(this.timers.keys()),
      monitoringCount: this.timers.size,
    };
  }
}

/**
 * Create and initialize Health Monitor service
 */
export async function createHealthMonitor(
  app: Application,
  options: HealthMonitorOptions = {}
): Promise<HealthMonitor> {
  const monitor = new HealthMonitor(app, options);
  await monitor.initialize();
  return monitor;
}
