/**
 * Worktrees Service
 *
 * Provides REST + WebSocket API for worktree management.
 * Uses DrizzleService adapter with WorktreeRepository.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { appendFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { ENVIRONMENT } from '@agor/core/config';
import { type Database, WorktreeRepository } from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import { renderTemplate } from '@agor/core/templates/handlebars-helpers';
import type { QueryParams, Repo, UUID, Worktree, WorktreeID } from '@agor/core/types';
import { DrizzleService } from '../adapters/drizzle';

/**
 * Worktree service params
 */
export type WorktreeParams = QueryParams<{
  repo_id?: UUID;
  name?: string;
  ref?: string;
}>;

/**
 * Process tracking for environment management
 */
interface ManagedProcess {
  process: ChildProcess;
  pid: number;
  worktreeId: WorktreeID;
  startedAt: Date;
  logPath: string;
}

/**
 * Extended worktrees service with custom methods
 */
export class WorktreesService extends DrizzleService<Worktree, Partial<Worktree>, WorktreeParams> {
  private worktreeRepo: WorktreeRepository;
  private app: Application;
  private processes = new Map<WorktreeID, ManagedProcess>();

  constructor(db: Database, app: Application) {
    const worktreeRepo = new WorktreeRepository(db);
    super(worktreeRepo, {
      id: 'worktree_id',
      paginate: {
        default: 50,
        max: 100,
      },
    });

    this.worktreeRepo = worktreeRepo;
    this.app = app;
  }

  /**
   * Override find to support repo_id filter
   */
  async find(params?: WorktreeParams) {
    const { repo_id } = params?.query || {};

    // If repo_id filter is provided, use repository method
    if (repo_id) {
      const worktrees = await this.worktreeRepo.findAll({ repo_id });

      // Return with pagination if enabled
      if (this.paginate) {
        return {
          total: worktrees.length,
          limit: params?.query?.$limit || this.paginate.default || 50,
          skip: params?.query?.$skip || 0,
          data: worktrees,
        };
      }

      return worktrees;
    }

    // Otherwise, use default find
    return super.find(params);
  }

  /**
   * Custom method: Find worktree by repo_id and name
   */
  async findByRepoAndName(
    repoId: UUID,
    name: string,
    _params?: WorktreeParams
  ): Promise<Worktree | null> {
    return this.worktreeRepo.findByRepoAndName(repoId, name);
  }

  /**
   * Custom method: Add session to worktree
   */
  async addSession(id: WorktreeID, sessionId: UUID, params?: WorktreeParams): Promise<Worktree> {
    const worktree = await this.worktreeRepo.addSession(id, sessionId);

    // Emit WebSocket event
    this.emit?.('patched', worktree, params);

    return worktree;
  }

  /**
   * Custom method: Remove session from worktree
   */
  async removeSession(id: WorktreeID, sessionId: UUID, params?: WorktreeParams): Promise<Worktree> {
    const worktree = await this.worktreeRepo.removeSession(id, sessionId);

    // Emit WebSocket event
    this.emit?.('patched', worktree, params);

    return worktree;
  }

  /**
   * Custom method: Update environment status
   */
  async updateEnvironment(
    id: WorktreeID,
    environmentUpdate: Partial<Worktree['environment_instance']>,
    params?: WorktreeParams
  ): Promise<Worktree> {
    const existing = await this.get(id, params);

    const updatedEnvironment = {
      ...existing.environment_instance,
      ...environmentUpdate,
    } as Worktree['environment_instance'];

    // Check if environment state actually changed (ignoring timestamp-only updates)
    // For health checks, we only care about status and message changes, not timestamp
    const oldState = { ...existing.environment_instance };
    const newState = { ...updatedEnvironment };

    // Remove timestamps for comparison
    if (oldState?.last_health_check) {
      delete oldState.last_health_check.timestamp;
    }
    if (newState?.last_health_check) {
      delete newState.last_health_check.timestamp;
    }

    const hasChanged = JSON.stringify(oldState) !== JSON.stringify(newState);

    // Only emit WebSocket event if state changed
    if (!hasChanged) {
      return existing;
    }

    const worktree = await this.patch(
      id,
      {
        environment_instance: updatedEnvironment,
        updated_at: new Date().toISOString(),
      },
      params
    );

    return worktree as Worktree;
  }

