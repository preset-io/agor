/**
 * Repos Service
 *
 * Provides REST + WebSocket API for repository management.
 * Uses DrizzleService adapter with RepoRepository.
 *
 * Git operations (clone, worktree add) are delegated to the executor process
 * for proper Unix isolation. The executor handles filesystem operations while
 * the daemon handles database records and business logic.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  extractSlugFromUrl,
  isValidGitUrl,
  isValidSlug,
  isWorktreeRbacEnabled,
  normalizeRepoUrl,
  PAGINATION,
  parseAgorYml,
  writeAgorYml,
} from '@agor/core/config';
import { type Database, RepoRepository, WorktreeRepository } from '@agor/core/db';
import { autoAssignWorktreeUniqueId } from '@agor/core/environment/variable-resolver';
import { type Application, Forbidden, NotAuthenticated } from '@agor/core/feathers';
import {
  getDefaultBranch,
  getRemoteUrl,
  getWorktreePath,
  isValidGitRepo,
  listWorktrees,
  simpleGit,
} from '@agor/core/git';
import type {
  AuthenticatedParams,
  QueryParams,
  Repo,
  RepoEnvironment,
  RepoSlug,
  UserID,
  UUID,
  Worktree,
  WorktreePermissionLevel,
} from '@agor/core/types';
import { DrizzleService } from '../adapters/drizzle';
import { resolveGitImpersonationForUser } from '../utils/git-impersonation.js';
import {
  generateSessionToken,
  getDaemonUrl,
  spawnExecutorFireAndForget,
} from '../utils/spawn-executor.js';

/**
 * Repo service params
 */
export type RepoParams = QueryParams<{
  slug?: string;
  managed_by_agor?: boolean;
  cleanup?: boolean; // For delete operations: true = delete filesystem, false = database only
}>;

async function deriveLocalRepoSlug(path: string, explicitSlug?: string): Promise<RepoSlug> {
  if (explicitSlug) {
    if (!isValidSlug(explicitSlug)) {
      throw new Error(`Invalid slug format: ${explicitSlug}`);
    }
    return explicitSlug as RepoSlug;
  }

  const toLocalSlug = (base: string): RepoSlug => {
    const [_, repoNameRaw] = base.split('/');
    const repoName = repoNameRaw ?? base;
    const sanitized = repoName
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '');

    if (!sanitized) {
      throw new Error('Could not derive a valid slug from local repository name');
    }

    return `local/${sanitized}` as RepoSlug;
  };

  const remoteUrl = await getRemoteUrl(path);
  if (remoteUrl && isValidGitUrl(remoteUrl)) {
    try {
      const remoteSlug = extractSlugFromUrl(remoteUrl);
      return toLocalSlug(remoteSlug);
    } catch {
      // fall through to error below
    }
  }

  throw new Error(
    `Could not auto-detect slug for local repository at ${path}.\nUse --slug to provide one explicitly`
  );
}

/**
 * Extended repos service with custom methods
 */
export class ReposService extends DrizzleService<Repo, Partial<Repo>, RepoParams> {
  private repoRepo: RepoRepository;
  private app: Application;
  private db: Database;

  constructor(db: Database, app: Application) {
    const repoRepo = new RepoRepository(db);
    super(repoRepo, {
      id: 'repo_id',
      resourceType: 'Repo',
      paginate: {
        default: PAGINATION.DEFAULT_LIMIT,
        max: PAGINATION.MAX_LIMIT,
      },
    });

    this.repoRepo = repoRepo;
    this.app = app;
    this.db = db;
  }

  /**
   * Custom method: Find repo by slug
   */
  async findBySlug(slug: string, _params?: RepoParams): Promise<Repo | null> {
    return this.repoRepo.findBySlug(slug);
  }

