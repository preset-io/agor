import { BranchRepository, CapabilityPolicyRepository, shortId } from '@agor/core/db';
import type {
  Board,
  BoardID,
  Branch,
  BranchFilesystemAction,
  BranchID,
  Repo,
  Session,
  TeammateConfig,
  UUID,
  ZoneBoardObject,
} from '@agor/core/types';
import { getTeammateConfig, isTeammate } from '@agor/core/types';
import { computeZoneRelativePosition } from '@agor/core/utils/board-placement';
import { normalizeOptionalHttpUrl } from '@agor/core/utils/url';
import type { McpServer, ServerContext } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { BRANCH_FILESYSTEM_STATUS_EXECUTOR_COMMAND_ID } from '../../auth/executor-command-ids.js';
import type {
  BoardsServiceImpl,
  BranchesServiceImpl,
  ReposServiceImpl,
} from '../../declarations.js';
import type { BranchParams } from '../../services/branches.js';
import { issueExecutorCommandToken } from '../../services/session-token-service.js';
import { isSuperAdmin } from '../../utils/branch-authorization.js';
import { resolveDelegatedExecutionHomeKey } from '../../utils/executor-delegated-home.js';
import { getDaemonUrl, requestExecutor } from '../../utils/spawn-executor.js';
import {
  BRANCH_FILESYSTEM_READY_POLL_INTERVAL_MS,
  type BranchFilesystemReadinessResult,
  DEFAULT_BRANCH_FILESYSTEM_READY_WAIT_TIMEOUT_MS,
  MAX_BRANCH_FILESYSTEM_READY_WAIT_TIMEOUT_MS,
  MIN_BRANCH_FILESYSTEM_READY_WAIT_TIMEOUT_MS,
  waitForBranchFilesystemReady,
} from '../branch-filesystem-readiness.js';
import { branchCapabilityPolicySchema } from '../capability-policy-schema.js';
import {
  resolveBoardId,
  resolveBranchId,
  resolveMcpServerId,
  resolveRepoId,
} from '../resolve-ids.js';
import {
  mcpLimit,
  mcpOffset,
  mcpOptionalId,
  mcpOptionalNonNegativeInt,
  mcpOptionalPositiveInt,
  mcpOptionalString,
  mcpRequiredId,
  mcpRequiredString,
} from '../schema.js';
import type { McpContext } from '../server.js';
import { coerceString, sessionContextRequiredResult, textResult } from '../server.js';
import { runWithMcpTenantDatabaseScope, runWithMcpTenantDatabaseWrite } from '../tenant-scope.js';
import { assertValidVariant } from './_environment-helpers.js';

const BRANCH_NAME_PATTERN = /^[a-z0-9-]+$/;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;
const BRANCH_LIST_DEFAULT_LIMIT = 50;
const BRANCH_LIST_MAX_LIMIT = 100;
const CLEANUP_CANDIDATE_DEFAULT_OLDER_THAN_DAYS = 7;
const CLEANUP_CANDIDATE_SOURCE_PAGE_LIMIT = 10000;
type CleanupCandidateFilesystemStatus = NonNullable<Branch['filesystem_status']>;
const CLEANUP_CANDIDATE_DEFAULT_FILESYSTEM_STATUSES = [
  'ready',
  'preserved',
  'cleaned',
] as const satisfies readonly CleanupCandidateFilesystemStatus[];
const CLEANUP_CANDIDATE_FILESYSTEM_STATUSES = [
  'creating',
  'ready',
  'failed',
  'preserved',
  'cleaned',
  'deleted',
] as const satisfies readonly CleanupCandidateFilesystemStatus[];
const CLEANUP_CANDIDATE_STORAGE_MODES = ['worktree', 'clone'] as const;

function containsTeammateKnowledgeConfigMutation(customContext: unknown): boolean {
  if (!customContext || typeof customContext !== 'object' || Array.isArray(customContext)) {
    return false;
  }
  const record = customContext as Record<string, unknown>;
  for (const key of ['teammate', 'assistant', 'agent']) {
    const value = record[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (Object.hasOwn(value as Record<string, unknown>, 'kb')) return true;
    }
  }
  return false;
}

function normalizeFilesystemStatus(branch: Branch): CleanupCandidateFilesystemStatus {
  return branch.filesystem_status ?? 'ready';
}

function readinessPoll(branchId: string) {
  return {
    tool: 'agor_branches_wait_for_ready',
    arguments: { branchId },
  };
}

const branchFilesystemReadyWaitTimeoutSchema = z
  .number({ error: 'waitTimeoutMs must be a number when provided.' })
  .int('waitTimeoutMs must be an integer.')
  .min(
    MIN_BRANCH_FILESYSTEM_READY_WAIT_TIMEOUT_MS,
    `waitTimeoutMs must be at least ${MIN_BRANCH_FILESYSTEM_READY_WAIT_TIMEOUT_MS}.`
  )
  .max(
    MAX_BRANCH_FILESYSTEM_READY_WAIT_TIMEOUT_MS,
    `waitTimeoutMs must be at most ${MAX_BRANCH_FILESYSTEM_READY_WAIT_TIMEOUT_MS}.`
  )
  .optional()
  .describe(
    `Maximum milliseconds to wait (default ${DEFAULT_BRANCH_FILESYSTEM_READY_WAIT_TIMEOUT_MS}, max ${MAX_BRANCH_FILESYSTEM_READY_WAIT_TIMEOUT_MS}).`
  );

function readinessResponse(result: BranchFilesystemReadinessResult): {
  readiness: Record<string, unknown>;
  isError: boolean;
} {
  const readiness: Record<string, unknown> = {
    outcome: result.outcome,
    elapsed_ms: result.elapsedMs,
    timeout_ms: result.timeoutMs,
    poll_interval_ms: BRANCH_FILESYSTEM_READY_POLL_INTERVAL_MS,
  };

  if (result.outcome === 'ready') {
    readiness.message = 'Branch filesystem is ready for session creation.';
    return { readiness, isError: false };
  }

  if (result.outcome === 'timeout') {
    readiness.message =
      'Timed out while the branch filesystem is still being created. The wait did not modify or cancel materialization; call agor_branches_wait_for_ready before creating a session.';
    readiness.poll = readinessPoll(result.branch.branch_id);
    return { readiness, isError: false };
  }

  readiness.message =
    result.outcome === 'failed'
      ? result.branch.error_message || 'Branch filesystem creation failed.'
      : `Branch filesystem is unavailable (${result.unavailableReason ?? 'terminal state'}).`;
  if (result.unavailableReason) readiness.reason = result.unavailableReason;
  return { readiness, isError: true };
}

function mcpRequestSignal(requestContext: ServerContext): AbortSignal {
  return requestContext.mcpReq.signal;
}

/**
 * Feathers authorization hooks cache loaded records on params for the duration
 * of one service call. A readiness wait spans multiple observations, so every
 * read needs a pristine params object or it can reuse the first branch row.
 * Whitelist the trusted MCP identity fields instead of cloning hook-added data
 * that may already be present after optional Session authorization.
 */
function freshMcpServiceParams(ctx: McpContext): McpContext['baseServiceParams'] {
  const { authenticated, provider, tenant, user } = ctx.baseServiceParams;
  return {
    ...(user ? { user: { ...user } } : {}),
    ...(authenticated !== undefined ? { authenticated } : {}),
    ...(provider !== undefined ? { provider } : {}),
    ...(tenant ? { tenant: { ...tenant } } : {}),
  };
}

function parseCleanupCutoff(args: { archivedBefore?: string; archivedOlderThanDays?: number }): {
  cutoff: Date;
  source: 'archivedBefore' | 'archivedOlderThanDays';
  olderThanDays?: number;
} {
  const archivedBefore = coerceString(args.archivedBefore);
  if (archivedBefore) {
    const cutoff = new Date(archivedBefore);
    if (Number.isNaN(cutoff.getTime())) {
      throw new Error('archivedBefore must be a valid ISO-8601 date/time string');
    }
    if (cutoff.getTime() > Date.now()) {
      throw new Error('archivedBefore must not be in the future');
    }
    return { cutoff, source: 'archivedBefore' };
  }

  const olderThanDays = args.archivedOlderThanDays ?? CLEANUP_CANDIDATE_DEFAULT_OLDER_THAN_DAYS;
  if (!Number.isFinite(olderThanDays) || olderThanDays < 1) {
    throw new Error('archivedOlderThanDays must be at least 1 day');
  }
  return {
    cutoff: new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000),
    source: 'archivedOlderThanDays',
    olderThanDays,
  };
}

