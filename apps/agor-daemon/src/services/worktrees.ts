/**
 * Worktrees Service
 *
 * Provides REST + WebSocket API for worktree management.
 * Uses DrizzleService adapter with WorktreeRepository.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { ENVIRONMENT } from '@agor/core/config';
import { type Database, WorktreeRepository } from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import { removeWorktree } from '@agor/core/git';
import { renderTemplate } from '@agor/core/templates/handlebars-helpers';
import type {
  BoardEntityObject,
  QueryParams,
  Repo,
  UUID,
  Worktree,
  WorktreeID,
} from '@agor/core/types';
import { getNextRunTime, validateCron } from '@agor/core/utils/cron';
import { DrizzleService } from '../adapters/drizzle';

/**
 * Worktree service params
 */
export type WorktreeParams = QueryParams<{
  repo_id?: UUID;
  name?: string;
  ref?: string;
  deleteFromFilesystem?: boolean;
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
  // Cache board-objects service reference (lazy-loaded to avoid circular deps)
  private boardObjectsService?: {
    findByWorktreeId: (worktreeId: WorktreeID) => Promise<unknown>;
    create: (data: unknown) => Promise<unknown>;
    remove: (id: string) => Promise<unknown>;
  };

  constructor(db: Database, app: Application) {
    const worktreeRepo = new WorktreeRepository(db);
    super(worktreeRepo, {
      id: 'worktree_id',
      resourceType: 'Worktree',
      paginate: {
        default: 50,
        max: 100,
      },
    });

    this.worktreeRepo = worktreeRepo;
    this.app = app;
  }

  /**
   * Get board-objects service (lazy-loaded to prevent circular dependencies)
   * FIX: Cache service reference instead of calling this.app.service() repeatedly
   */
  private getBoardObjectsService() {
    if (!this.boardObjectsService) {
      this.boardObjectsService = this.app.service('board-objects') as unknown as {
        findByWorktreeId: (worktreeId: WorktreeID) => Promise<unknown>;
        create: (data: unknown) => Promise<unknown>;
        remove: (id: string) => Promise<unknown>;
      };
    }
    return this.boardObjectsService;
  }

  /**
   * Override patch to handle board_objects when board_id changes and schedule validation
   */
  async patch(id: WorktreeID, data: Partial<Worktree>, params?: WorktreeParams): Promise<Worktree> {
    // Get current worktree to check if board_id is changing
    const currentWorktree = await this.get(id, params);
    const oldBoardId = currentWorktree.board_id;
    const boardIdProvided = Object.hasOwn(data, 'board_id');
    const newBoardId = data.board_id;

    // ===== SCHEDULER VALIDATION =====

    // Validate cron expression if schedule_cron is being updated
    if (data.schedule_cron !== undefined && data.schedule_cron !== null) {
      try {
        validateCron(data.schedule_cron);
      } catch (error) {
        throw new Error(
          `Invalid cron expression: ${error instanceof Error ? error.message : String(error)}`
        );
      }

      // Compute next_run_at if cron is valid
      try {
        const nextRunAt = getNextRunTime(data.schedule_cron);
        data.schedule_next_run_at = nextRunAt;
      } catch (error) {
        console.error('Failed to compute next_run_at:', error);
        // Don't fail the patch if next_run_at computation fails
        // Scheduler will handle it on next tick
      }
    }

    // If schedule_enabled is being set to true, ensure schedule config exists
    if (data.schedule_enabled === true && !currentWorktree.schedule && !data.schedule) {
      throw new Error(
        'Cannot enable schedule without schedule configuration. Please provide schedule config in data.schedule.'
      );
    }

    // If schedule_enabled is being set to false, clear next_run_at
    if (data.schedule_enabled === false) {
      data.schedule_next_run_at = undefined;
    }

    // Call parent patch
    const updatedWorktree = (await super.patch(id, data, params)) as Worktree;

    // Handle board_objects changes if board_id changed
    if (!boardIdProvided) {
      return updatedWorktree;
    }

    if (oldBoardId !== newBoardId) {
      const boardObjectsService = this.getBoardObjectsService();

      try {
        // First, check if a board_object already exists
        const existingObject = (await boardObjectsService.findByWorktreeId(id)) as
          | { object_id: string }
          | null;

        if (existingObject) {
          // Board object exists - delete it first
          await boardObjectsService.remove(existingObject.object_id);
        }

        // Now create new board_object if board_id is set
        if (newBoardId) {
          await boardObjectsService.create({
            board_id: newBoardId,
            worktree_id: id,
            position: { x: 100, y: 100 }, // Default position
          });
        }
      } catch (error) {
        console.error(
          `❌ Failed to manage board_objects for worktree ${id}:`,
          error instanceof Error ? error.message : String(error)
        );
        // Don't throw - allow worktree patch to succeed even if board_object management fails
      }
    }

    return updatedWorktree;
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
   * Override remove to support filesystem deletion
   */
  async remove(id: WorktreeID, params?: WorktreeParams): Promise<Worktree> {
    const { deleteFromFilesystem } = params?.query || {};

    // Get worktree details before deletion
    const worktree = await this.get(id, params);

    // Remove from database FIRST for instant UI feedback
    // CASCADE will clean up related comments automatically
    const result = await super.remove(id, params);

    // Then remove from filesystem (slower operation, happens in background)
    if (deleteFromFilesystem) {
      // Note: We don't await this - it happens asynchronously after DB deletion
      const repo = (await this.app.service('repos').get(worktree.repo_id)) as Repo;
      console.log(`🗑️  Removing worktree from filesystem: ${worktree.path}`);
      removeWorktree(repo.local_path, worktree.path)
        .then(() => {
          console.log(`✅ Worktree removed from filesystem successfully`);
        })
        .catch(error => {
          console.error(
            `⚠️  Failed to remove worktree from filesystem:`,
            error instanceof Error ? error.message : String(error)
          );
        });
    }

    return result as Worktree;
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
   * Custom method: Add worktree to board
   *
   * Phase 0: Sets board_id on worktree
   * Phase 1: Will also create board_object entry for positioning
   */
  async addToBoard(id: WorktreeID, boardId: UUID, params?: WorktreeParams): Promise<Worktree> {
    // Set worktree.board_id
    const worktree = await this.patch(
      id,
      {
        board_id: boardId,
        updated_at: new Date().toISOString(),
      },
      params
    );

    // TODO (Phase 1): Create board_object entry for positioning
    // await this.app.service('board-objects').create({
    //   board_id: boardId,
    //   object_type: 'worktree',
    //   worktree_id: id,
    //   position: { x: 100, y: 100 }, // Default position
    // });

    return worktree as Worktree;
  }

  /**
   * Custom method: Remove worktree from board
   *
   * Phase 0: Clears board_id on worktree
   * Phase 1: Will also remove board_object entry
   */
  async removeFromBoard(id: WorktreeID, params?: WorktreeParams): Promise<Worktree> {
    // Clear worktree.board_id
    const worktree = await this.patch(
      id,
      {
        board_id: undefined,
        updated_at: new Date().toISOString(),
      },
      params
    );

    // TODO (Phase 1): Remove board_object entry
    // const objects = await this.app.service('board-objects').find({
    //   query: { worktree_id: id },
    // });
    // for (const obj of objects.data) {
    //   await this.app.service('board-objects').remove(obj.object_id);
    // }

    return worktree as Worktree;
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

    // Remove timestamps for comparison - create new objects without timestamp
    if (oldState?.last_health_check) {
      // biome-ignore lint/correctness/noUnusedVariables: extracting to remove from object
      const { timestamp, ...healthCheck } = oldState.last_health_check;
      oldState.last_health_check = healthCheck as typeof oldState.last_health_check;
    }
    if (newState?.last_health_check) {
      // biome-ignore lint/correctness/noUnusedVariables: extracting to remove from object
      const { timestamp, ...healthCheck } = newState.last_health_check;
      newState.last_health_check = healthCheck as typeof newState.last_health_check;
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

      // Keep status as 'starting' - let health checks transition to 'running'
      // The first successful health check will transition from 'starting' → 'running'
      // This prevents premature "healthy" status before app is truly ready
      return await this.updateEnvironment(
        id,
        {
          // Don't change status - keep as 'starting' until first successful health check
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

      // During 'starting' state, don't mark as unhealthy - keep retrying
      // Only mark as unhealthy when transitioning from healthy->unhealthy in 'running' state
      if (currentStatus === 'starting') {
        // Don't update health check during startup - wait for first success
        // This prevents the UI from showing unhealthy state while environment is still starting
        return worktree;
      }

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
   * Custom method: Get environment logs
   */
  async getLogs(
    id: WorktreeID,
    params?: WorktreeParams
  ): Promise<{
    logs: string;
    timestamp: string;
    error?: string;
    truncated?: boolean;
  }> {
    const worktree = await this.get(id, params);
    const repo = (await this.app.service('repos').get(worktree.repo_id)) as Repo;

    // Check if logs command is configured
    if (!repo.environment_config?.logs_command) {
      return {
        logs: '',
        timestamp: new Date().toISOString(),
        error: 'No logs command configured',
      };
    }

    try {
      // Build template context and render command
      const templateContext = this.buildTemplateContext(worktree, repo);
      const command = renderTemplate(repo.environment_config.logs_command, templateContext);

      console.log(`📋 Fetching logs for worktree ${worktree.name}: ${command}`);

      // Execute command with timeout and output limits
      const result = await new Promise<{
        stdout: string;
        stderr: string;
        truncated: boolean;
      }>((resolve, reject) => {
        const childProcess = spawn(command, {
          cwd: worktree.path,
          shell: true,
        });

        let stdout = '';
        let stderr = '';
        let truncated = false;

        // Set timeout
        const timeout = setTimeout(() => {
          childProcess.kill('SIGTERM');
          reject(new Error(`Logs command timed out after ${ENVIRONMENT.LOGS_TIMEOUT_MS / 1000}s`));
        }, ENVIRONMENT.LOGS_TIMEOUT_MS);

        // Capture stdout with size limit
        childProcess.stdout?.on('data', (data: Buffer) => {
          const chunk = data.toString();
          if (stdout.length + chunk.length <= ENVIRONMENT.LOGS_MAX_BYTES) {
            stdout += chunk;
          } else {
            // Truncate to max bytes
            stdout += chunk.substring(0, ENVIRONMENT.LOGS_MAX_BYTES - stdout.length);
            truncated = true;
            childProcess.kill('SIGTERM');
          }
        });

        // Capture stderr
        childProcess.stderr?.on('data', (data: Buffer) => {
          stderr += data.toString();
        });

        childProcess.on('exit', code => {
          clearTimeout(timeout);
          if (code === 0 || stdout.length > 0) {
            resolve({ stdout, stderr, truncated });
          } else {
            reject(new Error(stderr || `Logs command exited with code ${code}`));
          }
        });

        childProcess.on('error', error => {
          clearTimeout(timeout);
          reject(error);
        });
      });

      // Process output: split into lines and keep last N lines
      const allLines = result.stdout.split('\n');
      let finalLines = allLines;
      let wasTruncatedByLines = false;

      if (allLines.length > ENVIRONMENT.LOGS_MAX_LINES) {
        finalLines = allLines.slice(-ENVIRONMENT.LOGS_MAX_LINES);
        wasTruncatedByLines = true;
      }

      const logs = finalLines.join('\n');
      const truncated = result.truncated || wasTruncatedByLines;

      console.log(
        `✅ Fetched ${allLines.length} lines (${logs.length} bytes) for ${worktree.name}${truncated ? ' [truncated]' : ''}`
      );

      return {
        logs,
        timestamp: new Date().toISOString(),
        truncated,
      };
    } catch (error) {
      console.error(
        `❌ Failed to fetch logs for ${worktree.name}:`,
        error instanceof Error ? error.message : String(error)
      );

      return {
        logs: '',
        timestamp: new Date().toISOString(),
        error: error instanceof Error ? error.message : 'Unknown error',
      };
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
