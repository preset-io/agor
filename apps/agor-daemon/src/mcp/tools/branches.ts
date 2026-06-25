import { existsSync } from 'node:fs';
import { isBranchRbacEnabled, loadConfig } from '@agor/core/config';
import { BranchRepository, shortId } from '@agor/core/db';
import type {
  BoardID,
  Branch,
  BranchID,
  Repo,
  Session,
  UUID,
  ZoneBoardObject,
} from '@agor/core/types';
import { BRANCH_PERMISSION_LEVELS, getAssistantConfig, isAssistant } from '@agor/core/types';
import { computeZoneRelativePosition } from '@agor/core/utils/board-placement';
import { normalizeOptionalHttpUrl } from '@agor/core/utils/url';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { BranchesServiceImpl, ReposServiceImpl } from '../../declarations.js';
import type { BranchParams } from '../../services/branches.js';
import { isSuperAdmin } from '../../utils/branch-authorization.js';
import {
  resolveBoardId,
  resolveBranchId,
  resolveMcpServerId,
  resolveRepoId,
} from '../resolve-ids.js';
import {
  mcpLimit,
  mcpOptionalId,
  mcpOptionalNonNegativeInt,
  mcpOptionalPositiveInt,
  mcpOptionalString,
  mcpRequiredId,
  mcpRequiredString,
} from '../schema.js';
import type { McpContext } from '../server.js';
import { coerceString, sessionContextRequiredResult, textResult } from '../server.js';
import { assertValidVariant } from './_environment-helpers.js';

const BRANCH_NAME_PATTERN = /^[a-z0-9-]+$/;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;
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