  /**
   * Custom method: Clone repository (fire-and-forget)
   *
   * Spawns executor to handle everything:
   * - Git clone
   * - Parse .agor.yml
   * - Create DB record via Feathers
   * - Initialize Unix group
   *
   * Returns immediately with { status: 'pending' }.
   * Client receives 'repos.created' WebSocket event when complete.
   */
  async cloneRepository(
    data: { url: string; slug?: string; name?: string; default_branch?: string },
    params?: RepoParams
  ): Promise<{ status: 'pending' | 'exists'; slug: string }> {
    // Note: `||` (not `??`) is intentional — we want an empty `data.slug`
    // to fall through to derivation rather than be treated as "explicit".
    let slug = data.slug || data.name;
    if (!slug) {
      // Normalize URL (strip trailing slashes and `.git`) using the shared
      // canonical form, so UI and daemon cannot drift.
      slug = extractSlugFromUrl(normalizeRepoUrl(data.url));
    }
    if (!slug || !isValidSlug(slug)) {
      throw new Error('Could not derive a valid slug from URL. Please provide a slug.');
    }

    // If repo with this slug already exists, this is a no-op but we surface
    // it as `status: 'exists'` (rather than `pending`) so callers can give
    // users immediate feedback — otherwise the UI would wait indefinitely
    // for a `repos.created` event that will never fire.
    const existing = await this.repoRepo.findBySlug(slug);
    if (existing) {
      return { status: 'exists', slug };
    }

    const userId = (params as AuthenticatedParams | undefined)?.user?.user_id as UserID | undefined;

    // Generate service JWT for executor authentication. The executor talks back
    // to the daemon to create the repo record (which may include
    // environment_config from .agor.yml) and patch status — operations that
    // materialize admin-defined templates rather than user edits. Using a
    // service token ensures hooks like requireAdminForEnvConfig bypass via
    // _isServiceAccount. Executor fetches per-user credentials via Feathers
    // RPC (users.getGitEnvironment) using the same service JWT.
    const sessionToken = generateSessionToken(
      this.app as unknown as { settings: { authentication?: { secret?: string } } }
    );

    // Check if Unix group isolation should be initialized
    const rbacEnabled = isWorktreeRbacEnabled();

    // Resolve Unix user for impersonation (handles simple/insulated/strict modes)
    const asUser = userId ? await resolveGitImpersonationForUser(this.db, userId) : undefined;

    // Fire and forget - spawn executor and return immediately.
    // Executor handles: git clone, .agor.yml parsing, DB record creation.
    // Executor fetches per-user credentials via Feathers RPC (users.getGitEnvironment).
    // Unix group init (groupadd/chgrp/setfacl) runs daemon-side via repos.initializeUnixGroup RPC.
    const app = this.app;
    spawnExecutorFireAndForget(
      {
        command: 'git.clone',
        sessionToken,
        daemonUrl: getDaemonUrl(),
        params: {
          url: data.url,
          slug,
          // Forward the user-supplied default_branch so the executor
          // persists what the operator typed in "Add Repository" instead
          // of silently overwriting it with origin/HEAD.
          ...(data.default_branch ? { default_branch: data.default_branch } : {}),
          createDbRecord: true,
          userId: userId as string | undefined,
          initUnixGroup: rbacEnabled,
        },
      },
      {
        logPrefix: `[clone ${slug}]`,
        asUser, // Run as resolved user (fresh groups via sudo -u)
        onExit: (code) => {
          if (code !== 0 && code !== null) {
            // Broadcast clone failure to all connected clients
            console.error(
              `[clone ${slug}] Clone failed with exit code ${code}, broadcasting error`
            );
            const io = (app as unknown as { io?: { emit: (event: string, data: unknown) => void } })
              .io;
            if (io) {
              // Include the pinned branch in the message so an operator who
              // typo'd the Default Branch can self-diagnose. `git clone
              // --branch <X>` failure is one of the most common reasons a
              // clone exits non-zero, but the executor's stderr is consumed
              // by spawnExecutorFireAndForget — without this hint the user
              // sees only "Clone failed (exit code 128)" and has no idea
              // the branch field is the cause.
              const branchHint = data.default_branch
                ? ` Default Branch was set to '${data.default_branch}' — verify it exists on the remote.`
                : '';
              io.emit('repo:cloneError', {
                slug,
                url: data.url,
                error: `Clone failed (exit code ${code}). Check that the repository URL is correct and accessible.${branchHint}`,
              });
            }
          }
        },
      }
    );

    // Return immediately - client will receive WebSocket event when repo is created
    return { status: 'pending', slug };
  }

  /**
   * Custom method: Initialize Unix group for a repo (daemon-side privileged operation).
   *
   * Called by the executor via Feathers RPC after cloning a repo, so that
   * groupadd/chgrp/setfacl run with daemon sudo privileges regardless of
   * executor impersonation mode.
   *
   * Auth: only service accounts (executor JWTs) may invoke this externally.
   * Internal calls (no `provider`) pass through.
   */
  async initializeUnixGroup(
    data: { repoId: string; userId?: string },
    params?: RepoParams
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

    const { initializeRepoUnixGroup } = await import('../utils/unix-group-init.js');
    const unixGroup = await initializeRepoUnixGroup(this.db, this.app, data.repoId, data.userId);
    return { unixGroup };
  }

