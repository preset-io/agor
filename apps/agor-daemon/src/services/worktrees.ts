/**
 * Worktrees Service
 *
 * Provides REST + WebSocket API for worktree management.
 * Uses DrizzleService adapter with WorktreeRepository.
 */

import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { ENVIRONMENT, isWorktreeRbacEnabled, loadConfig, PAGINATION } from '@agor/core/config';
import { type Database, WorktreeRepository, type WorktreeWithZoneAndSessions } from '@agor/core/db';
import { renderWorktreeSnapshot } from '@agor/core/environment/render-snapshot';
import { type Application, Forbidden, NotAuthenticated } from '@agor/core/feathers';
import type {
  AuthenticatedParams,
  BoardID,
  QueryParams,
  Repo,
  UserID,
  UUID,
  Worktree,
  WorktreeID,
} from '@agor/core/types';
import { ROLES } from '@agor/core/types';
import { getGidFromGroupName, spawnEnvironmentCommand } from '@agor/core/unix';
import { getNextRunTime, validateCron } from '@agor/core/utils/cron';
import { resolveHostIpAddress } from '@agor/core/utils/host-ip';
import { isAllowedHealthCheckUrl } from '@agor/core/utils/url';
import { DrizzleService } from '../adapters/drizzle';
import { ensureCanTriggerManagedEnv, ensureMinimumRole } from '../utils/authorization.js';
import { resolveGitImpersonationForWorktree } from '../utils/git-impersonation.js';
import { generateSessionToken, getDaemonUrl, spawnExecutor } from '../utils/spawn-executor.js';
import type { InternalEnrichmentParams } from './sessions';

/**
 * Worktree service params
 */
export type WorktreeParams = QueryParams<{
  repo_id?: UUID;
  name?: string;
  ref?: string;
  deleteFromFilesystem?: boolean;
  include_sessions?: boolean | 'true' | 'false'; // Opt-in session activity enrichment
  last_message_truncation_length?: number; // Default: 500 chars, min: 50, max: 10000
}> &
  InternalEnrichmentParams & {
    /** Root-level include_sessions flag (bypasses Feathers query filtering, used by internal service calls) */
    _include_sessions?: boolean | 'true' | 'false';
  };

/**
 * Parse and validate last_message_truncation_length parameter
 * Feathers delivers query params as strings, so we need to parse and validate
 */
