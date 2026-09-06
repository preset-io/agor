/**
 * Repos Service
 *
 * Provides REST + WebSocket API for repository management.
 * Uses DrizzleService adapter with RepoRepository.
 *
 * Repository Git/filesystem inspection and mutation are delegated to the
 * executor process. The daemon owns authorization, pure validation, and DB
 * metadata only.
 */

import path from 'node:path';
import {
  ensureBranchCloneDepthAllowed,
  ensureBranchStorageModeAllowed,
  extractSlugFromUrl,
  getBranchesDir,
  getBranchPath,
  getReposDir,
  isValidGitUrl,
  isValidSlug,
  normalizeRepoUrl,
  PAGINATION,
  resolveBranchStorageConfig,
  resolveMultiTenancyConfig,
} from '@agor/core/config';
import {
  BranchRepository,
  getCurrentTenantId,
  RepoRepository,
  runWithTenantDatabaseTransaction,
  shortId,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import { autoAssignBranchUniqueId } from '@agor/core/environment/variable-resolver';
import { type Application, BadRequest, Forbidden, NotAuthenticated } from '@agor/core/feathers';
import { redactGitUrlCredentials, stripGitUrlCredentials } from '@agor/core/git/pure';
import type {
  AuthenticatedParams,
  Branch,
  CloneRepositoryResult,
  QueryParams,
  Repo,
  RepoEnvironment,
  RepoSlug,
  UserID,
  UserRole,
  UUID,
} from '@agor/core/types';
import { hasMinimumRole, ROLES, TEAMMATE_FRAMEWORK_REPO_URL } from '@agor/core/types';
import { DrizzleService } from '../adapters/drizzle';
import type { BranchesServiceImpl } from '../declarations.js';
import { emitHaNativeSocketEvent, tenantChannelName } from '../realtime/routing.js';
import { ensureBranchWorkspaceAccess } from '../utils/branch-workspace-path.js';
import { shouldUseCloneReferencePath } from '../utils/clone-reference.js';
import { emitServiceEvent } from '../utils/emit-service-event.js';
import { resolveDelegatedExecutionHomeKey } from '../utils/executor-delegated-home.js';
import {
  getDaemonUrl,
  requestExecutor,
  spawnExecutorFireAndForget,
} from '../utils/spawn-executor.js';
import { withFreshTenantWrite } from '../utils/tenant-db-scope.js';
import { issueExecutorCommandToken } from './session-token-service.js';

/**
 * Repo service params
 */
export type RepoParams = QueryParams<{
  slug?: string;
  managed_by_agor?: boolean;
  cleanup?: boolean; // For delete operations: true = delete filesystem, false = database only
}>;

function deriveLocalRepoSlug(remoteUrl: string | undefined, explicitSlug?: string): RepoSlug {
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

  if (remoteUrl && isValidGitUrl(remoteUrl)) {
    try {
      const remoteSlug = extractSlugFromUrl(remoteUrl);
      return toLocalSlug(remoteSlug);
    } catch {
      // fall through to error below
    }
  }

  throw new Error(
    'Could not auto-detect slug for local repository.\nUse --slug to provide one explicitly'
  );
}

/**
 * Extended repos service with custom methods
 */
export class ReposService extends DrizzleService<Repo, Partial<Repo>, RepoParams> {
  private repoRepo: RepoRepository;
  private app: Application;
  private db: TenantScopeAwareDatabase;

  constructor(db: TenantScopeAwareDatabase, app: Application) {
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

  override async create(
    data: Partial<Repo> | Partial<Repo>[],
    params?: RepoParams
  ): Promise<Repo | Repo[]> {
    const rows = Array.isArray(data) ? data : [data];
    if (
      resolveMultiTenancyConfig(this.app.get('config')).mode === 'required_from_auth' &&
      rows.some((row) => row.repo_type === 'local')
    ) {
      throw new BadRequest(
        'Local repository registration is unavailable in hosted multi-tenant mode.'
      );
    }
    return super.create(data, params);
  }

  override async patch(
    id: string | null,
    data: Partial<Repo>,
    params?: RepoParams
  ): Promise<Repo | Repo[]> {
    if (
      data.repo_type === 'local' &&
      resolveMultiTenancyConfig(this.app.get('config')).mode === 'required_from_auth'
    ) {
      if (!id) {
        throw new BadRequest(
          'Bulk conversion to local repositories is unavailable in hosted multi-tenant mode.'
        );
      }
      const current = await this.get(id, params);
      if (current.repo_type !== 'local') {
        throw new BadRequest(
          'Local repository registration is unavailable in hosted multi-tenant mode.'
        );
      }
    }
    return super.patch(id, data, params);
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
    if (!userId) throw new NotAuthenticated('Authentication required');
    const mayImportEnvironment = hasMinimumRole(
      (params as AuthenticatedParams | undefined)?.user?.role,
      ROLES.ADMIN
    );

    // The clone worker is the initiating user over ordinary Feathers
    // authorization. Admin-derived `.agor.yml` import below therefore passes
    // the same environment hook as an interactive repo patch; members cannot
    // smuggle executable config through clone finalization.
    // A managed clone is lifecycle storage beneath the configured repo root,
    // not a read/probe in the requesting user's home. Delegated substrates
    // receive the caller's stable execution-home key for routing.
    const delegatedHomeKey = await resolveDelegatedExecutionHomeKey(
      this.db,
      userId,
      this.app.get('config')
    );

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
    const tenantId = (params as AuthenticatedParams | undefined)?.tenant?.tenant_id;
    const expectedLocalPath = path.join(getReposDir(tenantId), slug);
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
    const sessionToken = await issueExecutorCommandToken(this.app, 'git.clone', userId);

    // Fire and forget - spawn executor and return immediately.
    // Executor handles: git clone, .agor.yml parsing, repo row patching.
    // Executor resolves the token principal's bounded Git capability through
    // the executor-only credential service.
    // Unix permissions are applied synchronously inside that lifecycle executor.
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
          // `.agor.yml` can define executable environment commands. Preserve
          // the same admin boundary as direct repo create/patch even though
          // clone finalization currently authenticates as a daemon worker.
          importEnvironmentConfig: mayImportEnvironment,
          userId: userId as string | undefined,
        },
      },
      {
        logPrefix: `[clone ${slug}]`,
        delegatedHomeKey: delegatedHomeKey,
        templateVariables: {
          user_id: userId,
        },
        onExit: async (code) => {
          if (code !== 0 && code !== null) {
            console.error(
              `[clone ${slug}] Clone failed with exit code ${code}; resolving durable error`
            );
            const io = (
              app as unknown as {
                io?: {
                  to: (room: string) => { emit: (event: string, data: unknown) => void };
                };
              }
            ).io;
            // Resolve the durable row before emitting the fallback event. If
            // the executor already persisted a categorized error, include the
            // same structured payload so the fallback toast cannot lose the
            // auth/CA/Git remediation hints. If the executor crashed before
            // patching, preserve the safety-net failure row and emit that one.
            const resolveDurableFailure = async () => {
              let current: Repo | undefined;
              try {
                current = (await reposService.get(repoId)) as Repo;
                if (current.clone_status === 'cloning') {
                  current = (await reposService.patch(repoId, {
                    clone_status: 'failed',
                    clone_error: {
                      exit_code: code,
                      category: 'unknown',
                      message: `Clone exited with code ${code} before reporting an error.`,
                    },
                  })) as Repo;
                }
              } catch (err) {
                console.error(
                  `[clone ${slug}] Failed to mark repo as failed in onExit safety net:`,
                  err instanceof Error ? err.message : String(err)
                );
              }

              if (io && tenantId) {
                // Include the pinned branch in the message so an operator who
                // typo'd the Default Branch can self-diagnose.
                const branchHint = data.default_branch
                  ? ` Default Branch was set to '${data.default_branch}' — verify it exists on the remote.`
                  : '';
                emitHaNativeSocketEvent(io.to(tenantChannelName(tenantId)), 'repo:cloneError', {
                  slug,
                  url: remoteUrl,
                  error:
                    current?.clone_error?.message ??
                    `Clone failed (exit code ${code}). Check that the repository URL is correct and accessible.${branchHint}`,
                  repo_id: repoId,
                  ...(current?.clone_error ? { clone_error: current.clone_error } : {}),
                });
              } else if (io) {
                // Never fall back to a global raw Socket.IO broadcast. The
                // durable repos.patched event remains the source of truth.
                console.warn(`[clone ${slug}] Missing tenant scope; skipping clone-error toast`);
              }
            };

            // Executor callbacks outlive the request transaction that spawned
            // them. In tenant-aware modes, explicitly leave any inherited ALS
            // transaction and persist the safety-net result in one fresh,
            // write-gated tenant unit. Standalone SQLite retains its historical
            // unscoped internal-service behavior.
            if (tenantId) {
              await withFreshTenantWrite(this.db, tenantId, resolveDurableFailure);
            } else {
              await resolveDurableFailure();
            }
          }
        },
      }
    );

    // Return immediately - callers can poll `agor_repos_get(repoId)` for
    // `clone_status: 'ready' | 'failed'` to discover the final outcome.
    return { status: 'pending', slug, repo_id: repoId };
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
    if (
      effectiveType === 'local' &&
      current.repo_type !== 'local' &&
      resolveMultiTenancyConfig(this.app.get('config')).mode === 'required_from_auth'
    ) {
      throw new BadRequest(
        'Local repository registration is unavailable in hosted multi-tenant mode.'
      );
    }
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
    if (resolveMultiTenancyConfig(this.app.get('config')).mode === 'required_from_auth') {
      throw new BadRequest(
        'Local repository registration is unavailable in hosted multi-tenant mode.'
      );
    }
    if (!data.path) {
      throw new Error('Path is required to add a local repository');
    }

    const inputPath = data.path.trim();
    if (!inputPath) {
      throw new Error('Path is required to add a local repository');
    }

    const userId = (params as AuthenticatedParams | undefined)?.user?.user_id as UserID | undefined;
    const delegatedHomeKey = await resolveDelegatedExecutionHomeKey(
      this.db,
      userId,
      this.app.get('config')
    );
    const inspection = await requestExecutor(
      {
        command: 'git.repo.inspect',
        daemonUrl: getDaemonUrl(),
        params: { path: inputPath },
      },
      { delegatedHomeKey: delegatedHomeKey, logPrefix: '[repos.local.inspect]' }
    );
    if (!inspection.success)
      throw new Error(inspection.error?.message ?? 'Repository inspection failed');
    const metadata = inspection.data as {
      path: string;
      defaultBranch?: string;
      remoteUrl?: string;
      environment?: RepoEnvironment;
      credentialFindingCount: number;
      environmentWarning?: string;
    };
    const repoPath = metadata.path;
    const slug = deriveLocalRepoSlug(metadata.remoteUrl, data.slug);

    const existing = await this.repoRepo.findBySlug(slug);
    if (existing) {
      throw new Error(
        `Repository '${slug}' already exists.\nUse a different slug with: --slug custom/name`
      );
    }

    if (metadata.credentialFindingCount > 0) {
      console.warn(
        `[repos.local] Registered local repo has ${metadata.credentialFindingCount} credential-bearing remote URL(s) in git config; persisted remote_url was sanitized. Run the repair utility if this repo is managed/shared.`
      );
    }
    if (metadata.environmentWarning) {
      console.warn(`[repos.local] ${metadata.environmentWarning}`);
    }
    const name = slug.split('/').pop() ?? slug;

    const repo = (await this.create(
      {
        repo_type: 'local',
        slug,
        name,
        remote_url: metadata.remoteUrl,
        local_path: repoPath,
        default_branch: metadata.defaultBranch,
        environment: metadata.environment,
      },
      params
    )) as Repo;

    return repo;
  }

  /**
   * Custom method: Create branch
   *
   * Delegates Git workspace materialization (worktree or clone) to the executor
   * process for Unix isolation.
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
      /** Remote that owns sourceBranch when it differs from the destination repo. */
      sourceRemoteUrl?: string;
      issue_url?: string;
      pull_request_url?: string;
      boardId: string;
      custom_context?: Record<string, unknown>;
      notes?: string | null;
      /** Explicit board position. Honored as-is when supplied; otherwise
       *  the service computes a smart placement (zone-relative if a
       *  zoneId was passed, else next-free slot among existing entities).
       *  Agents/MCP callers should omit this so they don't have to think
       *  about x/y; the UI passes the viewport center. */
      position?: { x: number; y: number };
      zoneId?: string;
      environment_variant?: string;
      /**
       * Branch storage model — see context/explorations/clone-redesign.md.
       * The deployment configuration selects the default. 'worktree' uses
       * native `git worktree add`; 'clone' uses a self-standing `git clone`.
       */
      storage_mode?: 'worktree' | 'clone';
      /** Shallow clone depth (only when storage_mode='clone'). NULL/undefined = full clone. */
      clone_depth?: number;
    },
    params?: RepoParams
  ): Promise<Branch> {
    if (!data.boardId) {
      throw new BadRequest('boardId is required when creating a branch');
    }

    const repo = await this.get(id, params);

    let baseRemoteUrl: string | undefined;
    if (data.sourceRemoteUrl) {
      if (!data.createBranch || !data.sourceBranch) {
        throw new BadRequest(
          'sourceRemoteUrl requires createBranch=true and a sourceBranch to qualify.'
        );
      }
      baseRemoteUrl = stripGitUrlCredentials(data.sourceRemoteUrl);
      if (!isValidGitUrl(baseRemoteUrl)) {
        throw new BadRequest(`Invalid sourceRemoteUrl: ${redactGitUrlCredentials(baseRemoteUrl)}`);
      }
      if (baseRemoteUrl !== TEAMMATE_FRAMEWORK_REPO_URL) {
        throw new BadRequest(
          'sourceRemoteUrl must identify the canonical Agor teammate template repository.'
        );
      }
      // Persist the server-owned constant rather than a client spelling of it.
      // The executor may attach the caller's Git credential to this host, so
      // this must never become an arbitrary client-selected outbound target.
      baseRemoteUrl = TEAMMATE_FRAMEWORK_REPO_URL;
    }

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
    const config = this.app.get('config');
    const { defaultMode } = resolveBranchStorageConfig(config);
    const storageMode: 'worktree' | 'clone' = data.storage_mode ?? defaultMode;
    ensureBranchStorageModeAllowed(storageMode, config);
    if (
      storageMode === 'worktree' &&
      resolveMultiTenancyConfig(config).mode === 'required_from_auth'
    ) {
      throw new BadRequest(
        "storage_mode='worktree' is unavailable in hosted multi-tenant mode; use clone storage."
      );
    }
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
      ensureBranchCloneDepthAllowed(cloneDepth, config);
    }
    // Auth hooks (`requireMinimumRole`) guarantee `params.user` exists by
    // the time we get here. The identity is forwarded so executor-local Git
    // can resolve the requesting user's credential route.
    const userId = (params as AuthenticatedParams).user!.user_id as UserID;

    // Delegated routing is configuration/auth validation, not filesystem
    // materialization. Resolve it before persisting a branch intent so an
    // invalid or missing home key cannot leave a row stuck in `creating`.
    const delegatedHomeKey = await resolveDelegatedExecutionHomeKey(this.db, userId, config);

    if (storageMode === 'clone') {
      if (!repo.remote_url) {
        throw new Error(
          `Cannot create a clone-mode branch for repo '${repo.slug}': repo has no remote_url. ` +
            `Register the repo with a remote first, or choose another storage mode enabled by this deployment.`
        );
      }
    }
    // NOTE: Filesystem and remote-ref checks live in the executor / core
    // helpers — they're filesystem/network facts, not DB facts. The daemon
    // persists the authorized intent first; the executor atomically resolves
    // the tenant-scoped row and performs those checks during materialization.
    // Materialization failures are surfaced via
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

    const tenantId = (params as AuthenticatedParams | undefined)?.tenant?.tenant_id;
    const branchPath = getBranchPath(repo.slug, data.name, tenantId);

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

    // Environment command templates (start_command, stop_command, etc.) are
    // rendered by the executor after filesystem materialization.

    // Storage mode (storageMode + cloneDepth) was resolved + validated up
    // top so the preflights could gate on it; reuse those vars below.

    // Create DB record EARLY with 'creating' status
    // Executor will:
    // 1. Create git branch on filesystem
    // 2. Render environment templates with the materialized branch context
    // 3. Patch branch to 'ready' with rendered templates
    let branch = (await branchesService.create(
      {
        repo_id: repo.repo_id,
        name: data.name,
        path: branchPath,
        ref: data.ref,
        ref_type: data.refType,
        base_ref: data.sourceBranch,
        base_remote_url: baseRemoteUrl,
        new_branch: data.createBranch ?? false,
        branch_unique_id: branchUniqueId,
        filesystem_status: 'creating', // Will be set to 'ready' by executor
        // Environment templates are rendered after filesystem materialization.
        // RBAC fields are intentionally omitted at creation: new branches
        // always align with their board defaults. Overrides are a deliberate
        // post-create action from the Branch permissions tab.
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
    // The executor operates as the initiating user: it updates only the
    // filesystem status directly, then asks the daemon's existing
    // render-environment route to derive executable fields from trusted repo
    // configuration. Per-user credentials come from the same Feathers identity.
    // Filesystem authorization stays fail-closed inside the selected substrate.
    try {
      const sessionToken = await issueExecutorCommandToken(
        this.app,
        'git.branch.add',
        userId,
        branch.branch_id
      );

      spawnExecutorFireAndForget(
        {
          command: 'git.branch.add',
          sessionToken,
          daemonUrl: getDaemonUrl(),
          params: {
            branchId: branch.branch_id,
            repoId: repo.repo_id,
            userId: userId as string | undefined,
            principalBranchAccess: 'write',
            useReference:
              storageMode === 'clone' &&
              !!repo.local_path &&
              shouldUseCloneReferencePath(this.app.get('config')),
          },
        },
        {
          logPrefix: `[ReposService.createBranch ${data.name}]`,
          delegatedHomeKey: delegatedHomeKey,
          templateVariables: {
            branch_id: branch.branch_id,
            user_id: userId,
            branch_fs_access: 'write',
          },
        }
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[ReposService.createBranch] Failed to spawn executor:', message);
      branch = (await branchesService.patch(
        branch.branch_id,
        {
          filesystem_status: 'failed',
          error_message: `Failed to spawn executor: ${message}`,
        },
        { ...params, provider: undefined }
      )) as Branch;
    }

    // Return immediately; asynchronous filesystem updates arrive via WebSocket.
    // A synchronous dispatch failure instead returns the patched failed branch.
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
    const userId = (serviceParams as Partial<AuthenticatedParams> | undefined)?.user?.user_id as
      | UserID
      | undefined;
    if (!userId) throw new NotAuthenticated('Authentication required');
    const branchFsAccess = await ensureBranchWorkspaceAccess(
      new BranchRepository(this.db),
      branch,
      userId,
      (serviceParams as Partial<AuthenticatedParams> | undefined)?.user?.role as
        | UserRole
        | undefined,
      command === 'branch.agor-yml.export' ? 'session' : 'view',
      command === 'branch.agor-yml.export' ? 'write' : 'read',
      this.app.get('config').execution?.allow_superadmin === true
    );
    const sessionToken = await issueExecutorCommandToken(
      this.app,
      command,
      userId,
      branch.branch_id
    );
    const delegatedHomeKey = await resolveDelegatedExecutionHomeKey(
      this.db,
      userId,
      this.app.get('config')
    );

    return requestExecutor(
      {
        command,
        sessionToken,
        daemonUrl: getDaemonUrl(),
        params: {
          repoId: repo.repo_id,
          branchId: branch.branch_id,
          ...params,
          cwd: branch.path,
          principalBranchAccess: branchFsAccess,
        },
      },
      {
        logPrefix: `[${command} ${repo.slug}/${branch.name}]`,
        delegatedHomeKey: delegatedHomeKey,
        templateVariables: {
          branch_id: branch.branch_id,
          user_id: userId,
          branch_fs_access: branchFsAccess,
        },
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
    if (
      !hasMinimumRole((params as Partial<AuthenticatedParams> | undefined)?.user?.role, ROLES.ADMIN)
    ) {
      throw new Forbidden('Admin access is required to import repository environment settings');
    }
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

    emitServiceEvent(this.app, {
      path: 'repos',
      event: 'patched',
      data: updated,
      params,
      id,
    });
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
    if (
      !hasMinimumRole((params as Partial<AuthenticatedParams> | undefined)?.user?.role, ROLES.ADMIN)
    ) {
      throw new Forbidden('Admin access is required to export repository environment settings');
    }
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
    // This legacy path deletes remote files before taking branch lifecycle
    // locks. Do not erase a newly admitted command's checkout. A distributed
    // repository-cleanup workflow is deliberately outside environment scope.
    const config = this.app.get('config');
    if (
      cleanup &&
      config.deployment?.mode === 'ha' &&
      config.deployment.ha?.execution_topology === 'external'
    ) {
      throw new Error(
        'Repository filesystem cleanup is unavailable with external HA execution. Stop environments, inspect outcomes, and use operator-managed cleanup; metadata-only removal remains available.'
      );
    }

    // Get ALL branches for this repo (needed for both filesystem and database cleanup).
    // CRITICAL: Use the unbounded repository query so transport pagination and
    // caller RBAC scope cannot truncate the deletion inventory.
    const branchesService = this.app.service('branches') as unknown as BranchesServiceImpl;
    const branchRepo = new BranchRepository(this.db);
    const findRepoBranches = async (repoId: UUID): Promise<Branch[]> => {
      const found = await branchRepo.findAllByRepoId(repoId);
      const foreignBranches = found.filter((branch) => branch.repo_id !== repoId);
      if (foreignBranches.length > 0) {
        throw new Error(
          `SAFETY CHECK FAILED: Found ${foreignBranches.length} branch(s) not belonging to repo ${repoId}. ` +
            `Aborting deletion to prevent cross-repo data loss. This is a bug — please report it.`
        );
      }
      return found;
    };
    const branches = await findRepoBranches(repo.repo_id as UUID);

    console.log(
      `🗑️  Repo deletion: Found ${branches.length} branch(s) for repo ${repo.slug} (${repo.repo_id})`
    );

    // If cleanup is requested and this is a remote repo, delete filesystem directories FIRST.
    // Delegate to the executor so the daemon never rm -rfs managed repo/branch dirs itself.
    if (cleanup && repo.repo_type === 'remote') {
      if (!repo.local_path) throw new Error(`Repo ${repo.repo_id} has no local_path`);

      const cleanupResult = await requestExecutor(
        {
          command: 'git.repo.delete',
          params: {
            repoId: repo.repo_id,
            repoPath: repo.local_path,
            branchPaths: branches.map((branch) => branch.path),
            reposRoot: getReposDir((params as AuthenticatedParams | undefined)?.tenant?.tenant_id),
            branchesRoot: getBranchesDir(
              (params as AuthenticatedParams | undefined)?.tenant?.tenant_id
            ),
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

    const tenantId =
      (params as AuthenticatedParams | undefined)?.tenant?.tenant_id ?? getCurrentTenantId();
    return runWithTenantDatabaseTransaction(this.db, tenantId, async () => {
      // Lock the parent first. PostgreSQL branch inserts take a conflicting FK
      // key-share lock, so none can appear after the unbounded inventory read;
      // SQLite's IMMEDIATE transaction provides the corresponding exclusion.
      const lockedRepo = await this.repoRepo.lockForBranchInventory(repo.repo_id);
      const metadataBranches = await findRepoBranches(lockedRepo.repo_id);
      for (const branch of metadataBranches) {
        // The repo deletion itself is already authorized; individual branch
        // permission hooks would incorrectly block full repository cleanup.
        await branchesService.removeMetadataWithRealtime(branch.branch_id, params);
        console.log(`🗑️  Deleted branch from database: ${branch.name}`);
      }

      // The native transaction covers every branch row plus the repository.
      // Tombstones queued above drain once, only after this final delete commits.
      return super.remove(lockedRepo.repo_id, params) as Promise<Repo>;
    });
  }
}

/**
 * Service factory function
 */
export function createReposService(db: TenantScopeAwareDatabase, app: Application): ReposService {
  return new ReposService(db, app);
}