  /**
   * Custom method: Register an existing local repository
   */
  async addLocalRepository(
    data: { path: string; slug?: string },
    params?: RepoParams
  ): Promise<Repo> {
    if (!data.path) {
      throw new Error('Path is required to add a local repository');
    }

    let inputPath = data.path.trim();
    if (!inputPath) {
      throw new Error('Path is required to add a local repository');
    }

    // Expand leading ~ to user's home directory
    if (inputPath.startsWith('~')) {
      const homeDir = homedir();
      inputPath = path.join(homeDir, inputPath.slice(1).replace(/^[/\\]?/, ''));
    }

    if (!path.isAbsolute(inputPath)) {
      throw new Error(`Path must be absolute: ${inputPath}`);
    }

    const repoPath = path.resolve(inputPath);

    const isValidRepo = await isValidGitRepo(repoPath);
    if (!isValidRepo) {
      throw new Error(`Not a valid git repository: ${repoPath}`);
    }

    const slug = await deriveLocalRepoSlug(repoPath, data.slug);

    const existing = await this.repoRepo.findBySlug(slug);
    if (existing) {
      throw new Error(
        `Repository '${slug}' already exists.\nUse a different slug with: --slug custom/name`
      );
    }

    const defaultBranch = await getDefaultBranch(repoPath);

    const agorYmlPath = path.join(repoPath, '.agor.yml');
    let environment: RepoEnvironment | undefined;

    try {
      const parsed = parseAgorYml(agorYmlPath);
      if (parsed) {
        environment = parsed;
        console.log(`✅ Loaded environment config from .agor.yml for ${slug}`);
      }
    } catch (error) {
      console.warn(
        `⚠️  Failed to parse .agor.yml for ${slug}:`,
        error instanceof Error ? error.message : String(error)
      );
    }

    const remoteUrl = (await getRemoteUrl(repoPath)) ?? undefined;
    const name = slug.split('/').pop() ?? slug;

    const repo = (await this.create(
      {
        repo_type: 'local',
        slug,
        name,
        remote_url: remoteUrl,
        local_path: repoPath,
        default_branch: defaultBranch,
        environment,
      },
      params
    )) as Repo;

    // TODO: Unix group initialization for local repos
    // For local repos, Unix group init should also go through executor.
    // Currently, local repos don't trigger git operations via executor,
    // so we'd need a separate executor command (e.g., 'unix.init-repo-group').
    // For now, local repos don't get Unix group isolation automatically.
    // Use `agor admin sync-unix` to initialize groups for existing repos.

    return repo;
  }

