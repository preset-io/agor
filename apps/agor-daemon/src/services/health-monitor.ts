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
import { shortId } from '@agor/core/db';
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

export interface HealthMonitorOptions {
  /** Internal params used for startup/background scans when no request context exists. */
  defaultParams?: HealthMonitorParams;
}

function tenantParamsFromBranch(branch: Branch): HealthMonitorParams | undefined {
  const tenantId = (branch as Branch & { tenant_id?: unknown }).tenant_id;
  if (typeof tenantId !== 'string' || tenantId.length === 0) return undefined;
  return { tenant: { tenant_id: tenantId as TenantID, source: 'auth_claim' } };
}

export class HealthMonitor {
  private app: Application;
  private intervals = new Map<BranchID, NodeJS.Timeout>();
  private branchParams = new Map<BranchID, HealthMonitorParams>();
  private isShuttingDown = false;
  private defaultParams?: HealthMonitorParams;

  constructor(app: Application, options: HealthMonitorOptions = {}) {
    this.app = app;
    this.defaultParams = options.defaultParams;
    this.setupBranchListeners();
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
      const params = tenantParamsFromBranch(branch) ?? this.defaultParams;
      if (params) this.branchParams.set(branch.branch_id, params);
      if (!this.intervals.has(branch.branch_id)) {
        healthMonitorDebug(`🏥 Starting health monitoring for branch: ${branch.name}`);
        this.startMonitoring(branch.branch_id, params);
      }
    } else {
      // Stop monitoring if status is not running or starting.
      if (this.intervals.has(branch.branch_id)) {
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
    // Clear existing interval if any
    this.stopMonitoring(branchId);
    if (params) this.branchParams.set(branchId, params);

    // Wait grace period before first check
    setTimeout(() => {
      if (this.isShuttingDown) return;

      // Perform first health check
      this.checkHealth(branchId);

      // Set up periodic health checks
      const interval = setInterval(() => {
        if (this.isShuttingDown) return;
        this.checkHealth(branchId);
      }, ENVIRONMENT.HEALTH_CHECK_INTERVAL_MS);

      this.intervals.set(branchId, interval);
    }, ENVIRONMENT.STARTUP_GRACE_PERIOD_MS);
  }

  /**
   * Stop monitoring a branch's health
   */
  private stopMonitoring(branchId: BranchID) {
    const interval = this.intervals.get(branchId);
    if (interval) {
      clearInterval(interval);
      this.intervals.delete(branchId);
    }
  }

  /**
   * Perform health check for a specific branch
   */
  private async checkHealth(branchId: BranchID) {
    try {
      const branchesService = this.app.service('branches') as unknown as BranchesServiceImpl;

      const params = this.branchParams.get(branchId) ?? this.defaultParams;

      // Get current branch state
      const branch = await branchesService.get(branchId, params as never);

      // Only check if still running or starting
      const status = branch.environment_instance?.status;
      if (status !== 'running' && status !== 'starting') {
        // Silently stop monitoring (not an error - expected when env stops)
        // Start/stop logs are already handled in handleBranchUpdate()
        this.stopMonitoring(branchId);
        return;
      }

      // Perform health check via the service method
      // This will update environment_instance and broadcast via WebSocket
      // Logging is handled in checkHealth() method - only logs on state changes
      await branchesService.checkHealth(branchId, params as never);
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
    }
  }

  /**
   * Initialize monitoring for all currently running branches
   *
   * Called on daemon startup to resume monitoring existing environments
   */
  async initialize() {
    try {
      const branchesService = this.app.service('branches');

      // Find all branches with running status
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
        const params = tenantParamsFromBranch(branch) ?? this.defaultParams;
        if (params) this.branchParams.set(branch.branch_id, params);
        this.startMonitoring(branch.branch_id, params);
      }
      console.log(`🏥 Health Monitor initialized (${activeBranches.length} active environment(s))`);
    } catch (error) {
      console.error('❌ Failed to initialize Health Monitor:', error);
    }
  }

  /**
   * Cleanup all monitoring intervals
   *
   * Called on daemon shutdown
   */
  cleanup() {
    this.isShuttingDown = true;

    // Clear all intervals
    const stoppedCount = this.intervals.size;
    for (const interval of this.intervals.values()) {
      clearInterval(interval);
    }

    this.intervals.clear();
    this.branchParams.clear();
    console.log(`🏥 Health Monitor cleaned up (${stoppedCount} monitor(s) stopped)`);
  }

  /**
   * Get monitoring status (for debugging)
   */
  getStatus() {
    return {
      isShuttingDown: this.isShuttingDown,
      monitoredBranches: Array.from(this.intervals.keys()),
      monitoringCount: this.intervals.size,
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