function containsAssistantKnowledgeConfigMutation(customContext: unknown): boolean {
  if (!customContext || typeof customContext !== 'object' || Array.isArray(customContext)) {
    return false;
  }
  const record = customContext as Record<string, unknown>;
  for (const key of ['assistant', 'agent']) {
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

async function shouldScopeAssistantDiscoveryToUser(ctx: McpContext): Promise<boolean> {
  if (!isBranchRbacEnabled()) return false;
  if (ctx.authenticatedUser?._isServiceAccount) return false;

  const config = await loadConfig();
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
      return textResult(branch);
    }
  );

  // Tool 2: agor_branches_list
  server.registerTool(
    'agor_branches_list',
    {
      description:
        'List all branches in a repository. Each branch includes zone_id and zone_label when ' +
        'the branch is assigned to a board zone — use these fields directly to identify which ' +
        'zone a branch is in without extra agor_branches_get calls. Also includes ' +
        'pull_request_url, issue_url, board_object_id, and position when set.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        repoId: mcpOptionalId('repoId', 'Repository', 'Repository ID to filter by'),
        limit: mcpLimit(50),
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
      if (args.limit) query.$limit = args.limit;
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
        'and excludes assistant/private branches by default. It returns repo metadata, archive timestamps, ' +
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
        excludeAssistants: z
          .boolean()
          .optional()
          .describe('Exclude long-lived assistant branches. Default: true.'),
        excludePrivate: z
          .boolean()
          .optional()
          .describe('Exclude branches with others_can="none" (private to owners). Default: true.'),
        pathExists: z
          .boolean()
          .optional()
          .describe(
            'Filter by whether the recorded branch path currently exists. This checks the exact stored path; it does not scan the filesystem.'
          ),
        limit: mcpLimit(50),
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
      const excludeAssistants = args.excludeAssistants ?? true;
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

      const filtered = branches
        .map((branch) => {
          const pathExists = branch.path ? existsSync(branch.path) : false;
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
          if (excludeAssistants && isAssistant(branch)) return false;
          if (excludePrivate && branch.others_can === 'none') return false;
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
        is_assistant: isAssistant(branch),
        is_private: branch.others_can === 'none',
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
          exclude_assistants: excludeAssistants,
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
        'For zone trigger behavior (prompt templates), use agor_branches_set_zone after creation.',
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
        boardId: mcpRequiredId(
          'boardId',
          'Board',
          'Board ID to place the branch on (positions to default coordinates). Required to ensure branches are visible in the UI.'
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
      }),
    },
    async (args) => {
      const repoId = await resolveRepoId(ctx, coerceString(args.repoId)!);
      let branchName = coerceString(args.branchName)!;
      const originalName = branchName;
      const boardId = await resolveBoardId(ctx, coerceString(args.boardId)!);
      if (!boardId) throw new Error('boardId is required');
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

      // Auto-suffix: resolve name conflicts by appending -2, -3, etc.
      // Uses direct DB query to bypass Feathers pagination limits
      if (autoSuffix) {
        const branchRepo = new BranchRepository(ctx.db);
        const activeNames = await branchRepo.getActiveNamesByRepo(repoId as UUID);
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

      const branch = await reposService.createBranch(
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
        },
        ctx.baseServiceParams
      );

      // Build response with appropriate notes
      const response: Record<string, unknown> = { ...branch };

      if (branchName !== originalName) {
        response._note = `Name '${originalName}' was already taken. Created as '${branchName}' instead (autoSuffix applied).`;
      }

      if (zoneId) {
        response._zone = { zone_id: zoneId };
      } else {
        response.hint =
          'Use agor_branches_set_zone to pin this branch to a specific zone and optionally trigger zone prompt templates.';
      }

      return textResult(response);
    }
  );

  // Tool 4: agor_branches_update
  server.registerTool(
    'agor_branches_update',
    {
      description:
        'Update metadata for an existing branch (issue/PR URLs, notes, board placement, custom context, RBAC permissions, owners)',
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
            'Custom context object for templates and automations. Pass null to clear existing context.'
          ),
        mcpServerIds: z
          .array(mcpRequiredId('mcpServerIds[]', 'MCP server', 'MCP server ID'))
          .nullable()
          .optional()
          .describe(
            'Default MCP server IDs for new sessions in this branch. Sessions inherit these unless they explicitly specify their own. Pass null to clear.'
          ),
        // RBAC fields (optional, safe to ignore for single-user setups)
        othersCan: z
          .enum(BRANCH_PERMISSION_LEVELS)
          .optional()
          .describe(
            'App-layer permission for non-owner users. ' +
              '"none" = no access, "view" = read-only, "session" = can create & prompt own sessions, ' +
              '"prompt" = can prompt ANY session (including other users\'), "all" = full access. ' +
              'Always effective regardless of Unix isolation mode. Single-user setups can ignore this.'
          ),
        othersFsAccess: z
          .enum(['none', 'read', 'write'])
          .optional()
          .describe(
            'OS-level filesystem permission for non-owner users. ' +
              '"none" = no filesystem access, "read" = read-only, "write" = read-write. ' +
              'Only effective when Unix isolation (AGOR_UNIX_MODE) is configured. ' +
              'Has no effect in simple mode. Single-user setups can ignore this.'
          ),
        addOwnerIds: z
          .array(mcpRequiredId('addOwnerIds[]', 'User', 'User ID'))
          .optional()
          .describe(
            'User IDs to ADD as owners of this branch. ' +
              'Owners have full access regardless of othersCan/othersFsAccess settings. ' +
              'Idempotent — adding an existing owner is a no-op.'
          ),
        removeOwnerIds: z
          .array(mcpRequiredId('removeOwnerIds[]', 'User', 'User ID'))
          .optional()
          .describe(
            'User IDs to REMOVE as owners of this branch. ' +
              'Idempotent — removing a non-owner is a no-op.'
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
        if (containsAssistantKnowledgeConfigMutation(args.customContext)) {
          throw new Error(
            'Assistant Knowledge namespace configuration cannot be changed through MCP. Use the BranchModal Knowledge tab or API-only assistant Knowledge config endpoint.'
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
      if (args.othersCan !== undefined) {
        fieldsProvided++;
        updates.others_can = args.othersCan;
      }
      if (args.othersFsAccess !== undefined) {
        fieldsProvided++;
        updates.others_fs_access = args.othersFsAccess;
      }
      const hasOwnerChanges =
        (args.addOwnerIds && args.addOwnerIds.length > 0) ||
        (args.removeOwnerIds && args.removeOwnerIds.length > 0);
      if (hasOwnerChanges) fieldsProvided++;

      if (fieldsProvided === 0) throw new Error('provide at least one field to update');

      // Patch branch fields (skip if only owner changes)
      let branch: Branch;
      if (Object.keys(updates).length > 0) {
        branch = (await ctx.app
          .service('branches')
          .patch(
            resolvedBranchId as string,
            updates as unknown as Partial<Branch>,
            ctx.baseServiceParams
          )) as Branch;
      } else {
        branch = (await ctx.app
          .service('branches')
          .get(resolvedBranchId as string, ctx.baseServiceParams)) as Branch;
      }

      // Handle owner additions/removals via the owners service (includes unix sync hooks)
      const ownerErrors: string[] = [];
      if (hasOwnerChanges) {
        if (!isBranchRbacEnabled()) {
          ownerErrors.push(
            'Owner changes ignored: branch RBAC is not enabled. Enable branch_rbac in config to manage owners.'
          );
        } else {
          const branchOwnersService = ctx.app.service('branches/:id/owners');
          // Use full UUID from resolved branch (not the potentially-short input ID)
          const routeParams = {
            ...ctx.baseServiceParams,
            route: { id: branch.branch_id },
          };

          if (args.addOwnerIds) {
            for (const ownerId of args.addOwnerIds) {
              try {
                await branchOwnersService.create({ user_id: ownerId }, routeParams);
              } catch (error) {
                ownerErrors.push(
                  `Failed to add owner ${ownerId}: ${error instanceof Error ? error.message : String(error)}`
                );
              }
            }
          }

          if (args.removeOwnerIds) {
            for (const ownerId of args.removeOwnerIds) {
              try {
                await branchOwnersService.remove(ownerId, routeParams);
              } catch (error) {
                ownerErrors.push(
                  `Failed to remove owner ${ownerId}: ${error instanceof Error ? error.message : String(error)}`
                );
              }
            }
          }
        }
      }

      return textResult({
        branch,
        note: 'Branch metadata updated successfully.',
        ...(ownerErrors.length > 0 ? { ownerWarnings: ownerErrors } : {}),
      });
    }
  );

  // Tool 5: agor_branches_set_zone
  server.registerTool(
    'agor_branches_set_zone',
    {
      description:
        "Pin a branch to a zone on a board, clear its current zone pin with zoneId:null, and optionally trigger the zone's prompt template. Calculates zone center position automatically and creates board association. If the zone has an 'always_new' trigger, a new session is automatically created and the prompt template is executed (matching UI drag-drop behavior). For 'show_picker' zones, use triggerTemplate + targetSessionId to send to an existing session.",
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
          'Session ID to send the zone trigger prompt to (required if triggerTemplate is true)'
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
      const branchId = await resolveBranchId(ctx, coerceString(args.branchId)!);
      const zoneId = args.zoneId === null ? null : coerceString(args.zoneId)!;
      const rawTargetSessionId = coerceString(args.targetSessionId);
      const triggerTemplate = args.triggerTemplate === true;

      if (zoneId === null && (triggerTemplate || rawTargetSessionId)) {
        throw new Error(
          'triggerTemplate and targetSessionId cannot be used when zoneId is null; clearing a zone pin does not run zone triggers.'
        );
      }

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

      // Get branch to find its board
      const branch = await ctx.app.service('branches').get(branchId, ctx.baseServiceParams);

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
        const boardObject = await boardObjectsService.findByBranchId(
          branchId as BranchID,
          ctx.baseServiceParams
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
        await boardObjectsService.findByBranchId(branchId as BranchID, ctx.baseServiceParams);

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
      const filesystemAction =
        (args.filesystemAction as 'preserved' | 'cleaned' | 'deleted') || 'cleaned';
      const branchesService = ctx.app.service('branches') as unknown as BranchesServiceImpl;
      const result = await branchesService.archiveOrDelete(
        branchId as BranchID,
        { metadataAction: 'archive', filesystemAction },
        ctx.baseServiceParams
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
      const filesystemAction = (args.filesystemAction as 'preserved' | 'deleted') || 'deleted';
      const branchesService = ctx.app.service('branches') as unknown as BranchesServiceImpl;
      await branchesService.archiveOrDelete(
        branchId as BranchID,
        { metadataAction: 'delete', filesystemAction },
        ctx.baseServiceParams
      );
      return textResult({
        success: true,
        branch_id: branchId,
        message: 'Branch permanently deleted.',
      });
    }
  );

  // Tool 9: agor_assistants_list
  server.registerTool(
    'agor_assistants_list',
    {
      description:
        "List all assistants (long-lived agents with schedules). Returns each assistant's name, description, schedule status, and last activity timestamp. Use this to discover other assistants on the platform.",
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        repoId: mcpOptionalId('repoId', 'Repository', 'Filter assistants by repository ID'),
        limit: mcpLimit(200),
      }),
    },
    async (args) => {
      const limit = args.limit || 200;
      const repoId = args.repoId ? await resolveRepoId(ctx, args.repoId) : undefined;

      const branchRepo = new BranchRepository(ctx.db);
      const assistants = await branchRepo.findAssistantBranches({
        archived: false,
        ...(repoId ? { repo_id: repoId as UUID } : {}),
        ...((await shouldScopeAssistantDiscoveryToUser(ctx)) ? { userId: ctx.userId as UUID } : {}),
        limit,
      });

      // Per-branch schedule fields are now in the first-class `schedules`
      // table; consumers should call `agor_schedules_list({branchId})`
      // for that. This tool keeps the assistant-discovery shape lean and
      // omits the (now-multiplexed) schedule summary.
      const shaped = assistants.map((w) => {
        const config = getAssistantConfig(w);
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

      return textResult({
        total: shaped.length,
        assistants: shaped,
      });
    }
  );
}