  /**
   * Custom method: Start environment
   */
  async startEnvironment(id: WorktreeID, params?: WorktreeParams): Promise<Worktree> {
    const worktree = await this.get(id, params);
    const repo = (await this.app.service('repos').get(worktree.repo_id)) as Repo;

    // Validate environment config exists
    if (!repo.environment_config?.up_command) {
      throw new Error('No environment configuration found for this repository');
    }

    // Check if already running
    if (worktree.environment_instance?.status === 'running') {
      throw new Error('Environment is already running');
    }

    // Set status to 'starting'
    await this.updateEnvironment(
      id,
      {
        status: 'starting',
        last_health_check: undefined,
      },
      params
    );

    try {
      // Build template context
      const templateContext = this.buildTemplateContext(worktree, repo);

      // Render command
      const command = renderTemplate(repo.environment_config.up_command, templateContext);

      console.log(`🚀 Starting environment for worktree ${worktree.name}: ${command}`);

      // Create log directory
      const logPath = join(
        homedir(),
        '.agor',
        'logs',
        'worktrees',
        worktree.worktree_id,
        'environment.log'
      );
      await mkdir(dirname(logPath), { recursive: true });

      // Execute command and wait for it to complete
      // The command should start services and return (e.g., docker-compose up -d)
      await new Promise<void>((resolve, reject) => {
        const childProcess = spawn(command, {
          cwd: worktree.path,
          shell: true,
          stdio: 'inherit', // Show output directly in daemon logs
        });

        childProcess.on('exit', code => {
          if (code === 0) {
            console.log(`✅ Start command completed successfully for ${worktree.name}`);
            resolve();
          } else {
            reject(new Error(`Start command exited with code ${code}`));
          }
        });

        childProcess.on('error', reject);
      });

      // Compute access URLs from app_url_template if available
      let access_urls: Array<{ name: string; url: string }> | undefined;
      if (repo.environment_config.app_url_template) {
        const url = renderTemplate(repo.environment_config.app_url_template, templateContext);
        access_urls = [{ name: 'App', url }];
      }

      // Update status to 'running' - now rely on health checks to monitor
      return await this.updateEnvironment(
        id,
        {
          status: 'running',
          process: undefined, // No subprocess to track
          access_urls,
        },
        params
      );
    } catch (error) {
      // Update status to 'error'
      await this.updateEnvironment(
        id,
        {
          status: 'error',
          last_health_check: {
            timestamp: new Date().toISOString(),
            status: 'unhealthy',
            message: error instanceof Error ? error.message : 'Unknown error',
          },
        },
        params
      );

      throw error;
    }
  }

  /**
   * Custom method: Stop environment
   */
  async stopEnvironment(id: WorktreeID, params?: WorktreeParams): Promise<Worktree> {
    const worktree = await this.get(id, params);
    const repo = (await this.app.service('repos').get(worktree.repo_id)) as Repo;

    // Set status to 'stopping'
    await this.updateEnvironment(
      id,
      {
        status: 'stopping',
      },
      params
    );

    try {
      // Check if we have a down command
      if (repo.environment_config?.down_command) {
        // Build template context
        const templateContext = this.buildTemplateContext(worktree, repo);

        // Render command
        const command = renderTemplate(repo.environment_config.down_command, templateContext);

        console.log(`🛑 Stopping environment for worktree ${worktree.name}: ${command}`);

        // Execute down command
        await new Promise<void>((resolve, reject) => {
          const stopProcess = spawn(command, {
            cwd: worktree.path,
            shell: true,
            stdio: 'inherit',
          });

          stopProcess.on('exit', code => {
            if (code === 0) {
              resolve();
            } else {
              reject(new Error(`Down command exited with code ${code}`));
            }
          });

          stopProcess.on('error', reject);
        });
      } else {
        // No down command - kill the managed process if we have it
        const managedProcess = this.processes.get(id);
        if (managedProcess) {
          managedProcess.process.kill('SIGTERM');
          this.processes.delete(id);
        } else if (worktree.environment_instance?.process?.pid) {
          // Try to kill by PID stored in database
          try {
            process.kill(worktree.environment_instance.process.pid, 'SIGTERM');
          } catch (error) {
            console.warn(
              `Failed to kill process ${worktree.environment_instance.process.pid}: ${error}`
            );
          }
        }
      }

      // Update status to 'stopped'
      return await this.updateEnvironment(
        id,
        {
          status: 'stopped',
          process: undefined,
          last_health_check: {
            timestamp: new Date().toISOString(),
            status: 'unknown',
            message: 'Environment stopped',
          },
        },
        params
      );
    } catch (error) {
      // Update status to 'error'
      await this.updateEnvironment(
        id,
        {
          status: 'error',
          last_health_check: {
            timestamp: new Date().toISOString(),
            status: 'unhealthy',
            message: error instanceof Error ? error.message : 'Unknown error',
          },
        },
        params
      );

      throw error;
    }
  }