function parseTruncationLength(value: unknown): number {
  // Default value
  const DEFAULT = 500;
  const MIN = 50;
  const MAX = 10000;

  if (value === undefined || value === null) {
    return DEFAULT;
  }

  // Parse to number
  const parsed = typeof value === 'number' ? value : Number(value);

  // Validate: must be finite, positive, and within bounds
  if (!Number.isFinite(parsed) || parsed < MIN || parsed > MAX) {
    return DEFAULT;
  }

  return Math.floor(parsed); // Ensure integer
}

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
  private db: Database;
  private app: Application;
  private processes = new Map<WorktreeID, ManagedProcess>();
  // Cache board-objects service reference (lazy-loaded to avoid circular deps)
  private boardObjectsService?: {
    find: (params?: unknown) => Promise<unknown>;
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
        default: PAGINATION.DEFAULT_LIMIT,
        max: PAGINATION.MAX_LIMIT,
      },
    });

    this.worktreeRepo = worktreeRepo;
    this.db = db;
    this.app = app;
  }

  /**
   * Enforce `execution.managed_envs_minimum_role` on env command triggers.
   * Canonical enforcement point — runs for REST, WebSocket, *and* MCP callers
   * since all trigger paths reach this service class.
   */
  private async ensureCanTriggerEnv(
    params: WorktreeParams | undefined,
    action: string
  ): Promise<void> {
    const config = await loadConfig();
    ensureCanTriggerManagedEnv(config.execution?.managed_envs_minimum_role, params, action);
  }

  /**
   * Extract caller identity for audit logging. Internal/daemon-initiated
   * calls (no params.provider, no user) return undefined which the audit
   * entry records explicitly.
   */
  private extractTriggeredBy(
    params: WorktreeParams | undefined
  ): { user_id?: string; email?: string } | undefined {
    const user = (params as AuthenticatedParams | undefined)?.user;
    if (!user) return undefined;
    return { user_id: user.user_id, email: user.email };
  }

  /**
   * Get board-objects service (lazy-loaded to prevent circular dependencies)
   * FIX: Cache service reference instead of calling this.app.service() repeatedly
   */
  private getBoardObjectsService() {
    if (!this.boardObjectsService) {
      this.boardObjectsService = this.app.service('board-objects') as unknown as {
        find: (params?: unknown) => Promise<unknown>;
        findByWorktreeId: (worktreeId: WorktreeID) => Promise<unknown>;
        create: (data: unknown) => Promise<unknown>;
        remove: (id: string) => Promise<unknown>;
      };
    }
    return this.boardObjectsService;
  }

  /**
   * Compute a smart default position for a worktree on a board, based on existing entities/zones.
   * Falls back to a small jitter near origin if placement utilities fail.
   */
  private async computeDefaultBoardPositionForWorktree(
    boardId: BoardID,
    currentWorktreeId: WorktreeID,
    params?: WorktreeParams
  ): Promise<{ x: number; y: number }> {
    try {
      const boardObjectsService = this.getBoardObjectsService();
      const board = (await this.app.service('boards').get(boardId, params)) as {
        objects?: Record<string, { type?: string }>;
      };

      const existingResult = (await boardObjectsService.find({
        query: { board_id: boardId },
        ...params,
      })) as { data: Array<{ worktree_id?: string | null; position: { x: number; y: number } }> };

      const activeWorktreesResult = await this.app.service('worktrees').find({
        query: { board_id: boardId, archived: false, $limit: 5000 },
        paginate: false,
      });
      const activeWorktrees = Array.isArray(activeWorktreesResult)
        ? activeWorktreesResult
        : (activeWorktreesResult as { data: Array<{ worktree_id: string }> }).data;
      const activeWorktreeIds = new Set(activeWorktrees.map((wt) => wt.worktree_id));

      const activeEntities = existingResult.data.filter((obj) => {
        if (!obj.worktree_id) return true;
        if (obj.worktree_id === currentWorktreeId) return false;
        return activeWorktreeIds.has(obj.worktree_id);
      });

      const zones = board?.objects
        ? Object.entries(board.objects)
            .filter(([, o]) => (o as { type?: string }).type === 'zone')
            .map(([id, o]) => ({ id, ...(o as object) }))
        : [];

      const { resolveEntityAbsolutePositions, computeDefaultBoardPosition } = await import(
        '@agor/core/utils/board-placement'
      );
      const absolutePositions = resolveEntityAbsolutePositions(
        activeEntities as never,
        zones as never
      );
      return computeDefaultBoardPosition(absolutePositions, zones as never);
    } catch (error) {
      console.warn(
        `⚠️ Failed smart board placement for worktree ${currentWorktreeId}:`,
        error instanceof Error ? error.message : String(error)
      );
      return { x: 100 + Math.random() * 200, y: 100 + Math.random() * 200 };
    }
  }

  /**
   * Apply config-driven defaults before insert.
   *
   * Reads `worktrees.others_can_default` and `worktrees.others_fs_access_default`
   * so admins can set org-wide defaults in config.yaml. Explicit values on the
   * input always win; defaults fill in only when the caller omits the field.
   */
  private async applyWorktreeCreateDefaults(data: Partial<Worktree>): Promise<Partial<Worktree>> {
    const config = await loadConfig();
    const defaults = config.worktrees;
    if (!defaults) return data;

    const withDefaults: Partial<Worktree> = { ...data };
    if (defaults.others_can_default !== undefined && withDefaults.others_can === undefined) {
      withDefaults.others_can = defaults.others_can_default;
    }
    if (
      defaults.others_fs_access_default !== undefined &&
      withDefaults.others_fs_access === undefined
    ) {
      withDefaults.others_fs_access = defaults.others_fs_access_default;
    }
    return withDefaults;
  }

  /**
   * Custom method: Initialize Unix group for a worktree (daemon-side privileged operation).
   *
   * Called by the executor via Feathers RPC after creating the git worktree on
   * disk, so that groupadd/chgrp/setfacl run with daemon sudo privileges
   * regardless of executor impersonation mode.
   *
   * Auth: only service accounts (executor JWTs) may invoke this externally.
   * Internal calls (no `provider`) pass through.
   */
  async initializeUnixGroup(
    data: { worktreeId: string; othersAccess?: 'none' | 'read' | 'write' },
    params?: WorktreeParams
  ): Promise<{ unixGroup: string }> {
    if (params?.provider) {
      const caller = (params as AuthenticatedParams | undefined)?.user;
      if (!caller) {
        throw new NotAuthenticated('Authentication required');
      }
      const isService = !!(caller as { _isServiceAccount?: boolean })._isServiceAccount;
      if (!isService) {
        throw new Forbidden('Only the executor service account may initialize Unix groups');
      }
    }

    const { initializeWorktreeUnixGroup } = await import('../utils/unix-group-init.js');
    const unixGroup = await initializeWorktreeUnixGroup(
      this.db,
      this.app,
      data.worktreeId,
      data.othersAccess || 'read'
    );
    return { unixGroup };
  }

  /**
   * Override create to inject config-driven worktree defaults.
   */
  async create(
    data: Partial<Worktree> | Partial<Worktree>[],
    params?: WorktreeParams
  ): Promise<Worktree | Worktree[]> {
    if (Array.isArray(data)) {
      const withDefaults = await Promise.all(
        data.map((item) => this.applyWorktreeCreateDefaults(item))
      );
      return super.create(withDefaults, params) as Promise<Worktree[]>;
    }
    const withDefaults = await this.applyWorktreeCreateDefaults(data);
    return super.create(withDefaults, params) as Promise<Worktree>;
  }

  /**
   * Override patch to handle board_objects when board_id changes and schedule validation
   */
  async patch(
    id: WorktreeID,
    data: Partial<Worktree>,
    params?: WorktreeParams
  ): Promise<WorktreeWithZoneAndSessions> {
    // Get current worktree to check if board_id is changing
    const currentWorktree = await super.get(id, params);
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
      const withZone = await this.worktreeRepo.enrichWithZoneInfo(updatedWorktree);

      // Only enrich with session activity if explicitly requested
      if (params?.query?.include_sessions === true || params?.query?.include_sessions === 'true') {
        const truncationLength = parseTruncationLength(
          params?.query?.last_message_truncation_length
        );
        return this.worktreeRepo.enrichWithSessionActivity(withZone, truncationLength);
      }

      return withZone as WorktreeWithZoneAndSessions;
    }

    if (oldBoardId !== newBoardId) {
      const boardObjectsService = this.getBoardObjectsService();

      try {
        // First, check if a board_object already exists
        const existingObject = (await boardObjectsService.findByWorktreeId(id)) as {
          object_id: string;
        } | null;

        if (existingObject) {
          // Board object exists - delete it first
          await boardObjectsService.remove(existingObject.object_id);
        }

        // Now create new board_object if board_id is set
        if (newBoardId) {
          const position = await this.computeDefaultBoardPositionForWorktree(
            newBoardId,
            id,
            params
          );
          await boardObjectsService.create({
            board_id: newBoardId,
            worktree_id: id,
            position,
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

    const withZone = await this.worktreeRepo.enrichWithZoneInfo(updatedWorktree);

    // Only enrich with session activity if explicitly requested
    if (params?.query?.include_sessions === true || params?.query?.include_sessions === 'true') {
      const truncationLength = parseTruncationLength(params?.query?.last_message_truncation_length);
      return this.worktreeRepo.enrichWithSessionActivity(withZone, truncationLength);
    }

    return withZone as WorktreeWithZoneAndSessions;
  }

  /**
   * Override get to enrich with zone information
   *
   * Session activity enrichment is opt-in via include_sessions query parameter
   */
  async get(id: WorktreeID, params?: WorktreeParams): Promise<WorktreeWithZoneAndSessions> {
    // Check both query params and root-level params (root-level bypasses Feathers query filtering)
    const includeSessionsQuery = params?.query?.include_sessions;
    const includeSessionsRoot = params?._include_sessions;
    const includeSessions = includeSessionsRoot ?? includeSessionsQuery;

    const worktree = await super.get(id, params);
    const withZone = await this.worktreeRepo.enrichWithZoneInfo(worktree as Worktree);

    // Only enrich with session activity if explicitly requested
    if (includeSessions === true || includeSessions === 'true') {
      const truncationLengthQuery = params?.query?.last_message_truncation_length;
      const truncationLengthRoot = params?._last_message_truncation_length;
      const truncationLength = parseTruncationLength(truncationLengthRoot ?? truncationLengthQuery);
      const result = await this.worktreeRepo.enrichWithSessionActivity(withZone, truncationLength);
      return result;
    }

    return withZone as WorktreeWithZoneAndSessions;
  }

  /**
   * Override find to enrich with zone information only
   *
   * Note: Session activity is NOT included in list operations - only on single GET
   */
  async find(params?: WorktreeParams) {
    // Use default find to ensure all hooks and scoping are applied (including repo_id filter)
    const result = await super.find(params);

    // Handle both paginated and non-paginated results
    if (Array.isArray(result)) {
      return this.worktreeRepo.enrichManyWithZoneInfo(result as Worktree[]);
    } else {
      const enriched = await this.worktreeRepo.enrichManyWithZoneInfo(result.data as Worktree[]);
      return {
        ...result,
        data: enriched,
      };
    }
  }

  /**
   * Override remove to support filesystem deletion
   *
   * Delegates filesystem removal to executor for Unix isolation.
   */
  async remove(id: WorktreeID, params?: WorktreeParams): Promise<Worktree> {
    const { deleteFromFilesystem } = params?.query || {};

    // Get worktree details before deletion
    const worktree = await this.get(id, params);

    // Remove from database FIRST for instant UI feedback
    // CASCADE will clean up related comments automatically
    const result = await super.remove(id, params);

    // Then remove from filesystem via executor (fire-and-forget)
    // Executor handles its own logging and error reporting via Feathers
    if (deleteFromFilesystem) {
      console.log(`🗑️  Spawning executor to remove worktree from filesystem: ${worktree.path}`);

      // Resolve Unix user for impersonation (handles simple/insulated/strict modes)
      const rbacEnabled = isWorktreeRbacEnabled();
      const asUser = rbacEnabled
        ? await resolveGitImpersonationForWorktree(this.db, worktree)
        : undefined;

      // Generate session token for executor authentication
      const userId = (params as AuthenticatedParams | undefined)?.user?.user_id as
        | UserID
        | undefined;
      const appWithToken = this.app as unknown as {
        sessionTokenService?: import('../services/session-token-service').SessionTokenService;
      };

      // Generate token and spawn executor (fire-and-forget)
      appWithToken.sessionTokenService
        ?.generateToken('worktree-remove', userId || 'anonymous')
        .then((sessionToken) => {
          spawnExecutor(
            {
              command: 'git.worktree.remove',
              sessionToken,
              daemonUrl: getDaemonUrl(),
              params: {
                worktreeId: worktree.worktree_id,
                worktreePath: worktree.path,
                deleteDbRecord: false, // Already deleted above
                // Clean up the branch if it was created by Agor
                branch: worktree.ref,
                deleteBranch: worktree.new_branch,
              },
            },
            {
              logPrefix: `[WorktreesService.remove ${worktree.name}]`,
              asUser, // Run as resolved user (fresh groups via sudo -u)
            }
          );
        })
        .catch((error) => {
          console.error(
            `⚠️  Failed to generate session token for worktree removal:`,
            error instanceof Error ? error.message : String(error)
          );
        });
    }

    return result as Worktree;
  }

  /**
   * Custom method: Archive or delete worktree with filesystem options
   *
   * This method implements the archive/delete modal functionality.
   * Supports both soft delete (archive) and hard delete, with granular filesystem control.
   *
   * @param id - Worktree ID
   * @param options - Archive/delete configuration
   * @param params - Query params
   */
  async archiveOrDelete(
    id: WorktreeID,
    options: {
      metadataAction: 'archive' | 'delete';
      filesystemAction: 'preserved' | 'cleaned' | 'deleted';
    },
    params?: WorktreeParams
  ): Promise<WorktreeWithZoneAndSessions | { deleted: true; worktree_id: WorktreeID }> {
    const { metadataAction, filesystemAction } = options;
    const worktree = await this.get(id, params);
    const currentUserId = 'anonymous' as UUID; // TODO: Get from auth context

    // Stop environment if running
    if (worktree.environment_instance?.status === 'running') {
      console.log(`⚠️  Stopping environment for worktree ${worktree.name} before ${metadataAction}`);
      try {
        await this.stopEnvironment(id, params);
      } catch (error) {
        console.warn(
          `Failed to stop environment, continuing with ${metadataAction}:`,
          error instanceof Error ? error.message : String(error)
        );
      }
    }

    // Perform filesystem action via executor (fire-and-forget)
    // Executor handles its own logging and error reporting via Feathers
    // Using executor ensures proper Unix isolation for file operations
    const userId = (params as AuthenticatedParams | undefined)?.user?.user_id as UserID | undefined;
    const appWithToken = this.app as unknown as {
      sessionTokenService?: import('../services/session-token-service').SessionTokenService;
    };

    if (filesystemAction === 'cleaned') {
      console.log(`🧹 Spawning executor to clean worktree filesystem: ${worktree.path}`);

      // No user impersonation for infrastructure operations — the daemon user
      // owns all worktrees and impersonation would resolve getWorktreesDir()
      // to the wrong home directory, causing safety check failures.

      appWithToken.sessionTokenService
        ?.generateToken('worktree-clean', userId || 'anonymous')
        .then((sessionToken) => {
          spawnExecutor(
            {
              command: 'git.worktree.clean',
              sessionToken,
              daemonUrl: getDaemonUrl(),
              params: {
                worktreePath: worktree.path,
              },
            },
            {
              logPrefix: `[WorktreesService.clean ${worktree.name}]`,
            }
          );
        })
        .catch((error) => {
          console.error(
            `⚠️  Failed to generate session token for worktree cleaning:`,
            error instanceof Error ? error.message : String(error)
          );
        });
    } else if (filesystemAction === 'deleted') {
      console.log(`🗑️  Spawning executor to delete worktree from filesystem: ${worktree.path}`);

      // No user impersonation for infrastructure operations — the daemon user
      // owns all worktrees and impersonation would resolve getWorktreesDir()
      // to the wrong home directory, causing safety check failures.

      appWithToken.sessionTokenService
        ?.generateToken('worktree-delete', userId || 'anonymous')
        .then((sessionToken) => {
          spawnExecutor(
            {
              command: 'git.worktree.remove',
              sessionToken,
              daemonUrl: getDaemonUrl(),
              params: {
                worktreeId: worktree.worktree_id,
                worktreePath: worktree.path,
                deleteDbRecord: false, // Daemon handles DB deletion separately
                // Clean up the branch if it was created by Agor
                branch: worktree.ref,
                deleteBranch: worktree.new_branch,
              },
            },
            {
              logPrefix: `[WorktreesService.delete ${worktree.name}]`,
            }
          );
        })
        .catch((error) => {
          console.error(
            `⚠️  Failed to generate session token for worktree deletion:`,
            error instanceof Error ? error.message : String(error)
          );
        });
    }

    // Metadata action: archive or delete
    if (metadataAction === 'archive') {
      // Archive: Soft delete worktree and cascade to sessions
      console.log(`📦 Archiving worktree: ${worktree.name} (filesystem: ${filesystemAction})`);

      // Update worktree
      const archivedWorktree = await this.patch(
        id,
        {
          archived: true,
          archived_at: new Date().toISOString(),
          archived_by: currentUserId,
          filesystem_status: filesystemAction,
          // Preserve board_id + board_object placement so unarchive can restore in-place
          updated_at: new Date().toISOString(),
        },
        params
      );

      // Archive all sessions in this worktree
      // Use internal call (no provider) to bypass RBAC hooks that would ignore worktree_id filter
      const sessionsService = this.app.service('sessions');
      const sessionsResult = await sessionsService.find({
        query: { worktree_id: id, $limit: 1000 },
        paginate: false,
      });
      const sessions = Array.isArray(sessionsResult) ? sessionsResult : sessionsResult.data;

      for (const session of sessions) {
        await sessionsService.patch(
          session.session_id,
          {
            archived: true,
            archived_reason: 'worktree_archived',
          },
          { provider: undefined } // Bypass RBAC - this is an internal cascade operation
        );
      }

      console.log(`✅ Archived worktree ${worktree.name} and ${sessions.length} session(s)`);
      return archivedWorktree;
    } else {
      // Delete: Hard delete (CASCADE will remove sessions, messages, tasks)
      console.log(`🗑️  Permanently deleting worktree: ${worktree.name}`);

      await this.remove(id, params);

      console.log(`✅ Permanently deleted worktree ${worktree.name}`);
      return { deleted: true, worktree_id: id };
    }
  }

  /**
   * Custom method: Unarchive a worktree
   */
  async unarchive(
    id: WorktreeID,
    options?: { boardId?: BoardID },
    params?: WorktreeParams
  ): Promise<WorktreeWithZoneAndSessions> {
    const worktree = await this.get(id, params);

    if (!worktree.archived) {
      throw new Error(`Worktree ${worktree.name} is not archived`);
    }

    console.log(`📦 Unarchiving worktree: ${worktree.name}`);

    const boardIdExplicitlyProvided = options !== undefined && 'boardId' in options;
    const targetBoardId = boardIdExplicitlyProvided ? options?.boardId : worktree.board_id;

    // Update worktree - clear archive metadata
    const patchData: Partial<Worktree> = {
      archived: false,
      archived_at: undefined,
      archived_by: undefined,
      filesystem_status: undefined,
      updated_at: new Date().toISOString(),
    };
    if (boardIdExplicitlyProvided) {
      patchData.board_id = options?.boardId;
    }

    const unarchivedWorktree = await this.patch(id, patchData, params);

    // Recreate the git worktree on filesystem if the directory is missing
    // (e.g., it was archived with filesystemAction: 'deleted')
    if (!existsSync(worktree.path)) {
      console.log(`📂 Worktree directory missing, spawning executor to recreate: ${worktree.path}`);

      // Set filesystem_status to 'creating' while we rebuild
      await this.patch(id, { filesystem_status: 'creating' }, { provider: undefined });

      // Look up repo to get local_path
      const reposService = this.app.service('repos');
      const repo = (await reposService.get(worktree.repo_id)) as Repo;

      const rbacEnabled = isWorktreeRbacEnabled();
      const { getDaemonUser } = await import('@agor/core/config');
      const daemonUser = getDaemonUser();

      // No user impersonation for infrastructure operations — the daemon user
      // owns all worktrees and impersonation would resolve getWorktreesDir()
      // to the wrong home directory, causing safety check failures.

      try {
        // Use a service JWT so the executor can patch rendered env command
        // templates without tripping requireAdminForEnvConfig when unarchive
        // is performed by a non-admin user.
        const sessionToken = generateSessionToken(
          this.app as unknown as { settings: { authentication?: { secret?: string } } }
        );
        spawnExecutor(
          {
            command: 'git.worktree.add',
            sessionToken,
            daemonUrl: getDaemonUrl(),
            params: {
              worktreeId: worktree.worktree_id,
              repoId: repo.repo_id,
              repoPath: repo.local_path,
              worktreeName: worktree.name,
              worktreePath: worktree.path,
              branch: worktree.ref,
              refType: worktree.ref_type || 'branch',
              // Use restore mode: checks if branch exists on remote via ls-remote,
              // checks out existing branch if found, otherwise creates new branch from base_ref.
              // This is safe because it only creates a new branch when ls-remote confirms
              // the branch doesn't exist on the remote (no risk of force-deleting existing branches).
              createBranch: false,
              restoreMode: true,
              sourceBranch: worktree.base_ref || repo.default_branch || 'main',
              // Unix group isolation
              initUnixGroup: rbacEnabled,
              othersAccess: worktree.others_fs_access || 'read',
              daemonUser,
              repoUnixGroup: repo.unix_group,
            },
          },
          {
            logPrefix: `[WorktreesService.unarchive ${worktree.name}]`,
          }
        );
      } catch (error) {
        console.error(
          `⚠️  Failed to spawn executor for worktree recreation:`,
          error instanceof Error ? error.message : String(error)
        );
        // Mark as failed so the UI can show the error state
        const errMsg = error instanceof Error ? error.message : String(error);
        await this.patch(
          id,
          { filesystem_status: 'failed', error_message: `Failed to spawn executor: ${errMsg}` },
          { provider: undefined }
        );
      }
    }

    // Ensure a board object exists when unarchiving to a board.
    // Older archived worktrees may have had their board object removed.
    if (targetBoardId) {
      const boardObjectsService = this.getBoardObjectsService();
      try {
        const existingObject = (await boardObjectsService.findByWorktreeId(id)) as {
          object_id: string;
        } | null;
        if (!existingObject) {
          const position = await this.computeDefaultBoardPositionForWorktree(
            targetBoardId,
            id,
            params
          );
          await boardObjectsService.create({
            board_id: targetBoardId,
            worktree_id: id,
            position,
          });
        }
      } catch (error) {
        console.error(
          `⚠️ Failed to restore board object for unarchived worktree ${id}:`,
          error instanceof Error ? error.message : String(error)
        );
      }
    }

    // Unarchive all sessions that were archived due to worktree archival
    // Use internal call (no provider) to bypass RBAC hooks that would ignore worktree_id filter
    const sessionsService = this.app.service('sessions');
    const sessionsResult = await sessionsService.find({
      query: {
        worktree_id: id,
        archived: true,
        archived_reason: 'worktree_archived',
        $limit: 1000,
      },
      paginate: false,
    });
    const sessions = Array.isArray(sessionsResult) ? sessionsResult : sessionsResult.data;

    for (const session of sessions) {
      await sessionsService.patch(
        session.session_id,
        {
          archived: false,
          archived_reason: undefined,
        },
        { provider: undefined } // Bypass RBAC - this is an internal cascade operation
      );
    }

    console.log(`✅ Unarchived worktree ${worktree.name} and ${sessions.length} session(s)`);
    return unarchivedWorktree;
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
  async addToBoard(
    id: WorktreeID,
    boardId: UUID,
    params?: WorktreeParams
  ): Promise<WorktreeWithZoneAndSessions> {
    // Set worktree.board_id (patch already enriches with zone info)
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

    return worktree;
  }

  /**
   * Custom method: Remove worktree from board
   *
   * Phase 0: Clears board_id on worktree
   * Phase 1: Will also remove board_object entry
   */
  async removeFromBoard(
    id: WorktreeID,
    params?: WorktreeParams
  ): Promise<WorktreeWithZoneAndSessions> {
    // Clear worktree.board_id (patch already enriches with zone info, but it will be empty now)
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

    return worktree;
  }

  /**
   * Custom method: Update environment status
   */
  async updateEnvironment(
    id: WorktreeID,
    environmentUpdate: Partial<Worktree['environment_instance']>,
    params?: WorktreeParams
  ): Promise<WorktreeWithZoneAndSessions> {
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
      const { timestamp, ...healthCheck } = oldState.last_health_check;
      oldState.last_health_check = healthCheck as typeof oldState.last_health_check;
    }
    if (newState?.last_health_check) {
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

    return worktree;
  }

  /**
   * Custom method: Start environment
   */
  async startEnvironment(
    id: WorktreeID,
    params?: WorktreeParams
  ): Promise<WorktreeWithZoneAndSessions> {
    await this.ensureCanTriggerEnv(params, 'start worktree environments');
    const worktree = await this.get(id, params);

    // Validate static start command exists
    if (!worktree.start_command) {
      throw new Error('No start command configured for this worktree');
    }

    // Check if already running
    if (worktree.environment_instance?.status === 'running') {
      throw new Error('Environment is already running');
    }

    // Set status to 'starting' and record start timestamp
    // Merge with existing process fields (e.g. pid from a failed stop) rather than replacing
    // Clear last_error from previous attempts
    await this.updateEnvironment(
      id,
      {
        status: 'starting',
        process: {
          ...worktree.environment_instance?.process,
          started_at: new Date().toISOString(),
        },
        last_health_check: undefined,
        last_error: undefined,
      },
      params
    );

    try {
      // Use static start_command (initialized from template at worktree creation)
      const command = worktree.start_command;

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
      // Use stdio: 'pipe' to capture output for error reporting
      const childProcess = await spawnEnvironmentCommand({
        command,
        worktree,
        db: this.db,
        commandType: 'start',
        stdio: 'pipe',
        triggeredBy: this.extractTriggeredBy(params),
      });

      // Collect stdout/stderr for error reporting (last ~100 lines)
      const outputChunks: string[] = [];
      const MAX_OUTPUT_LINES = 100;

      const collectOutput = (stream: NodeJS.ReadableStream | null, prefix?: string) => {
        if (!stream) return;
        stream.on('data', (chunk: Buffer) => {
          const text = chunk.toString();
          // Also forward to daemon console so logs aren't lost
          if (prefix) {
            process.stderr.write(text);
          } else {
            process.stdout.write(text);
          }
          outputChunks.push(text);
        });
      };
      collectOutput(childProcess.stdout);
      collectOutput(childProcess.stderr, 'stderr');

      await new Promise<void>((resolve, reject) => {
        childProcess.on('exit', (code: number | null) => {
          if (code === 0) {
            console.log(`✅ Start command completed successfully for ${worktree.name}`);
            resolve();
          } else {
            // Combine collected output and truncate to last ~100 lines
            const fullOutput = outputChunks.join('');
            const lines = fullOutput.split('\n');
            const truncated =
              lines.length > MAX_OUTPUT_LINES
                ? `... (truncated ${lines.length - MAX_OUTPUT_LINES} lines)\n${lines.slice(-MAX_OUTPUT_LINES).join('\n')}`
                : fullOutput;
            const output = truncated.trim();
            const err = new Error(`Start command exited with code ${code}`) as Error & {
              commandOutput?: string;
            };
            err.commandOutput = output || undefined;
            reject(err);
          }
        });

        childProcess.on('error', (error: Error) => reject(error));
      });

      // Use static app_url (initialized from template at worktree creation)
      let access_urls: Array<{ name: string; url: string }> | undefined;
      if (worktree.app_url) {
        access_urls = [{ name: 'App', url: worktree.app_url }];
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
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const commandOutput =
        error instanceof Error
          ? (error as Error & { commandOutput?: string }).commandOutput
          : undefined;

      // Store short message in last_health_check, full output in last_error
      await this.updateEnvironment(
        id,
        {
          status: 'error',
          last_health_check: {
            timestamp: new Date().toISOString(),
            status: 'unhealthy',
            message: errorMessage,
          },
          last_error: commandOutput || errorMessage,
        },
        params
      );

      throw error;
    }
  }

  /**
   * Custom method: Stop environment
   */
  async stopEnvironment(
    id: WorktreeID,
    params?: WorktreeParams
  ): Promise<WorktreeWithZoneAndSessions> {
    await this.ensureCanTriggerEnv(params, 'stop worktree environments');
    const worktree = await this.get(id, params);

    // Set status to 'stopping'
    await this.updateEnvironment(
      id,
      {
        status: 'stopping',
      },
      params
    );

    try {
      // Check if we have a static stop command
      if (worktree.stop_command) {
        // Use static stop_command (initialized from template at worktree creation)
        const command = worktree.stop_command;

        console.log(`🛑 Stopping environment for worktree ${worktree.name}: ${command}`);

        // Execute down command
        const stopProcess = await spawnEnvironmentCommand({
          command,
          worktree,
          db: this.db,
          commandType: 'stop',
          triggeredBy: this.extractTriggeredBy(params),
        });

        await new Promise<void>((resolve, reject) => {
          stopProcess.on('exit', (code: number | null) => {
            if (code === 0) {
              resolve();
            } else {
              reject(new Error(`Down command exited with code ${code}`));
            }
          });

          stopProcess.on('error', (error: Error) => reject(error));
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
  async restartEnvironment(
    id: WorktreeID,
    params?: WorktreeParams
  ): Promise<WorktreeWithZoneAndSessions> {
    const worktree = await this.get(id, params);

    // Stop if running
    if (worktree.environment_instance?.status === 'running') {
      await this.stopEnvironment(id, params);

      // Wait a bit for processes to clean up
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    // Start
    return await this.startEnvironment(id, params);
  }

  /**
   * Custom method: Nuke environment (destructive operation)
   */
  async nukeEnvironment(
    id: WorktreeID,
    params?: WorktreeParams
  ): Promise<WorktreeWithZoneAndSessions> {
    await this.ensureCanTriggerEnv(params, 'nuke worktree environments');
    const worktree = await this.get(id, params);

    // Require nuke_command to be configured
    if (!worktree.nuke_command) {
      throw new Error('No nuke_command configured for this worktree');
    }

    // Set status to 'stopping' (reuse stopping state for nuke)
    await this.updateEnvironment(
      id,
      {
        status: 'stopping',
      },
      params
    );

    try {
      const command = worktree.nuke_command;

      console.log(`💣 NUKING environment for worktree ${worktree.name}: ${command}`);
      console.warn('⚠️  This is a destructive operation!');

      // Execute nuke command
      const nukeProcess = await spawnEnvironmentCommand({
        command,
        worktree,
        db: this.db,
        commandType: 'nuke',
        triggeredBy: this.extractTriggeredBy(params),
      });

      await new Promise<void>((resolve, reject) => {
        nukeProcess.on('exit', (code: number | null) => {
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`Nuke command exited with code ${code}`));
          }
        });

        nukeProcess.on('error', (error: Error) => reject(error));
      });

      // Clean up any managed process references
      const managedProcess = this.processes.get(id);
      if (managedProcess) {
        this.processes.delete(id);
      }

      // Update status to 'stopped' with clear nuke message
      return await this.updateEnvironment(
        id,
        {
          status: 'stopped',
          process: undefined,
          last_health_check: {
            timestamp: new Date().toISOString(),
            status: 'unknown',
            message: 'Environment nuked - all data and volumes destroyed',
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
            message: error instanceof Error ? error.message : 'Unknown error during nuke',
          },
        },
        params
      );

      throw error;
    }
  }

  /**
   * Custom method: Check health
   */
  async checkHealth(id: WorktreeID, params?: WorktreeParams): Promise<WorktreeWithZoneAndSessions> {
    const worktree = await this.get(id, params);
    const _repo = (await this.app.service('repos').get(worktree.repo_id, params)) as Repo;

    // Only check health for 'running' or 'starting' status
    const currentStatus = worktree.environment_instance?.status;
    if (currentStatus !== 'running' && currentStatus !== 'starting') {
      return worktree;
    }

    // Check if we have a health check URL (static field, not template)
    if (!worktree.health_check_url) {
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

    // Use static health_check_url (initialized from template at worktree creation)
    const healthUrl = worktree.health_check_url;

    // Validate URL to prevent SSRF against cloud metadata or internal services
    if (!isAllowedHealthCheckUrl(healthUrl)) {
      console.warn(`⚠️ Blocked health check to disallowed URL: ${healthUrl}`);
      return await this.updateEnvironment(
        id,
        {
          last_health_check: {
            timestamp: new Date().toISOString(),
            status: 'unhealthy',
            message: 'Health check URL blocked by security policy',
          },
        },
        params
      );
    }

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
    await this.ensureCanTriggerEnv(params, 'fetch worktree environment logs');
    const worktree = await this.get(id, params);

    // Check if static logs command is configured
    if (!worktree.logs_command) {
      return {
        logs: '',
        timestamp: new Date().toISOString(),
        error: 'No logs command configured',
      };
    }

    try {
      // Use static logs_command (initialized from template at worktree creation)
      const command = worktree.logs_command;

      console.log(`📋 Fetching logs for worktree ${worktree.name}: ${command}`);

      // Execute command with timeout and output limits
      const childProcess = await spawnEnvironmentCommand({
        command,
        worktree,
        db: this.db,
        commandType: 'logs',
        stdio: 'pipe', // Need to capture output for logs
        triggeredBy: this.extractTriggeredBy(params),
      });

      const result = await new Promise<{
        stdout: string;
        stderr: string;
        truncated: boolean;
      }>((resolve, reject) => {
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

        childProcess.on('exit', (code: number | null) => {
          clearTimeout(timeout);
          if (code === 0 || stdout.length > 0) {
            resolve({ stdout, stderr, truncated });
          } else {
            reject(new Error(stderr || `Logs command exited with code ${code}`));
          }
        });

        childProcess.on('error', (error: Error) => {
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
   * Custom method: Re-render environment commands from the repo's v2
   * `environment` config and persist the result onto the worktree.
   *
   * When no `variant` is supplied, the repo's default variant is used.
   * Re-rendering with the currently-selected variant is allowed for any
   * trigger-capable role (see `execution.managed_envs_minimum_role`); changing
   * the variant requires admin since it replaces executable command strings
   * that run as the system user (same rationale as `requireAdminForEnvConfig`
   * in authorization.ts).
   *
   * Returns the updated worktree (with new `environment_variant`, `start_command`,
   * `stop_command`, etc).
   */
  async renderEnvironment(
    id: WorktreeID,
    data: { variant?: string } | undefined,
    params?: WorktreeParams
  ): Promise<WorktreeWithZoneAndSessions> {
    await this.ensureCanTriggerEnv(params, 'render worktree environment');

    const worktree = await this.get(id, params);
    const reposService = this.app.service('repos');
    const repo = (await reposService.get(worktree.repo_id, params)) as Repo;

    const env = repo.environment;
    if (!env) {
      throw new Error('Repo has no v2 environment config; nothing to render');
    }

    const requestedVariant = data?.variant ?? env.default;
    const currentVariant = worktree.environment_variant;

    // Variant change (including first-time assignment against an existing
    // worktree) replaces executable commands → require admin.
    if (requestedVariant !== currentVariant) {
      ensureMinimumRole(
        params,
        ROLES.ADMIN,
        `change worktree environment variant to "${requestedVariant}"`
      );
    }

    // Resolve host IP + unix GID (matches executor's renderEnvironmentTemplates).
    const config = await loadConfig();
    const hostIpAddress = resolveHostIpAddress(config.daemon?.host_ip_address);
    const unixGid = worktree.unix_group ? getGidFromGroupName(worktree.unix_group) : undefined;

    const snapshot = renderWorktreeSnapshot(
      { slug: repo.slug, environment: env },
      {
        worktree_unique_id: worktree.worktree_unique_id,
        name: worktree.name,
        path: worktree.path,
        custom_context: worktree.custom_context,
        unix_gid: unixGid,
        host_ip_address: hostIpAddress,
      },
      requestedVariant
    );
    if (!snapshot) {
      // Should be unreachable: env is non-null and renderWorktreeSnapshot only
      // returns null when env is absent. Defensive throw keeps types honest.
      throw new Error('Failed to render environment snapshot');
    }

    return await this.patch(
      id,
      {
        environment_variant: snapshot.variant,
        start_command: snapshot.start || undefined,
        stop_command: snapshot.stop || undefined,
        nuke_command: snapshot.nuke,
        logs_command: snapshot.logs,
        health_check_url: snapshot.health,
        app_url: snapshot.app,
        updated_at: new Date().toISOString(),
      },
      params
    );
  }
}

/**
 * Service factory function
 */
export function createWorktreesService(db: Database, app: Application): WorktreesService {
  return new WorktreesService(db, app);
}
