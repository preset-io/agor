/**
 * Branches Service
 *
 * Provides REST + WebSocket API for branch management.
 * Uses DrizzleService adapter with BranchRepository.
 */

import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { analyticsLogger } from '@agor/core/analytics';
import { ENVIRONMENT, isBranchRbacEnabled, loadConfig, PAGINATION } from '@agor/core/config';
import {
  BoardRepository,
  BranchRepository,
  type BranchWithZoneAndSessions,
  type Database,
} from '@agor/core/db';
import { renderBranchSnapshot } from '@agor/core/environment/render-snapshot';
import {
  MANAGED_ENV_EXECUTION_MODE_DEFAULT,
  type ManagedEnvCommandType,
  type ManagedEnvExecutionMode,
  redactManagedEnvWebhookUrlForAudit,
  resolveManagedEnvCommandExecution,
  validateManagedEnvLifecyclePolicy,
  validateRenderedManagedEnvUrlFields,
} from '@agor/core/environment/webhook';
import { type Application, BadRequest, Forbidden, NotAuthenticated } from '@agor/core/feathers';
import { stripGitUrlCredentials } from '@agor/core/git';
import type {
  AuthenticatedParams,
  BoardID,
  Branch,
  BranchID,
  QueryParams,
  Repo,
  UserID,
  UUID,
} from '@agor/core/types';
import { isAssistant, ROLES } from '@agor/core/types';
import { getGidFromGroupName, spawnEnvironmentCommand } from '@agor/core/unix';
import { resolveHostIpAddress } from '@agor/core/utils/host-ip';
import { isAllowedHealthCheckUrl } from '@agor/core/utils/url';
import { DrizzleService } from '../adapters/drizzle';
import { buildBranchCreatedAnalyticsProperties } from '../utils/analytics-payloads.js';
import { ensureCanTriggerManagedEnv, ensureMinimumRole } from '../utils/authorization.js';
import { shouldUseCloneReferencePath } from '../utils/clone-reference.js';
import { resolveGitImpersonationForBranch } from '../utils/git-impersonation.js';
import { parseLastMessageTruncationLength } from '../utils/query-params.js';
import { generateSessionToken, getDaemonUrl, spawnExecutor } from '../utils/spawn-executor.js';
import type { InternalEnrichmentParams } from './sessions';

/**
 * Branch service params
 */
export type BranchParams = QueryParams<{
  branch_id?: BranchID | { $in?: BranchID[] };
  repo_id?: UUID;
  name?: string;
  ref?: string;
  zone_id?: string; // Virtual filter: board_objects.data.zone_id, handled before pagination
  deleteFromFilesystem?: boolean;
  include_sessions?: boolean | 'true' | 'false'; // Opt-in session activity enrichment
  last_message_truncation_length?: number; // Default: 500 chars, min: 50, max: 10000
}> &
  InternalEnrichmentParams & {
    /** Root-level include_sessions flag (bypasses Feathers query filtering, used by internal service calls) */
    _include_sessions?: boolean | 'true' | 'false';
  };

/**
 * Process tracking for environment management
 */
interface ManagedProcess {
  process: ChildProcess;
  pid: number;
  branchId: BranchID;
  startedAt: Date;
  logPath: string;
}

/**
 * Extended branches service with custom methods
 */
export class BranchesService extends DrizzleService<Branch, Partial<Branch>, BranchParams> {
  private branchRepo: BranchRepository;
  private boardRepo: BoardRepository;
  private db: Database;
  private app: Application;
  private processes = new Map<BranchID, ManagedProcess>();
  // Cache board-objects service reference (lazy-loaded to avoid circular deps)
  private boardObjectsService?: {
    find: (params?: unknown) => Promise<unknown>;
    findByBranchId: (branchId: BranchID) => Promise<{ object_id: string; zone_id?: string } | null>;
    create: (data: unknown) => Promise<unknown>;
    remove: (id: string) => Promise<unknown>;
    patch: (id: string, data: { zone_id?: string | null }) => Promise<unknown>;
  };

  constructor(db: Database, app: Application) {
    const branchRepo = new BranchRepository(db);
    super(branchRepo, {
      id: 'branch_id',
      resourceType: 'Branch',
      paginate: {
        default: PAGINATION.DEFAULT_LIMIT,
        max: PAGINATION.MAX_LIMIT,
      },
    });

    this.branchRepo = branchRepo;
    this.boardRepo = new BoardRepository(db);
    this.db = db;
    this.app = app;
  }

  /**
   * Enforce `execution.managed_envs_minimum_role` on env command triggers.
   * Canonical enforcement point — runs for REST, WebSocket, *and* MCP callers
   * since all trigger paths reach this service class.
   */
  private async ensureCanTriggerEnv(
    params: BranchParams | undefined,
    action: string
  ): Promise<void> {
    const config = await loadConfig();
    ensureCanTriggerManagedEnv(config.execution?.managed_envs_minimum_role, params, action);
  }

  private async getManagedEnvExecutionMode(): Promise<ManagedEnvExecutionMode> {
    const config = await loadConfig();
    return config.execution?.managed_envs_execution_mode ?? MANAGED_ENV_EXECUTION_MODE_DEFAULT;
  }

  private async resolveEnvironmentCommand(command: string, commandType: ManagedEnvCommandType) {
    return resolveManagedEnvCommandExecution(
      command,
      await this.getManagedEnvExecutionMode(),
      commandType
    );
  }

  private async validateRenderedEnvironmentActions(snapshot: {
    start?: string;
    stop?: string;
    nuke?: string;
    logs?: string;
  }): Promise<void> {
    const mode = await this.getManagedEnvExecutionMode();
    validateManagedEnvLifecyclePolicy(
      {
        start: snapshot.start,
        stop: snapshot.stop,
        nuke: snapshot.nuke,
        logs: snapshot.logs,
      },
      mode,
      'rendered branch environment'
    );
  }

