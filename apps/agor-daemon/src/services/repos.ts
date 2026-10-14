import { BRANCH_FILESYSTEM_ACTIONS } from '@agor/core/types';
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
  BranchMaintenanceRepository,
  BranchRepository,
  enqueueAfterTenantDatabaseCommit,
  generateId,
  getCurrentTenantId,
  RepoRepository,
  runWithTenantContext,
  runWithTenantDatabaseScope,
  runWithTenantDatabaseTransaction,
  shortId,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import { autoAssignBranchUniqueId } from '@agor/core/environment/variable-resolver';
import {
  type Application,
  BadRequest,
  Conflict,
  Forbidden,
  NotAuthenticated,
  NotFound,
} from '@agor/core/feathers';
import {
  assertNetworkGitRemoteUrl,
  redactGitUrlCredentials,
  stripGitUrlCredentials,
} from '@agor/core/git/pure';
import type {
  AuthenticatedParams,
  Board,
  Branch,
  BranchID,
  CloneRepositoryResult,
  QueryParams,
  Repo,
  RepoEnvironment,
  RepoSlug,
  UserID,
  UserRole,
  UUID,
} from '@agor/core/types';
import {
  getTeammateConfig,
  hasMinimumRole,
  isCanonicalTeammateFrameworkRepo,
  isTeammate,
  ROLES,
  TEAMMATE_FRAMEWORK_REPO_URL,
  validateRepoCleanupPolicy,
} from '@agor/core/types';
import { DrizzleService } from '../adapters/drizzle';
import { authenticatedExecutorCommandRuntimeScope } from '../auth/executor-runtime-scope.js';
import type { BranchesServiceImpl } from '../declarations.js';
import { ensureCanControlBranchEnvironment } from '../utils/branch-authorization.js';
import { resolveBranchExecutorSandboxMounts } from '../utils/branch-executor-sandbox.js';
import { ensureBranchWorkspaceAccess } from '../utils/branch-workspace-path.js';
import { shouldUseCloneReferencePath } from '../utils/clone-reference.js';
import { emitServiceEvent } from '../utils/emit-service-event.js';
import { resolveDelegatedExecutionHomeKey } from '../utils/executor-delegated-home.js';
import {
  getDaemonUrl,
  requestExecutor,
  spawnExecutorFireAndForget,
  startContainedExecutorCommand,
} from '../utils/spawn-executor.js';
import { withFreshTenantWrite } from '../utils/tenant-db-scope.js';
import {
  commitZoneEntityPlacementGrowth,
  planZoneEntityPlacement,
  type ZoneEntityPlacementPlan,
} from '../utils/zone-placement.js';
import { BRANCH_MATERIALIZATION_INTENT, type BranchParams } from './branches.js';
import { issueExecutorCommandToken } from './session-token-service.js';

/**
 * Repo service params
 */
export type RepoParams = QueryParams<{
  slug?: string;
  managed_by_agor?: boolean;
  cleanup?: boolean; // For delete operations: true = delete filesystem, false = database only
}> &
  AuthenticatedParams;

/**
 * Reduce an error to a short, log/DB-safe message. Strips embedded credentials
 * from any remote URLs the underlying git error may have echoed back, so
 * persisted `error_message` values and logs never leak secrets. Callers are
 * responsible for not passing absolute user paths into user-facing copy.
 */