  /**
   * Custom method: Restart environment
   */
  async restartEnvironment(id: WorktreeID, params?: WorktreeParams): Promise<Worktree> {
    const worktree = await this.get(id, params);

    // Stop if running
    if (worktree.environment_instance?.status === 'running') {
      await this.stopEnvironment(id, params);

      // Wait a bit for processes to clean up
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    // Start
    return await this.startEnvironment(id, params);
  }

  /**
   * Custom method: Check health
   */
  async checkHealth(id: WorktreeID, params?: WorktreeParams): Promise<Worktree> {
    const worktree = await this.get(id, params);
    const repo = (await this.app.service('repos').get(worktree.repo_id)) as Repo;

    // Only check health for 'running' or 'starting' status
    const currentStatus = worktree.environment_instance?.status;
    if (currentStatus !== 'running' && currentStatus !== 'starting') {
      return worktree;
    }

    // Check if we have a health check URL
    if (!repo.environment_config?.health_check?.url_template) {
      // No health check configured - stay in 'starting' forever (manual intervention required)
      // Don't auto-transition to 'running' without health check confirmation
      const managedProcess = this.processes.get(id);
      const isProcessAlive = managedProcess?.process && !managedProcess.process.killed;

      return await this.updateEnvironment(
        id,
        {
          last_health_check: {
            timestamp: new Date().toISOString(),
            status: isProcessAlive ? 'healthy' : 'unknown',
            message: isProcessAlive ? 'Process running' : 'No health check configured',
          },
        },
        params
      );
    }

    // Build template context and render health check URL
    const templateContext = this.buildTemplateContext(worktree, repo);
    const healthUrl = renderTemplate(
      repo.environment_config.health_check.url_template,
      templateContext
    );

    // Track previous health status to detect changes
    const previousHealthStatus = worktree.environment_instance?.last_health_check?.status;

    try {
      // Perform HTTP health check with timeout
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), ENVIRONMENT.HEALTH_CHECK_TIMEOUT_MS);

      const response = await fetch(healthUrl, {
        signal: controller.signal,
        method: 'GET',
      });

      clearTimeout(timeout);

      const isHealthy = response.ok;
      const newHealthStatus = isHealthy ? 'healthy' : 'unhealthy';

      // Only log if health status changed
      if (previousHealthStatus !== newHealthStatus) {
        console.log(
          `🏥 Health status changed for ${worktree.name}: ${previousHealthStatus || 'unknown'} → ${newHealthStatus} (HTTP ${response.status})`
        );
      }

      // If health check succeeds and we're in 'starting' state, transition to 'running'
      const shouldTransitionToRunning = isHealthy && currentStatus === 'starting';

      if (shouldTransitionToRunning) {
        console.log(
          `✅ First successful health check for ${worktree.name} - transitioning to 'running'`
        );
      }

      return await this.updateEnvironment(
        id,
        {
          status: shouldTransitionToRunning ? 'running' : currentStatus,
          last_health_check: {
            timestamp: new Date().toISOString(),
            status: newHealthStatus,
            message: isHealthy
              ? `HTTP ${response.status}`
              : `HTTP ${response.status} ${response.statusText}`,
          },
        },
        params
      );
    } catch (error) {
      // Health check failed
      const message =
        error instanceof Error
          ? error.name === 'AbortError'
            ? 'Timeout'
            : error.message
          : 'Unknown error';

      const newHealthStatus = 'unhealthy';

      // Only log if health status changed or if this is an error
      if (previousHealthStatus !== newHealthStatus) {
        console.log(
          `🏥 Health status changed for ${worktree.name}: ${previousHealthStatus || 'unknown'} → ${newHealthStatus} (${message})`
        );
      }

      return await this.updateEnvironment(
        id,
        {
          last_health_check: {
            timestamp: new Date().toISOString(),
            status: 'unhealthy',
            message,
          },
        },
        params
      );
    }
  }

  /**
   * Custom method: Recompute access URLs for a running environment
   *
   * Called when repo environment_config is updated to refresh URLs without restart
   */
  async recomputeAccessUrls(id: WorktreeID, params?: WorktreeParams): Promise<Worktree> {
    const worktree = await this.get(id, params);
    const repo = (await this.app.service('repos').get(worktree.repo_id)) as Repo;

    // Only recompute if environment is running or starting
    const status = worktree.environment_instance?.status;
    if (status !== 'running' && status !== 'starting') {
      console.log(`   Skipping ${worktree.name} - not active (status: ${status})`);
      return worktree;
    }

    // Compute access URLs from app_url_template
    let access_urls: Array<{ name: string; url: string }> | undefined;
    if (repo.environment_config?.app_url_template) {
      const templateContext = this.buildTemplateContext(worktree, repo);
      const url = renderTemplate(repo.environment_config.app_url_template, templateContext);
      access_urls = [{ name: 'App', url }];
      console.log(`   Recomputed access URL for ${worktree.name}: ${url}`);
    } else {
      console.log(`   Cleared access URL for ${worktree.name} - no template configured`);
    }

    // Update environment with new URLs (this will broadcast via WebSocket if changed)
    return await this.updateEnvironment(
      id,
      {
        access_urls,
      },
      params
    );
  }

  /**
   * Build template context for Handlebars rendering
   */
  private buildTemplateContext(worktree: Worktree, repo: Repo) {
    let customContext = {};
    try {
      customContext = worktree.custom_context || {};
    } catch {
      // Invalid custom context, use empty object
    }

    return {
      worktree: {
        unique_id: worktree.worktree_unique_id,
        name: worktree.name,
        path: worktree.path,
      },
      repo: {
        slug: repo.slug,
      },
      custom: customContext,
    };
  }
}

/**
 * Service factory function
 */
export function createWorktreesService(db: Database, app: Application): WorktreesService {
  return new WorktreesService(db, app);
}