  private async executeEnvironmentWebhook(options: {
    url: string;
    branch: Branch;
    commandType: ManagedEnvCommandType;
    triggeredBy?: { user_id?: string; email?: string };
    maxBytes?: number;
  }): Promise<{ body: string; truncated: boolean; status: number }> {
    const {
      url,
      branch,
      commandType,
      triggeredBy,
      maxBytes = ENVIRONMENT.LOGS_MAX_BYTES,
    } = options;
    const redactedUrl = redactManagedEnvWebhookUrlForAudit(url);

    console.log(
      `🔗 Calling environment ${commandType} webhook for branch ${branch.name}: ${redactedUrl}`
    );
    console.log(
      `AUDIT ${JSON.stringify({
        event: 'agor.env_webhook.get',
        timestamp: new Date().toISOString(),
        branch_id: branch.branch_id,
        branch_name: branch.name,
        command_type: commandType,
        url: redactedUrl,
        triggered_by_user_id: triggeredBy?.user_id,
        triggered_by_email: triggeredBy?.email,
      })}`
    );

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ENVIRONMENT.LOGS_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'User-Agent': 'Agor managed-environment webhook',
        },
      });

      const { body, truncated } = await this.readLimitedWebhookBody(response, maxBytes);

      if (!response.ok) {
        throw new Error(`Environment ${commandType} webhook returned HTTP ${response.status}`);
      }

      return { body, truncated, status: response.status };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(
          `Environment ${commandType} webhook timed out after ${ENVIRONMENT.LOGS_TIMEOUT_MS / 1000}s`
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async readLimitedWebhookBody(
    response: Response,
    maxBytes: number
  ): Promise<{ body: string; truncated: boolean }> {
    const reader = response.body?.getReader();
    if (!reader) return { body: '', truncated: false };

    const chunks: Uint8Array[] = [];
    let total = 0;
    let truncated = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      const remaining = maxBytes - total;
      if (remaining <= 0) {
        truncated = true;
        await reader.cancel();
        break;
      }

      if (value.byteLength <= remaining) {
        chunks.push(value);
        total += value.byteLength;
      } else {
        chunks.push(value.slice(0, remaining));
        total += remaining;
        truncated = true;
        await reader.cancel();
        break;
      }
    }

    return {
      body: Buffer.concat(chunks, total).toString('utf8'),
      truncated,
    };
  }

  /**
   * Extract caller identity for audit logging. Internal/daemon-initiated
   * calls (no params.provider, no user) return undefined which the audit
   * entry records explicitly.
   */
  private extractTriggeredBy(
    params: BranchParams | undefined
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
        findByBranchId: (
          branchId: BranchID
        ) => Promise<{ object_id: string; zone_id?: string } | null>;
        create: (data: unknown) => Promise<unknown>;
        remove: (id: string) => Promise<unknown>;
        patch: (id: string, data: { zone_id?: string | null }) => Promise<unknown>;
      };
    }
    return this.boardObjectsService;
  }

  /**
   * Compute a smart default position for a branch on a board, based on existing entities/zones.
   * Falls back to a small jitter near origin if placement utilities fail.
   */
  private async computeDefaultBoardPositionForBranch(
    boardId: BoardID,
    currentBranchId: BranchID,
    params?: BranchParams
  ): Promise<{ x: number; y: number }> {
    try {
      const boardObjectsService = this.getBoardObjectsService();
      const board = (await this.app.service('boards').get(boardId, params)) as {
        objects?: Record<string, { type?: string }>;
      };

      const existingResult = (await boardObjectsService.find({
        query: { board_id: boardId },
        ...params,
      })) as { data: Array<{ branch_id?: string | null; position: { x: number; y: number } }> };

      const activeBranchesResult = await this.app.service('branches').find({
        query: { board_id: boardId, archived: false, $limit: 5000 },
        paginate: false,
      });
      const activeBranches = Array.isArray(activeBranchesResult)
        ? activeBranchesResult
        : (activeBranchesResult as { data: Array<{ branch_id: string }> }).data;
      const activeBranchIds = new Set(activeBranches.map((wt) => wt.branch_id));

      const activeEntities = existingResult.data.filter((obj) => {
        if (!obj.branch_id) return true;
        if (obj.branch_id === currentBranchId) return false;
        return activeBranchIds.has(obj.branch_id);
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
        `⚠️ Failed smart board placement for branch ${currentBranchId}:`,
        error instanceof Error ? error.message : String(error)
      );
      return { x: 100 + Math.random() * 200, y: 100 + Math.random() * 200 };
    }
  }

  /**
   * Apply config-driven defaults before insert.
   *
   * Reads `branches.others_can_default` and `branches.others_fs_access_default`
   * so admins can set org-wide defaults in config.yaml. Explicit values on the
   * input always win; defaults fill in only when the caller omits the field.
   */
  private async applyBranchCreateDefaults(data: Partial<Branch>): Promise<Partial<Branch>> {
    const config = await loadConfig();
    const defaults = config.branches;
    if (!defaults) return data;

    const withDefaults: Partial<Branch> = { ...data };
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
   * Custom method: Initialize Unix group for a branch (daemon-side privileged operation).
   *
   * Called by the executor via Feathers RPC after creating the git branch on
   * disk, so that groupadd/chgrp/setfacl run with daemon sudo privileges
   * regardless of executor impersonation mode.
   *
   * Auth: only service accounts (executor JWTs) may invoke this externally.
   * Internal calls (no `provider`) pass through.
   */
  async initializeUnixGroup(
    data: { branchId: string; othersAccess?: 'none' | 'read' | 'write' },
    params?: BranchParams
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

    const { initializeBranchUnixGroup } = await import('../utils/unix-group-init.js');
    const unixGroup = await initializeBranchUnixGroup(
      this.db,
      this.app,
      data.branchId,
      data.othersAccess || 'read'
    );
    return { unixGroup };
  }

  /**
   * Override create to inject config-driven branch defaults.
   */
  async create(
    data: Partial<Branch> | Partial<Branch>[],
    params?: BranchParams
  ): Promise<Branch | Branch[]> {
    if (Array.isArray(data)) {
      const withDefaults = await Promise.all(
        data.map((item) => this.applyBranchCreateDefaults(item))
      );
      const created = (await super.create(withDefaults, params)) as Branch[];
      await Promise.all(created.map((branch) => this.maybeSetBoardPrimaryAssistant(branch)));
      for (const branch of created) {
        this.trackBranchCreated(branch);
      }
      return created;
    }
    const withDefaults = await this.applyBranchCreateDefaults(data);
    const created = (await super.create(withDefaults, params)) as Branch;
    await this.maybeSetBoardPrimaryAssistant(created);
    this.trackBranchCreated(created);
    return created;
  }

  private trackBranchCreated(branch: Branch): void {
    analyticsLogger.track('branch.created', buildBranchCreatedAnalyticsProperties(branch), {
      userId: branch.created_by,
    });
  }

  private async maybeSetBoardPrimaryAssistant(branch: Branch): Promise<void> {
    if (!branch.board_id || !isAssistant(branch)) return;

    try {
      const updatedBoard = await this.boardRepo.setPrimaryAssistantIfUnset(
        branch.board_id,
        branch.branch_id
      );
      if (updatedBoard) {
        this.app.service('boards').emit('patched', updatedBoard);
      }
    } catch (error) {
      console.warn(
        `⚠️ Failed to set primary assistant for board ${branch.board_id}:`,
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  private isPlainObject(value: unknown): value is Record<string, unknown> {
    return (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      !(value instanceof Date) &&
      Object.getPrototypeOf(value) === Object.prototype
    );
  }

  /**
   * Mirrors BranchRepository's patch merge semantics so we can reject
   * assistant/non-assistant conversions before the repository writes them.
   */
  private mergePatchPreview(
    target: Record<string, unknown>,
    source: Record<string, unknown>
  ): Record<string, unknown> {
    const result = { ...target };

    for (const key in source) {
      if (!Object.hasOwn(source, key)) continue;

      const sourceValue = source[key];
      const targetValue = target[key];

      if (sourceValue === undefined) continue;
      if (sourceValue === null || Array.isArray(sourceValue)) {
        result[key] = sourceValue;
        continue;
      }

      if (this.isPlainObject(sourceValue) && this.isPlainObject(targetValue)) {
        result[key] = this.mergePatchPreview(targetValue, sourceValue);
        continue;
      }

      result[key] = sourceValue;
    }

    return result;
  }

  private assertAssistantKindIsStable(currentBranch: Branch, patchData: Partial<Branch>): void {
    const wouldBeBranch = this.mergePatchPreview(
      currentBranch as unknown as Record<string, unknown>,
      patchData as Record<string, unknown>
    ) as unknown as Branch;
    if (isAssistant(currentBranch) === isAssistant(wouldBeBranch)) return;

    throw new BadRequest(
      'Branches cannot be converted between assistant and non-assistant types. Create a new branch or assistant instead.'
    );
  }

  private async maintainPrimaryAssistantAfterPatch(
    previousBranch: Branch,
    updatedBranch: Branch
  ): Promise<void> {
    const oldBoardId = previousBranch.board_id;
    const newBoardId = updatedBranch.board_id;
    const wasAssistant = isAssistant(previousBranch);
    const isNowAssistant = isAssistant(updatedBranch);

    const shouldClearOldPrimary = Boolean(
      oldBoardId &&
        wasAssistant &&
        (oldBoardId !== newBoardId || !isNowAssistant || updatedBranch.archived === true)
    );

    const shouldSetNewPrimary = Boolean(
      newBoardId &&
        isNowAssistant &&
        updatedBranch.archived !== true &&
        (oldBoardId !== newBoardId || previousBranch.archived === true)
    );

    if (!shouldClearOldPrimary && !shouldSetNewPrimary) return;

    try {
      if (shouldClearOldPrimary) {
        const updatedOldBoard = await this.boardRepo.clearPrimaryAssistantIfMatches(
          oldBoardId!,
          previousBranch.branch_id
        );
        if (updatedOldBoard) {
          this.app.service('boards').emit('patched', updatedOldBoard);
        }
      }

      if (shouldSetNewPrimary) {
        const updatedNewBoard = await this.boardRepo.setPrimaryAssistantIfUnset(
          newBoardId!,
          updatedBranch.branch_id
        );
        if (updatedNewBoard) {
          this.app.service('boards').emit('patched', updatedNewBoard);
        }
      }
    } catch (error) {
      console.warn(
        `⚠️ Failed to maintain primary assistant pointer for branch ${updatedBranch.branch_id}:`,
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  /**
   * Override patch to handle board_objects when board_id changes.
   *
   * Schedule config lives on the `schedules` table now (see
   * docs/internal/schedules-first-class-design-2026-05-24.md); patches
   * to schedule fields go through the `schedules` service, not here.
   */
  async patch(
    id: BranchID,
    data: Partial<Branch>,
    params?: BranchParams
  ): Promise<BranchWithZoneAndSessions> {
    // Get current branch to check type/board changes
    const currentBranch = await super.get(id, params);
    this.assertAssistantKindIsStable(currentBranch, data);

    const oldBoardId = currentBranch.board_id;
    const boardIdProvided = Object.hasOwn(data, 'board_id');
    const newBoardId = data.board_id;

    // Call parent patch
    const updatedBranch = (await super.patch(id, data, params)) as Branch;
    await this.maintainPrimaryAssistantAfterPatch(currentBranch, updatedBranch);

    // Handle board_objects changes if board_id changed
    if (!boardIdProvided) {
      const withZone = await this.branchRepo.enrichWithZoneInfo(updatedBranch);

      // Only enrich with session activity if explicitly requested
      if (params?.query?.include_sessions === true || params?.query?.include_sessions === 'true') {
        const truncationLength = parseLastMessageTruncationLength(
          params?.query?.last_message_truncation_length
        );
        return this.branchRepo.enrichWithSessionActivity(withZone, truncationLength);
      }

      return withZone as BranchWithZoneAndSessions;
    }

    if (oldBoardId !== newBoardId) {
      const boardObjectsService = this.getBoardObjectsService();

      try {
        // First, check if a board_object already exists
        const existingObject = (await boardObjectsService.findByBranchId(id)) as {
          object_id: string;
        } | null;

        if (existingObject) {
          // Board object exists - delete it first
          await boardObjectsService.remove(existingObject.object_id);
        }

        // Now create new board_object if board_id is set
        if (newBoardId) {
          const position = await this.computeDefaultBoardPositionForBranch(newBoardId, id, params);
          await boardObjectsService.create({
            board_id: newBoardId,
            branch_id: id,
            position,
          });
        }
      } catch (error) {
        console.error(
          `❌ Failed to manage board_objects for branch ${id}:`,
          error instanceof Error ? error.message : String(error)
        );
        // Don't throw - allow branch patch to succeed even if board_object management fails
      }
    }

    const withZone = await this.branchRepo.enrichWithZoneInfo(updatedBranch);

    // Only enrich with session activity if explicitly requested
    if (params?.query?.include_sessions === true || params?.query?.include_sessions === 'true') {
      const truncationLength = parseLastMessageTruncationLength(
        params?.query?.last_message_truncation_length
      );
      return this.branchRepo.enrichWithSessionActivity(withZone, truncationLength);
    }

    return withZone as BranchWithZoneAndSessions;
  }

  /**
   * Override get to enrich with zone information
   *
   * Session activity enrichment is opt-in via include_sessions query parameter
   */
  async get(id: BranchID, params?: BranchParams): Promise<BranchWithZoneAndSessions> {
    // Check both query params and root-level params (root-level bypasses Feathers query filtering)
    const includeSessionsQuery = params?.query?.include_sessions;
    const includeSessionsRoot = params?._include_sessions;
    const includeSessions = includeSessionsRoot ?? includeSessionsQuery;

    const branch = await super.get(id, params);
    const withZone = await this.branchRepo.enrichWithZoneInfo(branch as Branch);

    // Only enrich with session activity if explicitly requested
    if (includeSessions === true || includeSessions === 'true') {
      const truncationLengthQuery = params?.query?.last_message_truncation_length;
      const truncationLengthRoot = params?._last_message_truncation_length;
      const truncationLength = parseLastMessageTruncationLength(
        truncationLengthRoot ?? truncationLengthQuery
      );
      const result = await this.branchRepo.enrichWithSessionActivity(withZone, truncationLength);
      return result;
    }

    return withZone as BranchWithZoneAndSessions;
  }

  /**
   * Override find to enrich with zone information only
   *
   * Note: Session activity is NOT included in list operations - only on single GET
   *
   * `zone_id` is a virtual query parameter backed by board_objects.data.zone_id.
   * Resolve it to a branch_id filter before delegating to DrizzleService so
   * pagination is applied to the zone-filtered result set, while preserving any
   * existing branch_id scoping injected by RBAC hooks.
   */
  async find(params?: BranchParams) {
    const zoneId = params?.query?.zone_id;
    let findParams = params;

    if (zoneId) {
      const branchIdsInZone = await this.branchRepo.findBranchIdsByZone(zoneId);
      const existingBranchFilter = params?.query?.branch_id;
      let filteredBranchIds = branchIdsInZone;

      if (typeof existingBranchFilter === 'string') {
        filteredBranchIds = branchIdsInZone.includes(existingBranchFilter as BranchID)
          ? [existingBranchFilter as BranchID]
          : [];
      } else if (
        existingBranchFilter &&
        typeof existingBranchFilter === 'object' &&
        Array.isArray(existingBranchFilter.$in)
      ) {
        const allowed = new Set(existingBranchFilter.$in);
        filteredBranchIds = branchIdsInZone.filter((branchId) => allowed.has(branchId));
      }

      const { zone_id: _zoneId, ...queryWithoutZone } = params?.query ?? {};
      findParams = {
        ...params,
        query: {
          ...queryWithoutZone,
          branch_id: { $in: filteredBranchIds },
        },
      } as BranchParams;
    }

    // Use default find to ensure all hooks and scoping are applied (including repo_id filter)
    const result = await super.find(findParams);

    // Handle both paginated and non-paginated results
    if (Array.isArray(result)) {
      return this.branchRepo.enrichManyWithZoneInfo(result as Branch[]);
    } else {
      const enriched = await this.branchRepo.enrichManyWithZoneInfo(result.data as Branch[]);
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
  async remove(id: BranchID, params?: BranchParams): Promise<Branch> {
    const { deleteFromFilesystem } = params?.query || {};

    // Get branch details before deletion
    const branch = await this.get(id, params);

    // Remove from database FIRST for instant UI feedback
    // CASCADE will clean up related comments automatically
    const result = await super.remove(id, params);

    // Then remove from filesystem via executor (fire-and-forget)
    // Executor handles its own logging and error reporting via Feathers
    if (deleteFromFilesystem) {
      console.log(`🗑️  Spawning executor to remove branch from filesystem: ${branch.path}`);

      // Resolve Unix user for sudo wrap. Returns undefined in simple/no-RBAC
      // mode so we don't try to sudo on hosts without passwordless sudoers
      // (#1140 root cause; #1143 fixed the branch-remove sister bug by
      // centralizing the gate inside the resolver itself).
      const asUser = await resolveGitImpersonationForBranch(this.db, branch);

      // Generate session token for executor authentication. Hook chain
      // enforces auth before we get here, so non-null assertion is safe.
      const userId = (params as AuthenticatedParams).user!.user_id as UserID;
      const appWithToken = this.app as unknown as {
        sessionTokenService?: import('../services/session-token-service').SessionTokenService;
      };

      // Generate token and spawn executor (fire-and-forget)
      appWithToken.sessionTokenService
        ?.generateToken('branch-remove', userId)
        .then((sessionToken) => {
          spawnExecutor(
            {
              command: 'git.branch.remove',
              sessionToken,
              daemonUrl: getDaemonUrl(),
              params: {
                branchId: branch.branch_id,
                branchPath: branch.path,
                deleteDbRecord: false, // Already deleted above
                // Clean up the branch if it was created by Agor
                branch: branch.ref,
                deleteBranch: branch.new_branch,
                // Branch storage mode — executor needs this to pick the right
                // teardown path (clone-mode just rm -rf; worktree-mode also
                // runs `git worktree remove --force` against the base repo).
                storageMode: branch.storage_mode ?? 'worktree',
              },
            },
            {
              logPrefix: `[BranchesService.remove ${branch.name}]`,
              asUser, // Run as resolved user (fresh groups via sudo -u)
            }
          );
        })
        .catch((error) => {
          console.error(
            `⚠️  Failed to generate session token for branch removal:`,
            error instanceof Error ? error.message : String(error)
          );
        });
    }

    return result as Branch;
  }

  /**
   * Custom method: Archive or delete branch with filesystem options
   *
   * This method implements the archive/delete modal functionality.
   * Supports both soft delete (archive) and hard delete, with granular filesystem control.
   *
   * @param id - Branch ID
   * @param options - Archive/delete configuration
   * @param params - Query params
   */
  async archiveOrDelete(
    id: BranchID,
    options: {
      metadataAction: 'archive' | 'delete';
      filesystemAction: 'preserved' | 'cleaned' | 'deleted';
    },
    params?: BranchParams
  ): Promise<BranchWithZoneAndSessions | { deleted: true; branch_id: BranchID }> {
    const { metadataAction, filesystemAction } = options;
    const branch = await this.get(id, params);
    // Hook chain enforces auth before we get here.
    const currentUserId = (params as AuthenticatedParams).user!.user_id as UUID;

    // Stop environment if running
    if (branch.environment_instance?.status === 'running') {
      console.log(`⚠️  Stopping environment for branch ${branch.name} before ${metadataAction}`);
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
      console.log(`🧹 Spawning executor to clean branch filesystem: ${branch.path}`);

      // No user impersonation for infrastructure operations — the daemon user
      // owns all branches and impersonation would resolve getBranchesDir()
      // to the wrong home directory, causing safety check failures.

      appWithToken.sessionTokenService
        ?.generateToken('branch-clean', userId ?? currentUserId)
        .then((sessionToken) => {
          spawnExecutor(
            {
              command: 'git.branch.clean',
              sessionToken,
              daemonUrl: getDaemonUrl(),
              params: {
                branchPath: branch.path,
              },
            },
            {
              logPrefix: `[BranchesService.clean ${branch.name}]`,
            }
          );
        })
        .catch((error) => {
          console.error(
            `⚠️  Failed to generate session token for branch cleaning:`,
            error instanceof Error ? error.message : String(error)
          );
        });
    } else if (filesystemAction === 'deleted') {
      console.log(`🗑️  Spawning executor to delete branch from filesystem: ${branch.path}`);

      // No user impersonation for infrastructure operations — the daemon user
      // owns all branches and impersonation would resolve getBranchesDir()
      // to the wrong home directory, causing safety check failures.

      appWithToken.sessionTokenService
        ?.generateToken('branch-delete', userId ?? currentUserId)
        .then((sessionToken) => {
          spawnExecutor(
            {
              command: 'git.branch.remove',
              sessionToken,
              daemonUrl: getDaemonUrl(),
              params: {
                branchId: branch.branch_id,
                branchPath: branch.path,
                deleteDbRecord: false, // Daemon handles DB deletion separately
                // Clean up the branch if it was created by Agor
                branch: branch.ref,
                deleteBranch: branch.new_branch,
                // Branch storage mode — see sibling call site comment in
                // `BranchesService.remove` above for why this matters.
                storageMode: branch.storage_mode ?? 'worktree',
              },
            },
            {
              logPrefix: `[BranchesService.delete ${branch.name}]`,
            }
          );
        })
        .catch((error) => {
          console.error(
            `⚠️  Failed to generate session token for branch deletion:`,
            error instanceof Error ? error.message : String(error)
          );
        });
    }

    // Metadata action: archive or delete
    if (metadataAction === 'archive') {
      // Archive: Soft delete branch and cascade to sessions
      console.log(`📦 Archiving branch: ${branch.name} (filesystem: ${filesystemAction})`);

      // Update branch
      const archivedBranch = await this.patch(
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

      // Archive all sessions in this branch
      // Use internal call (no provider) to bypass RBAC hooks that would ignore branch_id filter
      const sessionsService = this.app.service('sessions');
      const sessionsResult = await sessionsService.find({
        query: { branch_id: id, $limit: 1000 },
        paginate: false,
      });
      const sessions = Array.isArray(sessionsResult) ? sessionsResult : sessionsResult.data;

      for (const session of sessions) {
        await sessionsService.patch(
          session.session_id,
          {
            archived: true,
            archived_reason: 'branch_archived',
          },
          { provider: undefined } // Bypass RBAC - this is an internal cascade operation
        );
      }

      console.log(`✅ Archived branch ${branch.name} and ${sessions.length} session(s)`);

      // Clear zone_id on the board entity so archived branches don't move with zones
      const boardObjectsService = this.getBoardObjectsService();
      const boardEntity = await boardObjectsService.findByBranchId(id);
      if (boardEntity?.zone_id) {
        await boardObjectsService.patch(boardEntity.object_id, { zone_id: null });
      }

      return archivedBranch;
    } else {
      // Delete: Hard delete (CASCADE will remove sessions, messages, tasks)
      console.log(`🗑️  Permanently deleting branch: ${branch.name}`);

      await this.remove(id, params);

      console.log(`✅ Permanently deleted branch ${branch.name}`);
      return { deleted: true, branch_id: id };
    }
  }

  /**
   * Custom method: Unarchive a branch
   */
  async unarchive(
    id: BranchID,
    options?: { boardId?: BoardID },
    params?: BranchParams
  ): Promise<BranchWithZoneAndSessions> {
    const branch = await this.get(id, params);

    if (!branch.archived) {
      throw new Error(`Branch ${branch.name} is not archived`);
    }

    console.log(`📦 Unarchiving branch: ${branch.name}`);

    const boardIdExplicitlyProvided = options !== undefined && 'boardId' in options;
    const targetBoardId = boardIdExplicitlyProvided ? options?.boardId : branch.board_id;

    // Update branch - clear archive metadata
    const patchData: Partial<Branch> = {
      archived: false,
      archived_at: undefined,
      archived_by: undefined,
      filesystem_status: undefined,
      updated_at: new Date().toISOString(),
    };
    if (boardIdExplicitlyProvided) {
      patchData.board_id = options?.boardId;
    }

    const unarchivedBranch = await this.patch(id, patchData, params);

    // Recreate the git branch on filesystem if the directory is missing
    // (e.g., it was archived with filesystemAction: 'deleted')
    if (!existsSync(branch.path)) {
      console.log(`📂 Branch directory missing, spawning executor to recreate: ${branch.path}`);

      // Set filesystem_status to 'creating' while we rebuild
      await this.patch(id, { filesystem_status: 'creating' }, { provider: undefined });

      // Look up repo to get local_path
      const reposService = this.app.service('repos');
      const repo = (await reposService.get(branch.repo_id)) as Repo;

      const rbacEnabled = isBranchRbacEnabled();
      const { getDaemonUser } = await import('@agor/core/config');
      const daemonUser = getDaemonUser();

      // No user impersonation for infrastructure operations — the daemon user
      // owns all branches and impersonation would resolve getBranchesDir()
      // to the wrong home directory, causing safety check failures.

      // Mirror the create path's storage-mode forwarding. Without this, a
      // clone-mode branch that was archived with filesystemAction='deleted'
      // would silently rebuild as native worktree mode, leaving the DB row
      // (storage_mode='clone') and disk (.git pointer file) inconsistent.
      const storageMode = branch.storage_mode ?? 'worktree';
      if (storageMode === 'clone' && !repo.remote_url) {
        const errMsg =
          `Cannot unarchive clone-mode branch '${branch.name}' for repo '${repo.slug}': ` +
          `repo has no remote_url. The clone source URL is unknown.`;
        console.error(`⚠️  ${errMsg}`);
        await this.patch(
          id,
          { filesystem_status: 'failed', error_message: errMsg },
          { provider: undefined }
        );
        return unarchivedBranch;
      }
      const safeRemoteUrl = repo.remote_url ? stripGitUrlCredentials(repo.remote_url) : undefined;

      try {
        // Use a service JWT so the executor can patch rendered env command
        // templates without tripping requireAdminForEnvConfig when unarchive
        // is performed by a non-admin user.
        const sessionToken = generateSessionToken(
          this.app as unknown as { settings: { authentication?: { secret?: string } } }
        );
        spawnExecutor(
          {
            command: 'git.branch.add',
            sessionToken,
            daemonUrl: getDaemonUrl(),
            params: {
              branchId: branch.branch_id,
              repoId: repo.repo_id,
              repoPath: repo.local_path,
              branchName: branch.name,
              branchPath: branch.path,
              branch: branch.ref,
              refType: branch.ref_type || 'branch',
              // Use restore mode: checks if branch exists on remote via ls-remote,
              // checks out existing branch if found, otherwise creates new branch from base_ref.
              // This is safe because it only creates a new branch when ls-remote confirms
              // the branch doesn't exist on the remote (no risk of force-deleting existing branches).
              createBranch: false,
              restoreMode: true,
              sourceBranch: branch.base_ref || repo.default_branch || 'main',
              // Unix group isolation
              initUnixGroup: rbacEnabled,
              othersAccess: branch.others_fs_access || 'read',
              daemonUser,
              repoUnixGroup: repo.unix_group,
              // Branch storage mode — preserves the branch's original
              // storage_mode across archive → delete → unarchive.
              storageMode,
              ...(branch.clone_depth !== undefined ? { cloneDepth: branch.clone_depth } : {}),
              ...(storageMode === 'clone' && safeRemoteUrl ? { remoteUrl: safeRemoteUrl } : {}),
              // `--reference` hint: see the create-path call site in
              // ReposService.createBranch for the rationale and strict-mode
              // exception.
              ...(storageMode === 'clone' && repo.local_path && shouldUseCloneReferencePath()
                ? { referencePath: repo.local_path }
                : {}),
            },
          },
          {
            logPrefix: `[BranchesService.unarchive ${branch.name}]`,
          }
        );
      } catch (error) {
        console.error(
          `⚠️  Failed to spawn executor for branch recreation:`,
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
    // Older archived branches may have had their board object removed.
    if (targetBoardId) {
      const boardObjectsService = this.getBoardObjectsService();
      try {
        const existingObject = (await boardObjectsService.findByBranchId(id)) as {
          object_id: string;
        } | null;
        if (!existingObject) {
          const position = await this.computeDefaultBoardPositionForBranch(
            targetBoardId,
            id,
            params
          );
          await boardObjectsService.create({
            board_id: targetBoardId,
            branch_id: id,
            position,
          });
        }
      } catch (error) {
        console.error(
          `⚠️ Failed to restore board object for unarchived branch ${id}:`,
          error instanceof Error ? error.message : String(error)
        );
      }
    }

    // Unarchive all sessions that were archived due to branch archival
    // Use internal call (no provider) to bypass RBAC hooks that would ignore branch_id filter
    const sessionsService = this.app.service('sessions');
    const sessionsResult = await sessionsService.find({
      query: {
        branch_id: id,
        archived: true,
        archived_reason: 'branch_archived',
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

    console.log(`✅ Unarchived branch ${branch.name} and ${sessions.length} session(s)`);
    return unarchivedBranch;
  }

  /**
   * Custom method: Find branch by repo_id and name
   */
  async findByRepoAndName(
    repoId: UUID,
    name: string,
    _params?: BranchParams
  ): Promise<Branch | null> {
    return this.branchRepo.findByRepoAndName(repoId, name);
  }

  /**
   * Custom method: Add branch to board
   *
   * Phase 0: Sets board_id on branch
   * Phase 1: Will also create board_object entry for positioning
   */
  async addToBoard(
    id: BranchID,
    boardId: UUID,
    params?: BranchParams
  ): Promise<BranchWithZoneAndSessions> {
    // Set branch.board_id (patch already enriches with zone info)
    const branch = await this.patch(
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
    //   object_type: 'branch',
    //   branch_id: id,
    //   position: { x: 100, y: 100 }, // Default position
    // });

    return branch;
  }

  /**
   * Custom method: Remove branch from board
   *
   * Phase 0: Clears board_id on branch
   * Phase 1: Will also remove board_object entry
   */
  async removeFromBoard(id: BranchID, params?: BranchParams): Promise<BranchWithZoneAndSessions> {
    // Clear branch.board_id (patch already enriches with zone info, but it will be empty now)
    const branch = await this.patch(
      id,
      {
        board_id: undefined,
        updated_at: new Date().toISOString(),
      },
      params
    );

    // TODO (Phase 1): Remove board_object entry
    // const objects = await this.app.service('board-objects').find({
    //   query: { branch_id: id },
    // });
    // for (const obj of objects.data) {
    //   await this.app.service('board-objects').remove(obj.object_id);
    // }

    return branch;
  }

  /**
   * Custom method: Update environment status
   */
  async updateEnvironment(
    id: BranchID,
    environmentUpdate: Partial<Branch['environment_instance']>,
    params?: BranchParams
  ): Promise<BranchWithZoneAndSessions> {
    const existing = await this.get(id, params);

    const updatedEnvironment = {
      ...existing.environment_instance,
      ...environmentUpdate,
    } as Branch['environment_instance'];

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

    const branch = await this.patch(
      id,
      {
        environment_instance: updatedEnvironment,
        updated_at: new Date().toISOString(),
      },
      params
    );

    return branch;
  }

  /**
   * Custom method: Start environment
   */
  async startEnvironment(id: BranchID, params?: BranchParams): Promise<BranchWithZoneAndSessions> {
    await this.ensureCanTriggerEnv(params, 'start branch environments');
    const branch = await this.get(id, params);

    // Validate static start command exists
    if (!branch.start_command) {
      throw new Error('No start command configured for this branch');
    }

    // Check if already running
    if (branch.environment_instance?.status === 'running') {
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
          ...branch.environment_instance?.process,
          started_at: new Date().toISOString(),
        },
        last_health_check: undefined,
        last_error: undefined,
      },
      params
    );

    try {
      // Use static start_command (initialized from template at branch creation)
      const command = branch.start_command;
      const execution = await this.resolveEnvironmentCommand(command, 'start');

      console.log(
        `🚀 Starting environment for branch ${branch.name}: ${
          execution.kind === 'webhook'
            ? redactManagedEnvWebhookUrlForAudit(execution.url)
            : execution.command
        }`
      );

      // Create log directory
      const logPath = join(
        homedir(),
        '.agor',
        'logs',
        'branches',
        branch.branch_id,
        'environment.log'
      );
      await mkdir(dirname(logPath), { recursive: true });

      if (execution.kind === 'webhook') {
        await this.executeEnvironmentWebhook({
          url: execution.url,
          branch,
          commandType: 'start',
          triggeredBy: this.extractTriggeredBy(params),
          maxBytes: 16 * 1024,
        });
        console.log(`✅ Start webhook completed successfully for ${branch.name}`);
      } else {
        // Execute command and wait for it to complete
        // Use stdio: 'pipe' to capture output for error reporting
        const childProcess = await spawnEnvironmentCommand({
          command: execution.command,
          branch,
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
              console.log(`✅ Start command completed successfully for ${branch.name}`);
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
      }

      // Use static app_url (initialized from template at branch creation)
      let access_urls: Array<{ name: string; url: string }> | undefined;
      if (branch.app_url) {
        access_urls = [{ name: 'App', url: branch.app_url }];
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
  async stopEnvironment(id: BranchID, params?: BranchParams): Promise<BranchWithZoneAndSessions> {
    await this.ensureCanTriggerEnv(params, 'stop branch environments');
    const branch = await this.get(id, params);

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
      if (branch.stop_command) {
        // Use static stop_command (initialized from template at branch creation)
        const command = branch.stop_command;
        const execution = await this.resolveEnvironmentCommand(command, 'stop');

        console.log(
          `🛑 Stopping environment for branch ${branch.name}: ${
            execution.kind === 'webhook'
              ? redactManagedEnvWebhookUrlForAudit(execution.url)
              : execution.command
          }`
        );

        if (execution.kind === 'webhook') {
          await this.executeEnvironmentWebhook({
            url: execution.url,
            branch,
            commandType: 'stop',
            triggeredBy: this.extractTriggeredBy(params),
            maxBytes: 16 * 1024,
          });
        } else {
          // Execute down command
          const stopProcess = await spawnEnvironmentCommand({
            command: execution.command,
            branch,
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
        }
      } else {
        // No down command - kill the managed process if we have it
        const managedProcess = this.processes.get(id);
        if (managedProcess) {
          managedProcess.process.kill('SIGTERM');
          this.processes.delete(id);
        } else if (branch.environment_instance?.process?.pid) {
          // Try to kill by PID stored in database
          try {
            process.kill(branch.environment_instance.process.pid, 'SIGTERM');
          } catch (error) {
            console.warn(
              `Failed to kill process ${branch.environment_instance.process.pid}: ${error}`
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
    id: BranchID,
    params?: BranchParams
  ): Promise<BranchWithZoneAndSessions> {
    const branch = await this.get(id, params);

    // Stop if running
    if (branch.environment_instance?.status === 'running') {
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
  async nukeEnvironment(id: BranchID, params?: BranchParams): Promise<BranchWithZoneAndSessions> {
    await this.ensureCanTriggerEnv(params, 'nuke branch environments');
    const branch = await this.get(id, params);

    // Require nuke_command to be configured
    if (!branch.nuke_command) {
      throw new Error('No nuke_command configured for this branch');
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
      const command = branch.nuke_command;
      const execution = await this.resolveEnvironmentCommand(command, 'nuke');

      console.log(
        `💣 NUKING environment for branch ${branch.name}: ${
          execution.kind === 'webhook'
            ? redactManagedEnvWebhookUrlForAudit(execution.url)
            : execution.command
        }`
      );
      console.warn('⚠️  This is a destructive operation!');

      if (execution.kind === 'webhook') {
        await this.executeEnvironmentWebhook({
          url: execution.url,
          branch,
          commandType: 'nuke',
          triggeredBy: this.extractTriggeredBy(params),
          maxBytes: 16 * 1024,
        });
      } else {
        // Execute nuke command
        const nukeProcess = await spawnEnvironmentCommand({
          command: execution.command,
          branch,
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
      }

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
  async checkHealth(id: BranchID, params?: BranchParams): Promise<BranchWithZoneAndSessions> {
    const branch = await this.get(id, params);
    const _repo = (await this.app.service('repos').get(branch.repo_id, params)) as Repo;

    // Only check health for 'running' or 'starting' status
    const currentStatus = branch.environment_instance?.status;
    if (currentStatus !== 'running' && currentStatus !== 'starting') {
      return branch;
    }

    // Check if we have a health check URL (static field, not template)
    if (!branch.health_check_url) {
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

    // Use static health_check_url (initialized from template at branch creation)
    const healthUrl = branch.health_check_url;

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
    const previousHealthStatus = branch.environment_instance?.last_health_check?.status;

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
          `🏥 Health status changed for ${branch.name}: ${previousHealthStatus || 'unknown'} → ${newHealthStatus} (HTTP ${response.status})`
        );
      }

      // If health check succeeds and we're in 'starting' state, transition to 'running'
      const shouldTransitionToRunning = isHealthy && currentStatus === 'starting';

      if (shouldTransitionToRunning) {
        console.log(
          `✅ First successful health check for ${branch.name} - transitioning to 'running'`
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
        return branch;
      }

      const newHealthStatus = 'unhealthy';

      // Only log if health status changed or if this is an error
      if (previousHealthStatus !== newHealthStatus) {
        console.log(
          `🏥 Health status changed for ${branch.name}: ${previousHealthStatus || 'unknown'} → ${newHealthStatus} (${message})`
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
    id: BranchID,
    params?: BranchParams
  ): Promise<{
    logs: string;
    timestamp: string;
    error?: string;
    truncated?: boolean;
  }> {
    await this.ensureCanTriggerEnv(params, 'fetch branch environment logs');
    const branch = await this.get(id, params);

    // Check if static logs command is configured
    if (!branch.logs_command) {
      return {
        logs: '',
        timestamp: new Date().toISOString(),
        error: 'No logs command configured',
      };
    }

    try {
      // Use static logs_command (initialized from template at branch creation)
      const command = branch.logs_command;
      const execution = await this.resolveEnvironmentCommand(command, 'logs');

      console.log(
        `📋 Fetching logs for branch ${branch.name}: ${
          execution.kind === 'webhook'
            ? redactManagedEnvWebhookUrlForAudit(execution.url)
            : execution.command
        }`
      );

      const result =
        execution.kind === 'webhook'
          ? await this.executeEnvironmentWebhook({
              url: execution.url,
              branch,
              commandType: 'logs',
              triggeredBy: this.extractTriggeredBy(params),
              maxBytes: ENVIRONMENT.LOGS_MAX_BYTES,
            }).then(({ body, truncated }) => ({ stdout: body, stderr: '', truncated }))
          : await new Promise<{
              stdout: string;
              stderr: string;
              truncated: boolean;
            }>((resolve, reject) => {
              // Execute command with timeout and output limits
              spawnEnvironmentCommand({
                command: execution.command,
                branch,
                db: this.db,
                commandType: 'logs',
                stdio: 'pipe', // Need to capture output for logs
                triggeredBy: this.extractTriggeredBy(params),
              })
                .then((childProcess) => {
                  let stdout = '';
                  let stderr = '';
                  let truncated = false;

                  // Set timeout
                  const timeout = setTimeout(() => {
                    childProcess.kill('SIGTERM');
                    reject(
                      new Error(
                        `Logs command timed out after ${ENVIRONMENT.LOGS_TIMEOUT_MS / 1000}s`
                      )
                    );
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
                })
                .catch(reject);
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
        `✅ Fetched ${allLines.length} lines (${logs.length} bytes) for ${branch.name}${truncated ? ' [truncated]' : ''}`
      );

      return {
        logs,
        timestamp: new Date().toISOString(),
        truncated,
      };
    } catch (error) {
      console.error(
        `❌ Failed to fetch logs for ${branch.name}:`,
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
   * `environment` config and persist the result onto the branch.
   *
   * When no `variant` is supplied, the repo's default variant is used.
   * Re-rendering with the currently-selected variant is allowed for any
   * trigger-capable role (see `execution.managed_envs_minimum_role`); changing
   * the variant requires admin since it replaces executable command strings
   * that run as the system user (same rationale as `requireAdminForEnvConfig`
   * in authorization.ts).
   *
   * Returns the updated branch (with new `environment_variant`, `start_command`,
   * `stop_command`, etc).
   */
  async renderEnvironment(
    id: BranchID,
    data: { variant?: string } | undefined,
    params?: BranchParams
  ): Promise<BranchWithZoneAndSessions> {
    await this.ensureCanTriggerEnv(params, 'render branch environment');

    const branch = await this.get(id, params);
    const reposService = this.app.service('repos');
    const repo = (await reposService.get(branch.repo_id, params)) as Repo;

    const env = repo.environment;
    if (!env) {
      throw new Error('Repo has no v2 environment config; nothing to render');
    }

    const requestedVariant = data?.variant ?? env.default;
    const currentVariant = branch.environment_variant;

    // Variant change (including first-time assignment against an existing
    // branch) replaces executable commands → require admin.
    if (requestedVariant !== currentVariant) {
      ensureMinimumRole(
        params,
        ROLES.ADMIN,
        `change branch environment variant to "${requestedVariant}"`
      );

      // Refuse to swap variants while the env is live. The current process
      // was started with the old command strings; replacing them out from
      // under it would leave us unable to stop/restart cleanly. This guard
      // is the authoritative invariant for ALL callers (REST, UI, MCP).
      const envStatus = branch.environment_instance?.status;
      if (envStatus === 'running' || envStatus === 'starting') {
        throw new Error(
          `Cannot change environment variant to "${requestedVariant}" while the environment is ${envStatus} ` +
            `(currently configured for "${currentVariant || '(none)'}"). Stop the environment first.`
        );
      }
    }

    // Resolve host IP + unix GID (matches executor's renderEnvironmentTemplates).
    const config = await loadConfig();
    const hostIpAddress = resolveHostIpAddress(config.daemon?.host_ip_address);
    const unixGid = branch.unix_group ? getGidFromGroupName(branch.unix_group) : undefined;

    const snapshot = renderBranchSnapshot(
      { slug: repo.slug, environment: env },
      {
        branch_unique_id: branch.branch_unique_id,
        name: branch.name,
        path: branch.path,
        custom_context: branch.custom_context,
        unix_gid: unixGid,
        host_ip_address: hostIpAddress,
      },
      requestedVariant
    );
    if (!snapshot) {
      // Should be unreachable: env is non-null and renderBranchSnapshot only
      // returns null when env is absent. Defensive throw keeps types honest.
      throw new Error('Failed to render environment snapshot');
    }

    await this.validateRenderedEnvironmentActions(snapshot);
    validateRenderedManagedEnvUrlFields({
      health: snapshot.health,
      app: snapshot.app,
    });

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
export function createBranchesService(db: Database, app: Application): BranchesService {
  return new BranchesService(db, app);
}