  /**
   * Custom method: Create worktree
   *
   * Delegates git worktree add to executor process for Unix isolation.
   * Executor handles filesystem operations, daemon handles DB record creation
   * and template rendering.
   */
  async createWorktree(
    id: string,
    data: {
      name: string;
      ref: string;
      refType?: 'branch' | 'tag';
      createBranch?: boolean;
      pullLatest?: boolean;
      sourceBranch?: string;
      issue_url?: string;
      pull_request_url?: string;
      boardId?: string;
      zoneId?: string;
      others_can?: WorktreePermissionLevel;
      others_fs_access?: 'none' | 'read' | 'write';
    },
    params?: RepoParams
  ): Promise<Worktree> {
    const repo = await this.get(id, params);

    console.log('🔍 RepoService.createWorktree - repo lookup result:', {
      repo_id: repo.repo_id,
      slug: repo.slug,
      local_path: repo.local_path,
      remote_url: repo.remote_url,
    });

    // Check for duplicate worktree name in this repo (non-archived only)
    const worktreeRepo = new WorktreeRepository(this.db);
    const existingWorktree = await worktreeRepo.findActiveByRepoAndName(
      repo.repo_id as UUID,
      data.name
    );
    if (existingWorktree) {
      throw new Error(`A worktree named '${data.name}' already exists in this repository`);
    }

    // Pre-flight checks: validate git state before creating DB record
    // This gives the user immediate feedback instead of a silent fire-and-forget failure
    if (repo.local_path) {
      try {
        const git = simpleGit(repo.local_path);

        // Check 1: Validate sourceBranch exists on remote (if specified)
        // Skip for tags — tags are validated differently (they don't have origin/ prefix)
        if (data.sourceBranch && data.createBranch && data.refType !== 'tag') {
          try {
            await git.fetch(['origin']);
            const remoteBranches = await git.branch(['-r']);
            const remoteRef = `origin/${data.sourceBranch}`;
            if (!remoteBranches.all.includes(remoteRef)) {
              // Also check local branches as fallback
              const localBranches = await git.branch();
              if (!localBranches.all.includes(data.sourceBranch)) {
                throw new Error(
                  `Source branch '${data.sourceBranch}' does not exist on remote or locally. ` +
                    `Available remote branches can be listed with 'git branch -r'. ` +
                    `Please specify a valid sourceBranch.`
                );
              }
            }
          } catch (error) {
            if (
              error instanceof Error &&
              error.message.includes('does not exist on remote or locally')
            ) {
              throw error;
            }
            // Fetch failed — log warning but continue (executor will retry)
            console.warn(
              `⚠️  Pre-flight sourceBranch check failed (continuing anyway):`,
              error instanceof Error ? error.message : String(error)
            );
          }
        }

        // Check 2: Detect stale or conflicting branches
        if (data.createBranch) {
          const branches = await git.branch();
          const branchName = data.ref || data.name;

          if (branches.all.includes(branchName)) {
            // Branch exists — check if it's in use by another worktree
            const gitWorktrees = await listWorktrees(repo.local_path);
            const branchInUse = gitWorktrees.some((wt: { ref?: string }) => wt.ref === branchName);

            if (branchInUse) {
              throw new Error(
                `A branch named '${branchName}' already exists and is in use by another worktree. Please choose a different name.`
              );
            }

            // Branch exists but is orphaned — the executor will clean it up automatically
            console.log(
              `⚠️  Branch '${branchName}' exists but is orphaned (stale). Executor will clean it up.`
            );
          }
        }
      } catch (error) {
        // Re-throw user-facing errors
        if (
          error instanceof Error &&
          (error.message.includes('already exists and is in use') ||
            error.message.includes('does not exist on remote or locally'))
        ) {
          throw error;
        }
        // Log but don't block creation for other git errors (e.g., repo not accessible)
        console.warn(
          `⚠️  Pre-flight branch check failed (continuing anyway):`,
          error instanceof Error ? error.message : String(error)
        );
      }
    }

    // Validate boardId exists before creating DB record (FK constraint would reject it)
    // Board is stored for later use in smart positioning
    let board: { objects?: Record<string, { type?: string }> } | undefined;
    if (data.boardId) {
      try {
        board = await this.app.service('boards').get(data.boardId, params);
      } catch {
        throw new Error(
          `Board '${data.boardId}' not found. Provide a valid boardId ` +
            `(use agor_boards_list to see available boards).`
        );
      }

      // Validate zoneId exists on the board
      if (data.zoneId && board) {
        const zone = board.objects?.[data.zoneId];
        if (!zone || zone.type !== 'zone') {
          throw new Error(
            `Zone '${data.zoneId}' not found on board '${data.boardId}'. ` +
              `Provide a valid zoneId from the board's zone objects.`
          );
        }
      }
    }

    const worktreePath = getWorktreePath(repo.slug, data.name);

    // Fail-fast: check if target directory already exists on disk
    if (existsSync(worktreePath)) {
      throw new Error(
        `Target directory '${worktreePath}' already exists on disk. ` +
          `This usually means an archived or partially-cleaned worktree still occupies this path. ` +
          `Please choose a different name or clean up the existing directory.`
      );
    }

    // Fail-fast: check if the branch is already checked out by another git worktree
    // (covers non-createBranch cases not handled by the pre-flight check above)
    if (!data.createBranch && repo.local_path) {
      try {
        const gitWorktrees = await listWorktrees(repo.local_path);
        const branchInUse = gitWorktrees.some((wt: { ref?: string }) => wt.ref === data.ref);
        if (branchInUse) {
          throw new Error(
            `Branch '${data.ref}' is already checked out by another worktree. ` +
              `Git does not allow the same branch to be checked out in multiple worktrees. ` +
              `Please choose a different branch or create a new branch.`
          );
        }
      } catch (error) {
        if (error instanceof Error && error.message.includes('already checked out')) {
          throw error;
        }
        // Don't block creation for transient git errors
        console.warn(
          `⚠️  Pre-flight branch checkout check failed (continuing anyway):`,
          error instanceof Error ? error.message : String(error)
        );
      }
    }

    console.log('🔍 RepoService.createWorktree - computed paths:', {
      worktreePath,
      repoLocalPath: repo.local_path,
    });

    const userId = (params as AuthenticatedParams | undefined)?.user?.user_id as UserID | undefined;

    // Get ALL used unique IDs (including archived worktrees) to avoid collisions.
    // Previously this queried via Feathers which excluded archived worktrees by default,
    // causing ID collisions when archived worktrees held the assigned ID.
    const allUsedIds = await worktreeRepo.getAllUsedUniqueIds();
    const worktreeUniqueId = autoAssignWorktreeUniqueId(allUsedIds);

    const worktreesService = this.app.service('worktrees');

    // NOTE: Environment command templates (start_command, stop_command, etc.) are NOT
    // rendered here. They will be rendered by the executor after Unix groups are created
    // and GID is available, ensuring {{worktree.gid}} is populated in templates.
    // See: packages/executor/src/commands/git.ts:renderEnvironmentTemplates()

    // Create DB record EARLY with 'creating' status
    // Executor will:
    // 1. Create git worktree on filesystem
    // 2. Initialize Unix groups (if RBAC enabled)
    // 3. Render environment templates with full context including GID
    // 4. Patch worktree to 'ready' with rendered templates
    const worktree = (await worktreesService.create(
      {
        repo_id: repo.repo_id,
        name: data.name,
        path: worktreePath,
        ref: data.ref,
        ref_type: data.refType,
        base_ref: data.sourceBranch,
        new_branch: data.createBranch ?? false,
        worktree_unique_id: worktreeUniqueId,
        filesystem_status: 'creating', // Will be set to 'ready' by executor
        // Environment templates will be rendered by executor after Unix group creation
        // RBAC fields (optional, defaults handled by repository layer)
        ...(data.others_can ? { others_can: data.others_can } : {}),
        ...(data.others_fs_access ? { others_fs_access: data.others_fs_access } : {}),
        sessions: [],
        last_used: new Date().toISOString(),
        issue_url: data.issue_url,
        pull_request_url: data.pull_request_url,
        board_id: data.boardId,
        created_by: (params as AuthenticatedParams | undefined)?.user?.user_id || 'anonymous',
      },
      params
    )) as Worktree;

    // Add creating user as owner of the worktree
    if (userId) {
      const worktreeRepo = new WorktreeRepository(this.db);
      await worktreeRepo.addOwner(worktree.worktree_id, userId);
      console.log(`✓ Added user ${userId.substring(0, 8)} as owner of worktree ${worktree.name}`);
    }

    if (data.boardId) {
      const boardObjectsService = this.app.service('board-objects');

      // Compute position automatically — agents should never need to think about x/y
      let position: { x: number; y: number } | undefined;
      const resolvedZoneId = data.zoneId;

      try {
        // If placing in a zone, compute zone-relative position
        if (resolvedZoneId && board) {
          const zone = board.objects?.[resolvedZoneId];
          if (zone?.type === 'zone') {
            const { computeZoneRelativePosition } = await import(
              '@agor/core/utils/board-placement'
            );
            position = computeZoneRelativePosition(
              zone as import('@agor/core/types').ZoneBoardObject
            );
          }
        }

        // If not in a zone, compute a smart default position using board entities
        if (!position) {
          const { resolveEntityAbsolutePositions, computeDefaultBoardPosition } = await import(
            '@agor/core/utils/board-placement'
          );

          // Fetch all entities for THIS board
          const existingResult = await boardObjectsService.find({
            query: { board_id: data.boardId },
            ...params,
          });
          const existing = (
            existingResult as {
              data: import('@agor/core/types').BoardEntityObject[];
            }
          ).data;

          // Filter to active (non-archived) worktree entities via single batch query
          const worktreeEntities = existing.filter(
            (obj: import('@agor/core/types').BoardEntityObject) =>
              obj.entity_type === 'worktree' && obj.worktree_id
          );

          let activeEntities = worktreeEntities;
          if (worktreeEntities.length > 0) {
            const worktreesResult = await this.app.service('worktrees').find({
              query: { repo_id: repo.repo_id, $limit: 500 },
              paginate: false,
            });
            const worktreesList = Array.isArray(worktreesResult)
              ? worktreesResult
              : (worktreesResult as { data: { worktree_id: string; archived: boolean }[] }).data;
            const archivedIds = new Set(
              worktreesList
                .filter((wt: { archived: boolean }) => wt.archived)
                .map((wt: { worktree_id: string }) => wt.worktree_id)
            );
            activeEntities = worktreeEntities.filter((e) => !archivedIds.has(e.worktree_id!));
          }

          // Extract zones from THIS board's objects
          const zones = board?.objects
            ? Object.entries(board.objects)
                .filter(([, o]) => (o as { type: string }).type === 'zone')
                .map(([id, o]) => ({ id, ...(o as import('@agor/core/types').ZoneBoardObject) }))
            : [];

          const absolutePositions = resolveEntityAbsolutePositions(activeEntities, zones);
          position = computeDefaultBoardPosition(absolutePositions, zones);
        }
      } catch (error) {
        console.warn(
          '⚠️  Smart positioning failed, using fallback:',
          error instanceof Error ? error.message : String(error)
        );
      }

      // Final fallback: near origin (if smart positioning threw)
      if (!position) {
        position = { x: 100 + Math.random() * 200, y: 100 + Math.random() * 200 };
      }

      await boardObjectsService.create(
        {
          board_id: data.boardId,
          worktree_id: worktree.worktree_id,
          position,
          ...(resolvedZoneId ? { zone_id: resolvedZoneId } : {}),
        },
        params
      );
    }

    // Fire-and-forget: spawn executor to create git worktree on filesystem.
    // Executor will patch filesystem_status to 'ready' when done (or 'failed'
    // on error), and along the way render environment command templates
    // (start_command, stop_command, etc.) onto the worktree. Those fields
    // trip the requireAdminForEnvConfig hook on patch, so we authenticate
    // the executor with a service JWT to bypass admin checks for internal
    // materialization of admin-defined templates.
    //
    // Per-user credentials: Feathers RPC (users.getGitEnvironment)
    // Unix group init: Feathers RPC (worktrees.initializeUnixGroup) — runs daemon-side
    try {
      const sessionToken = generateSessionToken(
        this.app as unknown as { settings: { authentication?: { secret?: string } } }
      );

      // Check if Unix group isolation should be initialized
      const rbacEnabled = isWorktreeRbacEnabled();

      // Resolve Unix user for impersonation (handles simple/insulated/strict modes)
      const asUser = userId ? await resolveGitImpersonationForUser(this.db, userId) : undefined;

      spawnExecutorFireAndForget(
        {
          command: 'git.worktree.add',
          sessionToken,
          daemonUrl: getDaemonUrl(),
          params: {
            worktreeId: worktree.worktree_id,
            repoId: repo.repo_id,
            repoPath: repo.local_path,
            worktreeName: data.name,
            worktreePath,
            branch: data.ref,
            sourceBranch: data.sourceBranch,
            createBranch: data.createBranch,
            refType: data.refType,
            userId: userId as string | undefined,
            // Unix group isolation (only when RBAC is enabled)
            initUnixGroup: rbacEnabled,
            othersAccess: data.others_fs_access || worktree.others_fs_access || 'read',
          },
        },
        {
          logPrefix: `[ReposService.createWorktree ${data.name}]`,
          asUser, // Run as resolved user (fresh groups via sudo -u)
        }
      );
    } catch (error) {
      console.error(
        '[ReposService.createWorktree] Failed to spawn executor:',
        error instanceof Error ? error.message : String(error)
      );
    }

    // Return immediately with 'creating' status - UI will see updates via WebSocket
    return worktree;
  }