function sanitizeProvisioningError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  try {
    return redactGitUrlCredentials(raw).slice(0, 2000);
  } catch {
    return 'Provisioning failed; inspect executor logs.';
  }
}

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

  /**
   * Short tenant/RLS unit of work for custom methods that bypass Feathers hooks.
   *
   * Custom route/MCP methods reach the repositories directly, so nothing else
   * establishes a tenant database scope for them. In `required_from_auth` mode
   * the daemon's database handle is a scope-requiring proxy, so an unscoped
   * repository write throws `MissingTenantDatabaseScopeError`. Re-entrant: it
   * no-ops when a compatible scope is already active.
   */
  private withTenantDatabase<T>(
    params: RepoParams | undefined,
    work: () => Promise<T>
  ): Promise<T> {
    const tenantId =
      (params as AuthenticatedParams | undefined)?.tenant?.tenant_id ?? getCurrentTenantId();
    return runWithTenantDatabaseScope(this.db, tenantId, work);
  }

  override async create(
    data: Partial<Repo> | Partial<Repo>[],
    params?: RepoParams
  ): Promise<Repo | Repo[]> {
    const rows = Array.isArray(data) ? data : [data];
    for (const row of rows) {
      this.validateCleanupPolicyWrite(row, params);
      this.validateCloneLifecycleWrite(row, params);
    }
    if (this.isHostedMultiTenancy()) {
      if (rows.some((row) => row.repo_type === 'local')) {
        throw new BadRequest(
          'Local repository registration is unavailable in hosted multi-tenant mode.'
        );
      }
      for (const row of rows) {
        this.validateHostedRemoteUrlWrite(row);
        // Managed storage is derived from the authenticated tenant and slug; a
        // caller-chosen path would become filesystem authority for Git executors.
        if (row.local_path != null && row.local_path !== this.managedRepoPath(row.slug, params)) {
          throw new BadRequest('local_path is managed by Agor and cannot be set.');
        }
      }
    }
    return super.create(data, params);
  }

  override async patch(
    id: string | null,
    data: Partial<Repo>,
    params?: RepoParams
  ): Promise<Repo | Repo[]> {
    this.validateCleanupPolicyWrite(data, params);
    this.validateCloneLifecycleWrite(data, params);
    await this.validateRepoLocationWrite(id, data, params);
    return super.patch(id, data, params);
  }

  override async update(id: string, data: Partial<Repo>, params?: RepoParams): Promise<Repo> {
    this.validateCleanupPolicyWrite(data, params);
    this.validateCloneLifecycleWrite(data, params);
    await this.validateRepoLocationWrite(id, data, params);
    return super.update(id, data, params);
  }

  /**
   * `local_path` is fixed when a repository is registered: rewriting it would
   * aim every later Git executor (origin realign, branch materialization,
   * sandbox mounts) at an arbitrary daemon-readable repository. Hosted
   * deployments additionally require network remotes and forbid local rows.
   */
  private async validateRepoLocationWrite(
    id: string | null,
    data: Partial<Repo>,
    params?: RepoParams
  ): Promise<void> {
    const hosted = this.isHostedMultiTenancy();
    if (hosted) this.validateHostedRemoteUrlWrite(data);
    const becomesLocal = hosted && data.repo_type === 'local';
    const setsLocalPath = Object.hasOwn(data, 'local_path');
    if (!becomesLocal && !setsLocalPath) return;
    if (!id) {
      throw new BadRequest(
        becomesLocal
          ? 'Bulk conversion to local repositories is unavailable in hosted multi-tenant mode.'
          : 'local_path is managed by Agor and cannot be changed.'
      );
    }
    const current = await this.get(id, params);
    if (setsLocalPath && data.local_path !== current.local_path) {
      throw new BadRequest('local_path is managed by Agor and cannot be changed.');
    }
    if (becomesLocal && current.repo_type !== 'local') {
      throw new BadRequest(
        'Local repository registration is unavailable in hosted multi-tenant mode.'
      );
    }
  }

  private validateCloneLifecycleWrite(data: Partial<Repo>, params?: RepoParams): void {
    if (!params?.provider) return; // Trusted claim / exit reconciliation is internal.
    if (
      !['clone_status', 'clone_generation', 'clone_error'].some((key) => Object.hasOwn(data, key))
    )
      return;
    if (authenticatedExecutorCommandRuntimeScope(params)?.commandId !== 'git.clone') {
      throw new Forbidden(
        'Repository setup status is managed by the Git executor. Use repository setup to retry.'
      );
    }
  }

  private isHostedMultiTenancy(): boolean {
    return resolveMultiTenancyConfig(this.app.get('config')).mode === 'required_from_auth';
  }

  /** Canonical managed clone location: `<tenant repos root>/<slug>`. */
  private managedRepoPath(slug: string | undefined, params?: RepoParams): string {
    if (!slug || !isValidSlug(slug)) {
      throw new BadRequest('A valid org/name slug is required for a managed repository.');
    }
    const tenantId =
      (params as AuthenticatedParams | undefined)?.tenant?.tenant_id ?? getCurrentTenantId();
    return path.join(getReposDir(tenantId), slug);
  }

  /** Hosted tenants share one daemon filesystem, so remotes must be network transports. */
  private validateHostedRemoteUrlWrite(data: Partial<Repo>): void {
    if (!data.remote_url) return;
    try {
      assertNetworkGitRemoteUrl(stripGitUrlCredentials(data.remote_url));
    } catch {
      throw new BadRequest(
        'Repository remote must be an HTTPS or SSH URL in hosted multi-tenant mode.'
      );
    }
  }

  private validateCleanupPolicyWrite(data: Partial<Repo>, params?: RepoParams): void {
    if (!Object.hasOwn(data, 'cleanup_policy')) return;
    // Executable repo configuration uses the existing admin boundary, even
    // for direct in-process service callers. Branch management is insufficient.
    const user = (params as AuthenticatedParams | undefined)?.user;
    if (!user || !hasMinimumRole(user.role, ROLES.ADMIN)) {
      throw new Forbidden('Admin access is required to configure repository workspace cleanup');
    }
    try {
      data.cleanup_policy = validateRepoCleanupPolicy(data.cleanup_policy);
    } catch {
      throw new BadRequest(
        'Invalid cleanup policy: supply boolean settings and a command of at most 4096 characters, nonempty when enabled, with no NUL'
      );
    }
  }

  /**
   * Custom method: Find repo by slug
   */
  async findBySlug(slug: string, _params?: RepoParams): Promise<Repo | null> {
    return this.repoRepo.findBySlug(slug);
  }

  /**
   * Register / retry a managed clone. A retry retains the repo and all branches.
   * Claims are atomic across daemon replicas; executors start only after commit.
   * `exists` is registration, not proof of caller remote access or filesystem readiness.
   */
  async cloneRepository(
    data: { url: string; slug?: string; name?: string; default_branch?: string },
    params?: RepoParams
  ): Promise<CloneRepositoryResult> {
    const user = params?.user;
    if (!user?.user_id) throw new NotAuthenticated('Authentication required');
    if (!hasMinimumRole(user.role, ROLES.MEMBER)) {
      throw new Forbidden('Member access is required to set up repositories.');
    }
    const userId = user.user_id as UserID;
    const remoteUrl = stripGitUrlCredentials(data.url);
    const slug = data.slug || data.name || extractSlugFromUrl(normalizeRepoUrl(remoteUrl));
    if (!slug || !isValidSlug(slug)) {
      throw new BadRequest('Provide a valid repository URL and name.');
    }
    if (this.isHostedMultiTenancy()) this.validateHostedRemoteUrlWrite({ remote_url: remoteUrl });

    return this.withTenantDatabase(params, async () => {
      // Metadata is shared within this tenant, credentials are not. Joining an
      // existing registration needs no new executor or credential token. This
      // fast path is only an optimization; claimClone still arbitrates races.
      const existing = await this.repoRepo.findBySlug(slug);
      if (existing) {
        if (
          existing.repo_type !== 'remote' ||
          normalizeRepoUrl(existing.remote_url ?? '') !== normalizeRepoUrl(remoteUrl)
        ) {
          throw new Conflict(
            'This repository name is already registered with a different source. Choose another name or ask an administrator to check repository settings.'
          );
        }
        if (existing.clone_status !== 'failed')
          return { status: 'exists', slug, repo_id: existing.repo_id };
      }
      // Validate routing and credentials before claiming, so these failures cannot
      // leave a placeholder stuck in cloning with no worker to finish it.
      const delegatedHomeKey = await resolveDelegatedExecutionHomeKey(
        this.db,
        userId,
        this.app.get('config')
      );
      const sessionToken = await issueExecutorCommandToken(this.app, 'git.clone', userId);
      const claim = await this.repoRepo.claimClone({
        slug: slug as RepoSlug,
        name: data.name || slug,
        repo_type: 'remote',
        remote_url: remoteUrl,
        local_path: this.managedRepoPath(slug, params),
        ...(data.default_branch ? { default_branch: data.default_branch } : {}),
      });
      const repo = claim.repo;
      const repoId = repo.repo_id;
      if (!claim.acquired) return { status: 'exists', slug, repo_id: repoId };
      const generation = repo.clone_generation;
      const tenantId = params?.tenant?.tenant_id ?? getCurrentTenantId();
      emitServiceEvent(this.app, {
        path: 'repos',
        event: claim.created ? 'created' : 'patched',
        data: repo,
        params,
        id: repoId,
      });

      // The old worker may exit after a retry has already claimed the same row.
      // Both the read and the atomic repository update fence on attempt identity.
      const reportFailure = async (code: number | null, dispatchError?: unknown) => {
        const work = async () => {
          const reposService = this.app.service('repos');
          const current = (await reposService.get(repoId)) as Repo;
          if (current.clone_generation !== generation || current.clone_status !== 'cloning') return;
          const diagnostic = dispatchError
            ? sanitizeProvisioningError(dispatchError)
            : `Repository setup worker exited (${code ?? 'signal'}) before reporting an outcome.`;
          console.error(`[clone ${slug}] attempt ${generation}: ${diagnostic}`);
          await reposService.patch(repoId, {
            clone_status: 'failed',
            clone_generation: generation,
            clone_error: { exit_code: code || 1, category: 'unknown', message: diagnostic },
          });
          // Durable repos.patched is the source of truth. Do not broadcast raw
          // errors to the whole tenant or mark a newer successful attempt failed.
        };
        try {
          if (tenantId) await withFreshTenantWrite(this.db, tenantId, work);
          else await work();
        } catch (error) {
          console.error(
            `[clone ${slug}] Could not persist setup outcome: ${sanitizeProvisioningError(error)}`
          );
        }
      };
      const launch = async () => {
        try {
          spawnExecutorFireAndForget(
            {
              command: 'git.clone',
              sessionToken,
              daemonUrl: getDaemonUrl(),
              params: {
                url: remoteUrl,
                slug,
                repoId,
                cloneGeneration: generation,
                outputPath: repo.local_path,
                ...(repo.default_branch ? { default_branch: repo.default_branch } : {}),
                createDbRecord: true,
                // Recovery must not replace saved variants/template overrides.
                // Existing repos can import YAML through the explicit admin action.
                importEnvironmentConfig: claim.created && hasMinimumRole(user.role, ROLES.ADMIN),
                userId,
              },
            },
            {
              logPrefix: `[clone ${slug}]`,
              delegatedHomeKey,
              templateVariables: { user_id: userId },
              onExit: (code) => reportFailure(code),
            }
          );
        } catch (error) {
          await reportFailure(1, error);
        }
      };
      // Includes the command token as well as the row. In PostgreSQL, launching
      // inside the request transaction races the worker's first authenticated read.
      if (
        !enqueueAfterTenantDatabaseCommit(async () => {
          if (tenantId) await runWithTenantContext(tenantId, launch);
          else await launch();
        })
      )
        await launch();
      return { status: 'pending', slug, repo_id: repoId };
    });
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
    // Both MCP and HTTP enter with tenant identity only. Admit in a short
    // write-gated unit, then release it before the executor inspects the repo.
    const tenantId =
      (params as AuthenticatedParams | undefined)?.tenant?.tenant_id ?? getCurrentTenantId();
    const delegatedHomeKey = await withFreshTenantWrite(this.db, tenantId, () =>
      resolveDelegatedExecutionHomeKey(this.db, userId, this.app.get('config'))
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

    // Inspection may outlive admission; recheck the write gate when persisting.
    return withFreshTenantWrite(this.db, tenantId, async () => {
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
    });
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
       * Branch storage model. The deployment configuration selects the default. 'worktree' uses
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

    // The deterministic workspace path is owned by the branch name even while
    // archived. Reusing it would let a new row collide with preserved cleanup.
    const branchRepo = new BranchRepository(this.db);
    const existingBranch = await branchRepo.findByRepoAndName(repo.repo_id as UUID, data.name);
    if (existingBranch) {
      throw new Conflict(
        existingBranch.archived
          ? `An archived branch named '${data.name}' still owns this workspace path. Unarchive it instead of creating a new branch.`
          : `A branch named '${data.name}' already exists in this repository`
      );
    }

    // Resolve + validate the storage mode. The daemon owns DB/auth/config
    // shape; everything else (git/filesystem inspection, conflict detection,
    // path-exists checks) belongs to the executor (see operator's layering
    // rule: "daemon/client = database, executor = filesystem").
    const config = this.app.get('config');
    const { defaultMode } = resolveBranchStorageConfig(config);
    const localHome = isTeammate(data) && isCanonicalTeammateFrameworkRepo(repo);
    const storageMode: 'worktree' | 'clone' = localHome
      ? 'clone'
      : (data.storage_mode ?? defaultMode);
    ensureBranchStorageModeAllowed(storageMode, config);
    if (
      storageMode === 'worktree' &&
      resolveMultiTenancyConfig(config).mode === 'required_from_auth'
    ) {
      throw new BadRequest(
        "storage_mode='worktree' is unavailable in hosted multi-tenant mode; use clone storage."
      );
    }
    const cloneDepth = localHome ? undefined : data.clone_depth;
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
    let zonePlacement: ZoneEntityPlacementPlan | undefined;
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
        // Plan the zone slot before any row exists: a zone pin must be
        // contained, so a fixed-size zone with no room fails here with a clear
        // error instead of creating a branch whose pin cannot hold it.
        if (!data.position) {
          zonePlacement = await planZoneEntityPlacement(this.app, params ?? {}, {
            board: board as Board,
            zoneId: data.zoneId,
          });
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
    const branchCreateParams: BranchParams | undefined = localHome
      ? { ...params, [BRANCH_MATERIALIZATION_INTENT]: true }
      : params;
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
        // Generation owning this first attempt. Fences its acknowledgements
        // against any later retry that supersedes it.
        provisioning_attempt_id: generateId(),
        provisioning_operation: 'create',
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
      branchCreateParams
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
        // If placing in a zone, use the contained slot planned above, growing
        // the zone first when its resize policy required it.
        if (!position && zonePlacement) {
          position = zonePlacement.position;
          try {
            await commitZoneEntityPlacementGrowth(
              this.app,
              params ?? {},
              board as Board,
              zonePlacement
            );
          } catch (error) {
            // The branch row already exists. Keep the pin at the planned slot —
            // an undersized zone is visible and fixable by an arrange, whereas
            // dropping the pin silently strands the branch outside its zone.
            console.warn(
              `⚠️  Could not grow zone ${zonePlacement.zoneId} for new branch; pinning without resize:`,
              error instanceof Error ? error.message : String(error)
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
    branch = await this.dispatchBranchProvisioning(
      branch,
      repo,
      userId,
      params,
      'create',
      delegatedHomeKey
    );

    // Return immediately; asynchronous filesystem updates arrive via WebSocket.
    // A synchronous dispatch failure instead returns the patched failed branch.
    return branch;
  }

  /**
   * Spawn the `git.branch.add` executor that materializes a branch's working
   * directory, with a daemon-side safety net for observed executor failures.
   * HA orphan recovery after owner loss requires a separate ownership protocol.
   *
   * The executor itself patches `ready`/`failed` when it can, but only if its
   * own error handler runs AND it still holds a daemon connection. When the
   * process is killed or crashes first (SIGTERM on a watch restart, OOM, a
   * startup crash, a dropped socket) nothing would otherwise transition the
   * row. The `onExit` net below reconciles those cases.
   *
   * A synchronous spawn failure is patched to `failed` and the patched row is
   * returned, so `createBranch` still hands its caller the failed
   * representation rather than a stale `creating` one.
   *
   * Reusable for explicit `retryBranchProvisioning()` calls. The standalone
   * startup watchdog only marks interrupted attempts failed; it never dispatches. Structured logs are emitted at
   * enqueue / exit / reconcile so the lifecycle is traceable.
   *
   * `delegatedHomeKey` is pre-resolved by `createBranch` on purpose — routing
   * is validated before a branch row is persisted, so an invalid home key can
   * never leave a row stuck in `creating`. Other callers resolve it here.
   */
  private async dispatchBranchProvisioning(
    branch: Branch,
    repo: Repo,
    userId: UserID,
    params: RepoParams | undefined,
    reason: 'create' | 'retry' | 'restore',
    delegatedHomeKey?: string
  ): Promise<Branch> {
    const storageMode = branch.storage_mode ?? 'worktree';
    const logPrefix = `[branch-provisioning ${shortId(branch.branch_id)}]`;
    // Capture the tenant NOW (we are inside a request/startup scope). The
    // executor's onExit fires asynchronously after that scope has unwound, so
    // any DB write there must re-establish this tenant's transaction scope or
    // Postgres rejects the SAVEPOINT the branch mutation opens.
    const tenantId = getCurrentTenantId();
    // The generation this dispatch owns. Captured by the onExit closure and
    // handed to the executor so both acknowledgement paths can be fenced: if a
    // retry supersedes this attempt, neither our late onExit nor the executor's
    // late terminal patch may write over the newer attempt.
    const attemptId = branch.provisioning_attempt_id;
    try {
      const sessionToken = await issueExecutorCommandToken(
        this.app,
        'git.branch.add',
        userId,
        branch.branch_id,
        undefined,
        attemptId
      );

      // Retry/watchdog callers have no pre-resolved routing; create passes its
      // own so validation still happens before the row is persisted.
      const homeKey =
        delegatedHomeKey ??
        (await resolveDelegatedExecutionHomeKey(this.db, userId, this.app.get('config')));

      console.log(
        `${logPrefix} enqueue git.branch.add (reason=${reason}, storage_mode=${storageMode})`
      );

      const launch = () =>
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
              // Echoed back on the executor's terminal patch so a superseded
              // attempt's late ack can be discarded instead of overwriting a
              // newer one.
              ...(attemptId ? { provisioningAttemptId: attemptId } : {}),
              restoreMode: branch.provisioning_operation === 'restore',
              allowExistingCheckout: reason !== 'create',
              useReference:
                storageMode === 'clone' &&
                !getTeammateConfig(branch)?.localHome &&
                !!repo.local_path &&
                shouldUseCloneReferencePath(this.app.get('config')),
            },
          },
          {
            logPrefix,
            delegatedHomeKey: homeKey,
            templateVariables: {
              branch_id: branch.branch_id,
              user_id: userId,
              branch_fs_access: 'write',
            },
            onExit: (code) => {
              if (code === 0) {
                // Success path: the executor patched 'ready' itself.
                console.log(`${logPrefix} executor exited cleanly (code 0)`);
                return;
              }
              console.error(
                `${logPrefix} executor exited with code ${code ?? 'null'}; running safety-net reconcile`
              );
              void this.reconcileBranchFilesystemAfterExit(
                branch.branch_id,
                code,
                tenantId,
                attemptId
              );
            },
          }
        );
      // REST uses short scopes; MCP may own an outer transaction. Neither the
      // attempt nor its command credential may be consumed before commit.
      if (
        reason !== 'create' &&
        enqueueAfterTenantDatabaseCommit(async () => {
          const work = async () => {
            try {
              launch();
            } catch (error) {
              await this.markBranchProvisioningFailedIfStuck(
                branch.branch_id,
                `Failed to spawn executor: ${sanitizeProvisioningError(error)}`,
                tenantId,
                attemptId
              );
            }
          };
          if (tenantId) await runWithTenantContext(tenantId, work);
          else await work();
        })
      )
        return branch;
      launch();
      return branch;
    } catch (error) {
      // Synchronous spawn failure (token generation, routing resolution, or a
      // missing executor binary). Fire-and-forget means no process exists to
      // emit onExit, so mark the branch failed here or it stays 'creating'
      // with no signal at all. Returned so callers surface the failed row.
      const message = error instanceof Error ? error.message : String(error);
      console.error(`${logPrefix} failed to spawn executor: ${message}`);
      const { applied, branch: failedBranch } = await new BranchRepository(
        this.db
      ).acknowledgeProvisioningAttempt(
        branch.branch_id,
        {
          filesystem_status: 'failed',
          error_message: `Failed to spawn executor: ${message}`,
        },
        attemptId
      );
      if (applied) this.emitBranchPatched(failedBranch, params);
      return failedBranch;
    }
  }

  /**
   * onExit safety net: after a non-zero executor exit, move the branch to a
   * terminal `failed` state IF it is still `creating` (the executor died before
   * it could report success or failure itself). Deliberately does NOT inspect
   * the daemon-local filesystem or promote to `ready` from a `.git` path — a
   * daemon cannot reliably tell a complete checkout from a stale/partial/
   * wrong-ref one, and in a multi-host deployment it may not even see the
   * executor's filesystem. Surfacing `failed` keeps a human decision point;
   * the user (or MCP/UI) retries explicitly. Never deletes refs or directories.
   *
   * Fenced on `attemptId`: this net belongs to one specific dispatch. A slow
   * attempt can exit long after a retry has already claimed `creating` for a
   * newer attempt, and marking the row `failed` then would kill a healthy
   * in-flight materialization.
   */
  private async reconcileBranchFilesystemAfterExit(
    branchId: string,
    code: number | null,
    tenantId: string | undefined,
    attemptId: string | undefined
  ): Promise<void> {
    await this.markBranchProvisioningFailedIfStuck(
      branchId,
      `Branch provisioning did not complete: the materialization process exited with code ${code ?? 'unknown'} before it could confirm a usable working directory. Retry provisioning to try again.`,
      tenantId,
      attemptId
    );
  }

  /**
   * Atomically move a branch to `failed` with an actionable message IF (and
   * only if) it is still `creating`. The compare-and-swap lives in the
   * repository under a row lock, so it never clobbers a terminal status the
   * executor already wrote and never races a concurrent transition. Emits a
   * `patched` event so connected UIs update.
   */
  private async markBranchProvisioningFailedIfStuck(
    branchId: string,
    message: string,
    tenantId: string | undefined,
    expectedAttemptId?: string
  ): Promise<boolean> {
    const logPrefix = `[branch-provisioning ${shortId(branchId)}]`;
    try {
      return await runWithTenantDatabaseScope(this.db, tenantId, async () => {
        const branchRepo = new BranchRepository(this.db);
        const { changed, branch } = await branchRepo.markProvisioningFailedIfCreating(
          branchId,
          message,
          expectedAttemptId
        );
        if (changed) {
          console.warn(`${logPrefix} → failed (interrupted provisioning surfaced for retry)`);
          this.emitBranchPatched(branch);
        }
        return changed;
      });
    } catch (error) {
      console.error(
        `${logPrefix} failed to mark stuck branch failed: ${sanitizeProvisioningError(error)}`
      );
      return false;
    }
  }

  /**
   * Authorized retry/restore through one atomic admission and executor owner.
   * Active failed or stale archive outcomes are repairable; archived branches
   * enter only via unarchive's internal restoreArchived argument. Creating is
   * never taken over based on age. A ready active branch is a no-op.
   */
  async retryBranchProvisioning(
    branchId: string,
    params?: RepoParams,
    restoreArchived = false
  ): Promise<Branch> {
    const branchesService = this.app.service('branches');
    // Read through the service so short IDs resolve and RBAC hooks fire.
    const branch = (await branchesService.get(branchId, params)) as Branch;
    const status = branch.filesystem_status;
    const branchRepo = new BranchRepository(this.db);

    // Authorization. The `get` above only establishes VIEW access, and the CAS
    // below writes through the repository — so it never passes through the
    // branches-service `patch` hook that normally demands `all`. Without this
    // gate any member who can *see* a failed branch could trigger provisioning. Assert the
    // canonical branch-control level (effective `all`, owner, or global admin)
    // here in the service so REST, MCP and the UI are covered by one check;
    // The row-locked validation below also requires a caller and filesystem write access.
    await this.withTenantDatabase(params, () =>
      ensureCanControlBranchEnvironment(
        branchRepo,
        branch.branch_id as BranchID,
        params as AuthenticatedParams | undefined,
        'retry branch provisioning'
      )
    );

    // Archived branches have their own restore/unarchive lifecycle. Status alone
    // does not catch this: archiving overwrites `filesystem_status`, but an
    // already-`failed` branch that was then archived can still read `failed`.
    if (branch.archived && !restoreArchived) {
      throw new Conflict(
        'This branch is archived. Unarchive it first — archived branches are restored through the unarchive flow, not by retrying provisioning.',
        {
          code: 'BRANCH_PROVISIONING_NOT_RETRYABLE',
          branchId: branch.branch_id,
          filesystemStatus: status ?? 'unknown',
        }
      );
    }

    const restore =
      restoreArchived || BRANCH_FILESYSTEM_ACTIONS.some((candidate) => candidate === status);
    if (status === 'ready' && !restore) {
      return branch;
    }
    if (status === 'creating') {
      throw new Conflict(
        'Branch provisioning is already in progress. Wait for it to finish before retrying.',
        {
          code: 'BRANCH_PROVISIONING_IN_PROGRESS',
          branchId: branch.branch_id,
          filesystemStatus: status,
        }
      );
    } else if (status !== 'failed' && !restore) {
      throw new Conflict(
        `Branch provisioning cannot be retried from status "${status ?? 'unknown'}". Only failed or active preserved/cleaned/deleted records are recoverable; use unarchive for archived branches.`,
        {
          code: 'BRANCH_PROVISIONING_NOT_RETRYABLE',
          branchId: branch.branch_id,
          filesystemStatus: status ?? 'unknown',
        }
      );
    }

    const repo = await this.withTenantDatabase(params, () =>
      this.repoRepo.findById(branch.repo_id)
    );
    if (!repo) {
      throw new BadRequest(`Repo ${branch.repo_id} not found for branch ${branchId}`);
    }

    const requestUser = params?.user;
    if (!requestUser) throw new NotAuthenticated('Authentication required');
    const validate = async (db: import('@agor/core/db').Database, current: Branch) => {
      await ensureBranchWorkspaceAccess(
        new BranchRepository(db),
        current,
        requestUser.user_id,
        requestUser.role as UserRole,
        'all',
        'write',
        this.app.get('config').execution?.allow_superadmin === true
      );
      if (current.path !== branch.path || current.repo_id !== branch.repo_id)
        throw new Conflict('Branch location changed; refresh before recovery');
      if (
        (current.storage_mode ?? 'worktree') === 'worktree' &&
        resolveMultiTenancyConfig(this.app.get('config')).mode === 'required_from_auth'
      )
        throw new BadRequest(
          'Historical worktree branches cannot be restored in hosted multi-tenant mode.'
        );
    };
    const { claimed, branch: claimedBranch } = await this.withTenantDatabase(params, () =>
      branchRepo.claimForProvisioning(branch.branch_id, generateId(), {
        restore,
        archived: restoreArchived,
        validate,
      })
    );
    if (!claimed) {
      // A competing attempt can finish before our locked read. Returning its
      // durable ready state is a safe no-op, never another executor admission.
      if (
        !claimedBranch.archived &&
        !claimedBranch.deletion_status &&
        claimedBranch.filesystem_status === 'ready'
      )
        return claimedBranch;
      if (claimedBranch.filesystem_status === 'creating') {
        throw new Conflict(
          'Branch provisioning is already in progress. Wait for it to finish before retrying.',
          {
            code: 'BRANCH_PROVISIONING_IN_PROGRESS',
            branchId: claimedBranch.branch_id,
            filesystemStatus: 'creating',
          }
        );
      }
      throw new Conflict(
        'Branch recovery is blocked or its state changed. Refresh before retrying.'
      );
    }
    this.emitBranchPatched(claimedBranch, params);
    // Use the authorized caller's credentials and execution identity, never the
    // original creator's credentials for another manager's recovery request.
    return this.withTenantDatabase(params, () =>
      this.dispatchBranchProvisioning(
        claimedBranch,
        repo,
        requestUser.user_id as UserID,
        params,
        restore ? 'restore' : 'retry'
      )
    );
  }

  /**
   * Legacy standalone-startup reconciliation of interrupted provisioning.
   * The caller must establish that no other materializer can still own these
   * attempts; a `creating` row alone is not evidence of owner death. HA startup
   * does not call this method. It marks eligible rows `failed` without checking
   * local `.git` paths or automatically dispatching replacements.
   *
   * This operates only in the caller's trusted tenant scope (the bootstrap
   * tenant at standalone startup), never as a cross-tenant sweep. Other tenants'
   * stranded `creating` rows are not recovered here, and retryBranchProvisioning
   * refuses them. The bounded scan is a safety net, not a guarantee that all
   * interrupted provisioning becomes retryable.
   */
  async reconcileStuckCreatingBranches(
    params?: RepoParams
  ): Promise<{ scanned: number; failed: number }> {
    const SCAN_LIMIT = 5000;
    const branchRepo = new BranchRepository(this.db);
    const stuck = await this.withTenantDatabase(params, () =>
      branchRepo.findCreatingPage(SCAN_LIMIT + 1)
    );
    if (stuck.length > SCAN_LIMIT) {
      console.warn(
        `[branch-provisioning] watchdog: hit the ${SCAN_LIMIT}-row scan cap — some stuck branches may not be reconciled this pass.`
      );
    }
    // Filter in memory: `filesystem_status` is a real column but the generic
    // service find does not guarantee arbitrary-column pushdown, so don't rely
    // on the query narrowing it for us.
    stuck.length = Math.min(stuck.length, SCAN_LIMIT);

    const tenantId = getCurrentTenantId();
    // Count only transitions the CAS actually applied. A row can leave
    // `creating` between the scan and the write (the executor acks, or another
    // reconcile wins), in which case the CAS reports `changed: false` — counting
    // it anyway would over-report transitions in the operational summary.
    const summary = { scanned: stuck.length, failed: 0 };
    for (const branch of stuck) {
      const changed = await this.markBranchProvisioningFailedIfStuck(
        branch.branch_id,
        'Branch provisioning was interrupted — the daemon restarted before it completed. Retry provisioning to try again.',
        tenantId
      );
      if (changed) summary.failed++;
    }
    if (summary.scanned > 0) {
      console.log(
        `[branch-provisioning] watchdog: scanned=${summary.scanned} failed=${summary.failed} (interrupted → failed, awaiting explicit retry)`
      );
    }
    return summary;
  }

  /**
   * Broadcast a `branches` `patched` event for a row we wrote directly through
   * the repository (the atomic provisioning CAS bypasses the Feathers service,
   * so its automatic event doesn't fire). Best-effort: if it can't emit, the
   * executor's own terminal `patch` — or a client refetch — still converges.
   * `params` carries the requester's tenant/connection context so the event
   * reaches browser sockets; the crash/watchdog paths have none, which is fine
   * (those set `failed`, which clients also pick up on their next read).
   */
  private emitBranchPatched(branch: Branch, params?: RepoParams): void {
    try {
      emitServiceEvent(this.app, {
        path: 'branches',
        event: 'patched',
        data: branch,
        params,
        id: branch.branch_id,
      });
    } catch (error) {
      console.warn(
        `[branch-provisioning ${shortId(branch.branch_id)}] failed to emit patched event: ${sanitizeProvisioningError(error)}`
      );
    }
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
    const tenantId = getCurrentTenantId();
    if (!tenantId) throw new NotAuthenticated('Trusted tenant context is required');
    // Long routes (export) carry tenant identity without a database scope, so
    // prepare the launch in one short tenant unit and run the executor outside it.
    const { branchFsAccess, delegatedHomeKey, sandboxMounts } = await this.withTenantDatabase(
      serviceParams,
      async () => ({
        branchFsAccess: await ensureBranchWorkspaceAccess(
          new BranchRepository(this.db),
          branch,
          userId,
          (serviceParams as Partial<AuthenticatedParams> | undefined)?.user?.role as
            | UserRole
            | undefined,
          command === 'branch.agor-yml.export' ? 'session' : 'view',
          command === 'branch.agor-yml.export' ? 'write' : 'read',
          this.app.get('config').execution?.allow_superadmin === true
        ),
        delegatedHomeKey: await resolveDelegatedExecutionHomeKey(
          this.db,
          userId,
          this.app.get('config')
        ),
        // The caller is the execution principal for this stateless request, so
        // a per-user sandbox mounts the caller's home store (not the owner's).
        sandboxMounts: await resolveBranchExecutorSandboxMounts({
          config: this.app.get('config'),
          tenantId,
          executionUserId: userId,
          branch,
          db: this.db,
        }),
      })
    );
    const sessionToken = await issueExecutorCommandToken(
      this.app,
      command,
      userId,
      branch.branch_id
    );

    const payload = {
      command,
      sessionToken,
      daemonUrl: getDaemonUrl(),
      params: {
        repoId: repo.repo_id,
        branchId: branch.branch_id,
        ...params,
        cwd: branch.path,
        principalBranchAccess: branchFsAccess,
        ...sandboxMounts,
      },
    };
    const options = {
      logPrefix: `[${command} ${repo.slug}/${branch.name}]`,
      delegatedHomeKey: delegatedHomeKey,
      templateVariables: {
        branch_id: branch.branch_id,
        user_id: userId,
        branch_fs_access: branchFsAccess,
      },
    };
    if (command !== 'branch.agor-yml.export') return requestExecutor(payload, options);
    const scoped = <T>(work: (repository: BranchMaintenanceRepository) => Promise<T>) =>
      withFreshTenantWrite(this.db, tenantId, () => work(new BranchMaintenanceRepository(this.db)));
    const admitted = await scoped((repository) =>
      repository.claim(branch.branch_id, 'workspace_write', userId, async (tx) => {
        const branches = new BranchRepository(tx);
        const current = await branches.findById(branch.branch_id);
        if (!current) throw new BadRequest('Branch no longer exists');
        await ensureBranchWorkspaceAccess(
          branches,
          current,
          userId,
          (serviceParams as Partial<AuthenticatedParams> | undefined)?.user?.role as
            | UserRole
            | undefined,
          'session',
          'write',
          this.app.get('config').execution?.allow_superadmin === true
        );
      })
    );
    if (!admitted.acquired) throw new Error('Branch workspace maintenance is already in progress');
    const invocation = await scoped((repository) => repository.beginExecution(admitted.claim));
    // The existing contained request executor owns this short taskless write.
    // Lost ownership never permits deletion to race an unknown writer.
    const handle = startContainedExecutorCommand(payload, options);
    const result = await handle.result;
    if (!(await handle.verifyAbsence()))
      throw new Error('Workspace write outcome requires containment reconciliation');
    await scoped(async (repository) => {
      await repository.settleExecution(admitted.claim, invocation);
      await repository.release(admitted.claim);
    });
    return result;
  }

  /**
   * Custom method: Import environment config from .agor.yml
   *
   * Requires `branch_id` in `data` — `.agor.yml` is branch-scoped, so the
   * caller must name which branch's working copy to read. This is a
   * one-shot manual import — the repo is NOT re-ingested automatically on
   * subsequent operations.
   *
   * Registered as a long (identity-only) route, like its export sibling: the
   * file is read by an executor process, so no tenant transaction may be held
   * across that spawn. The repo read, the branch authorization (through the
   * branches service, which arms its own scope) and the launch preparation in
   * runAgorYmlExecutorCommand each open their own short unit; the executor
   * carries the tenant only in its command token; the write runs in a fresh
   * unit after the executor returns.
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
    const tenantId =
      (params as AuthenticatedParams | undefined)?.tenant?.tenant_id ?? getCurrentTenantId();
    if (!tenantId) throw new NotAuthenticated('Trusted tenant context is required');

    const repo = await this.withTenantDatabase(params, () => this.get(id, params));
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

    // Fresh unit after the spawn: re-read the row, and re-assert the write gate
    // in case a tenant freeze began while the executor ran. Preserve any
    // existing DB-only template_overrides across import — the file never
    // contains them, so a naive replace would otherwise wipe them. Imports and
    // YAML Save share the repository's complete-configuration replacement
    // contract, removing deleted variants and fields atomically.
    const updated = await withFreshTenantWrite(this.db, tenantId, async () => {
      const current = await this.repoRepo.findById(repo.repo_id);
      if (!current) throw new NotFound(`Repository ${repo.repo_id} no longer exists`);
      const replacement: RepoEnvironment = current.environment?.template_overrides
        ? { ...environment, template_overrides: current.environment.template_overrides }
        : environment;
      return this.repoRepo.setEnvironment(current.repo_id, replacement);
    });

    emitServiceEvent(this.app, {
      path: 'repos',
      event: 'patched',
      data: updated,
      params,
      id: updated.repo_id,
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
    if (branches.length)
      throw new Error(
        'Permanently delete this repository’s branches first and wait for completion before removing the repository.'
      );

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