function notesPreview(notes: string | undefined, maxLength = 200): string | null {
  if (!notes) return null;
  const singleLine = notes.replace(/\s+/g, ' ').trim();
  if (singleLine.length <= maxLength) return singleLine;
  return `${singleLine.slice(0, maxLength - 1)}…`;
}

async function shouldScopeTeammateDiscoveryToUser(ctx: McpContext): Promise<boolean> {
  if (ctx.app.get('config').execution?.branch_rbac !== true) return false;
  if (ctx.authenticatedUser?._isServiceAccount) return false;

  const config = ctx.app.get('config');
  const allowSuperadmin = config.execution?.allow_superadmin === true;
  return !isSuperAdmin(ctx.authenticatedUser?.role, allowSuperadmin);
}

async function findAllArchivedBranchesForCleanup(
  ctx: McpContext,
  baseQuery: Record<string, unknown>
): Promise<{ branches: Branch[]; total: number; pages: number }> {
  const branches: Branch[] = [];
  let skip = 0;
  let total: number | undefined;
  let pages = 0;

  while (total === undefined || branches.length < total) {
    const result = await ctx.app.service('branches').find({
      query: {
        ...baseQuery,
        $limit: CLEANUP_CANDIDATE_SOURCE_PAGE_LIMIT,
        $skip: skip,
      },
      ...ctx.baseServiceParams,
    });
    pages += 1;

    if (Array.isArray(result)) {
      branches.push(...(result as Branch[]));
      total = branches.length;
      break;
    }

    const paginated = result as { data: Branch[]; total?: number; limit?: number; skip?: number };
    const pageData = paginated.data ?? [];
    branches.push(...pageData);
    total = paginated.total ?? branches.length;

    if (pageData.length === 0) break;
    skip += pageData.length;
  }

  return { branches, total: total ?? branches.length, pages };
}

