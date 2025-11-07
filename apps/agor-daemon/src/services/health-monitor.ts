/**
 * Health Monitor Service
 *
 * Periodically checks health of running worktree environments.
 * Runs every 5 seconds and updates environment_instance.last_health_check.
 *
 * Features:
 * - Interval-based polling (5 seconds)
 * - Only monitors worktrees with status='running'
 * - Automatic start/stop on environment state changes
 * - Graceful cleanup on daemon shutdown
 */

import { ENVIRONMENT } from '@agor/core/config';
import type { Application } from '@agor/core/feathers';
import type { Worktree, WorktreeID } from '@agor/core/types';
import { NotFoundError } from '@agor/core/utils/errors';
import type { WorktreesServiceImpl } from '../declarations';

/**
 * Health Monitor - Singleton service for periodic health checks
 */
export class HealthMonitor {
  private app: Application;
  private intervals = new Map<WorktreeID, NodeJS.Timeout>();
  private isShuttingDown = false;

  constructor(app: Application) {
    this.app = app;
    this.setupWorktreeListeners();
  }

  /**
   * Set up WebSocket listeners for worktree changes
   */
  private setupWorktreeListeners() {
    const worktreesService = this.app.service('worktrees');

    // Listen for worktree updates (start/stop/status changes)
    worktreesService.on('patched', (worktree: Worktree) => {
      this.handleWorktreeUpdate(worktree);
    });

    // Listen for worktree creation (in case created with running status)
    worktreesService.on('created', (worktree: Worktree) => {
      this.handleWorktreeUpdate(worktree);
    });

    // Listen for worktree removal (cleanup monitoring)
    worktreesService.on('removed', (worktree: Worktree) => {
      this.stopMonitoring(worktree.worktree_id);
    });
  }

  /**
   * Handle worktree state changes
   */
  private handleWorktreeUpdate(worktree: Worktree) {
    if (this.isShuttingDown) return;

    const status = worktree.environment_instance?.status;

    if (status === 'running' || status === 'starting') {
      // Start monitoring if not already monitored
      // Monitor both 'running' and 'starting' - health checks will transition 'starting' → 'running'
      if (!this.intervals.has(worktree.worktree_id)) {
        console.log(`🏥 Starting health monitoring for worktree: ${worktree.name}`);
        this.startMonitoring(worktree.worktree_id);
      }
    } else {
      // Stop monitoring if status is not running or starting
      if (this.intervals.has(worktree.worktree_id)) {
        console.log(`🏥 Stopping health monitoring for worktree: ${worktree.name}`);
        this.stopMonitoring(worktree.worktree_id);
      }
    }
  }

  /**
   * Start monitoring a worktree's health
   */
  private startMonitoring(worktreeId: WorktreeID) {
    // Clear existing interval if any
    this.stopMonitoring(worktreeId);

    // Wait grace period before first check
    setTimeout(() => {
      if (this.isShuttingDown) return;

      // Perform first health check
      this.checkHealth(worktreeId);

      // Set up periodic health checks
      const interval = setInterval(() => {
        if (this.isShuttingDown) return;
        this.checkHealth(worktreeId);
      }, ENVIRONMENT.HEALTH_CHECK_INTERVAL_MS);

      this.intervals.set(worktreeId, interval);
    }, ENVIRONMENT.STARTUP_GRACE_PERIOD_MS);
  }

  /**
   * Stop monitoring a worktree's health
   */
  private stopMonitoring(worktreeId: WorktreeID) {
    const interval = this.intervals.get(worktreeId);
    if (interval) {
      clearInterval(interval);
      this.intervals.delete(worktreeId);
    }
  }

  /**
   * Perform health check for a specific worktree
   */
  private async checkHealth(worktreeId: WorktreeID) {
    try {
      const worktreesService = this.app.service('worktrees') as unknown as WorktreesServiceImpl;

      // Get current worktree state
      const worktree = await worktreesService.get(worktreeId);

      // Only check if still running or starting
      const status = worktree.environment_instance?.status;
      if (status !== 'running' && status !== 'starting') {
        // Silently stop monitoring (not an error - expected when env stops)
        // Start/stop logs are already handled in handleWorktreeUpdate()
        this.stopMonitoring(worktreeId);
        return;
      }

      // Perform health check via the service method
      // This will update environment_instance and broadcast via WebSocket
      // Logging is handled in checkHealth() method - only logs on state changes
      await worktreesService.checkHealth(worktreeId);
    } catch (error) {
      // If worktree was deleted or not found, stop monitoring silently
      // This is expected when worktrees are deleted while health checks are in progress
      if (error instanceof NotFoundError) {
        this.stopMonitoring(worktreeId);
        // Only log at debug level - this is normal cleanup, not an error
        if (process.env.DEBUG) {
          console.log(`   Health monitoring stopped for deleted worktree ${worktreeId.substring(0, 8)}`);
        }
        return;
      }

      // Log actual errors (not "not found" errors from deleted worktrees)
      console.error(
        `❌ Health check failed for worktree ${worktreeId.substring(0, 8)}:`,
        error instanceof Error ? error.message : error
      );
    }
  }

  /**
   * Initialize monitoring for all currently running worktrees
   *
   * Called on daemon startup to resume monitoring existing environments
   */
  async initialize() {
    console.log('🏥 Initializing Health Monitor...');

    try {
      const worktreesService = this.app.service('worktrees');

      // Find all worktrees with running status
      const result = await worktreesService.find({
        query: {
          $limit: 1000,
        },
        paginate: false,
      });

      // Handle both paginated and non-paginated responses
      const worktrees = (Array.isArray(result) ? result : result.data) as Worktree[];

      // Start monitoring running or starting worktrees
      const activeWorktrees = worktrees.filter(
        w =>
          w.environment_instance?.status === 'running' ||
          w.environment_instance?.status === 'starting'
      );

      if (activeWorktrees.length > 0) {
        console.log(`   Found ${activeWorktrees.length} active environment(s)`);
        for (const worktree of activeWorktrees) {
          this.startMonitoring(worktree.worktree_id);
        }
      } else {
        console.log('   No active environments found');
      }
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
    console.log('🏥 Cleaning up Health Monitor...');
    this.isShuttingDown = true;

    // Clear all intervals
    for (const [worktreeId, interval] of this.intervals.entries()) {
      clearInterval(interval);
      console.log(`   Stopped monitoring: ${worktreeId.substring(0, 8)}`);
    }

    this.intervals.clear();
    console.log('   Health Monitor cleaned up');
  }

  /**
   * Get monitoring status (for debugging)
   */
  getStatus() {
    return {
      isShuttingDown: this.isShuttingDown,
      monitoredWorktrees: Array.from(this.intervals.keys()),
      monitoringCount: this.intervals.size,
    };
  }
}

/**
 * Create and initialize Health Monitor service
 */
export async function createHealthMonitor(app: Application): Promise<HealthMonitor> {
  const monitor = new HealthMonitor(app);
  await monitor.initialize();
  return monitor;
}