  /**
   * Resolve the `.agor.yml` location for an import/export request.
   *
   * Always reads from / writes to the given worktree's working directory:
   * `.agor.yml` is a branch-scoped file, so every import/export must name
   * which branch (worktree) it targets. Reading from the repo's base path
   * would silently cross branch boundaries and is never what the caller
   * wants.
   *
   * Routes through the worktrees service so RBAC hooks (loadWorktree +
   * ensureCanView) fire against the caller's params — calling the repository
   * directly would bypass worktree-level permission checks and let a user
   * with repo access read/write a worktree path they cannot see.
   */
  private async resolveAgorYmlPath(
    repo: Repo,
    worktreeId: string,
    params?: RepoParams
  ): Promise<string> {
    const worktreesService = this.app.service('worktrees');
    const worktree = (await worktreesService.get(worktreeId, params)) as Worktree;
    if (worktree.repo_id !== repo.repo_id) {
      throw new Error(`Worktree ${worktreeId} does not belong to repo ${repo.repo_id}`);
    }
    return path.join(worktree.path, '.agor.yml');
  }

  /**
   * Custom method: Import environment config from .agor.yml
   *
   * Requires `worktree_id` in `data` — `.agor.yml` is branch-scoped, so the
   * caller must name which worktree's working copy to read. This is a
   * one-shot manual import — the repo is NOT re-ingested automatically on
   * subsequent operations.
   */
  async importFromAgorYml(
    id: string,
    data: { worktree_id: string },
    params?: RepoParams
  ): Promise<Repo> {
    if (!data?.worktree_id) {
      throw new Error('worktree_id is required to import .agor.yml');
    }
    const repo = await this.get(id, params);
    const agorYmlPath = await this.resolveAgorYmlPath(repo, data.worktree_id, params);

    // Parse .agor.yml (returns v2 RepoEnvironment; v1 is wrapped automatically).
    // `template_overrides:` at any level throws — it is DB-only.
    const environment = parseAgorYml(agorYmlPath);

    if (!environment) {
      throw new Error('.agor.yml not found or has no environment configuration');
    }

    // Preserve any existing DB-only template_overrides across import — the
    // file never contains them, so a naive replace would otherwise wipe them.
    const replacement: RepoEnvironment = repo.environment?.template_overrides
      ? { ...environment, template_overrides: repo.environment.template_overrides }
      : environment;

    // Replace wholesale (NOT deep-merge) — otherwise deepMerge in
    // RepoRepository.update would preserve stale variant keys that the user
    // renamed or removed in .agor.yml, and fields dropped from a still-present
    // variant would also linger. See packages/core/src/db/repositories/repos.ts
    // setEnvironment() for the single-field replace semantics.
    const updated = await this.repoRepo.setEnvironment(id, replacement);

    // DrizzleService.patch would normally fire this; emit manually since we
    // bypassed it to get replace semantics.
    this.emit?.('patched', updated, params);
    return updated;
  }