export function registerBranchTools(server: McpServer, ctx: McpContext): void {
  // Tool 1: agor_branches_get
  server.registerTool(
    'agor_branches_get',
    {
      description:
        'Get detailed information about a branch, including path, git ref, and git state',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        branchId: mcpRequiredId('branchId', 'Branch'),
      }),
    },
    async (args) => {
      const branchParams: BranchParams = {
        ...ctx.baseServiceParams,
        _include_sessions: true,
        _last_message_truncation_length: 500,
      };
      const branch = await ctx.app
        .service('branches')
        .get(args.branchId, branchParams as Parameters<BranchesServiceImpl['get']>[1]);
      const permissions = await ctx.app
        .service('branches/:id/permissions')
        .find({ ...ctx.baseServiceParams, route: { id: branch.branch_id } });
      return textResult({ ...branch, permissions });
    }
  );

  server.registerTool(
    'agor_branches_wait_for_ready',
    {
      description:
        'Wait for asynchronous branch filesystem materialization before creating a session. ' +
        'This read-only, retry-safe tool performs an immediate authorized read, then polls the shared database once per second. ' +
        'It returns the authoritative refreshed branch when ready, a structured terminal error if creation failed or the branch became unavailable, ' +
        'or a timeout result that preserves the branch so this tool can be called again. Branch creation itself remains asynchronous.',
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: z.object({
        branchId: mcpRequiredId('branchId', 'Branch'),
        waitTimeoutMs: branchFilesystemReadyWaitTimeoutSchema.describe(
          `Maximum milliseconds to wait (default ${DEFAULT_BRANCH_FILESYSTEM_READY_WAIT_TIMEOUT_MS}, max ${MAX_BRANCH_FILESYSTEM_READY_WAIT_TIMEOUT_MS}). ` +
            "Waits longer than the MCP client's request deadline require a matching client timeout. " +
            'For longer clone/materialization jobs, safely call this read-only tool again.'
        ),
      }),
    },
    async (args, requestContext) => {
      const timeoutMs = args.waitTimeoutMs ?? DEFAULT_BRANCH_FILESYSTEM_READY_WAIT_TIMEOUT_MS;
      const branches = ctx.app.service('branches');
      const result = await waitForBranchFilesystemReady({
        branchId: args.branchId,
        timeoutMs,
        signal: mcpRequestSignal(requestContext),
        readBranch: (branchId) =>
          branches.get(
            branchId,
            freshMcpServiceParams(ctx) as Parameters<BranchesServiceImpl['get']>[1]
          ),
      });

      const formatted = readinessResponse(result);
      return {
        ...textResult({ branch: result.branch, _readiness: formatted.readiness }),
        ...(formatted.isError ? { isError: true } : {}),
      };
    }
  );

  // Tool 2: agor_branches_list
  server.registerTool(
    'agor_branches_list',
    {
      description:
        'List a paginated set of branches, optionally filtered by repository. Inspect total, ' +
        'limit, and skip in the response, then advance offset until all desired pages have been read. ' +
        'Each branch includes zone_id and zone_label when ' +
        'the branch is assigned to a board zone — use these fields directly to identify which ' +
        'zone a branch is in without extra agor_branches_get calls. Also includes ' +
        'pull_request_url, issue_url, board_object_id, and position when set.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        repoId: mcpOptionalId('repoId', 'Repository', 'Repository ID to filter by'),
        limit: mcpLimit(BRANCH_LIST_DEFAULT_LIMIT, BRANCH_LIST_MAX_LIMIT),
        offset: mcpOffset(0),
        includeArchived: z
          .boolean()
          .optional()
          .describe(
            'Include archived branches in results (default: false). By default, archived branches are excluded.'
          ),
        archived: z
          .boolean()
          .optional()
          .describe(
            'Filter to show ONLY archived branches. When true, returns only archived branches. Overrides includeArchived.'
          ),
        zoneId: mcpOptionalString(
          'zoneId',
          'Filter results to branches in a specific board zone (e.g. "zone-1776863814461"). ' +
            'Avoids the need to call agor_branches_get on each branch to check zone membership.'
        ),
      }),
    },
    async (args) => {
      const query: Record<string, unknown> = {};
      if (args.repoId) query.repo_id = await resolveRepoId(ctx, args.repoId);
      // Prevent no-argument MCP calls from inheriting the service's intentional
      // 10,000-row UI default. On large installations that aggregate response
      // can cross the Socket.IO 1 MB frame limit when Codex persists the tool
      // completion through the executor.
      query.$limit = args.limit ?? BRANCH_LIST_DEFAULT_LIMIT;
      query.$skip = args.offset ?? 0;
      if (args.archived === true) {
        query.archived = true;
      } else if (!args.includeArchived) {
        query.archived = false;
      }
      // Delegate zone filtering to BranchesService so it runs before pagination.
      if (args.zoneId) query.zone_id = coerceString(args.zoneId);

      const result = await ctx.app.service('branches').find({ query, ...ctx.baseServiceParams });
      return textResult(result);
    }
  );

  // Tool 2b: agor_branches_cleanup_candidates
  server.registerTool(
    'agor_branches_cleanup_candidates',
    {
      description:
        'Safely inventory archived branch worktrees that may be candidates for disk cleanup. ' +
        'Read-only: never deletes or mutates anything. This tool ALWAYS restricts results to archived branches, ' +
        'defaults to branches archived more than 7 days ago, excludes filesystem_status="deleted", ' +
        'and excludes teammate/private branches by default. It returns repo metadata, archive timestamps, ' +
        'filesystem/storage status, path, and a path_exists boolean computed from the recorded branch path only.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        repoId: mcpOptionalId('repoId', 'Repository', 'Repository ID to filter by'),
        archivedBefore: mcpOptionalString(
          'archivedBefore',
          'Only include branches archived before this ISO-8601 date/time. Overrides the default archivedOlderThanDays=7 cutoff.'
        ),
        archivedOlderThanDays: mcpOptionalPositiveInt(
          'archivedOlderThanDays',
          'Only include branches archived more than this many days ago. Must be at least 1. Default: 7. Ignored when archivedBefore is provided.'
        ),
        filesystemStatus: z
          .enum(CLEANUP_CANDIDATE_FILESYSTEM_STATUSES)
          .optional()
          .describe(
            'Single filesystem_status to include. Undefined branch statuses are treated as "ready".'
          ),
        filesystemStatuses: z
          .array(z.enum(CLEANUP_CANDIDATE_FILESYSTEM_STATUSES))
          .optional()
          .describe(
            'Filesystem statuses to include. Default: ["ready","preserved","cleaned"], intentionally excluding "deleted". Undefined branch statuses are treated as "ready".'
          ),
        storageMode: z
          .enum(CLEANUP_CANDIDATE_STORAGE_MODES)
          .optional()
          .describe('Filter by branch storage mode ("worktree" or "clone").'),
        excludeTeammates: z
          .boolean()
          .optional()
          .describe('Exclude long-lived teammate branches. Default: true.'),
        excludePrivate: z
          .boolean()
          .optional()
          .describe('Exclude branches whose effective policy is Private. Default: true.'),
        pathExists: z
          .boolean()
          .optional()
          .describe(
            'Filter by whether the recorded branch path currently exists. This checks the exact stored path; it does not scan the filesystem.'
          ),
        limit: mcpLimit(50, 100),
        skip: mcpOptionalNonNegativeInt(
          'skip',
          'Number of filtered candidates to skip (default: 0)'
        ),
      }),
    },
    async (args) => {
      if (args.filesystemStatus && args.filesystemStatuses) {
        throw new Error('Pass either filesystemStatus or filesystemStatuses, not both');
      }

      const cutoff = parseCleanupCutoff(args);
      const statuses = new Set(
        args.filesystemStatuses ??
          (args.filesystemStatus
            ? [args.filesystemStatus]
            : [...CLEANUP_CANDIDATE_DEFAULT_FILESYSTEM_STATUSES])
      );
      const excludeTeammates = args.excludeTeammates ?? true;
      const excludePrivate = args.excludePrivate ?? true;
      const limit = args.limit ?? 50;
      const skip = args.skip ?? 0;

      const query: Record<string, unknown> = {
        archived: true,
        $sort: { archived_at: 1 },
      };
      if (args.repoId) query.repo_id = await resolveRepoId(ctx, args.repoId);

      const {
        branches,
        total: scannedArchivedBranches,
        pages: scannedPages,
      } = await findAllArchivedBranchesForCleanup(ctx, query);

      const repoIds = [...new Set(branches.map((branch) => branch.repo_id))];
      const sharingModes = await runWithMcpTenantDatabaseScope<Map<BranchID, 'private' | 'shared'>>(
        ctx,
        (db) =>
          (
            new CapabilityPolicyRepository(db) as CapabilityPolicyRepository & {
              getBranchSharingModes(
                branchIds: readonly BranchID[]
              ): Promise<Map<BranchID, 'private' | 'shared'>>;
            }
          ).getBranchSharingModes(branches.map((branch) => branch.branch_id))
      );
      const reposById = new Map<string, Repo>();
      await Promise.all(
        repoIds.map(async (repoId) => {
          try {
            const repo = await ctx.app.service('repos').get(repoId, ctx.baseServiceParams);
            reposById.set(repoId, repo as Repo);
          } catch {
            // Keep the inventory useful even if a repo row is missing or inaccessible.
          }
        })
      );

      const statusResult = await requestExecutor(
        {
          command: 'branch.filesystem.status',
          sessionToken: await issueExecutorCommandToken(
            ctx.app,
            BRANCH_FILESYSTEM_STATUS_EXECUTOR_COMMAND_ID,
            ctx.userId
          ),
          daemonUrl: getDaemonUrl(),
          params: { branchIds: branches.map((branch) => branch.branch_id) },
        },
        {
          logPrefix: '[MCP branches.cleanupCandidates.status]',
          delegatedHomeKey: await runWithMcpTenantDatabaseScope(ctx, (db) =>
            resolveDelegatedExecutionHomeKey(
              db,
              ctx.authenticatedUser.user_id,
              ctx.app.get('config')
            )
          ),
        }
      );
      if (!statusResult.success) {
        throw new Error(
          `Failed to inspect archived branch filesystems: ${statusResult.error?.message ?? 'unknown executor error'}`
        );
      }
      const statusEntries =
        statusResult.data && typeof statusResult.data === 'object'
          ? (statusResult.data as { statuses?: unknown }).statuses
          : undefined;
      const pathExistsByBranch = new Map<string, boolean>(
        Array.isArray(statusEntries)
          ? statusEntries
              .filter(
                (entry): entry is { branchId: string; exists: boolean } =>
                  !!entry &&
                  typeof entry === 'object' &&
                  typeof (entry as { branchId?: unknown }).branchId === 'string' &&
                  typeof (entry as { exists?: unknown }).exists === 'boolean'
              )
              .map((entry) => [entry.branchId, entry.exists])
          : []
      );

      const filtered = branches
        .map((branch) => {
          const pathExists = pathExistsByBranch.get(branch.branch_id) ?? false;
          return {
            branch,
            pathExists,
            filesystemStatus: normalizeFilesystemStatus(branch),
            repo: reposById.get(branch.repo_id),
          };
        })
        .filter(({ branch, pathExists, filesystemStatus }) => {
          if (!branch.archived) return false; // Defense in depth: this tool never returns active branches.
          if (!branch.archived_at) return false;
          const archivedAtMs = new Date(branch.archived_at).getTime();
          if (!Number.isFinite(archivedAtMs)) return false;
          if (archivedAtMs >= cutoff.cutoff.getTime()) return false;
          if (!statuses.has(filesystemStatus)) return false;
          if (args.storageMode && (branch.storage_mode ?? 'worktree') !== args.storageMode) {
            return false;
          }
          if (excludeTeammates && isTeammate(branch)) return false;
          if (excludePrivate && sharingModes.get(branch.branch_id) === 'private') return false;
          if (args.pathExists !== undefined && pathExists !== args.pathExists) return false;
          return true;
        });

      const candidates = filtered.slice(skip, skip + limit).map(({ branch, pathExists, repo }) => ({
        repo_id: branch.repo_id,
        repo_slug: repo?.slug ?? null,
        repo_name: repo?.name ?? null,
        branch_id: branch.branch_id,
        name: branch.name,
        ref: branch.ref,
        archived: true,
        archived_at: branch.archived_at,
        archived_by: branch.archived_by ?? null,
        last_used: branch.last_used ?? null,
        filesystem_status: normalizeFilesystemStatus(branch),
        storage_mode: branch.storage_mode ?? 'worktree',
        path: branch.path,
        path_exists: pathExists,
        pull_request_url: branch.pull_request_url ?? null,
        issue_url: branch.issue_url ?? null,
        notes_preview: notesPreview(branch.notes),
        is_teammate: isTeammate(branch),
        is_private: sharingModes.get(branch.branch_id) === 'private',
      }));

      return textResult({
        total: filtered.length,
        limit,
        skip,
        candidates,
        safety: {
          read_only: true,
          archived_only: true,
          cutoff: cutoff.cutoff.toISOString(),
          cutoff_source: cutoff.source,
          archived_older_than_days:
            cutoff.source === 'archivedOlderThanDays' ? cutoff.olderThanDays : null,
          filesystem_statuses: [...statuses],
          exclude_teammates: excludeTeammates,
          exclude_private: excludePrivate,
          path_exists_filter: args.pathExists ?? null,
        },
        scanned: {
          archived_branches: scannedArchivedBranches,
          source_pages: scannedPages,
          source_page_limit: CLEANUP_CANDIDATE_SOURCE_PAGE_LIMIT,
        },
      });
    }
  );

  // Tool 3: agor_branches_create
  server.registerTool(
    'agor_branches_create',
    {
      description:
        'Create a branch (an isolated workspace with its own git ref) for a repository, with required board placement. ' +
        'To fork from an existing git branch under a unique name, set sourceBranch to the base git branch ' +
        'and branchName to your desired unique name (e.g., sourceBranch="issue-282", branchName="issue-282-review-1"). ' +
        'Use zoneId to place the branch in a specific zone (pin only, no trigger). ' +
        'For zone trigger behavior (prompt templates), use agor_branches_set_zone after creation. ' +
        'Filesystem materialization is asynchronous by default. Set waitForReady=true to wait for a bounded ' +
        'authoritative result in this call, or use the retry-safe agor_branches_wait_for_ready tool separately. ' +
        'To create a long-lived Agor teammate (a persistent AI teammate that manages other branches ' +
        'and maintains memory), pass the teammate object — this is the ONLY supported way to make a ' +
        'teammate via MCP. Teammate status cannot be toggled later with agor_branches_update. ' +
        'Agor follows a soft 1:1 teammate↔board convention: when creating a teammate, boardId is ' +
        'optional — omit it (or pass createBoard=true) to spin up a dedicated board for the teammate ' +
        'and wire it as that board primary teammate. If you pass a boardId that already has a ' +
        'different primary teammate, the branch is still created but a warning is returned (the ' +
        'convention is not hard-enforced).',
      inputSchema: z.object({
        repoId: mcpRequiredId(
          'repoId',
          'Repository',
          'Repository ID where the branch will be created'
        ),
        branchName: mcpRequiredString(
          'branchName',
          'Slug name for the branch directory (lowercase letters, numbers, hyphens). ' +
            'If the name conflicts with an existing branch, a numeric suffix is auto-appended (e.g., "my-feature-2"). ' +
            'Set autoSuffix=false to get an error on conflict instead.'
        ),
        boardId: mcpOptionalId(
          'boardId',
          'Board',
          'Board ID to place the branch on (positions to default coordinates). Required for normal branches to ensure they are visible in the UI. ' +
            'Optional when the teammate object is provided: omit it (or pass createBoard=true) to auto-create a dedicated board for the teammate.'
        ),
        createBoard: z
          .boolean()
          .optional()
          .describe(
            'Teammate branches only. When true, create a fresh board for this teammate and wire it as ' +
              'the board primary teammate (soft 1:1 teammate↔board convention). Mutually exclusive with boardId. ' +
              'For a teammate, omitting both boardId and createBoard also auto-creates a board.'
          ),
        ref: mcpOptionalString(
          'ref',
          'Git ref name to create or checkout. Defaults to branchName when creating a new git branch. ' +
            'Set this to create a git branch with a different name than the branch directory. ' +
            'Example: branchName="review-1", ref="issue-282-review-1" creates directory "review-1" on git branch "issue-282-review-1".'
        ),
        refType: z
          .enum(['branch', 'tag'])
          .optional()
          .describe('Type of ref (branch or tag). Defaults to branch.'),
        createBranch: z
          .boolean()
          .optional()
          .describe(
            'Whether to create a new branch (default: true). Set to false to checkout an existing branch. ' +
              'Auto-set to false when ref is a commit SHA.'
          ),
        pullLatest: z
          .boolean()
          .optional()
          .describe(
            'Pull latest from remote before creating the branch (defaults to true for new branches).'
          ),
        sourceBranch: mcpOptionalString(
          'sourceBranch',
          'Base branch to fork from when creating a new branch (defaults to the repo default branch, usually "main"). ' +
            'The new branch will be created from the tip of this branch. ' +
            'Must exist on the remote (origin) for clone storage mode; worktree storage mode may also use local refs.'
        ),
        autoSuffix: z
          .boolean()
          .optional()
          .describe(
            'If branchName conflicts with an existing branch, automatically append a numeric suffix ' +
              '(e.g., "my-feature" → "my-feature-2", "my-feature-3"). Defaults to true. Set to false to get an error on conflict instead.'
          ),
        zoneId: mcpOptionalString(
          'zoneId',
          'Zone ID to pin the branch to (e.g., "zone-1770152859108"). ' +
            'Places the branch inside the zone with automatic positioning (pin only, no trigger). ' +
            'For zone trigger behavior (prompt templates), use agor_branches_set_zone after creation.'
        ),
        issueUrl: mcpOptionalString('issueUrl', 'Issue URL to associate with the branch.'),
        pullRequestUrl: mcpOptionalString(
          'pullRequestUrl',
          'Pull request URL to associate with the branch.'
        ),
        // New branches always align with their board permissions. Use
        // agor_branches_update after creation for the deliberate override flow.
        variant: mcpOptionalString(
          'variant',
          'Environment variant name to use for this branch. ' +
            'Must be a key in the repo environment config variants. ' +
            'When omitted, the repo default variant is used. ' +
            'Use agor_environment_set later to switch variants on an existing branch.'
        ),
        storage_mode: z
          .enum(['worktree', 'clone'])
          .optional()
          .describe(
            'Branch storage model. ' +
              '"worktree" (default) = native `git worktree add` — shares the per-repo base ' +
              '`.git/` and is the legacy behaviour. ' +
              '"clone" = self-standing `git clone` into the branch directory — own `.git/config`, ' +
              'closes cross-branch credential/config leak vectors. ' +
              'See context/explorations/clone-redesign.md.'
          ),
        clone_depth: mcpOptionalPositiveInt(
          'clone_depth',
          'Shallow-clone depth (only meaningful when storage_mode="clone"). ' +
            'Positive integer → `git clone --depth N`. Omit for a full clone. ' +
            'Common shallow value: 100. Trade-off: smaller disk footprint, but ' +
            '`git log` past N commits is broken and some rebase operations fail.'
        ),
        waitForReady: z
          .boolean()
          .optional()
          .describe(
            'Wait for filesystem materialization before returning (default: false). ' +
              'This is an opt-in convenience on a non-idempotent create; if the client loses the response, creation still continues. ' +
              'Use the separate retry-safe agor_branches_wait_for_ready tool to recover from timeouts.'
          ),
        waitTimeoutMs: branchFilesystemReadyWaitTimeoutSchema.describe(
          `Maximum milliseconds to wait when waitForReady=true (default ${DEFAULT_BRANCH_FILESYSTEM_READY_WAIT_TIMEOUT_MS}, max ${MAX_BRANCH_FILESYSTEM_READY_WAIT_TIMEOUT_MS}). Requires waitForReady=true; waits longer than the MCP client's request deadline require a matching client timeout.`
        ),
        teammate: z
          .object({
            displayName: z
              .string({ error: 'teammate.displayName must be a string.' })
              .trim()
              .min(1, 'teammate.displayName cannot be empty')
              .describe('Human-friendly display name for the teammate (e.g., "Siebel CRM").'),
            emoji: z.string().optional().describe('Emoji icon for this teammate (e.g., "🧑‍💻").'),
            frameworkRepo: z
              .string()
              .optional()
              .describe(
                'Template/framework repo slug this teammate is based on. ' +
                  "Defaults to the created branch's repo slug when omitted."
              ),
            frameworkVersion: z
              .string()
              .optional()
              .describe('Framework version at creation time, for later upgrade detection.'),
            createdViaOnboarding: z
              .boolean()
              .optional()
              .describe(
                'Whether this teammate was created via the onboarding wizard (defaults to false).'
              ),
          })
          .optional()
          .describe(
            'When provided, create this branch as a long-lived Agor teammate. ' +
              'The teammate metadata is written to custom_context.teammate on the initial branch row, ' +
              'the board primary teammate pointer is wired automatically, and the teammate Knowledge ' +
              'namespace is provisioned. Knowledge namespace/grant config (the "kb" field) is managed ' +
              'separately and cannot be set here.'
          ),
      }),
    },
    async (args, requestContext) => {
      if (args.waitTimeoutMs !== undefined && args.waitForReady !== true) {
        throw new Error('waitTimeoutMs requires waitForReady=true.');
      }

      const repoId = await resolveRepoId(ctx, coerceString(args.repoId)!);
      let branchName = coerceString(args.branchName)!;
      const originalName = branchName;
      const boardIdArg = coerceString(args.boardId);
      // Resolve the board up front only when one was passed. For teammate
      // branches the board is optional (we may auto-create one below), so the
      // required-board check is deferred to the board-strategy block.
      let boardId: BoardID | undefined = boardIdArg
        ? await resolveBoardId(ctx, boardIdArg)
        : undefined;
      const createBoardArg = typeof args.createBoard === 'boolean' ? args.createBoard : undefined;
      const zoneId = coerceString(args.zoneId);
      const autoSuffix = typeof args.autoSuffix === 'boolean' ? args.autoSuffix : true;

      if (!BRANCH_NAME_PATTERN.test(branchName)) {
        throw new Error('branchName must use lowercase letters, numbers, or hyphens');
      }

      const reposService = ctx.app.service('repos') as unknown as ReposServiceImpl;
      let repo: Repo;
      try {
        repo = await reposService.get(repoId);
      } catch {
        throw new Error(`Repository ${repoId} not found`);
      }

      // Validate variant up front so the error lists the available variants.
      const variant = coerceString(args.variant);
      if (variant) assertValidVariant(repo, variant);

      // Optional: mark the new branch as a long-lived teammate in one shot.
      // Writing the teammate config onto the initial branch row (rather than a
      // follow-up patch) is what the UI does too — it lets BranchesService.create
      // wire the board primary_teammate_id pointer and provision the teammate
      // Knowledge namespace atomically, and sidesteps the assertTeammateKindIsStable
      // guard that (deliberately) blocks flipping teammate status via patch.
      const teammateInput = args.teammate as
        | {
            displayName?: unknown;
            emoji?: unknown;
            frameworkRepo?: unknown;
            frameworkVersion?: unknown;
            createdViaOnboarding?: unknown;
          }
        | undefined;
      let teammateConfig: TeammateConfig | undefined;
      if (teammateInput) {
        const displayName = coerceString(teammateInput.displayName)?.trim();
        if (!displayName) throw new Error('teammate.displayName is required');
        const emoji = coerceString(teammateInput.emoji);
        const frameworkRepo = coerceString(teammateInput.frameworkRepo) ?? repo.slug;
        const frameworkVersion = coerceString(teammateInput.frameworkVersion);
        teammateConfig = {
          kind: 'teammate',
          displayName,
          ...(emoji ? { emoji } : {}),
          ...(frameworkRepo ? { frameworkRepo } : {}),
          ...(frameworkVersion ? { frameworkVersion } : {}),
          createdViaOnboarding: teammateInput.createdViaOnboarding === true,
        };
      }

      // Board strategy + soft 1:1 teammate<->board coupling.
      //
      // Convention (deliberately not hard-enforced): every teammate has a
      // primary board and every board has a primary teammate. We reflect that
      // on the tool surface without forcing it:
      //   - teammate + no board  -> auto-create a dedicated board (becomes primary)
      //   - teammate + createBoard=true -> same, explicit
      //   - teammate + existing board that already has a *different* primary
      //     teammate -> still create, but return a warning (do not block)
      //   - normal branch -> boardId stays required (UI visibility invariant)
      let createdBoard: Board | undefined;
      let primaryTeammateWarning: string | undefined;

      if (teammateConfig) {
        if (boardId && createBoardArg === true) {
          throw new Error(
            'Pass either boardId (place the teammate on an existing board) or createBoard=true ' +
              '(create a dedicated board), not both.'
          );
        }

        if (!boardId) {
          if (createBoardArg === false) {
            throw new Error(
              'boardId is required, or set createBoard=true (or omit createBoard) to auto-create ' +
                'a dedicated board for this teammate.'
            );
          }

          // No board given (or createBoard explicitly requested): spin up a
          // dedicated board for this teammate. BranchesService.create then wires
          // it as the board primary teammate via setPrimaryTeammateIfUnset.
          const boardsService = ctx.app.service('boards') as unknown as BoardsServiceImpl;
          createdBoard = (await boardsService.create(
            {
              name: teammateConfig.displayName,
              created_by: ctx.userId,
              ...(teammateConfig.emoji ? { icon: teammateConfig.emoji } : {}),
            } as Partial<Board>,
            ctx.baseServiceParams
          )) as Board;
          boardId = createdBoard.board_id;
        } else {
          // Existing board: honour the 1:1 convention softly. If the board
          // already has a (different) primary teammate, warn — the new teammate
          // will join the board but will NOT become its primary.
          try {
            const boardsService = ctx.app.service('boards') as unknown as BoardsServiceImpl;
            const board = (await boardsService.get(boardId, ctx.baseServiceParams)) as Board;
            if (board?.primary_teammate_id) {
              primaryTeammateWarning =
                `Board ${boardId} already has a primary teammate (${board.primary_teammate_id}). ` +
                `Agor follows a soft 1:1 teammate↔board convention, so this teammate will be added ` +
                `to the board but will NOT become its primary teammate. Omit boardId or pass ` +
                `createBoard=true to give this teammate its own board.`;
            }
          } catch {
            // resolveBoardId already validated the board exists; ignore any
            // transient lookup failure here rather than block creation.
          }
        }
      } else {
        if (createBoardArg === true) {
          throw new Error('createBoard is only supported when creating a teammate branch.');
        }
        if (!boardId) {
          throw new Error('boardId is required');
        }
      }

      // By here boardId is always resolved (passed, auto-created, or threw above).
      if (!boardId) throw new Error('boardId is required');

      // Auto-suffix: resolve name conflicts by appending -2, -3, etc.
      // Uses direct DB query to bypass Feathers pagination limits
      if (autoSuffix) {
        const activeNames = await runWithMcpTenantDatabaseScope(ctx, (db) =>
          new BranchRepository(db).getActiveNamesByRepo(repoId as UUID)
        );
        const existingNames = new Set(activeNames);

        if (existingNames.has(branchName)) {
          let suffix = 2;
          while (existingNames.has(`${branchName}-${suffix}`)) {
            suffix++;
          }
          branchName = `${branchName}-${suffix}`;
        }
      }

      const defaultBranch = repo.default_branch ?? 'main';
      const refType = (coerceString(args.refType) as 'branch' | 'tag') || 'branch';
      let createBranch = typeof args.createBranch === 'boolean' ? args.createBranch : true;
      let ref = coerceString(args.ref);
      let sourceBranch = coerceString(args.sourceBranch);
      let pullLatest = typeof args.pullLatest === 'boolean' ? args.pullLatest : undefined;

      if (ref && GIT_SHA_PATTERN.test(ref)) {
        createBranch = false;
        pullLatest = false;
        sourceBranch = undefined;
      }

      if (createBranch) {
        if (!ref) ref = branchName;
        if (!sourceBranch) sourceBranch = defaultBranch;
        if (pullLatest === undefined) pullLatest = true;
      } else {
        if (!ref) throw new Error('ref is required when createBranch is false');
        sourceBranch = undefined;
        if (pullLatest === undefined) pullLatest = false;
      }

      const issueUrl = normalizeOptionalHttpUrl(args.issueUrl, 'issueUrl');
      const pullRequestUrl = normalizeOptionalHttpUrl(args.pullRequestUrl, 'pullRequestUrl');

      // If auto-suffix changed the ref (branch name defaults to branchName), update it
      if (createBranch && !coerceString(args.ref) && branchName !== originalName) {
        ref = branchName;
      }

      // Positioning is handled automatically by the repos service —
      // agents don't need to think about x/y coordinates.

      const storageMode = args.storage_mode as 'worktree' | 'clone' | undefined;
      const cloneDepth = typeof args.clone_depth === 'number' ? args.clone_depth : undefined;

      // `createBranch` is deliberately NOT a Feathers transport method (it takes
      // `(id, data)`), so this direct call bypasses the around hooks that enter
      // the tenant database scope for the HTTP `/repos/:id/branches` route. In
      // `required_from_auth` mode the guarded daemon-database proxy then throws
      // `MissingTenantDatabaseScopeError` on the first `this.db` touch. Re-enter
      // the authenticated tenant scope here so the metadata writes join one
      // tenant transaction — exactly like the HTTP route — while the readiness
      // wait below stays outside it and never holds a transaction across polls.
      const branch = await runWithMcpTenantDatabaseWrite(ctx, () =>
        reposService.createBranch(
          repoId,
          {
            name: branchName,
            ref,
            createBranch,
            refType,
            ...(pullLatest !== undefined ? { pullLatest } : {}),
            ...(sourceBranch ? { sourceBranch } : {}),
            ...(issueUrl ? { issue_url: issueUrl } : {}),
            ...(pullRequestUrl ? { pull_request_url: pullRequestUrl } : {}),
            boardId,
            ...(zoneId ? { zoneId } : {}),
            ...(variant ? { environment_variant: variant } : {}),
            ...(storageMode ? { storage_mode: storageMode } : {}),
            ...(cloneDepth !== undefined ? { clone_depth: cloneDepth } : {}),
            ...(teammateConfig ? { custom_context: { teammate: teammateConfig } } : {}),
          },
          ctx.baseServiceParams
        )
      );

      const readinessResult = args.waitForReady
        ? await waitForBranchFilesystemReady({
            branchId: branch.branch_id,
            timeoutMs: args.waitTimeoutMs ?? DEFAULT_BRANCH_FILESYSTEM_READY_WAIT_TIMEOUT_MS,
            signal: mcpRequestSignal(requestContext),
            readBranch: (branchId) =>
              ctx.app
                .service('branches')
                .get(
                  branchId,
                  freshMcpServiceParams(ctx) as Parameters<BranchesServiceImpl['get']>[1]
                ),
          })
        : undefined;

      // Build response with appropriate notes
      const response: Record<string, unknown> = { ...(readinessResult?.branch ?? branch) };

      const formattedReadiness = readinessResult ? readinessResponse(readinessResult) : undefined;
      if (formattedReadiness) response._readiness = formattedReadiness.readiness;

      if (branchName !== originalName) {
        response._note = `Name '${originalName}' was already taken. Created as '${branchName}' instead (autoSuffix applied).`;
      }

      if (teammateConfig) {
        // No warning => this teammate is the sole/first primary on its board
        // (freshly auto-created board, or an existing board with no prior
        // primary). A warning means the board already had a different primary.
        const becamePrimary = !primaryTeammateWarning;
        response._teammate = {
          created: true,
          display_name: teammateConfig.displayName,
          primary_board_id: boardId,
          is_board_primary_teammate: becamePrimary,
          note: becamePrimary
            ? 'Created as a long-lived Agor teammate and wired as the board primary teammate. The teammate Knowledge namespace was provisioned automatically.'
            : 'Created as a long-lived Agor teammate. Its Knowledge namespace was provisioned, but the target board already had a primary teammate so this teammate is NOT the board primary.',
        };

        if (createdBoard) {
          response._board = {
            created: true,
            board_id: createdBoard.board_id,
            name: createdBoard.name,
            note: 'A dedicated board was auto-created for this teammate (soft 1:1 teammate↔board convention).',
          };
        }

        if (primaryTeammateWarning) {
          response._warning = primaryTeammateWarning;
        }
      }

      if (zoneId) {
        response._zone = { zone_id: zoneId };
      } else {
        response.hint =
          'Use agor_branches_set_zone to pin this branch to a specific zone and optionally trigger zone prompt templates.';
      }

      return {
        ...textResult(response),
        ...(formattedReadiness?.isError ? { isError: true } : {}),
      };
    }
  );

  // Tool 4: agor_branches_update
  server.registerTool(
    'agor_branches_update',
    {
      description:
        'Update metadata for an existing branch (issue/PR URLs, notes, board placement, attention state, and custom context). Use agor_branches_permissions_update for access.',
      annotations: { idempotentHint: true },
      inputSchema: z.object({
        branchId: mcpOptionalId(
          'branchId',
          'Branch',
          'Branch ID to update. Optional when calling from a session with a bound branch.'
        ),
        issueUrl: z
          .string({ error: 'issueUrl must be a string or null when provided.' })
          .nullable()
          .optional()
          .describe('Issue URL to associate. Pass null to clear. Must be http(s) when provided.'),
        pullRequestUrl: z
          .string({ error: 'pullRequestUrl must be a string or null when provided.' })
          .nullable()
          .optional()
          .describe(
            'Pull request URL to associate. Pass null to clear. Must be http(s) when provided.'
          ),
        notes: z
          .string({ error: 'notes must be a string or null when provided.' })
          .nullable()
          .optional()
          .describe(
            'Freeform notes about the branch (markdown supported). Pass null or empty string to clear.'
          ),
        boardId: z
          .string({ error: 'boardId must be a string or null when provided.' })
          .nullable()
          .optional()
          .describe('Board ID to place this branch on. Pass null to remove from any board.'),
        customContext: z
          .record(z.string(), z.unknown())
          .nullable()
          .optional()
          .describe(
            'Custom context object for templates and automations. Pass null to clear existing context. ' +
              'Note: this cannot toggle a branch between teammate and non-teammate status — that flip is ' +
              'rejected. Create a teammate in one shot with the teammate param on agor_branches_create.'
          ),
        mcpServerIds: z
          .array(mcpRequiredId('mcpServerIds[]', 'MCP server', 'MCP server ID'))
          .nullable()
          .optional()
          .describe(
            'Default MCP server IDs for new sessions in this branch. Sessions inherit these unless they explicitly specify their own. Pass null to clear.'
          ),
        needsAttention: z
          .boolean({ error: 'needsAttention must be a boolean when provided.' })
          .optional()
          .describe(
            'Branch/card attention highlight state. Pass true to mark the branch as needing attention, or false to clear it.'
          ),
      }),
    },
    async (args) => {
      let resolvedBranchId: string;
      if (coerceString(args.branchId)) {
        resolvedBranchId = await resolveBranchId(ctx, coerceString(args.branchId)!);
      } else {
        if (!ctx.sessionId) return sessionContextRequiredResult();
        const currentSession = await ctx.app
          .service('sessions')
          .get(ctx.sessionId, ctx.baseServiceParams);
        const sessionBranchId = currentSession.branch_id;
        if (!sessionBranchId)
          throw new Error('branchId is required when current session is not bound to a branch');
        resolvedBranchId = sessionBranchId;
      }

      let fieldsProvided = 0;
      const updates: Record<string, unknown> = {};

      if (args.issueUrl !== undefined) {
        fieldsProvided++;
        updates.issue_url =
          args.issueUrl === null
            ? null
            : (normalizeOptionalHttpUrl(args.issueUrl, 'issueUrl') ?? null);
      }
      if (args.pullRequestUrl !== undefined) {
        fieldsProvided++;
        updates.pull_request_url =
          args.pullRequestUrl === null
            ? null
            : (normalizeOptionalHttpUrl(args.pullRequestUrl, 'pullRequestUrl') ?? null);
      }
      if (args.notes !== undefined) {
        fieldsProvided++;
        if (args.notes === null) {
          updates.notes = null;
        } else {
          const trimmed = typeof args.notes === 'string' ? args.notes.trim() : '';
          updates.notes = trimmed.length > 0 ? trimmed : null;
        }
      }
      if (args.boardId !== undefined) {
        fieldsProvided++;
        const boardIdStr = args.boardId === null ? null : coerceString(args.boardId);
        updates.board_id = boardIdStr ? await resolveBoardId(ctx, boardIdStr) : null;
      }
      if (args.customContext !== undefined) {
        if (containsTeammateKnowledgeConfigMutation(args.customContext)) {
          throw new Error(
            'Teammate Knowledge namespace configuration cannot be changed through MCP. Use the BranchModal Knowledge tab or API-only teammate Knowledge config endpoint.'
          );
        }
        fieldsProvided++;
        updates.custom_context = args.customContext === null ? null : args.customContext;
      }
      if (args.mcpServerIds !== undefined) {
        fieldsProvided++;
        updates.mcp_server_ids =
          args.mcpServerIds === null
            ? []
            : await Promise.all(args.mcpServerIds.map((id) => resolveMcpServerId(ctx, id)));
      }
      if (args.needsAttention !== undefined) {
        fieldsProvided++;
        updates.needs_attention = args.needsAttention;
      }
      if (fieldsProvided === 0) throw new Error('provide at least one field to update');

      const branch = (await ctx.app
        .service('branches')
        .patch(
          resolvedBranchId,
          updates as unknown as Partial<Branch>,
          ctx.baseServiceParams
        )) as Branch;

      return textResult({
        branch,
        note: 'Branch metadata updated successfully.',
      });
    }
  );

  server.registerTool(
    'agor_branches_permissions_update',
    {
      description:
        'Replace a branch permission package, including its inherit/override binding and shared-session switch. ' +
        'Read the current revision with agor_branches_get first. Primary ownership is immutable.',
      annotations: { idempotentHint: true },
      inputSchema: z.object({
        branchId: mcpRequiredId('branchId', 'Branch'),
        permissions: branchCapabilityPolicySchema,
      }),
    },
    async (args) => {
      const branchId = coerceString(args.branchId)!;
      const permissions = await ctx.app
        .service('branches/:id/permissions')
        .patch(null, args.permissions, { ...ctx.baseServiceParams, route: { id: branchId } });
      return textResult(permissions);
    }
  );

  // Tool 5: agor_branches_set_zone
  server.registerTool(
    'agor_branches_set_zone',
    {
      description:
        "Pin a branch to a zone on a board, clear its current zone pin with zoneId:null, and optionally trigger the zone's prompt template. Calculates zone center position automatically and creates board association. If the zone has an 'always_new' trigger, a new session is automatically created and the prompt template is executed (matching UI drag-drop behavior). For 'show_picker' zones, use triggerTemplate + targetSessionId to send to an existing session on the branch being moved (targetSessionId must live on that branch — cross-branch targets are rejected, since the trigger prompt acts on the moved branch's files). A remote orchestrator on a different branch does NOT target itself here; to be notified when the work finishes, register a completion callback instead (agor_sessions_create enableCallback/callbackSessionId, or agor_sessions_prompt callback).",
      inputSchema: z.object({
        branchId: mcpRequiredId(
          'branchId',
          'Branch',
          'Branch ID to pin to the zone (UUIDv7 or short ID)'
        ),
        zoneId: z
          .union([
            mcpRequiredString(
              'zoneId',
              'Zone ID to pin the branch to (e.g., "zone-1770152859108")'
            ),
            z.null(),
          ])
          .describe('Zone ID to pin the branch to, or null to clear the current zone pin.'),
        targetSessionId: mcpOptionalId(
          'targetSessionId',
          'Session',
          'Session ID to send the zone trigger prompt to (required if triggerTemplate is true). ' +
            'Must be a session on the branch being moved — cross-branch targets are rejected. ' +
            'For cross-branch completion notifications (e.g. a remote orchestrator), use a callback instead; see agor_sessions_create.'
        ),
        triggerTemplate: z
          .boolean()
          .optional()
          .describe(
            "Whether to execute the zone's prompt template after pinning (default: false). When true, sends the rendered template to targetSessionId. For zones with always_new triggers, this is handled automatically without needing to set this flag."
          ),
      }),
    },
    async (args) => {
      const branchIdInput = coerceString(args.branchId)!;
      const zoneId = args.zoneId === null ? null : coerceString(args.zoneId)!;
      const rawTargetSessionId = coerceString(args.targetSessionId);
      const triggerTemplate = args.triggerTemplate === true;

      if (zoneId === null && (triggerTemplate || rawTargetSessionId)) {
        throw new Error(
          'triggerTemplate and targetSessionId cannot be used when zoneId is null; clearing a zone pin does not run zone triggers.'
        );
      }

      // branches.get resolves short IDs and returns the canonical authorized
      // entity. Keep it for the rest of this operation instead of resolving
      // with one get and reading the same branch again below.
      const branch = await ctx.app.service('branches').get(branchIdInput, ctx.baseServiceParams);
      const branchId = branch.branch_id;
      const targetSession = rawTargetSessionId
        ? ((await ctx.app
            .service('sessions')
            .get(rawTargetSessionId, ctx.baseServiceParams)) as Pick<
            Session,
            'session_id' | 'branch_id' | 'description' | 'custom_context'
          >)
        : undefined;
      const targetSessionId = targetSession?.session_id;

      console.log(
        zoneId === null
          ? `📍 MCP clearing zone pin for branch ${shortId(branchId)}`
          : `📍 MCP pinning branch ${shortId(branchId)} to zone ${zoneId}`
      );

      if (triggerTemplate && targetSession && targetSession.branch_id !== branch.branch_id) {
        throw new Error(
          `targetSessionId ${shortId(targetSession.session_id)} belongs to branch ${shortId(
            targetSession.branch_id
          )}, but agor_branches_set_zone is moving branch ${shortId(
            branch.branch_id
          )}. Use a session in the moved branch or create a branch-local session first.`
        );
      }

      // Find or create board object for this branch
      const boardObjectsService = ctx.app.service('board-objects') as unknown as {
        findByBranchId: (
          branchId: BranchID,
          params?: unknown
        ) => Promise<import('@agor/core/types').BoardEntityObject | null>;
        create: (
          data: unknown,
          params?: unknown
        ) => Promise<import('@agor/core/types').BoardEntityObject>;
        patch: (
          objectId: string,
          data: Partial<Omit<import('@agor/core/types').BoardEntityObject, 'zone_id'>> & {
            zone_id?: string | null;
          },
          params?: unknown
        ) => Promise<import('@agor/core/types').BoardEntityObject>;
      };

      if (zoneId === null) {
        // findByBranchId is a custom (non-transport) method on the board-objects
        // service and reads `this.db` directly without an internal scope helper,
        // so enter the tenant DB scope for this read (the surrounding patch/create
        // are transport methods that enter it via their own hooks).
        const boardObject = await runWithMcpTenantDatabaseScope(ctx, () =>
          boardObjectsService.findByBranchId(branchId as BranchID, ctx.baseServiceParams)
        );
        if (!boardObject) {
          return textResult({
            branch,
            zone_id: null,
            note: 'Branch has no board object; no zone pin to clear.',
          });
        }

        const updatedBoardObject = await boardObjectsService.patch(
          boardObject.object_id,
          { zone_id: null },
          ctx.baseServiceParams
        );

        return textResult({
          branch,
          boardObject: updatedBoardObject,
          zone_id: null,
          note: 'Branch zone pin cleared.',
        });
      }

      if (!branch.board_id) {
        throw new Error('Branch must be on a board before it can be pinned to a zone');
      }

      // Get board to find zone definition
      const board = await ctx.app.service('boards').get(branch.board_id, ctx.baseServiceParams);

      const zone = board.objects?.[zoneId];
      if (zone?.type !== 'zone') {
        throw new Error(`Zone ${zoneId} not found on board ${branch.board_id}`);
      }

      // Calculate position RELATIVE to zone (not absolute canvas coordinates)
      // The UI expects relative positions and adds zone.x/zone.y when rendering
      const { x: relativeX, y: relativeY } = computeZoneRelativePosition(zone as ZoneBoardObject);

      let boardObject: import('@agor/core/types').BoardEntityObject | null =
        await runWithMcpTenantDatabaseScope(ctx, () =>
          boardObjectsService.findByBranchId(branchId as BranchID, ctx.baseServiceParams)
        );

      if (!boardObject) {
        // Create new board object
        boardObject = await boardObjectsService.create(
          {
            board_id: branch.board_id as BoardID,
            branch_id: branchId as BranchID,
            position: { x: relativeX, y: relativeY },
            zone_id: zoneId,
          },
          ctx.baseServiceParams
        );
      } else {
        // Update existing board object with zone and center position
        boardObject = await boardObjectsService.patch(
          boardObject.object_id,
          {
            position: { x: relativeX, y: relativeY },
            zone_id: zoneId,
          },
          ctx.baseServiceParams
        );
      }

      console.log(`✅ Branch pinned to zone at relative position (${relativeX}, ${relativeY})`);

      // Determine whether to fire zone trigger
      let promptResult:
        | {
            taskId?: string;
            sessionId?: string;
            queued?: boolean;
            queue_position?: number;
            note: string;
          }
        | undefined;

      const hasZoneTrigger = zone.trigger?.template && zone.trigger.template.trim().length > 0;
      const isAlwaysNew = hasZoneTrigger && zone.trigger!.behavior === 'always_new';

      if (triggerTemplate && targetSessionId && hasZoneTrigger) {
        // Case 1: Explicit trigger to an existing session
        console.log(`🎯 Triggering zone prompt template for session ${shortId(targetSessionId)}`);

        const { renderTemplate } = await import('@agor/core/templates/handlebars-helpers');
        const { buildZoneTriggerContext } = await import(
          '@agor/core/templates/zone-trigger-context'
        );

        // Pull the target session into the render context so templates can
        // reference `{{session.description}}` / `{{session.context.foo}}` —
        // matches what the UI's reuse-existing preview path does.
        const templateContext = buildZoneTriggerContext({
          branch,
          board,
          zone: { label: zone.label, status: zone.status },
          session: targetSession
            ? {
                description: targetSession.description,
                custom_context: targetSession.custom_context,
              }
            : undefined,
        });

        const renderedPrompt = renderTemplate(zone.trigger!.template, templateContext);

        if (renderedPrompt) {
          const task = await ctx.app
            .service('/sessions/:id/prompt')
            .create(
              { prompt: renderedPrompt, stream: true },
              { ...ctx.baseServiceParams, route: { id: targetSessionId } }
            );

          if (task.status === 'queued') {
            promptResult = {
              queued: true,
              taskId: task.task_id,
              queue_position: task.queue_position,
              sessionId: targetSessionId,
              note: 'Session is busy. Zone trigger prompt has been queued.',
            };
            console.log(
              `📬 Zone trigger queued for session ${shortId(targetSessionId)} at position ${task.queue_position}`
            );
          } else {
            promptResult = {
              taskId: task.task_id,
              sessionId: targetSessionId,
              note: 'Zone trigger prompt sent to target session',
            };
            console.log(`✅ Zone trigger executed: task ${shortId(task.task_id)}`);
          }
        } else {
          promptResult = {
            note: 'Zone trigger template rendered to empty string (check template syntax)',
          };
          console.warn('⚠️  Zone trigger template rendered to empty string');
        }
      } else if (isAlwaysNew) {
        // Case 2: always_new — delegate to the shared helper. Same code path
        // the daemon's POST /branches/:id/fire-zone-trigger uses, so MCP-
        // and UI-fired sessions stay in lockstep.
        console.log(
          `🎯 Zone has always_new trigger, auto-creating session for branch ${shortId(branchId)}`
        );

        try {
          const user = await ctx.app.service('users').get(ctx.userId, ctx.baseServiceParams);
          const { fireAlwaysNewZoneTrigger } = await import('../../services/zone-trigger.js');
          const { session: newSession, task } = await fireAlwaysNewZoneTrigger({
            app: ctx.app,
            params: ctx.baseServiceParams,
            branch,
            board,
            zone,
            user,
            userId: ctx.userId,
          });
          const agenticTool = newSession.agentic_tool;
          console.log(`✅ Auto-created session ${shortId(newSession.session_id)} (${agenticTool})`);
          promptResult = {
            taskId: task.task_id,
            sessionId: newSession.session_id,
            note: `always_new trigger: created session ${shortId(newSession.session_id)} (${agenticTool}) and sent prompt`,
          };
          console.log(`✅ Zone trigger executed: task ${shortId(task.task_id)}`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.includes('rendered to an empty prompt')) {
            promptResult = {
              note: 'Zone trigger template rendered to empty string (check template syntax)',
            };
            console.warn('⚠️  Zone trigger template rendered to empty string');
          } else {
            throw error;
          }
        }
      } else if (triggerTemplate && !hasZoneTrigger) {
        // Case 3: triggerTemplate requested but zone has no template configured
        promptResult = {
          note: `Zone "${zone.label}" has no trigger template configured. Add a trigger template to the zone via agor_boards_update first.`,
        };
      } else if (triggerTemplate && !targetSessionId) {
        // Case 3b: triggerTemplate requested but no targetSessionId on a non-always_new zone
        promptResult = {
          note: `Zone "${zone.label}" has a show_picker trigger. Provide a targetSessionId to send the prompt to, or use agor_sessions_create to make a new session first.`,
        };
      } else if (hasZoneTrigger && zone.trigger!.behavior === 'show_picker') {
        // Case 4: show_picker without explicit trigger — return trigger info for agent to decide
        promptResult = {
          note: `Zone "${zone.label}" has a show_picker trigger. Use triggerTemplate=true with a targetSessionId to execute, or use agor_sessions_create to make a new session first.`,
        };
      }

      return textResult({
        success: true,
        branch_id: branch.branch_id,
        zone_id: zoneId,
        position: { x: relativeX, y: relativeY },
        board_object_id: boardObject.object_id,
        ...(promptResult ? { trigger: promptResult } : {}),
      });
    }
  );

  // Tool 6: agor_branches_archive
  server.registerTool(
    'agor_branches_archive',
    {
      description:
        'Archive a branch (soft delete). Stops the environment if running, optionally cleans or deletes the filesystem, archives the branch metadata and all its sessions, and removes it from the board. Use agor_branches_unarchive to restore.',
      annotations: { destructiveHint: true },
      inputSchema: z.object({
        branchId: mcpRequiredId('branchId', 'Branch', 'Branch ID to archive (UUIDv7 or short ID)'),
        filesystemAction: z
          .enum(['preserved', 'cleaned', 'deleted'])
          .optional()
          .describe(
            'What to do with the branch files on disk. "preserved" leaves files untouched, "cleaned" runs git clean -fdx (removes node_modules, builds, untracked files), "deleted" removes the entire branch directory. Default: "cleaned".'
          ),
      }),
    },
    async (args) => {
      const branchId = await resolveBranchId(ctx, coerceString(args.branchId)!);
      const filesystemAction = (args.filesystemAction as BranchFilesystemAction) || 'cleaned';
      const result = await ctx.app
        .service('/branches/:id/archive-or-delete')
        .create(
          { metadataAction: 'archive', filesystemAction },
          { ...ctx.baseServiceParams, route: { id: branchId } }
        );
      return textResult({
        success: true,
        branch: result,
        message: 'Branch archived successfully.',
      });
    }
  );

  // Tool 7: agor_branches_unarchive
  server.registerTool(
    'agor_branches_unarchive',
    {
      description:
        'Restore a previously archived branch. Optionally place it back on a board. Also unarchives all sessions that were archived as part of the branch archival.',
      inputSchema: z.object({
        branchId: mcpRequiredId(
          'branchId',
          'Branch',
          'Branch ID to unarchive (UUIDv7 or short ID)'
        ),
        boardId: mcpOptionalId(
          'boardId',
          'Board',
          'Board ID to restore the branch onto (optional)'
        ),
      }),
    },
    async (args) => {
      const branchId = await resolveBranchId(ctx, coerceString(args.branchId)!);
      const boardIdStr = coerceString(args.boardId);
      const boardId = boardIdStr ? await resolveBoardId(ctx, boardIdStr) : undefined;
      const branchesService = ctx.app.service('branches') as unknown as BranchesServiceImpl;
      const result = await branchesService.unarchive(
        branchId as BranchID,
        boardId ? { boardId: boardId as BoardID } : undefined,
        ctx.baseServiceParams
      );
      return textResult({
        success: true,
        branch: result,
        message: 'Branch unarchived successfully.',
      });
    }
  );

  // Tool 8: agor_branches_delete
  server.registerTool(
    'agor_branches_delete',
    {
      description:
        'Permanently delete a branch and all its sessions, messages, and tasks. This action cannot be undone. Stops the environment if running and optionally removes files from disk.',
      annotations: { destructiveHint: true },
      inputSchema: z.object({
        branchId: mcpRequiredId('branchId', 'Branch', 'Branch ID to delete (UUIDv7 or short ID)'),
        filesystemAction: z
          .enum(['preserved', 'deleted'])
          .optional()
          .describe(
            'What to do with the branch files on disk. "preserved" leaves files untouched, "deleted" removes the entire branch directory. Default: "deleted".'
          ),
      }),
    },
    async (args) => {
      const branchId = await resolveBranchId(ctx, coerceString(args.branchId)!);
      const filesystemAction = (args.filesystemAction as BranchFilesystemAction) || 'deleted';
      await ctx.app
        .service('/branches/:id/archive-or-delete')
        .create(
          { metadataAction: 'delete', filesystemAction },
          { ...ctx.baseServiceParams, route: { id: branchId } }
        );
      return textResult({
        success: true,
        branch_id: branchId,
        message: 'Branch permanently deleted.',
      });
    }
  );

  const listTeammatesHandler = async (args: {
    repoId?: string;
    limit?: number;
    offset?: number;
  }) => {
    const limit = args.limit ?? 25;
    const offset = args.offset ?? 0;
    const repoId = args.repoId ? await resolveRepoId(ctx, args.repoId) : undefined;

    const userScoped = await shouldScopeTeammateDiscoveryToUser(ctx);
    const teammates = await runWithMcpTenantDatabaseScope(ctx, (db) =>
      new BranchRepository(db).findTeammateBranches({
        archived: false,
        ...(repoId ? { repo_id: repoId as UUID } : {}),
        ...(userScoped ? { userId: ctx.userId as UUID } : {}),
        // One-row look-ahead supplies hasMore without loading the full set.
        // Tenant/RBAC predicates are applied by the repository before paging.
        limit: limit + 1,
        offset,
      })
    );

    const shaped = teammates.map((w) => {
      const config = getTeammateConfig(w);
      return {
        branch_id: w.branch_id,
        name: w.name,
        display_name: config?.displayName ?? w.name,
        emoji: config?.emoji,
        description: w.notes || null,
        board_id: w.board_id || null,
        repo_id: w.repo_id,
        last_used: w.last_used,
      };
    });

    const hasMore = shaped.length > limit;
    const page = shaped.slice(0, limit);
    return textResult({
      total: hasMore ? null : offset + page.length,
      limit,
      offset,
      hasMore,
      nextOffset: hasMore ? offset + page.length : null,
      teammates: page,
    });
  };

  // Tool 9: agor_teammates_list
  server.registerTool(
    'agor_teammates_list',
    {
      description:
        'List a page of teammates (long-lived AI teammates with schedules). Authorization is applied before paging. Advance with offset=nextOffset while hasMore is true.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        repoId: mcpOptionalId('repoId', 'Repository', 'Filter teammates by repository ID'),
        limit: mcpLimit(25, 100),
        offset: mcpOffset(0),
      }),
    },
    listTeammatesHandler
  );
}
