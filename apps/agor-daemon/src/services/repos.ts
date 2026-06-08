/**
 * Repos Service
 *
 * Provides REST + WebSocket API for repository management.
 * Uses DrizzleService adapter with RepoRepository.
 *
 * Git operations (clone, branch add) are delegated to the executor process
 * for proper Unix isolation. The executor handles filesystem operations while
 * the daemon handles database records and business logic.
 */

import { homedir } from 'node:os';
import path from 'node:path';
import {
  ensureBranchStorageModeAllowed,
  extractSlugFromUrl,
  isBranchRbacEnabled,
  isValidGitUrl,
  isValidSlug,
  normalizeRepoUrl,
  PAGINATION,
  parseAgorYml,
  resolveBranchStorageConfig,
} from '@agor/core/config';
import { BranchRepository, type Database, RepoRepository, shortId } from '@agor/core/db';
import { autoAssignBranchUniqueId } from '@agor/core/environment/variable-resolver';
import { type Application, Forbidden, NotAuthenticated } from '@agor/core/feathers';
import {
  assertRemoteRefVisibleForClone,
  getBranchPath,
  getDefaultBranch,
  getRemoteUrl,
  getReposDir,
  isValidGitRepo,
  redactGitUrlCredentials,
  scanGitConfigRemoteCredentials,
  scrubGitConfigRemoteCredentials,
  stripGitUrlCredentials,
} from '@agor/core/git';
import type {
  AuthenticatedParams,
  Branch,
  BranchPermissionLevel,
  CloneRepositoryResult,
  QueryParams,
  Repo,
  RepoEnvironment,
  RepoSlug,
  UserID,
  UUID,
} from '@agor/core/types';
import { DrizzleService } from '../adapters/drizzle';
import { shouldUseCloneReferencePath } from '../utils/clone-reference.js';
import { resolveExecutorReadAsUser } from '../utils/executor-read-impersonation.js';
import { resolveGitImpersonationForUser } from '../utils/git-impersonation.js';
import {
  generateSessionToken,
  getDaemonUrl,
  runExecutorCommand,
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
   * The DB row is created EARLY (here) with `clone_status: 'cloning'` so
   * MCP / UI callers can discover the outcome via `agor_repos_get(repoId)`
   * even when the clone fails — fixes #1126's "silent pending forever"
   * symptom. The executor then handles:
   * - Git clone
   * - Parse .agor.yml
   * - Patch the existing row to `'ready'` (with parsed env, default branch)
   *   or `'failed'` (with categorized clone_error)
   * - Initialize Unix group
   *
   * Returns immediately with `{ status: 'pending', slug, repo_id }`.
   * Clients see a `repos.created` event for the placeholder row, then a
   * `repos.patched` event when the clone finishes.
   *
   * Slug-collision policy: a previous `clone_status: 'failed'` row is
   * deleted to allow seamless retry; any other state surfaces `'exists'`.
   */
  async cloneRepository(
    data: { url: string; slug?: string; name?: string; default_branch?: string },
    params?: RepoParams
  ): Promise<CloneRepositoryResult> {
    const remoteUrl = stripGitUrlCredentials(data.url);
    if (remoteUrl !== data.url) {
      console.warn(
        `[repos.clone] Stripped credentials from submitted remote URL: ${redactGitUrlCredentials(data.url)}`
      );
    }

    // Note: `||` (not `??`) is intentional — we want an empty `data.slug`
    // to fall through to derivation rather than be treated as "explicit".
    let slug = data.slug || data.name;
    if (!slug) {
      // Normalize URL (strip trailing slashes and `.git`) using the shared
      // canonical form, so UI and daemon cannot drift.
      slug = extractSlugFromUrl(normalizeRepoUrl(remoteUrl));
    }
    if (!slug || !isValidSlug(slug)) {
      throw new Error('Could not derive a valid slug from URL. Please provide a slug.');
    }

    // Slug-collision policy:
    // - `clone_status: 'failed'` → previous attempt left a tombstone row;
    //   delete it so the user can retry without manually cleaning up.
    //   Cascades to any half-initialized branch rows (FK onDelete: cascade).
    // - any other state (ready / cloning / undefined-legacy) → surface
    //   `'exists'` so callers don't unintentionally clobber a working repo
    //   or interrupt an in-flight clone.
    //
    // Go through `this.remove` (the Feathers service) — NOT `repoRepo.delete`
    // directly — so the standard `repos.removed` WebSocket event fires and
    // connected UIs drop the failed row from their state before we create
    // the replacement placeholder.
    //
    // CRITICAL: do NOT forward the caller's `params.query` into the retry
    // remove. A REST caller hitting `/repos/clone?cleanup=true` would
    // otherwise trip the filesystem-cleanup branch on the placeholder
    // (which doesn't exist on disk anyway, but the side-effects matter for
    // branches that may have been pre-created). Pass an explicitly empty
    // query so retry is always a DB-only tombstone removal.
    const existing = await this.repoRepo.findBySlug(slug);
    if (existing) {
      if (existing.clone_status === 'failed') {
        console.log(
          `[clone ${slug}] Found previous failed clone (${shortId(existing.repo_id)}); deleting to retry`
        );
        await this.remove(existing.repo_id, { ...params, query: {} });
      } else {
        return { status: 'exists', slug, repo_id: existing.repo_id };
      }
    }

    const userId = (params as AuthenticatedParams | undefined)?.user?.user_id as UserID | undefined;

    // Generate service JWT for executor authentication. The executor talks back
    // to the daemon to patch the pre-created repo row to 'ready'/'failed' (and
    // surface the parsed `.agor.yml` environment on success). Using a service
    // token ensures hooks like requireAdminForEnvConfig bypass via
    // _isServiceAccount. Executor fetches per-user credentials via Feathers
    // RPC (users.getGitEnvironment) using the same service JWT.
    const sessionToken = generateSessionToken(
      this.app as unknown as { settings: { authentication?: { secret?: string } } }
    );

    // Unix group initialization gates on RBAC explicitly.
    const rbacEnabled = isBranchRbacEnabled();

    // Sudo wrap (asUser) is gated inside the resolver — returns undefined
    // in simple/no-RBAC mode so hosts without passwordless sudoers work
    // (#1140, #1143). Callers no longer duplicate the gate.
    const asUser = await resolveGitImpersonationForUser(this.db, userId);

    // Pre-create the repo row with `clone_status: 'cloning'` so failures stay
    // queryable via `agor_repos_get(repoId)`. Pre-#1126 the row was only
    // created on success by the executor — a failed clone left zero state and
    // MCP callers had no way to discover the outcome (issue #1126 bug B).
    //
    // Use the Feathers service `create` (not `repoRepo.create`) so the
    // standard `repos.created` WebSocket event fires and the UI can render
    // a "cloning" card immediately, then transition to ready/failed when the
    // executor patches the row.
    //
    // local_path is computed best-effort (mirrors what the executor will use).
    // Use the slug, not the URL basename, so two remotes with the same repo
    // name but distinct Agor slugs do not collide on disk.
    const expectedLocalPath = path.join(getReposDir(), slug);
    const placeholder = (await this.create(
      {
        slug: slug as RepoSlug,
        name: data.name || slug,
        repo_type: 'remote',
        remote_url: remoteUrl,
        local_path: expectedLocalPath,
        ...(data.default_branch ? { default_branch: data.default_branch } : {}),
        clone_status: 'cloning',
      },
      params
    )) as Repo;
    const repoId = placeholder.repo_id;

    // Fire and forget - spawn executor and return immediately.
    // Executor handles: git clone, .agor.yml parsing, repo row patching.
    // Executor fetches per-user credentials via Feathers RPC (users.getGitEnvironment).
    // Unix group init (groupadd/chgrp/setfacl) runs daemon-side via repos.initializeUnixGroup RPC.
    const app = this.app;
    // Capture the Feathers service so the `onExit` safety net (below) writes
    // through the same service layer the executor uses — that way clients
    // receive `repos.patched` regardless of which path declares failure.
    const reposService = this.app.service('repos');
    spawnExecutorFireAndForget(
      {
        command: 'git.clone',
        sessionToken,
        daemonUrl: getDaemonUrl(),
        params: {
          url: remoteUrl,
          slug,
          repoId,
          outputPath: expectedLocalPath,
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
            // Broadcast clone failure to all connected clients (the existing
            // toast UX). Persistent failure state lives on the repo row.
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
                url: remoteUrl,
                error: `Clone failed (exit code ${code}). Check that the repository URL is correct and accessible.${branchHint}`,
                repo_id: repoId,
              });
            }

            // Safety net: if the executor crashed before it could patch the
            // row (e.g. lost daemon connection), the repo would be stuck in
            // `'cloning'` forever. Force it to `'failed'` here, but only if
            // it's still 'cloning' (don't clobber a 'failed' write the
            // executor already made with a richer category/message).
            //
            // Use the service (no `params` → internal call, bypasses auth
            // hooks) so the patched event fires for any client that joined
            // after the initial broadcast above.
            void (async () => {
              try {
                const current = (await reposService.get(repoId)) as Repo;
                if (current.clone_status === 'cloning') {
                  await reposService.patch(repoId, {
                    clone_status: 'failed',
                    clone_error: {
                      exit_code: code,
                      category: 'unknown',
                      message: `Clone exited with code ${code} before reporting an error.`,
                    },
                  });
                }
              } catch (err) {
                console.error(
                  `[clone ${slug}] Failed to mark repo as failed in onExit safety net:`,
                  err instanceof Error ? err.message : String(err)
                );
              }
            })();
          }
        },
      }
    );

    // Return immediately - callers can poll `agor_repos_get(repoId)` for
    // `clone_status: 'ready' | 'failed'` to discover the final outcome.
    return { status: 'pending', slug, repo_id: repoId };
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
   * Custom method: Patch repo metadata with validation.
   *
   * Centralizes the rules that wrap the bare Feathers `patch` so callers
   * (MCP, REST, UI, internal) can't drift:
   * - `slug` must match `isValidSlug` and be unique across all repos.
   * - `remote_url`, when provided, must be a valid git URL.
   * - Resulting `repo_type: 'remote'` requires a `remote_url` (the patch's
   *   own field or the existing row's).
   *
   * Slug renames are DB-only — `local_path` on disk is not moved. Branches
   * and running sessions hold absolute paths into the old directory, so a
   * directory move is intentionally out of scope (do delete + re-clone).
   */
  async updateMetadata(
    id: string,
    patch: {
      name?: string;
      slug?: string;
      repo_type?: 'remote' | 'local';
      remote_url?: string;
      default_branch?: string;
    },
    params?: RepoParams
  ): Promise<Repo> {
    const cleanPatch: Partial<Repo> = {};
    if (patch.name !== undefined) cleanPatch.name = patch.name;

    if (patch.slug !== undefined) {
      if (!isValidSlug(patch.slug)) {
        throw new Error('slug must be in org/name format');
      }
      cleanPatch.slug = patch.slug as RepoSlug;
    }

    if (patch.repo_type !== undefined) {
      if (patch.repo_type !== 'remote' && patch.repo_type !== 'local') {
        throw new Error('repo_type must be "remote" or "local"');
      }
      cleanPatch.repo_type = patch.repo_type;
    }

    if (patch.remote_url !== undefined) {
      const safeRemoteUrl = patch.remote_url ? stripGitUrlCredentials(patch.remote_url) : '';
      if (safeRemoteUrl !== patch.remote_url) {
        console.warn(
          `[repos.updateMetadata] Stripped credentials from submitted remote URL: ${redactGitUrlCredentials(patch.remote_url)}`
        );
      }
      if (safeRemoteUrl && !isValidGitUrl(safeRemoteUrl)) {
        throw new Error('remote_url must be a valid git URL (https:// or git@)');
      }
      cleanPatch.remote_url = safeRemoteUrl;
    }

    if (patch.default_branch !== undefined) cleanPatch.default_branch = patch.default_branch;

    if (Object.keys(cleanPatch).length === 0) {
      throw new Error('At least one field must be provided to update');
    }

    const current = (await this.get(id, params)) as Repo;

    // Slug uniqueness — pre-check for a clean error message, but the DB
    // uniqueness constraint remains authoritative for concurrent writes.
    if (cleanPatch.slug && cleanPatch.slug !== current.slug) {
      const collision = await this.repoRepo.findBySlug(cleanPatch.slug);
      if (collision && collision.repo_id !== current.repo_id) {
        throw new Error(`A repository with slug '${cleanPatch.slug}' already exists`);
      }
    }

    // Resulting `remote` repos must have a remote_url. Evaluate against the
    // post-patch shape so we catch both "URL provided in patch" and
    // "URL already on the row".
    const effectiveType = cleanPatch.repo_type ?? current.repo_type;
    const effectiveRemoteUrl =
      'remote_url' in cleanPatch ? cleanPatch.remote_url : current.remote_url;
    if (effectiveType === 'remote' && !effectiveRemoteUrl) {
      throw new Error('repo_type "remote" requires a remote_url');
    }

    // Use the Feathers service `patch` (not `repoRepo.update`) so the standard
    // `patched` WebSocket event fires and the existing patch hooks run.
    return (await this.patch(id, cleanPatch, params)) as Repo;
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

    const remoteUrl = stripGitUrlCredentials((await getRemoteUrl(repoPath)) ?? '') || undefined;
    const scanResult = await scanGitConfigRemoteCredentials(repoPath);
    if (scanResult.findings.length > 0) {
      console.warn(
        `[repos.local] Registered local repo has ${scanResult.findings.length} credential-bearing remote URL(s) in git config; persisted remote_url was sanitized. Run the repair utility if this repo is managed/shared.`
      );
    }
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
   * Custom method: Create branch
   *
   * Delegates git worktree add to executor process for Unix isolation.
   * Executor handles filesystem operations, daemon handles DB record creation
   * and template rendering.
   */
  async createBranch(
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
      custom_context?: Record<string, unknown>;
      notes?: string | null;
      /** Explicit board position. Honored as-is when supplied; otherwise
       *  the service computes a smart placement (zone-relative if a
       *  zoneId was passed, else next-free slot among existing entities).
       *  Agents/MCP callers should omit this so they don't have to think
       *  about x/y; the UI passes the viewport center. */
      position?: { x: number; y: number };
      zoneId?: string;
      others_can?: BranchPermissionLevel;
      others_fs_access?: 'none' | 'read' | 'write';
      environment_variant?: string;
      /**
       * Branch storage model — see context/explorations/clone-redesign.md.
       * 'worktree' (default) = native `git worktree add`. 'clone' = self-standing `git clone`.
       */
      storage_mode?: 'worktree' | 'clone';
      /** Shallow clone depth (only when storage_mode='clone'). NULL/undefined = full clone. */
      clone_depth?: number;
    },
    params?: RepoParams
  ): Promise<Branch> {
    const repo = await this.get(id, params);

    console.log('🔍 RepoService.createBranch - repo lookup result:', {
      repo_id: repo.repo_id,
      slug: repo.slug,
      local_path: repo.local_path,
      remote_url: repo.remote_url ? redactGitUrlCredentials(repo.remote_url) : repo.remote_url,
    });

    // Check for duplicate branch name in this repo (non-archived only)
    const branchRepo = new BranchRepository(this.db);
    const existingBranch = await branchRepo.findActiveByRepoAndName(
      repo.repo_id as UUID,
      data.name
    );
    if (existingBranch) {
      throw new Error(`A branch named '${data.name}' already exists in this repository`);
    }

    // Resolve + validate the storage mode. The daemon owns DB/auth/config
    // shape; everything else (git/filesystem inspection, conflict detection,
    // path-exists checks) belongs to the executor (see operator's layering
    // rule: "daemon/client = database, executor = filesystem").
    const { defaultMode } = resolveBranchStorageConfig();
    const storageMode: 'worktree' | 'clone' = data.storage_mode ?? defaultMode;
    ensureBranchStorageModeAllowed(storageMode);
    const cloneDepth = data.clone_depth;
    if (cloneDepth !== undefined) {
      if (storageMode !== 'clone') {
        throw new Error(
          `clone_depth is only meaningful when storage_mode='clone' (got storage_mode='${storageMode}'). ` +
            `Omit clone_depth or set storage_mode='clone'.`
        );
      }
      if (!Number.isInteger(cloneDepth) || cloneDepth <= 0) {
        throw new Error(
          `clone_depth must be a positive integer when set (got ${cloneDepth}). ` +
            `Omit to make a full clone, or pass a positive int for --depth.`
        );
      }
    }
    // Auth hooks (`requireMinimumRole`) guarantee `params.user` exists by
    // the time we get here. Resolve it before clone preflight so private
    // remotes can use the same per-user git credentials the executor will
    // use for the eventual clone.
    const userId = (params as AuthenticatedParams).user!.user_id as UserID;

    if (storageMode === 'clone') {
      if (!repo.remote_url) {
        throw new Error(
          `Cannot create a clone-mode branch for repo '${repo.slug}': repo has no remote_url. ` +
            `Use storage_mode='worktree' or register the repo with a remote first.`
        );
      }
      const cloneRemoteUrl = repo.remote_url;
      const cloneRef = data.createBranch ? data.sourceBranch || data.ref : data.ref;
      const usersService = this.app.service('users') as unknown as {
        getGitEnvironment(
          data: { userId: string },
          params?: RepoParams
        ): Promise<Record<string, string>>;
      };
      const gitEnv = await usersService.getGitEnvironment({ userId }, params);
      await assertRemoteRefVisibleForClone({
        remoteUrl: cloneRemoteUrl,
        ref: cloneRef,
        refType: data.refType || 'branch',
        env: gitEnv,
      });
    }

    if (repo.local_path) {
      const scrubResult = await scrubGitConfigRemoteCredentials(repo.local_path);
      if (scrubResult.findings.length > 0) {
        console.warn(
          `[ReposService.createBranch] Scrubbed ${scrubResult.findings.length} credential-bearing git remote URL(s) from repo '${repo.slug}' before branch creation.`
        );
      }
    }

    // NOTE: Filesystem preflights (target-dir-exists,
    // branch-already-checked-out) live in the executor / core helpers —
    // they're filesystem facts, not DB facts. Clone-mode remote-ref
    // visibility is deliberately checked above before persisting, because
    // clone-mode cannot materialize local-only base branches and the async
    // executor failure path otherwise leaves confusing placeholder state.
    // The executor surfaces other materialization failures via
    // `filesystem_status='failed'` + `error_message`, which the UI already
    // renders cleanly. Daemon stays focused on DB/auth/config validation.
    // See `core.createBranch` / `createBranchAsClone` for the equivalent
    // checks at the materialisation boundary.

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
        if (zone?.type !== 'zone') {
          throw new Error(
            `Zone '${data.zoneId}' not found on board '${data.boardId}'. ` +
              `Provide a valid zoneId from the board's zone objects.`
          );
        }
      }
    }

    const branchPath = getBranchPath(repo.slug, data.name);

    // Path existence + branch-in-use checks have moved to the executor /
    // core git helpers — see the "filesystem preflights" note above. Both
    // `createBranch()` and `createBranchAsClone()` refuse to clobber an
    // existing `targetPath` and surface that failure through
    // `filesystem_status='failed'` on the DB row.

    console.log('🔍 RepoService.createBranch - computed paths:', {
      branchPath,
      repoLocalPath: repo.local_path,
    });

    // Get ALL used unique IDs (including archived branches) to avoid collisions.
    // Previously this queried via Feathers which excluded archived branches by default,
    // causing ID collisions when archived branches held the assigned ID.
    const allUsedIds = await branchRepo.getAllUsedUniqueIds();
    const branchUniqueId = autoAssignBranchUniqueId(allUsedIds);

    const branchesService = this.app.service('branches');

    // NOTE: Environment command templates (start_command, stop_command, etc.) are NOT
    // rendered here. They will be rendered by the executor after Unix groups are created
    // and GID is available, ensuring {{branch.gid}} is populated in templates.
    // See: packages/executor/src/commands/git.ts:renderEnvironmentTemplates()

    // Storage mode (storageMode + cloneDepth) was resolved + validated up
    // top so the preflights could gate on it; reuse those vars below.

    // Create DB record EARLY with 'creating' status
    // Executor will:
    // 1. Create git branch on filesystem
    // 2. Initialize Unix groups (if RBAC enabled)
    // 3. Render environment templates with full context including GID
    // 4. Patch branch to 'ready' with rendered templates
    const branch = (await branchesService.create(
      {
        repo_id: repo.repo_id,
        name: data.name,
        path: branchPath,
        ref: data.ref,
        ref_type: data.refType,
        base_ref: data.sourceBranch,
        new_branch: data.createBranch ?? false,
        branch_unique_id: branchUniqueId,
        filesystem_status: 'creating', // Will be set to 'ready' by executor
        // Environment templates will be rendered by executor after Unix group creation
        // RBAC fields (optional, defaults handled by repository layer)
        ...(data.others_can ? { others_can: data.others_can } : {}),
        ...(data.others_fs_access ? { others_fs_access: data.others_fs_access } : {}),
        ...(data.environment_variant ? { environment_variant: data.environment_variant } : {}),
        storage_mode: storageMode,
        ...(cloneDepth !== undefined ? { clone_depth: cloneDepth } : {}),
        sessions: [],
        last_used: new Date().toISOString(),
        issue_url: data.issue_url,
        pull_request_url: data.pull_request_url,
        notes: data.notes,
        custom_context: data.custom_context,
        board_id: data.boardId,
        created_by: userId,
      },
      params
    )) as Branch;

    // Add creating user as owner of the branch
    {
      const branchRepo = new BranchRepository(this.db);
      await branchRepo.addOwner(branch.branch_id, userId);
      console.log(`✓ Added user ${shortId(userId)} as owner of branch ${branch.name}`);
    }

    if (data.boardId) {
      const boardObjectsService = this.app.service('board-objects');

      // Honor an explicit position from the caller (the UI passes the
      // viewport center so the new card lands where the user invoked
      // the dialog). Agents/MCP callers omit `position` so they don't
      // have to think about x/y; fall through to smart placement.
      let position: { x: number; y: number } | undefined = data.position;
      const resolvedZoneId = data.zoneId;

      try {
        // If placing in a zone, compute zone-relative position
        if (!position && resolvedZoneId && board) {
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

          // Filter to active (non-archived) branch entities via single batch query
          const branchEntities = existing.filter(
            (obj: import('@agor/core/types').BoardEntityObject) =>
              obj.entity_type === 'branch' && obj.branch_id
          );

          let activeEntities = branchEntities;
          if (branchEntities.length > 0) {
            const branchesResult = await this.app.service('branches').find({
              query: { repo_id: repo.repo_id, $limit: 500 },
              paginate: false,
            });
            const branchesList = Array.isArray(branchesResult)
              ? branchesResult
              : (branchesResult as { data: { branch_id: string; archived: boolean }[] }).data;
            const archivedIds = new Set(
              branchesList
                .filter((wt: { archived: boolean }) => wt.archived)
                .map((wt: { branch_id: string }) => wt.branch_id)
            );
            activeEntities = branchEntities.filter((e) => !archivedIds.has(e.branch_id!));
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
          branch_id: branch.branch_id,
          position,
          ...(resolvedZoneId ? { zone_id: resolvedZoneId } : {}),
        },
        params
      );
    }

    // Fire-and-forget: spawn executor to create git branch on filesystem.
    // Executor will patch filesystem_status to 'ready' when done (or 'failed'
    // on error), and along the way render environment command templates
    // (start_command, stop_command, etc.) onto the branch. Those fields
    // trip the requireAdminForEnvConfig hook on patch, so we authenticate
    // the executor with a service JWT to bypass admin checks for internal
    // materialization of admin-defined templates.
    //
    // Per-user credentials: Feathers RPC (users.getGitEnvironment)
    // Unix group init: Feathers RPC (branches.initializeUnixGroup) — runs daemon-side
    try {
      const sessionToken = generateSessionToken(
        this.app as unknown as { settings: { authentication?: { secret?: string } } }
      );

      // Unix group initialization gates on RBAC explicitly.
      const rbacEnabled = isBranchRbacEnabled();

      // Sudo wrap (asUser) is gated inside the resolver — returns undefined
      // in simple/no-RBAC mode so hosts without passwordless sudoers work
      // (#1140, #1143). Callers no longer duplicate the gate.
      const asUser = await resolveGitImpersonationForUser(this.db, userId);
      const safeRemoteUrl = repo.remote_url ? stripGitUrlCredentials(repo.remote_url) : undefined;

      spawnExecutorFireAndForget(
        {
          command: 'git.branch.add',
          sessionToken,
          daemonUrl: getDaemonUrl(),
          params: {
            branchId: branch.branch_id,
            repoId: repo.repo_id,
            repoPath: repo.local_path,
            branchName: data.name,
            branchPath,
            branch: data.ref,
            sourceBranch: data.sourceBranch,
            createBranch: data.createBranch,
            refType: data.refType,
            userId: userId as string | undefined,
            // Unix group isolation (only when RBAC is enabled)
            initUnixGroup: rbacEnabled,
            othersAccess: data.others_fs_access || branch.others_fs_access || 'read',
            // Branch storage mode (forwarded for the clone-mode code path)
            storageMode,
            ...(cloneDepth !== undefined ? { cloneDepth } : {}),
            ...(storageMode === 'clone' && safeRemoteUrl ? { remoteUrl: safeRemoteUrl } : {}),
            // Hand the executor the per-repo base clone as a `--reference`
            // hint only when that object cache is readable by the eventual
            // session identity. In strict mode, per-user sessions need fully
            // self-standing clones instead of alternates into daemon-owned
            // managed repos.
            ...(storageMode === 'clone' && repo.local_path && shouldUseCloneReferencePath()
              ? { referencePath: repo.local_path }
              : {}),
          },
        },
        {
          logPrefix: `[ReposService.createBranch ${data.name}]`,
          asUser, // Run as resolved user (fresh groups via sudo -u)
        }
      );
    } catch (error) {
      console.error(
        '[ReposService.createBranch] Failed to spawn executor:',
        error instanceof Error ? error.message : String(error)
      );
    }

    // Return immediately with 'creating' status - UI will see updates via WebSocket
    return branch;
  }

  /**
   * Authorize branch-scoped .agor.yml import/export requests.
   *
   * Routes through the branches service so RBAC hooks (loadBranch +
   * ensureCanView) fire against the caller's params. File I/O itself happens
   * inside the executor; the daemon only validates the branch/repo relation.
   */
  private async getAuthorizedAgorYmlBranch(
    repo: Repo,
    branchId: string,
    params?: RepoParams
  ): Promise<Branch> {
    const branchesService = this.app.service('branches');
    const branch = (await branchesService.get(branchId, params)) as Branch;
    if (branch.repo_id !== repo.repo_id) {
      throw new Error(`Branch ${branchId} does not belong to repo ${repo.repo_id}`);
    }
    return branch;
  }

  private async runAgorYmlExecutorCommand(
    repo: Repo,
    branch: Branch,
    command: 'branch.agor-yml.import' | 'branch.agor-yml.export',
    params: Record<string, unknown>,
    serviceParams?: RepoParams
  ) {
    const sessionToken = generateSessionToken(
      this.app as unknown as { settings: { authentication?: { secret?: string } } }
    );
    const asUser = await resolveExecutorReadAsUser(
      this.db,
      (serviceParams as Partial<AuthenticatedParams> | undefined)?.user?.user_id as
        | UserID
        | undefined
    );

    return runExecutorCommand(
      {
        command,
        sessionToken,
        daemonUrl: getDaemonUrl(),
        params: {
          repoId: repo.repo_id,
          branchId: branch.branch_id,
          ...params,
        },
      },
      {
        logPrefix: `[${command} ${repo.slug}/${branch.name}]`,
        asUser,
      }
    );
  }

  /**
   * Custom method: Import environment config from .agor.yml
   *
   * Requires `branch_id` in `data` — `.agor.yml` is branch-scoped, so the
   * caller must name which branch's working copy to read. This is a
   * one-shot manual import — the repo is NOT re-ingested automatically on
   * subsequent operations.
   */
  async importFromAgorYml(
    id: string,
    data: { branch_id: string },
    params?: RepoParams
  ): Promise<Repo> {
    if (!data?.branch_id) {
      throw new Error('branch_id is required to import .agor.yml');
    }
    const repo = await this.get(id, params);
    const branch = await this.getAuthorizedAgorYmlBranch(repo, data.branch_id, params);

    const importResult = await this.runAgorYmlExecutorCommand(
      repo,
      branch,
      'branch.agor-yml.import',
      {},
      params
    );
    if (!importResult.success) {
      throw new Error(
        `Cannot import .agor.yml from ${branch.name}: ${importResult.error?.message ?? 'executor failed'}`
      );
    }

    // Executor parsing returns v2 RepoEnvironment; v1 is wrapped automatically.
    // `template_overrides:` at any level throws — it is DB-only.
    const environment =
      importResult.data && typeof importResult.data === 'object'
        ? ((importResult.data as { environment?: RepoEnvironment | null }).environment ?? null)
        : null;

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
   * Requires `branch_id` in `data` — `.agor.yml` is branch-scoped, so the
   * caller must name which branch's working copy to write into (admins then
   * commit the file on that branch).
   *
   * `template_overrides` are DB-only and are stripped by `writeAgorYml` — the
   * file always reflects the shared, committable variant definitions only.
   */
  async exportToAgorYml(
    id: string,
    data: { branch_id: string },
    params?: RepoParams
  ): Promise<{ path: string }> {
    if (!data?.branch_id) {
      throw new Error('branch_id is required to export .agor.yml');
    }
    const repo = await this.get(id, params);

    const envToWrite = repo.environment ?? undefined;
    if (!envToWrite && !repo.environment_config) {
      throw new Error('Repository has no environment configuration to export');
    }

    const branch = await this.getAuthorizedAgorYmlBranch(repo, data.branch_id, params);

    // Prefer v2 source of truth; fall back to legacy v1 view if somehow the
    // v2 wrapper wasn't materialized (executor writeAgorYml handles both).
    const exportResult = await this.runAgorYmlExecutorCommand(
      repo,
      branch,
      'branch.agor-yml.export',
      { environment: envToWrite ?? repo.environment_config! },
      params
    );
    if (!exportResult.success) {
      throw new Error(
        `Cannot export .agor.yml to ${branch.name}: ${exportResult.error?.message ?? 'executor failed'}`
      );
    }

    const exportedPath =
      exportResult.data && typeof exportResult.data === 'object'
        ? (exportResult.data as { path?: unknown }).path
        : undefined;

    return {
      path: typeof exportedPath === 'string' ? exportedPath : path.join(branch.path, '.agor.yml'),
    };
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

    // Get ALL branches for this repo (needed for both filesystem and database cleanup).
    // CRITICAL: Use an internal call (no provider) so repo deletion owns the
    // full branch inventory for this repo, independent of caller RBAC scope.
    const branchesService = this.app.service('branches');
    const branchesResult = await branchesService.find({
      query: { repo_id: repo.repo_id },
      paginate: false,
    });

    const branches = (
      Array.isArray(branchesResult) ? branchesResult : branchesResult.data
    ) as Branch[];

    // Safety check: verify all branches belong to this repo (defense in depth)
    const foreignBranches = branches.filter((wt) => wt.repo_id !== repo.repo_id);
    if (foreignBranches.length > 0) {
      throw new Error(
        `SAFETY CHECK FAILED: Found ${foreignBranches.length} branch(s) not belonging to repo ${repo.repo_id}. ` +
          `Aborting deletion to prevent cross-repo data loss. This is a bug — please report it.`
      );
    }

    console.log(
      `🗑️  Repo deletion: Found ${branches.length} branch(s) for repo ${repo.slug} (${repo.repo_id})`
    );

    // If cleanup is requested and this is a remote repo, delete filesystem directories FIRST.
    // Delegate to the executor so the daemon never rm -rfs managed repo/branch dirs itself.
    if (cleanup && repo.repo_type === 'remote') {
      const sessionToken = generateSessionToken(
        this.app as unknown as { settings: { authentication?: { secret?: string } } }
      );

      const cleanupResult = await runExecutorCommand(
        {
          command: 'git.repo.delete',
          sessionToken,
          daemonUrl: getDaemonUrl(),
          params: {
            repoId: repo.repo_id,
          },
        },
        {
          logPrefix: `[repo.delete ${repo.slug}]`,
          timeoutMs: 5 * 60_000,
        }
      );

      if (!cleanupResult.success) {
        const errorMsg = cleanupResult.error?.message ?? 'unknown executor error';
        const deletedPaths =
          cleanupResult.error?.details && typeof cleanupResult.error.details === 'object'
            ? ((cleanupResult.error.details as { deletedPaths?: unknown }).deletedPaths ?? [])
            : [];
        const deletedPathList = Array.isArray(deletedPaths)
          ? deletedPaths.filter((value): value is string => typeof value === 'string')
          : [];

        if (deletedPathList.length > 0) {
          throw new Error(
            `Partial deletion occurred: Successfully deleted ${deletedPathList.length} path(s): ${deletedPathList.join(', ')}. ` +
              `Failed while deleting repository ${repo.slug}: ${errorMsg}. ` +
              `Database NOT modified. Manual cleanup required for deleted paths.`
          );
        }

        throw new Error(
          `Cannot delete repository: executor failed to delete managed directories for ${repo.slug}: ${errorMsg}. ` +
            `No files were deleted. Please fix this issue and retry.`
        );
      }

      console.log(
        `✅ Successfully deleted ${branches.length} branch director${branches.length === 1 ? 'y' : 'ies'} and repository directory`
      );
    }

    // Only reach here if filesystem cleanup succeeded (or wasn't requested)
    // Now safe to delete from database

    // IMPORTANT: Use Feathers service to delete branches (not direct DB cascade) because:
    // 1. WebSocket events broadcast to all clients (real-time UI updates)
    // 2. Service hooks run properly (lifecycle, validation, etc.)
    // 3. Session cascades trigger (sessions → tasks → messages)
    // 4. Foreign key cascades may not be reliable (pragmas are async fire-and-forget)
    // NOTE: Don't spread external params — use internal call to bypass auth/RBAC hooks.
    // The repo deletion itself is already authorized; individual branch permission checks
    // would incorrectly block cleanup of branches the user doesn't directly own.
    for (const branch of branches) {
      try {
        await branchesService.remove(branch.branch_id);
        console.log(`🗑️  Deleted branch from database: ${branch.name}`);
      } catch (error) {
        console.warn(
          `⚠️  Failed to delete branch ${branch.name} from database:`,
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