  /**
   * Custom method: Export environment config to .agor.yml
   *
   * Requires `worktree_id` in `data` — `.agor.yml` is branch-scoped, so the
   * caller must name which worktree's working copy to write into (admins then
   * commit the file on that branch).
   *
   * `template_overrides` are DB-only and are stripped by `writeAgorYml` — the
   * file always reflects the shared, committable variant definitions only.
   */
  async exportToAgorYml(
    id: string,
    data: { worktree_id: string },
    params?: RepoParams
  ): Promise<{ path: string }> {
    if (!data?.worktree_id) {
      throw new Error('worktree_id is required to export .agor.yml');
    }
    const repo = await this.get(id, params);

    const envToWrite = repo.environment ?? undefined;
    if (!envToWrite && !repo.environment_config) {
      throw new Error('Repository has no environment configuration to export');
    }

    const agorYmlPath = await this.resolveAgorYmlPath(repo, data.worktree_id, params);

    // Prefer v2 source of truth; fall back to legacy v1 view if somehow the
    // v2 wrapper wasn't materialized (writeAgorYml handles both).
    writeAgorYml(agorYmlPath, envToWrite ?? repo.environment_config!);

    return { path: agorYmlPath };
  }

  /**
   * Override remove to support filesystem cleanup
   *
   * Supports query parameter: ?cleanup=true to delete filesystem directories
   *
   * Behavior: Fail-fast transactional approach
   * - If cleanup=true: Delete filesystem FIRST, then database (abort on filesystem failure)
   * - If cleanup=false: Delete database only (filesystem preserved)
   */
  async remove(id: string, params?: RepoParams): Promise<Repo> {
    const repo = await this.get(id, params);
    const cleanup = params?.query?.cleanup === true;

    // Get ALL worktrees for this repo (needed for both filesystem and database cleanup)
    // CRITICAL: Use internal call (no provider) to avoid RBAC hooks that bypass repo_id filter.
    // Spreading external params with provider causes scopeWorktreeQuery to return ALL accessible
    // worktrees instead of filtering by repo_id, leading to cross-repo deletion.
    const worktreesService = this.app.service('worktrees');
    const worktreesResult = await worktreesService.find({
      query: { repo_id: repo.repo_id },
      paginate: false,
    });

    const worktrees = (
      Array.isArray(worktreesResult) ? worktreesResult : worktreesResult.data
    ) as Worktree[];

    // Safety check: verify all worktrees belong to this repo (defense in depth)
    const foreignWorktrees = worktrees.filter((wt) => wt.repo_id !== repo.repo_id);
    if (foreignWorktrees.length > 0) {
      throw new Error(
        `SAFETY CHECK FAILED: Found ${foreignWorktrees.length} worktree(s) not belonging to repo ${repo.repo_id}. ` +
          `Aborting deletion to prevent cross-repo data loss. This is a bug — please report it.`
      );
    }

    console.log(
      `🗑️  Repo deletion: Found ${worktrees.length} worktree(s) for repo ${repo.slug} (${repo.repo_id})`
    );

    // If cleanup is requested and this is a remote repo, delete filesystem directories FIRST
    if (cleanup && repo.repo_type === 'remote') {
      const { deleteRepoDirectory, deleteWorktreeDirectory } = await import('@agor/core/git');

      // Track successfully deleted paths for honest error reporting
      const deletedPaths: string[] = [];

      // FAIL FAST: Stop on first filesystem deletion failure
      // Delete worktree directories from filesystem
      for (const worktree of worktrees) {
        try {
          await deleteWorktreeDirectory(worktree.path);
          deletedPaths.push(worktree.path);
          console.log(`🗑️  Deleted worktree directory: ${worktree.path}`);
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          console.error(`❌ Failed to delete worktree directory ${worktree.path}:`, errorMsg);

          // Be honest about partial deletion
          if (deletedPaths.length > 0) {
            throw new Error(
              `Partial deletion occurred: Successfully deleted ${deletedPaths.length} path(s): ${deletedPaths.join(', ')}. ` +
                `Failed at ${worktree.path}: ${errorMsg}. ` +
                `Database NOT modified. Manual cleanup required for deleted paths.`
            );
          } else {
            throw new Error(
              `Cannot delete repository: Failed to delete worktree at ${worktree.path}: ${errorMsg}. ` +
                `No files were deleted. Please fix this issue and retry.`
            );
          }
        }
      }

      // Delete repository directory from filesystem
      try {
        await deleteRepoDirectory(repo.local_path);
        deletedPaths.push(repo.local_path);
        console.log(`🗑️  Deleted repository directory: ${repo.local_path}`);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error(`❌ Failed to delete repository directory ${repo.local_path}:`, errorMsg);

        // Be honest about partial deletion (worktrees were deleted, repo failed)
        throw new Error(
          `Partial deletion occurred: Successfully deleted ${deletedPaths.length} path(s): ${deletedPaths.join(', ')}. ` +
            `Failed to delete repository directory at ${repo.local_path}: ${errorMsg}. ` +
            `Database NOT modified. Manual cleanup required for deleted paths.`
        );
      }

      console.log(
        `✅ Successfully deleted ${worktrees.length} worktree director${worktrees.length === 1 ? 'y' : 'ies'} and repository directory`
      );
    }

    // Only reach here if filesystem cleanup succeeded (or wasn't requested)
    // Now safe to delete from database

    // IMPORTANT: Use Feathers service to delete worktrees (not direct DB cascade) because:
    // 1. WebSocket events broadcast to all clients (real-time UI updates)
    // 2. Service hooks run properly (lifecycle, validation, etc.)
    // 3. Session cascades trigger (sessions → tasks → messages)
    // 4. Foreign key cascades may not be reliable (pragmas are async fire-and-forget)
    // NOTE: Don't spread external params — use internal call to bypass auth/RBAC hooks.
    // The repo deletion itself is already authorized; individual worktree permission checks
    // would incorrectly block cleanup of worktrees the user doesn't directly own.
    for (const worktree of worktrees) {
      try {
        await worktreesService.remove(worktree.worktree_id);
        console.log(`🗑️  Deleted worktree from database: ${worktree.name}`);
      } catch (error) {
        console.warn(
          `⚠️  Failed to delete worktree ${worktree.name} from database:`,
          error instanceof Error ? error.message : String(error)
        );
      }
    }

    // Finally, delete repository from database
    return super.remove(id, params) as Promise<Repo>;
  }
}

/**
 * Service factory function
 */
export function createReposService(db: Database, app: Application): ReposService {
  return new ReposService(db, app);
}
