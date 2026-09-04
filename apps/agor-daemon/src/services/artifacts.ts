/**
 * Artifacts Service
 *
 * REST + WebSocket API for artifact management. Artifacts are board-scoped,
 * DB-backed Sandpack apps. The format is deliberately small: a file map +
 * declarative metadata (`required_env_vars`, `agor_grants`, `sandpack_config`).
 * The daemon handles secret/grant injection at render time and never persists
 * the synthesized values.
 *
 * No backwards compatibility with the legacy `sandpack.json`/`agor.config.js`
 * sidecar format — `detectLegacyFormat` flags old artifacts so the UI can
 * surface a self-service upgrade prompt.
 */

import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { getDaemonBaseUrl, PAGINATION, resolveUserEnvironment } from '@agor/core/config';
import {
  type ArtifactListProjection,
  ArtifactRepository,
  ArtifactTrustGrantRepository,
  BoardRepository,
  BranchRepository,
  bindRepositoryToTenantUnitOfWork,
  generateId,
  getCurrentTenantId,
  RepoRepository,
  type TenantScopeAwareDatabase,
  UsersRepository,
} from '@agor/core/db';
import { type Application, Forbidden, NotAuthenticated, Unavailable } from '@agor/core/feathers';
import type {
  AgorGrants,
  AgorRuntimeConfig,
  Artifact,
  ArtifactBuildStatus,
  ArtifactConsoleEntry,
  ArtifactPayload,
  ArtifactStatus,
  ArtifactTrustScopeType,
  AuthenticatedParams,
  BoardID,
  Branch,
  BranchID,
  QueryParams,
  SandpackConfig,
  SandpackError,
  SandpackTemplate,
  SessionID,
  UserID,
  UserRole,
  UUID,
} from '@agor/core/types';
import {
  ARTIFACT_LIST_FIELDS_WITHOUT_FILES,
  ARTIFACT_METADATA_LIST_FIELDS,
  canonicalizeAgorGrants,
  GRANT_ENV_VAR_NAMES,
  hasMinimumRole,
  NO_CONSENT_GRANT_KEYS,
  ROLES,
} from '@agor/core/types';
import { DrizzleService, type Query } from '../adapters/drizzle.js';
import { matchesExecutorCommandRuntimeScope } from '../auth/executor-runtime-scope.js';
import { AGOR_RUNTIME_SOURCE } from '../utils/agor-runtime-source.js';
import { ensureBranchWorkspaceAccess } from '../utils/branch-workspace-path.js';
import { emitServiceEvent } from '../utils/emit-service-event.js';
import { resolveDelegatedExecutionHomeKey } from '../utils/executor-delegated-home.js';
import { resolveOwnerHomeStore, resolveSandboxStoragePaths } from '../utils/sandbox-context.js';
import {
  detectLegacyFormat,
  envVarPrefixForTemplate,
  normalizeSandpackConfigForRender,
  sanitizeSandpackConfig,
} from '../utils/sandpack-config.js';
import { getDaemonUrl, requestExecutor } from '../utils/spawn-executor.js';
import { issueExecutorCommandToken } from './session-token-service.js';
import type { UsersService } from './users.js';

/**
 * Lazily-built data URL carrying the agor-runtime IIFE. Sandpack injects
 * each `externalResources` entry as a `<script src="...">` tag in the
 * iframe HTML, so a `data:text/javascript;base64,…` URL avoids any extra
 * HTTP round-trip and any cross-origin coupling. Built once per process —
 * the source is a static constant.
 *
 * The `#agor-runtime.js` fragment is necessary because Sandpack's static
 * client infers content type from the URL's last extension via
 * `/\.([^.]*)$/` and rejects anything that isn't `.js` or `.css` (see
 * `@codesandbox/sandpack-client/dist/index-*.mjs` -> `injectExternalResources`).
 * A bare `data:text/javascript;base64,…` ends in base64 chars, which would
 * be silently rejected. Browsers strip the fragment when fetching, so the
 * decoded body runs identically.
 */
let cachedAgorRuntimeDataUrl: string | null = null;
function agorRuntimeDataUrl(): string {
  if (cachedAgorRuntimeDataUrl !== null) return cachedAgorRuntimeDataUrl;
  const b64 = Buffer.from(AGOR_RUNTIME_SOURCE, 'utf-8').toString('base64');
  cachedAgorRuntimeDataUrl = `data:text/javascript;base64,${b64}#agor-runtime.js`;
  return cachedAgorRuntimeDataUrl;
}

/**
 * Return a copy of `cfg` with the agor-runtime data URL set as the sole
 * entry in `options.externalResources`. The persisted `sandpack_config`
 * is never mutated — this builds a new object for the served payload only.
 *
 * `externalResources` is daemon-owned: `sanitizeSandpackConfig` deliberately
 * strips it on write (XSS into the iframe), so we don't preserve any
 * author-supplied entries here even though `SandpackConfig` allows the
 * shape — re-emitting them would re-enable a prop the sanitizer blocked.
 */
function withInjectedAgorRuntime(cfg: SandpackConfig | undefined): SandpackConfig {
  const dataUrl = agorRuntimeDataUrl();
  return {
    ...(cfg ?? {}),
    options: {
      ...(cfg?.options ?? {}),
      externalResources: [dataUrl],
    },
  };
}

/**
 * Round-trip sidecar shape written by `land()` and read back by `publishArtifact()`.
 * Carries metadata that doesn't fit into the file map (template, sandpack
 * config, declarative consent surface).
 */
interface ArtifactSidecar {
  template?: SandpackTemplate;
  sandpack_config?: SandpackConfig;
  required_env_vars?: string[];
  agor_grants?: AgorGrants;
  agor_runtime?: AgorRuntimeConfig;
}

interface ArtifactValidationDiagnostic {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  file?: string;
  suggested_fix?: string;
}

interface ArtifactValidationResult {
  status: ArtifactBuildStatus;
  errors: string[];
  warnings: string[];
  diagnostics: ArtifactValidationDiagnostic[];
}

/**
 * Public Artifact transport surface. `update` is deliberately absent: the
 * service's own `update()` strips provenance, but leaving the verb off the wire
 * is what keeps `PUT /artifacts/:id` unreachable rather than merely gated.
 */
export const ARTIFACTS_SERVICE_TRANSPORT_METHODS = [
  'find',
  'get',
  'create',
  'patch',
  'remove',
  'publishFromExecutor',
  'validateFromExecutor',
] as const;

export type ArtifactParams = QueryParams<{
  board_id?: BoardID;
  branch_id?: BranchID;
  archived?: boolean;
}> &
  AuthenticatedParams & {
    /** Internal RBAC SQL pushdown marker set by register-hooks for external regular users. */
    _agorSqlBranchAccessUserId?: UUID;
  };

const MAX_CONSOLE_ENTRIES = 100;

const ARTIFACT_METADATA_LIST_FIELD_SET = new Set<string>(ARTIFACT_METADATA_LIST_FIELDS);
const ARTIFACT_LIST_FIELD_WITHOUT_FILES_SET = new Set<string>(ARTIFACT_LIST_FIELDS_WITHOUT_FILES);

/**
 * Choose the smallest SQL row shape that still preserves the generic adapter's
 * late filter, sort, and select semantics.
 *
 * A nonempty `$select` is the only opt-in: no selection (including `$select:
 * []`) retains the full-row response contract. Fields needed by residual
 * filters and `$sort` must also be materialized even when the caller will not
 * receive them. Unknown/future fields conservatively fall back to a full row so
 * a type/schema addition cannot silently change query behavior.
 */
function resolveArtifactListProjection(query: Query): ArtifactListProjection {
  const selectedFields = Array.isArray(query.$select) ? query.$select : undefined;
  if (!selectedFields || selectedFields.length === 0) return 'full';

  const materializedFields = new Set<string>(selectedFields);
  for (const field of Object.keys(query)) {
    if (!field.startsWith('$')) materializedFields.add(field);
  }
  for (const field of Object.keys(query.$sort ?? {})) materializedFields.add(field);

  let projection: ArtifactListProjection = 'metadata';
  for (const field of materializedFields) {
    if (!ARTIFACT_LIST_FIELD_WITHOUT_FILES_SET.has(field)) return 'full';
    if (!ARTIFACT_METADATA_LIST_FIELD_SET.has(field)) projection = 'without-files';
  }
  return projection;
}

/** Path the synthesized .env file lands at in the file map. */
const SYNTHESIZED_ENV_PATH = '/.env';

export class ArtifactsService extends DrizzleService<Artifact, Partial<Artifact>, ArtifactParams> {
  private artifactRepo: ArtifactRepository;
  private trustRepo: ArtifactTrustGrantRepository;
  private branchRepo: BranchRepository;
  private boardRepo: BoardRepository;
  private repoRepo: RepoRepository;
  private usersRepo: UsersRepository;
  private app: Application;
  /** Held for `resolveUserEnvironment` (scope-aware env-var resolution). */
  private dbRef: TenantScopeAwareDatabase;
  private runtimeIntrospectionEnabled: boolean;

  /**
   * In-memory ring buffer for console logs.
   *
   * Keyed by `${artifactId}:${userId}` — NOT just artifactId. After a viewer
   * grants trust, the daemon injects their secrets into the artifact's
   * runtime; an artifact that does `console.log(import.meta.env.VITE_X)`
   * would otherwise leak that secret into a global-per-artifact buffer
   * readable by anyone via agor_artifacts_status. Per-viewer keying
   * isolates each viewer's render output.
   */
  private consoleLogs: Map<string, ArtifactConsoleEntry[]> = new Map();

  /** In-memory Sandpack error state, keyed by `${artifactId}:${userId}`. */
  private sandpackErrors: Map<string, SandpackError | null> = new Map();

  /** In-memory Sandpack status, keyed by `${artifactId}:${userId}`. */
  private sandpackStatuses: Map<string, string> = new Map();

  /** Latest browser runtime report time, keyed by `${artifactId}:${userId}`. */
  private runtimeObservedAt: Map<string, string> = new Map();

  /**
   * Runtime-status waiters for synchronous-ish artifact publishing. Keyed by
   * `${artifactId}:${userId}` so a caller can only wait on their own browser
   * render; no other viewer's logs/errors are exposed.
   */
  private runtimeStatusWaiters: Map<string, Set<() => void>> = new Map();

  /**
   * Just-once / session-scope grants live here only — never persisted.
   * Keyed by `${userId}:${artifactId}`. Cleared when the daemon restarts.
   */
  private sessionGrants: Map<string, { envVars: Set<string>; grants: AgorGrants }> = new Map();

  /**
   * In-flight runtime queries keyed by request_id.
   *
   * When an agent calls `agor_artifacts_query_dom`, the daemon emits a
   * service event a viewer's browser picks up, dispatches into the
   * Sandpack iframe via postMessage, and POSTs the iframe's reply back.
   * That POST resolves the pending entry here. Cleaned up on timeout.
   *
   * `requesterId` is checked against the response endpoint's authenticated
   * user — only the original requester can fulfill their own query, so a
   * different viewer's browser tab can't return that user's rendered DOM.
   */
  private pendingRuntimeQueries: Map<
    string,
    {
      resolve: (result: unknown) => void;
      reject: (err: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
      requesterId: string;
    }
  > = new Map();

  constructor(
    db: TenantScopeAwareDatabase,
    app: Application,
    options: { runtimeIntrospectionEnabled?: boolean } = {}
  ) {
    const artifactRepo = bindRepositoryToTenantUnitOfWork(db, new ArtifactRepository(db));
    super(artifactRepo, {
      id: 'artifact_id',
      resourceType: 'Artifact',
      paginate: {
        default: PAGINATION.DEFAULT_LIMIT,
        max: PAGINATION.MAX_LIMIT,
      },
    });
    this.artifactRepo = artifactRepo;
    this.trustRepo = bindRepositoryToTenantUnitOfWork(db, new ArtifactTrustGrantRepository(db));
    this.branchRepo = bindRepositoryToTenantUnitOfWork(db, new BranchRepository(db));
    this.boardRepo = bindRepositoryToTenantUnitOfWork(db, new BoardRepository(db));
    this.repoRepo = bindRepositoryToTenantUnitOfWork(db, new RepoRepository(db));
    this.usersRepo = bindRepositoryToTenantUnitOfWork(db, new UsersRepository(db));
    this.app = app;
    this.dbRef = db;
    this.runtimeIntrospectionEnabled = options.runtimeIntrospectionEnabled !== false;
  }

  /**
   * Resolve the authoritative, caller-scoped mount inputs required by local
   * artifact executor commands. Artifact publish/validate/land all run in the
   * authenticated actor's filesystem sandbox, not the branch owner's home.
   *
   * Request and ambient tenant identities are both trusted boundaries, but
   * they must agree when both are present. Unsafe filesystem_home overrides,
   * missing tenant ownership, and credential-authority preflight failures all
   * throw before launch; there is deliberately no shared-home fallback.
   *
   * Architecture follow-up: register-services and BranchesService compose the
   * same mount family. Keep this caller-specific resolver local until a shared
   * helper can preserve each path's DB/tenant contract with integration tests.
   */
  private async resolveExecutorSandboxMounts(
    branch: Branch,
    userId: UserID,
    params: ArtifactParams
  ): Promise<{
    sandboxHomeStore?: string;
    sandboxWorktreesRoot?: string;
    sandboxBaseRepoPath?: string;
  }> {
    const config = this.app.get('config');
    const sandbox = config.execution?.sandbox;
    if (sandbox?.enabled !== true || sandbox.home_mode !== 'per_user') return {};

    const requestTenantId = params.tenant?.tenant_id ? String(params.tenant.tenant_id) : undefined;
    const ambientTenantId = getCurrentTenantId();
    const ambientTenant = ambientTenantId ? String(ambientTenantId) : undefined;
    if (requestTenantId && ambientTenant && requestTenantId !== ambientTenant) {
      throw new Forbidden('Artifact executor tenant identity mismatch');
    }
    const tenantId = ambientTenant ?? requestTenantId;
    const filesystemHome =
      (await this.usersRepo.findById(userId))?.filesystem_home?.trim() || undefined;
    const mounts: {
      sandboxHomeStore?: string;
      sandboxWorktreesRoot?: string;
      sandboxBaseRepoPath?: string;
    } = {
      sandboxHomeStore: resolveOwnerHomeStore({
        config,
        tenantId,
        ownerUserId: userId,
        filesystemHome,
      }),
      sandboxWorktreesRoot: resolveSandboxStoragePaths(config, tenantId).worktreesRoot,
    };

    // Linked worktrees need their shared git directory available. Clone-mode
    // branches carry .git inside the branch and need no base-repo mount.
    if (branch.storage_mode !== 'clone' && branch.repo_id) {
      const repo = await this.repoRepo.findById(branch.repo_id);
      mounts.sandboxBaseRepoPath = repo?.local_path ?? undefined;
    }
    return mounts;
  }

  private assertRuntimeIntrospectionEnabled(): void {
    if (!this.runtimeIntrospectionEnabled) {
      throw new Unavailable(
        'Synchronous artifact runtime introspection is unavailable in HA support profile constrained-active-active',
        { code: 'HA_FEATURE_UNSUPPORTED', feature: 'artifactRuntime' }
      );
    }
  }

  /**
   * Push the list read's high-selectivity predicates into SQL.
   *
   * The generic adapter would read the entire artifacts table and filter in
   * memory. Artifacts are fetched on initial app load, so we narrow the read to
   * the board, archived state, explicit branch ids, and any RBAC SQL branch
   * visibility marker before rows leave the database.
   * The per-row `rowToArtifact` / `getBaseUrl` enrichment runs inside
   * `artifactRepo.findAll` on the reduced set, and `find` still re-applies every
   * query filter in memory, so this only ever returns a superset of the matching
   * rows.
   *
   * Artifacts are not query-validated, so values arrive uncoerced: only push
   * when the value already has the column's type (string `board_id`, boolean
   * `archived`, string / all-string `{ $in }` `branch_id`). Anything else falls
   * through to the unchanged in-memory filter, preserving current behavior
   * exactly.
   *
   * `artifacts.branch_id` is nullable, so a `{ $in }` that contains a non-string
   * element (e.g. `null`) is deliberately NOT pushed: `filterData` matches null
   * branch_ids against such a set via JS `includes`, but SQL `IN (NULL)` never
   * does — pushing it would return a SUBSET and break the superset contract.
   * board_id / archived may still be pushed in that case.
   */
  protected async fetchData(query: Query, params?: ArtifactParams): Promise<Artifact[]> {
    const filter: {
      board_id?: BoardID;
      archived?: boolean;
      branchIds?: BranchID[];
      visibleToUserId?: UUID;
      projection?: ArtifactListProjection;
    } = {};

    if (typeof query.board_id === 'string') filter.board_id = query.board_id as BoardID;
    if (typeof query.archived === 'boolean') filter.archived = query.archived;
    if (params?._agorSqlBranchAccessUserId) {
      filter.visibleToUserId = params._agorSqlBranchAccessUserId;
    }

    // `$select` used to run only after `SELECT *` and JSON decoding, so even a
    // metadata-only initial hydration pulled every source file over the DB
    // connection. Keep full-row reads as the default. A nonempty selection can
    // use a leaner SQL shape only when that shape also contains every field the
    // generic adapter still needs for its residual filtering and sorting.
    const projection = resolveArtifactListProjection(query);
    if (projection !== 'full') filter.projection = projection;

    const branchId = query.branch_id;
    if (typeof branchId === 'string') {
      filter.branchIds = [branchId as BranchID];
    } else if (
      branchId &&
      typeof branchId === 'object' &&
      Array.isArray(branchId.$in) &&
      branchId.$in.every((el: unknown) => typeof el === 'string')
    ) {
      filter.branchIds = branchId.$in as BranchID[];
    }

    return this.artifactRepo.findAll(filter);
  }

  // Direct Feathers create is intentionally rejected — artifacts require
  // the publishArtifact() lifecycle (folder → DB).
  async create(_data: Partial<Artifact>, _params?: ArtifactParams): Promise<Artifact> {
    throw new Error(
      'Direct artifact creation not supported. Use publishArtifact() or agor_artifacts_publish MCP tool.'
    );
  }

  /**
   * Direct REST/service updates are metadata-only and must not rewrite
   * provenance. `source_session_id` is stamped by publishArtifact() from the
   * trusted MCP/session context; letting generic PATCH/UPDATE mutate it would
   * make the "created by session" link spoofable.
   */
  private stripClientControlledProvenance(data: Partial<Artifact>): Partial<Artifact> {
    const { source_session_id: _sourceSessionId, ...safeData } = data;
    return safeData;
  }

  async update(
    id: string | number,
    data: Partial<Artifact>,
    params?: ArtifactParams
  ): Promise<Artifact> {
    return (await super.update(id, this.stripClientControlledProvenance(data), params)) as Artifact;
  }

  /**
   * Patch override: route board_id and placement changes through
   * updateMetadata so the board_objects entry is moved/resized alongside the
   * row update. Plain metadata patches fall through to the default
   * DrizzleService patch.
   */
  async patch(
    id: string | number,
    data: Partial<Artifact>,
    params?: ArtifactParams
  ): Promise<Artifact> {
    const d = data as Partial<Artifact> & {
      x?: number;
      y?: number;
      width?: number;
      height?: number;
    };
    const placementFields =
      d.x !== undefined || d.y !== undefined || d.width !== undefined || d.height !== undefined;

    if (d.board_id !== undefined || placementFields) {
      const artifactId = String(id);
      const existing = await this.artifactRepo.findById(artifactId);
      if (!existing) throw new Error(`Artifact ${artifactId} not found`);
      const callerParams = params as { user?: { user_id?: string; role?: UserRole } } | undefined;
      const callerUserId = callerParams?.user?.user_id;
      const callerRole = callerParams?.user?.role;

      return this.updateMetadata(
        existing.artifact_id,
        {
          name: d.name,
          description: d.description,
          public: d.public,
          archived: d.archived,
          board_id: d.board_id,
          x: d.x,
          y: d.y,
          width: d.width,
          height: d.height,
        },
        callerUserId,
        callerRole
      );
    }

    return (await super.patch(
      id,
      this.stripClientControlledProvenance(data) as Partial<Artifact>,
      params
    )) as Artifact;
  }

  /**
   * Centralized visibility predicate. Private artifacts are only readable
   * by their creator; public artifacts are readable by anyone.
   */
  isVisibleTo(artifact: Pick<Artifact, 'public' | 'created_by'>, userId?: string): boolean {
    if (artifact.public) return true;
    if (!userId || !artifact.created_by) return false;
    return artifact.created_by === userId;
  }

  async remove(id: string | number, params?: ArtifactParams): Promise<Artifact> {
    const artifactId = String(id);
    const callerParams = params as { user?: { user_id?: string; role?: UserRole } } | undefined;
    // Thread the authenticated caller through so deleteArtifact() can run
    // its owner/admin check. The Feathers REST hook chain has already
    // gated this call (see ensureArtifactOwnerOrAdmin in register-hooks),
    // so the inline check is redundant for REST callers — but it stays as
    // a defense-in-depth and as the single auth point for non-Feathers
    // callers (e.g. internal lifecycle code).
    const artifact = await this.deleteArtifact(
      artifactId,
      callerParams?.user?.user_id,
      callerParams?.user?.role
    );
    emitServiceEvent(this.app, {
      path: 'artifacts',
      event: 'removed',
      data: artifact,
      params,
      id: artifactId,
    });
    return artifact;
  }

  /**
   * Publish a folder as a live Sandpack artifact on a board. Reads files from
   * a branch-relative folder, serializes them into the DB, and places (or updates) the
   * artifact on the board.
   *
   * Named `publishArtifact` (not `publish`) on purpose: `service.publish`
   * is a reserved Feathers channel-mixin hook — if a service defines a
   * `publish()` method, the mixin assumes custom channel routing and
   * skips all event subscriptions, including the default
   * `created`/`patched`/`removed` and custom events like `agor-query`.
   * That breaks every WebSocket fan-out from this service. See
   * `@feathersjs/transport-commons` channels/index.ts.
   */
  async publishArtifact(
    data: {
      branch_id: string;
      source_session_id?: SessionID | null;
      subpath: string;
      board_id?: string;
      name?: string;
      artifact_id?: string;
      template?: SandpackTemplate;
      public?: boolean;
      sandpack_config?: SandpackConfig;
      required_env_vars?: string[];
      agor_grants?: AgorGrants;
      agor_runtime?: AgorRuntimeConfig;
      x?: number;
      y?: number;
      width?: number;
      height?: number;
    },
    params: ArtifactParams
  ): Promise<Artifact> {
    const branch = await this.branchRepo.findById(data.branch_id);
    if (!branch) throw new Error(`Branch not found: ${data.branch_id}`);
    const branchFsAccess = await ensureBranchWorkspaceAccess(
      this.branchRepo,
      branch,
      params.user?.user_id,
      params.user?.role as UserRole | undefined,
      'session',
      'read',
      this.app.get('config').execution?.allow_superadmin === true
    );

    const userId = params.user?.user_id;
    if (!userId) throw new NotAuthenticated('Authentication required');
    const sandboxMounts = await this.resolveExecutorSandboxMounts(branch, userId as UserID, params);
    const sessionToken = await issueExecutorCommandToken(
      this.app,
      'artifact.publish',
      userId,
      branch.branch_id
    );
    const result = await requestExecutor(
      {
        command: 'branch.artifact.publish',
        sessionToken,
        daemonUrl: getDaemonUrl(),
        params: {
          branchId: branch.branch_id,
          subpath: data.subpath,
          publishData: data,
          cwd: branch.path,
          principalBranchAccess: branchFsAccess,
          ...sandboxMounts,
        },
      },
      {
        logPrefix: `[ArtifactsService.publish ${branch.branch_id}]`,
        delegatedHomeKey: await resolveDelegatedExecutionHomeKey(
          this.dbRef,
          userId,
          this.app.get('config')
        ),
        templateVariables: {
          branch_id: branch.branch_id,
          user_id: userId,
          branch_fs_access: branchFsAccess,
        },
      }
    );
    if (!result.success) {
      throw new Error(
        `Artifact publish failed: ${result.error?.message ?? 'unknown executor error'}`
      );
    }
    const artifactId =
      result.data && typeof result.data === 'object'
        ? (result.data as { artifactId?: unknown }).artifactId
        : undefined;
    if (typeof artifactId !== 'string') {
      throw new Error('Artifact publish failed: executor returned no artifact ID');
    }
    const artifact = await this.artifactRepo.findById(artifactId);
    if (!artifact) throw new Error(`Artifact ${artifactId} not found after executor publish`);
    return artifact;
  }

  async publishFromExecutor(
    data: {
      files: Record<string, string>;
      sidecar?: ArtifactSidecar | null;
      branch_id?: string;
      source_session_id?: SessionID | null;
      subpath?: string;
      board_id?: string;
      name?: string;
      artifact_id?: string;
      template?: SandpackTemplate;
      public?: boolean;
      sandpack_config?: SandpackConfig;
      required_env_vars?: string[];
      agor_grants?: AgorGrants;
      agor_runtime?: AgorRuntimeConfig;
      x?: number;
      y?: number;
      width?: number;
      height?: number;
    },
    params?: ArtifactParams
  ): Promise<Artifact> {
    const userId = this.requireExecutorCallback(params, 'artifact.publish', data.branch_id);
    const matchedBranchId = data.branch_id as BranchID;
    const provenanceSubpath = data.subpath ?? '';
    const files = data.files;
    const sidecar = data.sidecar ?? null;

    // For updates, load the existing row up-front so it can serve as the
    // bottom of the fallback chain (data > sidecar > existing > default).
    let existing: Artifact | null = null;
    if (data.artifact_id) {
      existing = await this.artifactRepo.findById(data.artifact_id);
      if (!existing) throw new Error(`Artifact ${data.artifact_id} not found`);
      if (userId && existing.created_by && existing.created_by !== userId) {
        throw new Error('Cannot update artifact: not the owner');
      }
    }

    // Resolution chain for each field: explicit data > sidecar > existing > default.
    const resolvedSandpackConfig = sanitizeSandpackConfig(
      data.sandpack_config ?? sidecar?.sandpack_config ?? existing?.sandpack_config
    );
    const requestedTemplate = (data.template ??
      resolvedSandpackConfig.template ??
      sidecar?.template ??
      existing?.template ??
      'react') as SandpackTemplate;
    const renderConfig = normalizeSandpackConfigForRender({
      template: requestedTemplate,
      sandpack_config: resolvedSandpackConfig,
      files,
      entry: existing?.entry,
    });
    const template = renderConfig.template;
    if (renderConfig.sandpack_config) {
      Object.assign(resolvedSandpackConfig, renderConfig.sandpack_config);
    } else if (!resolvedSandpackConfig.template) {
      resolvedSandpackConfig.template = template;
    }
    const requiredEnvVars = sanitizeEnvVarNames(
      data.required_env_vars ?? sidecar?.required_env_vars ?? existing?.required_env_vars
    );
    const agorGrants = canonicalizeAgorGrants(
      data.agor_grants ?? sidecar?.agor_grants ?? existing?.agor_grants
    );
    // agor_runtime is a small flag bag (currently just `enabled`). Same
    // explicit-data > sidecar > existing > default chain. Default is
    // implicit-enabled (i.e. `undefined` reads as enabled at render time).
    const agorRuntime: AgorRuntimeConfig | undefined =
      data.agor_runtime ?? sidecar?.agor_runtime ?? existing?.agor_runtime ?? undefined;

    // Name and board are required on create; on update they default to the
    // existing row so a routine republish doesn't have to know them.
    const resolvedName = data.name ?? existing?.name;
    if (!resolvedName) {
      throw new Error('name is required when creating a new artifact');
    }
    const resolvedBoardId = (data.board_id ?? existing?.board_id) as BoardID | undefined;
    if (!resolvedBoardId) {
      throw new Error('boardId is required when creating a new artifact');
    }
    const branch = await this.branchRepo.findById(matchedBranchId);
    if (!branch) throw new Error(`Branch not found: ${matchedBranchId}`);
    if (branch.board_id !== resolvedBoardId) {
      throw new Forbidden('Artifact board must match the source branch board');
    }

    const isPublic = data.public ?? existing?.public ?? true;

    // package.json#dependencies is the source of truth; cache it on the row
    // for cheap list-friendly reads.
    const cachedDeps = this.extractDependenciesFromPackageJson(files);
    const cachedEntry = resolvedSandpackConfig.customSetup?.entry;

    const contentHash = this.computeHashFromFiles(files);

    if (existing) {
      const buildResult = this.validateArtifactFiles(files, {
        template,
        sandpackConfig: resolvedSandpackConfig,
        requiredEnvVars,
      });

      const updated = await this.artifactRepo.update(existing.artifact_id, {
        name: resolvedName,
        branch_id: matchedBranchId ?? existing.branch_id ?? null,
        source_session_id: data.source_session_id ?? existing.source_session_id ?? null,
        files,
        dependencies: cachedDeps,
        entry: cachedEntry,
        template,
        sandpack_config: resolvedSandpackConfig,
        required_env_vars: requiredEnvVars,
        agor_grants: agorGrants,
        agor_runtime: agorRuntime,
        content_hash: contentHash,
        public: isPublic,
        build_status: buildResult.status,
        build_errors: buildResult.errors.length > 0 ? buildResult.errors : undefined,
      });

      // Stale Sandpack state — new content will produce fresh state from
      // the browser. Use the helper to clear ALL per-viewer entries; bare
      // `delete(artifact_id)` no longer matches the keys (which are now
      // `${artifactId}:${userId}` after the per-viewer console isolation
      // fix), so without this every viewer kept their stale error/status
      // across republishes.
      this.clearAllViewerBuffersFor(existing.artifact_id);

      emitServiceEvent(this.app, {
        path: 'artifacts',
        event: 'patched',
        data: updated,
        id: updated.artifact_id,
      });
      return updated;
    }

    const artifactId = generateId();
    const buildResult = this.validateArtifactFiles(files, {
      template,
      sandpackConfig: resolvedSandpackConfig,
      requiredEnvVars,
    });

    const artifact = await this.artifactRepo.create({
      artifact_id: artifactId,
      board_id: resolvedBoardId,
      branch_id: matchedBranchId,
      source_session_id: data.source_session_id ?? null,
      name: resolvedName,
      path: provenanceSubpath,
      template,
      files,
      dependencies: cachedDeps,
      entry: cachedEntry,
      sandpack_config: resolvedSandpackConfig,
      required_env_vars: requiredEnvVars,
      agor_grants: agorGrants,
      agor_runtime: agorRuntime,
      content_hash: contentHash,
      build_status: buildResult.status,
      build_errors: buildResult.errors.length > 0 ? buildResult.errors : undefined,
      public: isPublic,
      created_by: userId,
    });

    const objectId = `artifact-${artifactId}`;
    try {
      const updatedBoard = await this.boardRepo.upsertBoardObject(resolvedBoardId, objectId, {
        type: 'artifact',
        artifact_id: artifactId,
        x: data.x ?? 0,
        y: data.y ?? 0,
        width: data.width ?? 600,
        height: data.height ?? 400,
      });

      if (this.app) {
        emitServiceEvent(this.app, {
          path: 'boards',
          event: 'patched',
          data: updatedBoard,
          id: resolvedBoardId,
        });
      }
    } catch (boardError) {
      // Compensate: remove DB record if board placement fails.
      try {
        await this.artifactRepo.delete(artifactId);
      } catch (deleteError) {
        console.error(
          `Rollback failed: could not delete orphan artifact ${artifactId}:`,
          deleteError
        );
      }
      throw boardError;
    }

    emitServiceEvent(this.app, {
      path: 'artifacts',
      event: 'created',
      data: artifact,
      id: artifact.artifact_id,
    });
    return artifact;
  }

  /**
   * Update artifact metadata without touching files.
   * For file/content changes use publishArtifact().
   */
  async updateMetadata(
    artifactId: string,
    updates: {
      name?: string;
      description?: string;
      public?: boolean;
      archived?: boolean;
      board_id?: BoardID;
      x?: number;
      y?: number;
      width?: number;
      height?: number;
      required_env_vars?: string[];
      agor_grants?: AgorGrants;
      agor_runtime?: AgorRuntimeConfig;
      sandpack_config?: SandpackConfig;
    },
    userId?: string,
    userRole?: UserRole
  ): Promise<Artifact> {
    const existing = await this.artifactRepo.findById(artifactId);
    if (!existing) throw new Error(`Artifact ${artifactId} not found`);
    // Owner-or-admin: matches the Feathers REST hook (ensureArtifactOwner-
    // OrAdmin) and the agor_artifacts_update tool description. Without the
    // role check, an admin authorized by the hook still got rejected here.
    const isOwner = !!userId && existing.created_by === userId;
    const isAdmin = !!userRole && hasMinimumRole(userRole, ROLES.ADMIN);
    if (userId && !isOwner && !isAdmin) {
      throw new Error("Forbidden: only the artifact's creator or an admin may update it");
    }

    const fullArtifactId = existing.artifact_id;
    const objectId = `artifact-${fullArtifactId}`;
    const oldBoardId = existing.board_id;
    const newBoardId = updates.board_id ?? oldBoardId;
    const moving = newBoardId !== oldBoardId;

    if (moving) {
      const destBoard = await this.boardRepo.findById(newBoardId);
      if (!destBoard) {
        throw new Error(`Destination board ${newBoardId} not found`);
      }
    }

    let currentPlacement: { x: number; y: number; width: number; height: number } | null = null;
    try {
      const oldBoard = await this.boardRepo.findById(oldBoardId);
      const obj = oldBoard?.objects?.[objectId];
      if (obj && obj.type === 'artifact') {
        currentPlacement = { x: obj.x, y: obj.y, width: obj.width, height: obj.height };
      }
    } catch {
      // Old board may have been deleted.
    }

    const dbUpdates: Partial<Artifact> = {};
    if (updates.name !== undefined) dbUpdates.name = updates.name;
    if (updates.description !== undefined) dbUpdates.description = updates.description;
    if (updates.public !== undefined) dbUpdates.public = updates.public;
    if (updates.archived !== undefined) {
      dbUpdates.archived = updates.archived;
      // Explicit null on unarchive — `undefined` would be ignored by the
      // repo's `!== undefined` gate, leaving the stale archive timestamp
      // in place and confusing anything that reads it for archive history.
      dbUpdates.archived_at = updates.archived ? new Date().toISOString() : null;
    }
    if (moving) dbUpdates.board_id = newBoardId;
    if (updates.required_env_vars !== undefined) {
      dbUpdates.required_env_vars = sanitizeEnvVarNames(updates.required_env_vars);
    }
    if (updates.agor_grants !== undefined) {
      dbUpdates.agor_grants = canonicalizeAgorGrants(updates.agor_grants);
    }
    if (updates.agor_runtime !== undefined) {
      dbUpdates.agor_runtime = updates.agor_runtime;
    }
    if (updates.sandpack_config !== undefined) {
      const sanitizedConfig = sanitizeSandpackConfig(updates.sandpack_config);
      const normalizedConfig = normalizeSandpackConfigForRender({
        template: existing.template,
        sandpack_config: sanitizedConfig,
        files: existing.files,
        entry: existing.entry,
      });
      dbUpdates.sandpack_config = normalizedConfig.sandpack_config;
      if (normalizedConfig.template !== existing.template) {
        dbUpdates.template = normalizedConfig.template;
      }
      const normalizedEntry = normalizedConfig.sandpack_config?.customSetup?.entry;
      if (normalizedEntry !== undefined && normalizedEntry !== existing.entry) {
        dbUpdates.entry = normalizedEntry;
      }
    }

    let updated = existing;
    if (Object.keys(dbUpdates).length > 0) {
      updated = await this.artifactRepo.update(fullArtifactId, dbUpdates);
    }

    const placementChanged =
      updates.x !== undefined ||
      updates.y !== undefined ||
      updates.width !== undefined ||
      updates.height !== undefined;

    if (moving || placementChanged) {
      const placement = {
        type: 'artifact' as const,
        artifact_id: fullArtifactId,
        x: updates.x ?? currentPlacement?.x ?? 0,
        y: updates.y ?? currentPlacement?.y ?? 0,
        width: updates.width ?? currentPlacement?.width ?? 600,
        height: updates.height ?? currentPlacement?.height ?? 400,
      };

      try {
        const targetBoard = await this.boardRepo.upsertBoardObject(newBoardId, objectId, placement);
        emitServiceEvent(this.app, {
          path: 'boards',
          event: 'patched',
          data: targetBoard,
          id: newBoardId,
        });
      } catch (upsertError) {
        if (Object.keys(dbUpdates).length > 0) {
          try {
            const rollback: Partial<Artifact> = {};
            if (moving) rollback.board_id = oldBoardId;
            if (updates.name !== undefined) rollback.name = existing.name;
            if (updates.description !== undefined) rollback.description = existing.description;
            if (updates.public !== undefined) rollback.public = existing.public;
            if (updates.archived !== undefined) {
              rollback.archived = existing.archived;
              rollback.archived_at = existing.archived_at;
            }
            if (updates.sandpack_config !== undefined) {
              rollback.sandpack_config = existing.sandpack_config;
              rollback.template = existing.template;
              // The repository accepts null to restore a legacy row without
              // a denormalized entry; undefined would leave the normalized
              // value in place.
              rollback.entry = existing.entry ?? (null as unknown as string);
            }
            if (Object.keys(rollback).length > 0) {
              await this.artifactRepo.update(fullArtifactId, rollback);
            }
          } catch (rollbackError) {
            console.error(
              `Rollback failed after board_objects upsert error for artifact ${fullArtifactId}:`,
              rollbackError
            );
          }
        }
        throw upsertError;
      }

      if (moving) {
        try {
          const cleaned = await this.boardRepo.removeBoardObject(oldBoardId, objectId);
          emitServiceEvent(this.app, {
            path: 'boards',
            event: 'patched',
            data: cleaned,
            id: oldBoardId,
          });
        } catch {
          // Old board may not have this object.
        }
      }
    }

    if (
      updates.sandpack_config !== undefined ||
      updates.required_env_vars !== undefined ||
      updates.agor_grants !== undefined ||
      updates.agor_runtime !== undefined
    ) {
      this.clearAllViewerBuffersFor(fullArtifactId);
    }

    emitServiceEvent(this.app, {
      path: 'artifacts',
      event: 'patched',
      data: updated,
      id: updated.artifact_id,
    });
    return updated;
  }

  /**
   * Materialize an artifact's stored file map to a destination under a branch.
   * Inverse of publishArtifact(). Sandpack metadata is reconstructed as a sidecar
   * `agor.artifact.json` so a round-trip via publishArtifact() round-trips the
   * metadata that doesn't live in the file map.
   *
   * Security:
   * - destination must resolve strictly inside the branch root.
   * - per-file paths from the artifact's `files` map are re-validated to
   *   block traversal keys.
   * - when overwriting, uses `fs.rm` which removes symlinks rather than
   *   following them.
   */
  async land(
    artifactId: string,
    branchId: BranchID,
    options: { subpath?: string; overwrite?: boolean },
    params: ArtifactParams
  ): Promise<{ subpath: string; fileCount: number; bytesWritten: number }> {
    const branch = await this.branchRepo.findById(branchId);
    if (!branch) throw new Error(`Branch not found: ${branchId}`);
    const branchFsAccess = await ensureBranchWorkspaceAccess(
      this.branchRepo,
      branch,
      params.user?.user_id,
      params.user?.role as UserRole | undefined,
      'session',
      'write',
      this.app.get('config').execution?.allow_superadmin === true
    );
    const userId = params.user?.user_id;
    if (!userId) throw new NotAuthenticated('Authentication required');
    const sandboxMounts = await this.resolveExecutorSandboxMounts(branch, userId as UserID, params);
    const sessionToken = await issueExecutorCommandToken(
      this.app,
      'branch-artifact-land',
      userId,
      branchId
    );
    const result = await requestExecutor(
      {
        command: 'branch.artifact.land',
        sessionToken,
        daemonUrl: getDaemonUrl(),
        params: {
          branchId,
          artifactId,
          subpath: options.subpath,
          overwrite: options.overwrite,
          cwd: branch.path,
          principalBranchAccess: branchFsAccess,
          ...sandboxMounts,
        },
      },
      {
        logPrefix: `[ArtifactsService.land ${branchId}]`,
        delegatedHomeKey: await resolveDelegatedExecutionHomeKey(
          this.dbRef,
          userId,
          this.app.get('config')
        ),
        templateVariables: {
          branch_id: branch.branch_id,
          user_id: userId,
          branch_fs_access: branchFsAccess,
        },
      }
    );
    if (!result.success) {
      throw new Error(
        `Artifact materialization failed: ${result.error?.message ?? 'unknown executor error'}`
      );
    }
    const data = result.data as
      | { subpath?: unknown; fileCount?: unknown; bytesWritten?: unknown }
      | undefined;
    if (
      typeof data?.subpath !== 'string' ||
      typeof data.fileCount !== 'number' ||
      typeof data.bytesWritten !== 'number'
    ) {
      throw new Error('Artifact materialization failed: executor returned an invalid result');
    }
    return { subpath: data.subpath, fileCount: data.fileCount, bytesWritten: data.bytesWritten };
  }

  /**
   * Read artifact payload for the frontend.
   *
   * Resolves trust state, synthesizes a per-viewer `.env` (when consent
   * permits), runs legacy detection, and returns everything the renderer
   * needs.
   */
  async getPayload(artifactId: string, userId?: UserID): Promise<ArtifactPayload> {
    const artifact = await this.artifactRepo.findById(artifactId);
    if (!artifact) throw new Error(`Artifact ${artifactId} not found`);

    // Visibility check: private artifacts are only visible to their creator
    if (!artifact.public) {
      if (!userId || !artifact.created_by || artifact.created_by !== userId) {
        throw new Error(`Artifact ${artifactId} not found`);
      }
    }

    if (!artifact.files) {
      throw new Error(`Artifact ${artifactId} has no files in DB — cannot serve payload`);
    }

    const renderConfig = normalizeSandpackConfigForRender({
      template: artifact.template,
      sandpack_config: artifact.sandpack_config,
      files: artifact.files,
      entry: artifact.entry,
    });
    const filesOut: Record<string, string> = { ...artifact.files };
    const requiredEnvVars = artifact.required_env_vars ?? [];
    const grants = canonicalizeAgorGrants(artifact.agor_grants);
    const consentRelevantGrants = pickConsentRelevantGrants(grants);

    // "Needs consent" gates the trust prompt. "Has injectables" gates the
    // .env synthesis — no-consent grants (artifact_id, board_id) still want
    // values written even when the artifact is otherwise untrusted.
    const needsConsent =
      requiredEnvVars.length > 0 || Object.keys(consentRelevantGrants).length > 0;
    const hasInjectables = requiredEnvVars.length > 0 || Object.keys(grants).length > 0;

    let trustState: ArtifactPayload['trust_state'] = 'no_secrets_needed';
    let trustScope: ArtifactPayload['trust_scope'] | undefined;
    let envValues: Record<string, string> = {};

    if (needsConsent) {
      const decision = await this.resolveTrust({
        artifact,
        userId,
        requiredEnvVars,
        grants,
      });
      trustState = decision.state;
      trustScope = decision.scope;
      if (decision.state === 'self' || decision.state === 'trusted') {
        envValues = await this.resolveEnvVarValues(userId, requiredEnvVars);
      }
    }

    if (hasInjectables) {
      // The UI renders with `sandpack_config.template ?? artifact.template`,
      // so .env synthesis must follow the same effective template — otherwise
      // the daemon prefixes for one bundler while the bundler that actually
      // runs is something else.
      const effectiveTemplate = renderConfig.template;
      // If the artifact explicitly overrides the sandpack environment we
      // can't reliably guess the prefix — operator's responsibility to make
      // the override match the template's prefix convention.
      const envOverride = renderConfig.sandpack_config?.customSetup?.environment;
      if (envOverride) {
        console.warn(
          `[artifacts] Artifact ${artifact.artifact_id} sets customSetup.environment=${envOverride}; .env prefix still derived from template=${effectiveTemplate}. If the override changes the bundler family the injected vars may not be picked up.`
        );
      }
      const envFile = await this.synthesizeEnvFile({
        template: effectiveTemplate,
        requiredEnvVars,
        envValues,
        grants,
        artifact,
        userId,
        injectConsentGated: trustState === 'self' || trustState === 'trusted',
      });
      // Only emit a .env if we have something meaningful to put in it AND
      // the artifact's bundler can read it. For vanilla/static templates the
      // file is irrelevant (synthesizeEnvFile returns null).
      if (envFile !== null) filesOut[SYNTHESIZED_ENV_PATH] = envFile;
    }

    // Inject the iframe-side runtime that powers agent-driven introspection
    // (DOM queries, etc.) via `sandpack_config.options.externalResources` —
    // Sandpack adds the resulting `<script src="...">` to the iframe HTML
    // before any user code runs. We use a `data:` URL so no extra HTTP
    // round-trip is required and no daemon-served origin needs to be
    // CORS-allowed by the bundler. Default-on; authors can opt out via
    // `agor_runtime.enabled = false`. Render-time only — never persisted,
    // never touches user files.
    const runtimeEnabled = artifact.agor_runtime?.enabled !== false;
    const servedSandpackConfig = runtimeEnabled
      ? withInjectedAgorRuntime(renderConfig.sandpack_config)
      : renderConfig.sandpack_config;

    const contentHash = this.computeHashFromFiles({
      ...filesOut,
      '/.agor/sandpack-config.json': JSON.stringify(servedSandpackConfig ?? {}),
    });
    const legacy = detectLegacyFormat(artifact);

    const payload: ArtifactPayload = {
      artifact_id: artifact.artifact_id,
      source_session_id: artifact.source_session_id ?? null,
      name: artifact.name,
      description: artifact.description,
      template: renderConfig.template,
      files: filesOut,
      sandpack_config: servedSandpackConfig,
      dependencies: artifact.dependencies,
      entry:
        renderConfig.template === 'static'
          ? (renderConfig.sandpack_config?.customSetup?.entry ?? artifact.entry)
          : artifact.entry,
      content_hash: contentHash,
      runtime_report_hash: this.computeRuntimeReportHash(artifact),
      required_env_vars: requiredEnvVars.length > 0 ? requiredEnvVars : undefined,
      agor_grants: Object.keys(grants).length > 0 ? grants : undefined,
      trust_state: trustState,
      ...(trustScope ? { trust_scope: trustScope } : {}),
      ...(legacy.is_legacy ? { legacy } : {}),
    };
    return payload;
  }

  /**
   * Resolve consent for an artifact's requested env vars + grants.
   * Returns the trust state and (when applicable) the scope of the matching grant.
   *
   * Resolution order matches the roadmap:
   *   1. Author is the viewer → 'self'.
   *   2. instance > author > artifact > session — first matching wins.
   */
  private async resolveTrust(input: {
    artifact: Artifact;
    userId?: UserID;
    requiredEnvVars: string[];
    grants: AgorGrants;
  }): Promise<{ state: ArtifactPayload['trust_state']; scope?: ArtifactTrustScopeType }> {
    const { artifact, userId, requiredEnvVars, grants } = input;
    if (userId && artifact.created_by && artifact.created_by === userId) {
      return { state: 'self', scope: 'self' };
    }
    if (!userId) return { state: 'untrusted' };

    const consentRelevantGrants = pickConsentRelevantGrants(grants);

    const tryScopes: {
      type: Exclude<ArtifactTrustScopeType, 'session' | 'self'>;
      value: string | null;
    }[] = [
      { type: 'instance', value: null },
      { type: 'author', value: artifact.created_by ?? null },
      { type: 'artifact', value: artifact.artifact_id },
    ];
    for (const sc of tryScopes) {
      if (sc.type === 'author' && !sc.value) continue;
      const matches = await this.trustRepo.findActiveForScope({
        userId,
        scopeType: sc.type,
        scopeValue: sc.value,
      });
      if (matches.some((g) => coversRequest(g, requiredEnvVars, consentRelevantGrants))) {
        return { state: 'trusted', scope: sc.type };
      }
    }

    const sessionKey = `${userId}:${artifact.artifact_id}`;
    const sessionGrant = this.sessionGrants.get(sessionKey);
    if (sessionGrant) {
      const envCovered = requiredEnvVars.every((v) => sessionGrant.envVars.has(v));
      const grantsCovered = grantsAreSubset(consentRelevantGrants, sessionGrant.grants);
      if (envCovered && grantsCovered) {
        return { state: 'trusted', scope: 'session' };
      }
    }

    return { state: 'untrusted' };
  }

  /**
   * Build the synthesized `.env` body. Returns null for templates without a
   * dotenv path (vanilla/static), in which case nothing is injected.
   *
   * Injection rules:
   *   - `requiredEnvVars`: emitted with the consented value when trusted,
   *     empty string otherwise.
   *   - No-consent grants (artifact_id, board_id): always emitted with their
   *     real values regardless of trust state — they are pure metadata.
   *   - Consent-gated grants (agor_api_url, agor_user_email):
   *     emitted with real values when trusted, empty when not.
   *     Empty keys are still emitted so the artifact can detect "untrusted"
   *     rather than crash on a ReferenceError.
   */
  private async synthesizeEnvFile(input: {
    template: SandpackTemplate;
    requiredEnvVars: string[];
    envValues: Record<string, string>;
    grants: AgorGrants;
    artifact: Artifact;
    userId?: UserID;
    injectConsentGated: boolean;
  }): Promise<string | null> {
    const prefix = envVarPrefixForTemplate(input.template);
    if (prefix === null) {
      if (input.requiredEnvVars.length > 0 || Object.keys(input.grants).length > 0) {
        console.warn(
          `[artifacts] Artifact ${input.artifact.artifact_id} (template=${input.template}) requests env vars/grants but the template has no dotenv path. Nothing was injected.`
        );
      }
      return null;
    }

    const lines: string[] = [];

    for (const name of input.requiredEnvVars) {
      const value = input.envValues[name] ?? '';
      lines.push(`${prefix}${name}=${escapeEnvValue(value)}`);
    }

    // No-consent grants: always inject with real values.
    const noConsentGrants = pickNoConsentGrants(input.grants);
    if (Object.keys(noConsentGrants).length > 0) {
      const noConsentValues = await this.resolveGrantValues({
        grants: noConsentGrants,
        artifact: input.artifact,
        userId: input.userId,
      });
      for (const [name, value] of Object.entries(noConsentValues)) {
        lines.push(`${prefix}${name}=${escapeEnvValue(value)}`);
      }
    }

    // Consent-gated grants: real values when trusted, empty otherwise.
    const consentGated = pickConsentRelevantGrants(input.grants);
    if (input.injectConsentGated) {
      const injected = await this.resolveGrantValues({
        grants: consentGated,
        artifact: input.artifact,
        userId: input.userId,
      });
      for (const [name, value] of Object.entries(injected)) {
        lines.push(`${prefix}${name}=${escapeEnvValue(value)}`);
      }
    } else {
      for (const [grantName, fixedEnvName] of Object.entries(GRANT_ENV_VAR_NAMES)) {
        if (NO_CONSENT_GRANT_KEYS.includes(grantName as never)) continue;
        if ((consentGated as Record<string, unknown>)[grantName]) {
          lines.push(`${prefix}${fixedEnvName}=`);
        }
      }
    }

    return lines.length > 0 ? `${lines.join('\n')}\n` : null;
  }

  /**
   * Resolve the runtime values for each granted capability.
   */
  private async resolveGrantValues(input: {
    grants: AgorGrants;
    artifact: Artifact;
    userId?: UserID;
  }): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const { grants, artifact, userId } = input;

    if (grants.agor_api_url) {
      out[GRANT_ENV_VAR_NAMES.agor_api_url] = await getDaemonBaseUrl();
    }
    if (grants.agor_user_email && userId) {
      try {
        const usersService = this.app.service('users') as unknown as UsersService;
        const user = await usersService.get(userId);
        if (user?.email) out[GRANT_ENV_VAR_NAMES.agor_user_email] = user.email;
      } catch {
        // Fall through — leave the variable empty.
      }
    }
    if (grants.agor_artifact_id) {
      out[GRANT_ENV_VAR_NAMES.agor_artifact_id] = artifact.artifact_id;
    }
    if (grants.agor_board_id) {
      out[GRANT_ENV_VAR_NAMES.agor_board_id] = artifact.board_id;
    }

    return out;
  }

  private async resolveEnvVarValues(
    userId: UserID | undefined,
    names: string[]
  ): Promise<Record<string, string>> {
    if (!userId || names.length === 0) return {};
    try {
      // Scope-aware resolution: artifact rendering must NOT receive vars the
      // user scoped to specific sessions (`scope: 'session'`) — those only
      // unlock when a matching `sessionId` is passed. With no sessionId here,
      // session-scoped vars are skipped (see env-resolver.ts:179-183, 220-232).
      const all = await resolveUserEnvironment(userId, this.dbRef, {});
      const out: Record<string, string> = {};
      for (const n of names) {
        if (all[n] !== undefined) out[n] = all[n];
      }
      return out;
    } catch (err) {
      console.error(`[artifacts] failed to resolve env vars for user ${userId}:`, err);
      return {};
    }
  }

  // ── Trust grants management (called from REST routes / consent modal) ──

  /**
   * Persist a trust grant for `(viewer, scope_type, scope_value)`. The
   * consent surface (env vars + grants) is derived server-side from the
   * artifact's CURRENT request — the client never gets to nominate what it
   * is consenting to. This is intentional: the grant must reflect "what the
   * server will inject" at the moment of consent, not whatever the client
   * thinks should be covered. If the artifact later expands its requested
   * set, the grant becomes insufficient via `coversRequest`'s subset check
   * and the user is re-prompted.
   *
   * `session`-scope grants live in-process only (no DB write).
   */
  async grantTrust(input: {
    userId: string;
    artifactId: string;
    scopeType: ArtifactTrustScopeType;
  }): Promise<{ scope: ArtifactTrustScopeType; persisted: boolean }> {
    if (input.scopeType === 'self') {
      throw new Error("'self' grants are implicit and cannot be persisted");
    }

    // Server-derive the consent surface from the artifact's current request.
    const artifact = await this.artifactRepo.findById(input.artifactId);
    if (!artifact) throw new Error(`Artifact ${input.artifactId} not found`);
    if (!this.isVisibleTo(artifact, input.userId)) {
      // Mirror getPayload's privacy guarantee — don't leak existence of a
      // private artifact via the trust endpoint.
      throw new Error(`Artifact ${input.artifactId} not found`);
    }
    const sanitizedEnv = sanitizeEnvVarNames(artifact.required_env_vars ?? []);
    const sanitizedGrants = canonicalizeAgorGrants(artifact.agor_grants ?? {});

    if (input.scopeType === 'session') {
      const key = `${input.userId}:${input.artifactId}`;
      this.sessionGrants.set(key, {
        envVars: new Set(sanitizedEnv),
        grants: sanitizedGrants,
      });
      return { scope: 'session', persisted: false };
    }

    // Resolve scope_value from artifact when needed.
    let scopeValue: string | null = null;
    if (input.scopeType === 'artifact') {
      scopeValue = input.artifactId;
    } else if (input.scopeType === 'author') {
      if (!artifact.created_by) {
        throw new Error('Cannot grant author-scope trust: artifact has no recorded author');
      }
      scopeValue = artifact.created_by;
    } else if (input.scopeType === 'instance') {
      scopeValue = null;
      // Instance-wide trust is meaningful only on single-user instances. On
      // multi-user setups it would mean "trust any artifact published by any
      // user on this server with my secrets" — too broad. Reject.
      const config = this.app.get('config');
      const unixMode = config.execution?.unix_user_mode ?? 'simple';
      if (unixMode !== 'simple') {
        throw new Error(
          "'instance'-scope trust grants are disabled when execution.unix_user_mode is not 'simple' (multi-user instance)"
        );
      }
    }

    await this.trustRepo.create({
      user_id: input.userId,
      scope_type: input.scopeType,
      scope_value: scopeValue,
      env_vars_set: sanitizedEnv,
      agor_grants_set: sanitizedGrants,
    });
    return { scope: input.scopeType, persisted: true };
  }

  async listTrustGrants(userId: string) {
    return this.trustRepo.findActiveByUser(userId);
  }

  async revokeTrustGrant(userId: string, grantId: string): Promise<void> {
    const grant = await this.trustRepo.findById(grantId);
    if (!grant) throw new Error(`Trust grant ${grantId} not found`);
    if (grant.user_id !== userId) {
      throw new Error('Cannot revoke a trust grant owned by another user');
    }
    await this.trustRepo.revoke(grantId);
  }

  // ── External "open in" / export ────────────────────────────────────────

  /**
   * Build a CodeSandbox define-API payload from the artifact's stored files
   * and POST it. Returns the resulting sandbox URL on success.
   *
   * Caveats inherent to the eject path (caller should surface to users):
   *  - daemon-supplied capabilities are stripped server-side
   *    anyway and won't function on CodeSandbox;
   *  - the synthesized `.env` and round-trip sidecars are dropped — they're
   *    Agor-only artifacts;
   *  - CodeSandbox's define endpoint is sometimes Cloudflare-throttled.
   *
   * Throws `Error` on every failure (visibility, missing files, network,
   * non-JSON 200 — typically a Cloudflare interstitial). Callers should
   * catch and present a friendly message.
   */
  async exportToCodeSandbox(
    artifactId: string,
    userId?: UserID
  ): Promise<{ artifactId: string; sandboxId: string; url: string; note: string }> {
    const artifact = await this.artifactRepo.findById(artifactId);
    if (!artifact) throw new Error(`Artifact ${artifactId} not found`);
    if (!this.isVisibleTo(artifact, userId)) {
      // Same shape as a hard-not-found — don't leak existence of private artifacts.
      throw new Error(`Artifact ${artifactId} not found`);
    }
    if (!artifact.files || Object.keys(artifact.files).length === 0) {
      throw new Error(`Artifact ${artifactId} has no files to export`);
    }
    const exportRenderConfig = normalizeSandpackConfigForRender({
      template: artifact.template,
      sandpack_config: artifact.sandpack_config,
      files: artifact.files,
      entry: artifact.entry,
    });

    // Strip Agor-only sidecars + the synthesized .env. CodeSandbox expects
    // `src/index.js` keys, not `/src/index.js` (no leading slash). Hold the
    // user's package.json aside so we can merge dependencies into it before
    // adding it back — CSB infers the runtime (CRA / vue-cli / svelte / …)
    // from the dependency graph in package.json, so getting this right is
    // what makes the export validate.
    const filesPayload: Record<string, { content: string }> = {};
    let userPackageJson: string | null = null;
    for (const [filePath, content] of Object.entries(artifact.files)) {
      const stripped = filePath.startsWith('/') ? filePath.slice(1) : filePath;
      if (
        stripped === 'agor.config.js' ||
        stripped === 'agor.artifact.json' ||
        stripped === '.env'
      ) {
        continue;
      }
      if (stripped === 'package.json') {
        userPackageJson = content;
        continue;
      }
      filesPayload[stripped] = { content };
    }

    let userPkg: Record<string, unknown> = {};
    if (userPackageJson) {
      try {
        const parsed = JSON.parse(userPackageJson);
        if (typeof parsed === 'object' && parsed !== null) {
          userPkg = parsed as Record<string, unknown>;
        }
      } catch {
        // Forgive malformed user package.json — synthesize one from the
        // dependency cache rather than failing the whole export.
      }
    }
    const customSetupDeps = exportRenderConfig.sandpack_config?.customSetup?.dependencies ?? {};
    const cachedDeps = artifact.dependencies ?? {};
    const mergedDeps: Record<string, string> = {
      ...customSetupDeps,
      ...cachedDeps,
      ...((userPkg.dependencies as Record<string, string> | undefined) ?? {}),
    };
    const exportEntry =
      exportRenderConfig.sandpack_config?.customSetup?.entry ??
      artifact.entry ??
      userPkg.main ??
      (exportRenderConfig.template === 'static' ? '/index.html' : 'src/index.js');
    const packageEntry =
      typeof exportEntry === 'string' && exportEntry.startsWith('/')
        ? exportEntry.slice(1)
        : exportEntry;
    const finalPkg: Record<string, unknown> = {
      name: 'artifact-export',
      version: '0.0.0',
      ...userPkg,
      main: packageEntry,
      dependencies: mergedDeps,
    };
    filesPayload['package.json'] = { content: JSON.stringify(finalPkg, null, 2) };

    // Don't send a top-level `template` — Sandpack template names (`react`,
    // `react-ts`, `vue3`, …) are NOT valid CSB template names (`create-
    // react-app`, `vue-cli`, …). CSB returns "Unable to process params"
    // when given a Sandpack name. Letting CSB infer from package.json deps
    // is both simpler and more reliable.
    const definePayload = { files: filesPayload };

    let res: Response;
    try {
      res = await fetch('https://codesandbox.io/api/v1/sandboxes/define?json=1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(definePayload),
      });
    } catch (err) {
      throw new Error(
        `CodeSandbox define API unreachable: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    if (!res.ok) {
      // Failure bodies are typically Cloudflare HTML interstitials. Don't
      // dump them — they bloat logs/UIs without adding signal.
      const ct = res.headers.get('content-type') ?? '';
      let hint = '';
      if (ct.includes('application/json')) {
        try {
          const body = (await res.json()) as { error?: string; message?: string };
          const msg = body.error ?? body.message;
          if (typeof msg === 'string' && msg.length > 0) hint = `: ${msg.slice(0, 200)}`;
        } catch {}
      }
      throw new Error(
        `CodeSandbox define API failed (${res.status} ${res.statusText})${hint}. The endpoint is sometimes throttled by Cloudflare; retry in a moment.`
      );
    }
    let body: { sandbox_id?: string };
    try {
      body = (await res.json()) as { sandbox_id?: string };
    } catch (err) {
      throw new Error(
        `CodeSandbox returned a non-JSON 200 response (likely a Cloudflare interstitial). Try again later. ${err instanceof Error ? err.message : ''}`.trim()
      );
    }
    const sandboxId = body.sandbox_id;
    if (!sandboxId) {
      throw new Error('CodeSandbox returned a 200 with no sandbox_id');
    }

    const url = `https://codesandbox.io/s/${sandboxId}`;
    const requiredVars = artifact.required_env_vars ?? [];
    const exportTemplate = exportRenderConfig.template;
    const exportPrefix = envVarPrefixForTemplate(exportTemplate);
    let note: string;
    if (requiredVars.length === 0) {
      note = 'No required env vars to configure.';
    } else if (exportPrefix === null) {
      note = `This artifact declares required_env_vars=${JSON.stringify(requiredVars)} but its template (${exportTemplate}) has no dotenv path. CodeSandbox can't expose these to the running bundle without changes to the artifact's code.`;
    } else {
      const example = `${exportPrefix}${requiredVars[0]}`;
      note = `This artifact declares required_env_vars=${JSON.stringify(requiredVars)}. Set the prefixed names (e.g. ${example} for template ${exportTemplate}) in CodeSandbox → Settings → Secret Keys to make them available at runtime.`;
    }

    return { artifactId, sandboxId, url, note };
  }

  // ── Runtime queries (DOM introspection from agent → viewer's iframe) ──

  /**
   * Send a query to the requester's own browser tab(s) viewing this
   * artifact. The browser dispatches into the Sandpack iframe via
   * postMessage; agor-runtime.js (auto-injected at render time) replies;
   * the browser POSTs the reply to `/artifacts/:id/runtime-response/...`,
   * which calls `resolveRuntimeQuery` to complete this promise.
   *
   * Visibility-checked. Rejects if:
   * - the artifact is private and the caller can't see it,
   * - the artifact has `agor_runtime.enabled === false`,
   * - or no browser tab fulfilled the query within `timeoutMs`.
   *
   * Scope: publication filters `agor-query` to `requesterId`, and the response
   * endpoint independently requires the responder to match it. Other artifact
   * viewers therefore receive neither the selector/args nor the response.
   */
  async queryArtifactRuntime(input: {
    artifactId: string;
    userId: string;
    kind: 'query_dom' | 'document_html';
    args: Record<string, unknown>;
    timeoutMs?: number;
  }): Promise<unknown> {
    this.assertRuntimeIntrospectionEnabled();
    const artifact = await this.artifactRepo.findById(input.artifactId);
    if (!artifact) throw new Error(`Artifact ${input.artifactId} not found`);
    if (!this.isVisibleTo(artifact, input.userId)) {
      throw new Error(`Artifact ${input.artifactId} not found`);
    }
    if (artifact.agor_runtime?.enabled === false) {
      throw new Error(
        `Runtime introspection is disabled for artifact ${input.artifactId} (agor_runtime.enabled = false). The artifact author can re-enable it via agor_artifacts_update.`
      );
    }

    const requestId = generateId();
    const timeoutMs = Math.min(Math.max(input.timeoutMs ?? 5000, 500), 30000);

    const promise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRuntimeQueries.delete(requestId);
        reject(
          new Error(
            `Runtime query timed out after ${timeoutMs}ms. Open the artifact in your browser (so the runtime can answer), then retry.`
          )
        );
      }, timeoutMs);

      this.pendingRuntimeQueries.set(requestId, {
        resolve,
        reject,
        timeout,
        requesterId: input.userId,
      });
    });

    // The global realtime publisher treats this custom event as requester-only.
    this.app.service('artifacts').emit('agor-query', {
      request_id: requestId,
      artifact_id: input.artifactId,
      requested_by_user_id: input.userId,
      kind: input.kind,
      args: input.args,
    });

    return promise;
  }

  /**
   * Called by the response REST endpoint when a viewer's browser POSTs
   * the iframe's reply. The auth boundary already authenticated the
   * caller; we additionally check that the responder matches the original
   * requester so a different user can't fulfill someone else's query.
   *
   * Silently no-op when the request id is unknown (timed out, never
   * existed, or already completed). Stale POSTs are common — multiple
   * tabs may answer the same query and only the first wins.
   */
  resolveRuntimeQuery(input: {
    requestId: string;
    responderUserId: string;
    ok: boolean;
    result?: unknown;
    error?: string;
  }): void {
    const pending = this.pendingRuntimeQueries.get(input.requestId);
    if (!pending) return;
    if (pending.requesterId !== input.responderUserId) return;
    clearTimeout(pending.timeout);
    this.pendingRuntimeQueries.delete(input.requestId);
    if (input.ok) {
      pending.resolve(input.result);
    } else {
      pending.reject(new Error(input.error || 'Runtime query failed (no error provided)'));
    }
  }

  // ── Build / status / console / find helpers (mostly unchanged) ──

  async checkBuildFromFolder(
    input: { branch_id: string; subpath: string },
    params: ArtifactParams
  ): Promise<ArtifactValidationResult> {
    const branch = await this.branchRepo.findById(input.branch_id);
    if (!branch) throw new Error(`Branch not found: ${input.branch_id}`);
    const branchFsAccess = await ensureBranchWorkspaceAccess(
      this.branchRepo,
      branch,
      params.user?.user_id,
      params.user?.role as UserRole | undefined,
      'session',
      'read',
      this.app.get('config').execution?.allow_superadmin === true
    );
    const userId = params.user?.user_id;
    if (!userId) throw new NotAuthenticated('Authentication required');
    const sandboxMounts = await this.resolveExecutorSandboxMounts(branch, userId as UserID, params);
    const result = await requestExecutor(
      {
        command: 'branch.artifact.validate',
        sessionToken: await issueExecutorCommandToken(
          this.app,
          'artifact.validate',
          userId,
          branch.branch_id
        ),
        daemonUrl: getDaemonUrl(),
        params: {
          branchId: branch.branch_id,
          subpath: input.subpath,
          cwd: branch.path,
          principalBranchAccess: branchFsAccess,
          ...sandboxMounts,
        },
      },
      {
        logPrefix: `[ArtifactsService.validate ${branch.branch_id}]`,
        delegatedHomeKey: await resolveDelegatedExecutionHomeKey(
          this.dbRef,
          userId,
          this.app.get('config')
        ),
        templateVariables: {
          branch_id: branch.branch_id,
          user_id: userId,
          branch_fs_access: branchFsAccess,
        },
      }
    );
    if (!result.success) {
      throw new Error(
        `Artifact validation failed: ${result.error?.message ?? 'unknown executor error'}`
      );
    }
    return result.data as ArtifactValidationResult;
  }

  async validateFromExecutor(
    data: {
      files: Record<string, string>;
      sidecar?: ArtifactSidecar | null;
      branch_id?: string;
    },
    params?: ArtifactParams
  ): Promise<ArtifactValidationResult> {
    this.requireExecutorCallback(params, 'artifact.validate', data.branch_id);
    const sandpackConfig = sanitizeSandpackConfig(data.sidecar?.sandpack_config);
    const template = (sandpackConfig.template ??
      data.sidecar?.template ??
      'react') as SandpackTemplate;
    const requiredEnvVars = sanitizeEnvVarNames(data.sidecar?.required_env_vars);
    return this.validateArtifactFiles(data.files, { template, sandpackConfig, requiredEnvVars });
  }

  private requireExecutorCallback(
    params: ArtifactParams | undefined,
    action: 'artifact.publish' | 'artifact.validate',
    branchId: string | undefined
  ): UserID {
    const caller = params?.user;
    if (!caller) throw new NotAuthenticated('Authentication required');
    if (
      typeof branchId !== 'string' ||
      !matchesExecutorCommandRuntimeScope(params, action, branchId)
    ) {
      throw new Forbidden('Executor token is not scoped to this artifact operation');
    }
    return caller.user_id as UserID;
  }

  async checkBuild(artifactId: string): Promise<{
    status: ArtifactBuildStatus;
    errors: string[];
  }> {
    const payload = await this.getPayload(artifactId);
    const result = this.validateArtifactFiles(payload.files, {
      template: payload.sandpack_config?.template ?? payload.template,
      sandpackConfig: payload.sandpack_config,
      requiredEnvVars: payload.required_env_vars ?? [],
    });
    await this.artifactRepo.updateBuildStatus(
      artifactId,
      result.status,
      result.errors.length > 0 ? result.errors : undefined
    );
    return result;
  }

  /** Compose the per-viewer key for the in-memory console/error/status maps. */
  private viewerKey(artifactId: string, userId: string): string {
    return `${artifactId}:${userId}`;
  }

  /** Drop every per-viewer buffer entry for an artifact (called on delete). */
  private clearAllViewerBuffersFor(artifactId: string): void {
    const prefix = `${artifactId}:`;
    for (const key of this.consoleLogs.keys()) {
      if (key.startsWith(prefix)) this.consoleLogs.delete(key);
    }
    for (const key of this.sandpackErrors.keys()) {
      if (key.startsWith(prefix)) this.sandpackErrors.delete(key);
    }
    for (const key of this.sandpackStatuses.keys()) {
      if (key.startsWith(prefix)) this.sandpackStatuses.delete(key);
    }
    for (const key of this.runtimeObservedAt.keys()) {
      if (key.startsWith(prefix)) this.runtimeObservedAt.delete(key);
    }
    for (const key of this.runtimeStatusWaiters.keys()) {
      if (key.startsWith(prefix)) this.notifyRuntimeStatusWaiters(key);
    }
  }

  async appendConsoleLogs(
    artifactId: string,
    userId: string,
    entries: ArtifactConsoleEntry[],
    contentHash?: string
  ): Promise<void> {
    if (!(await this.isCurrentRuntimeReportHash(artifactId, contentHash))) return;
    const key = this.viewerKey(artifactId, userId);
    const existing = this.consoleLogs.get(key) ?? [];
    const combined = [...existing, ...entries];
    if (combined.length > MAX_CONSOLE_ENTRIES) {
      this.consoleLogs.set(key, combined.slice(-MAX_CONSOLE_ENTRIES));
    } else {
      this.consoleLogs.set(key, combined);
    }
    this.runtimeObservedAt.set(key, new Date().toISOString());
    this.notifyRuntimeStatusWaiters(key);
  }

  async setSandpackError(
    artifactId: string,
    userId: string,
    error: SandpackError | null,
    status?: string,
    contentHash?: string
  ): Promise<void> {
    if (!(await this.isCurrentRuntimeReportHash(artifactId, contentHash))) return;
    const key = this.viewerKey(artifactId, userId);
    this.sandpackErrors.set(key, error);
    if (status !== undefined) {
      this.sandpackStatuses.set(key, status);
    }
    this.runtimeObservedAt.set(key, new Date().toISOString());
    this.notifyRuntimeStatusWaiters(key);
  }

  private async isCurrentRuntimeReportHash(
    artifactId: string,
    runtimeReportHash?: string
  ): Promise<boolean> {
    if (!runtimeReportHash) return true;
    const artifact = await this.artifactRepo.findById(artifactId);
    if (!artifact) return false;
    return this.computeRuntimeReportHash(artifact) === runtimeReportHash;
  }

  private computeRuntimeReportHash(
    artifact: Pick<
      Artifact,
      | 'artifact_id'
      | 'board_id'
      | 'template'
      | 'files'
      | 'sandpack_config'
      | 'required_env_vars'
      | 'agor_grants'
      | 'agor_runtime'
      | 'entry'
    >
  ): string {
    const files = artifact.files ?? {};
    const renderConfig = normalizeSandpackConfigForRender({
      template: artifact.template,
      sandpack_config: artifact.sandpack_config,
      files,
      entry: artifact.entry,
    });
    return this.computeHashFromFiles({
      ...files,
      '/.agor/runtime-report-inputs.json': JSON.stringify({
        artifact_id: artifact.artifact_id,
        board_id: artifact.board_id,
        template: renderConfig.template,
        entry: renderConfig.sandpack_config?.customSetup?.entry ?? artifact.entry ?? null,
        sandpack_config: renderConfig.sandpack_config ?? null,
        required_env_vars: artifact.required_env_vars ?? [],
        agor_grants: canonicalizeAgorGrants(artifact.agor_grants),
        agor_runtime_enabled: artifact.agor_runtime?.enabled !== false,
      }),
    });
  }

  private notifyRuntimeStatusWaiters(key: string): void {
    const waiters = this.runtimeStatusWaiters.get(key);
    if (!waiters) return;
    for (const notify of waiters) notify();
  }

  /**
   * Returns the artifact's runtime status — visibility-checked. The console
   * logs and Sandpack-error fields are scoped to the calling user's render
   * (see `viewerKey`); other viewers' captured output is never returned.
   */
  async getStatus(artifactId: string, userId?: UserID): Promise<ArtifactStatus> {
    this.assertRuntimeIntrospectionEnabled();
    const artifact = await this.artifactRepo.findById(artifactId);
    if (!artifact) throw new Error(`Artifact ${artifactId} not found`);
    if (!this.isVisibleTo(artifact, userId)) {
      // Don't leak existence of private artifacts.
      throw new Error(`Artifact ${artifactId} not found`);
    }

    const key = userId ? this.viewerKey(artifactId, userId) : null;
    const sandpackError = key ? (this.sandpackErrors.get(key) ?? null) : null;
    const sandpackStatus = key ? this.sandpackStatuses.get(key) : undefined;
    const runtimeObservedAt = key ? this.runtimeObservedAt.get(key) : undefined;
    const consoleLogs = key ? (this.consoleLogs.get(key) ?? []) : [];

    let buildStatus = artifact.build_status;
    let buildErrors = artifact.build_errors;

    if (sandpackError) {
      buildStatus = 'error';
      const sandpackMsg = `[Sandpack] ${sandpackError.message}`;
      buildErrors = [...(buildErrors ?? []), sandpackMsg];
    }

    return {
      artifact_id: artifact.artifact_id,
      build_status: buildStatus,
      build_errors: buildErrors ?? [],
      sandpack_error: sandpackError,
      sandpack_status: sandpackStatus,
      runtime_observed_at: runtimeObservedAt,
      console_logs: consoleLogs,
      content_hash: artifact.content_hash,
    };
  }

  buildStatusDiagnostic(status: ArtifactStatus): {
    diagnosis: string;
    primary_error?: string;
    suggested_fix?: string;
  } | null {
    const messages = [
      status.sandpack_error?.message,
      ...(status.build_errors ?? []),
      ...status.console_logs
        .filter((entry) => entry.level === 'error')
        .map((entry) => entry.message),
    ].filter((msg): msg is string => !!msg && msg.length > 0);
    const primary = messages[0];
    if (!primary) {
      if (!status.runtime_observed_at) {
        return {
          diagnosis: 'no_browser_observation',
          suggested_fix:
            'Open the artifact on the board/fullscreen as this user, then call agor_artifacts_status or publish with waitForStatus=true.',
        };
      }
      return null;
    }

    if (/could not find module|cannot find module|module not found/i.test(primary)) {
      return {
        diagnosis: 'missing_local_import_or_dependency',
        primary_error: primary,
        suggested_fix:
          'If the missing specifier starts with ./ or ../, create that file or fix the import path. Otherwise add the package to package.json dependencies or sandpackConfig.customSetup.dependencies.',
      };
    }
    if (/package\.json|JSON|Unexpected token/i.test(primary)) {
      return {
        diagnosis: 'malformed_package_json_or_syntax',
        primary_error: primary,
        suggested_fix: 'Check package.json and the referenced source file for syntax errors.',
      };
    }
    if (/process is not defined|import\.meta|env/i.test(primary)) {
      return {
        diagnosis: 'environment_variable_access',
        primary_error: primary,
        suggested_fix:
          'Check the template-specific env convention. React/CRA exposes declared vars as process.env.REACT_APP_NAME; Vite-style apps use import.meta.env.VITE_NAME.',
      };
    }
    return {
      diagnosis: 'runtime_or_build_error',
      primary_error: primary,
      suggested_fix:
        'Inspect build_errors, sandpack_error, and console_logs; fix the referenced file and republish.',
    };
  }

  /**
   * Wait for the caller's own browser render to report a Sandpack status for
   * the artifact. This is deliberately not a server-side build: Sandpack runs
   * in the browser, and logs/errors are per-viewer because rendered code may
   * contain secret-derived values.
   *
   * Resolution states:
   * - observed + ok=true: Sandpack reached a non-running status and no quick
   *   console.error arrived during the settle window.
   * - observed + ok=false: Sandpack reported an error/timeout, or the app
   *   emitted console.error.
   * - observed=false: no browser for this user reported status before timeout.
   */
  async waitForRuntimeStatus(
    artifactId: string,
    userId: UserID | undefined,
    options: { timeoutMs?: number; settleMs?: number } = {}
  ): Promise<
    ArtifactStatus & { ok: boolean; observed: boolean; timed_out: boolean; note?: string }
  > {
    this.assertRuntimeIntrospectionEnabled();
    if (!userId) {
      const status = await this.getStatus(artifactId, userId);
      return {
        ...status,
        ok: false,
        observed: false,
        timed_out: false,
        note: 'Runtime validation requires an authenticated user so logs stay scoped to one viewer.',
      };
    }

    // Visibility and not-found behavior are delegated to getStatus().
    const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 10000, 500), 60000);
    const settleMs = Math.min(Math.max(options.settleMs ?? 1000, 0), 5000);
    const key = this.viewerKey(artifactId, userId);
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

    const classify = async (): Promise<
      | (ArtifactStatus & { ok: boolean; observed: boolean; timed_out: boolean; note?: string })
      | null
    > => {
      const status = await this.getStatus(artifactId, userId);
      const errorLogs = status.console_logs.filter((entry) => entry.level === 'error');
      if (status.sandpack_error || status.sandpack_status === 'timeout' || errorLogs.length > 0) {
        return {
          ...status,
          build_status: 'error',
          build_errors: [
            ...(status.build_errors ?? []),
            ...errorLogs.map((entry) => `[console.error] ${entry.message}`),
          ],
          ok: false,
          observed: true,
          timed_out: false,
          note: status.sandpack_error
            ? 'Sandpack reported a bundler/runtime error in your browser render.'
            : 'The artifact emitted console.error during boot/render.',
        };
      }
      if (status.build_status === 'error' && (status.build_errors?.length ?? 0) > 0) {
        return {
          ...status,
          ok: false,
          observed: false,
          timed_out: false,
          note: 'Server-side file validation failed before browser runtime validation.',
        };
      }
      if (status.sandpack_status && status.sandpack_status !== 'running') {
        return { ...status, ok: true, observed: true, timed_out: false };
      }
      return null;
    };

    const initial = await classify();
    if (initial && !initial.ok) return initial;
    if (initial?.ok && settleMs === 0) return initial;

    return new Promise((resolve) => {
      const cleanup = () => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (settleTimer) clearTimeout(settleTimer);
        const waiters = this.runtimeStatusWaiters.get(key);
        if (waiters) {
          waiters.delete(onUpdate);
          if (waiters.size === 0) this.runtimeStatusWaiters.delete(key);
        }
      };

      const finish = (
        result: ArtifactStatus & {
          ok: boolean;
          observed: boolean;
          timed_out: boolean;
          note?: string;
        }
      ) => {
        cleanup();
        resolve(result);
      };

      const scheduleSuccess = (status: ArtifactStatus) => {
        if (settleTimer) return;
        settleTimer = setTimeout(async () => {
          settleTimer = null;
          const latest = await classify();
          if (latest) finish(latest);
        }, settleMs);
      };

      const onUpdate = () => {
        void (async () => {
          const latest = await classify();
          if (!latest) return;
          if (!latest.ok) {
            finish(latest);
            return;
          }
          if (settleMs === 0) {
            finish(latest);
          } else {
            scheduleSuccess(latest);
          }
        })();
      };

      const waiters = this.runtimeStatusWaiters.get(key) ?? new Set<() => void>();
      waiters.add(onUpdate);
      this.runtimeStatusWaiters.set(key, waiters);

      timeoutTimer = setTimeout(async () => {
        const latest = await classify();
        if (latest) {
          finish(latest);
          return;
        }
        const status = await this.getStatus(artifactId, userId);
        finish({
          ...status,
          ok: false,
          observed: false,
          timed_out: true,
          note: `No Sandpack status was reported by your browser within ${timeoutMs}ms. Open the artifact on the board/fullscreen as this user and retry, or use agor_artifacts_status after viewing it. Server-side publish can only validate the file map; Sandpack boot happens in the browser.`,
        });
      }, timeoutMs);

      // Close the small race between the initial classify() and waiter
      // registration: a browser POST may have updated the in-memory status
      // just before we subscribed. Re-read once now that the waiter exists.
      onUpdate();
      if (initial?.ok) scheduleSuccess(initial);
    });
  }

  /**
   * Delete an artifact, its board placement, and its in-memory buffers.
   * Owner-or-admin only — agent-facing tools must pass `userId` and the
   * caller's role. The Feathers REST hook chain enforces the same rule for
   * direct PATCH/REMOVE; this method is what the MCP tool calls and used
   * to be unchecked.
   */
  async deleteArtifact(
    artifactId: string,
    userId?: string,
    userRole?: UserRole
  ): Promise<Artifact> {
    const artifact = await this.artifactRepo.findById(artifactId);
    if (!artifact) throw new Error(`Artifact ${artifactId} not found`);

    const isOwner = !!userId && artifact.created_by === userId;
    const isAdmin = !!userRole && hasMinimumRole(userRole, ROLES.ADMIN);
    if (!isOwner && !isAdmin) {
      throw new Error("Forbidden: only the artifact's creator or an admin may delete it");
    }

    const objectId = `artifact-${artifactId}`;
    try {
      const updatedBoard = await this.boardRepo.removeBoardObject(artifact.board_id, objectId);
      if (this.app && updatedBoard) {
        emitServiceEvent(this.app, {
          path: 'boards',
          event: 'patched',
          data: updatedBoard,
          id: artifact.board_id,
        });
      }
    } catch {
      // Board object may not exist or board may be deleted.
    }

    this.clearAllViewerBuffersFor(artifactId);
    await this.artifactRepo.delete(artifactId);
    // Returned so callers can emit `removed` events without a redundant
    // pre-delete fetch.
    return artifact;
  }

  async findByBoardId(boardId: BoardID, userId?: string): Promise<Artifact[]> {
    return this.artifactRepo.findByBoardId(boardId, { userId: userId ?? '__anonymous__' });
  }

  async findVisible(userId?: string, options?: { limit?: number }): Promise<Artifact[]> {
    return this.artifactRepo.findVisible(userId ?? '__anonymous__', { limit: options?.limit });
  }

  // ── Private helpers ──

  private validateArtifactFiles(
    files: Record<string, string>,
    options: {
      template?: SandpackTemplate;
      sandpackConfig?: SandpackConfig;
      requiredEnvVars?: string[];
    } = {}
  ): ArtifactValidationResult {
    const diagnostics: ArtifactValidationDiagnostic[] = [];
    const add = (
      severity: 'error' | 'warning',
      code: string,
      message: string,
      extra: Pick<ArtifactValidationDiagnostic, 'file' | 'suggested_fix'> = {}
    ) => diagnostics.push({ severity, code, message, ...extra });

    const sourceFiles = Object.entries(files).filter(([fp]) =>
      /\.(js|jsx|ts|tsx|html|css)$/.test(fp)
    );

    if (sourceFiles.length === 0) {
      add('error', 'no_source_files', 'No source files found in artifact', {
        suggested_fix: 'Add at least one .js, .jsx, .ts, .tsx, .html, or .css file.',
      });
    }

    for (const [filePath, content] of sourceFiles) {
      if (!content || content.trim().length === 0) {
        add('error', 'empty_source_file', `${filePath}: file is empty`, {
          file: filePath,
          suggested_fix: 'Add source code to the file or remove the empty file.',
        });
      }
    }

    const pkgPath = files['/package.json'] !== undefined ? '/package.json' : 'package.json';
    const pkg = files[pkgPath];
    if (pkg !== undefined) {
      try {
        JSON.parse(pkg);
      } catch (err) {
        add(
          'error',
          'malformed_package_json',
          `${pkgPath}: package.json is not valid JSON (${err instanceof Error ? err.message : String(err)})`,
          {
            file: pkgPath,
            suggested_fix: 'Fix package.json syntax, especially trailing commas and quotes.',
          }
        );
      }
    }

    const entry = options.sandpackConfig?.customSetup?.entry;
    if (entry && !this.hasFile(files, entry)) {
      add('error', 'missing_custom_entry', `Configured Sandpack entry file not found: ${entry}`, {
        file: entry,
        suggested_fix: 'Create the entry file or update sandpackConfig.customSetup.entry.',
      });
    } else if (!entry && !this.findLikelyEntry(files)) {
      add(
        'warning',
        'no_likely_entry',
        'No common Sandpack entry file found (for example /src/index.tsx, /src/main.tsx, /index.js, or /index.html).',
        {
          suggested_fix:
            'Add a conventional entry file or set sandpackConfig.customSetup.entry to the correct file.',
        }
      );
    }

    for (const [filePath, content] of Object.entries(files)) {
      if (!/\.(js|jsx|ts|tsx)$/.test(filePath)) continue;
      for (const specifier of this.extractRelativeImportSpecifiers(content)) {
        if (!this.resolveRelativeImport(files, filePath, specifier)) {
          add(
            'error',
            'missing_local_import',
            `${filePath}: local import not found: ${specifier}`,
            {
              file: filePath,
              suggested_fix: `Create the referenced module (${specifier}) or fix/remove the import in ${filePath}.`,
            }
          );
        }
      }
    }

    const template = options.template ?? 'react';
    const requiredEnvVars = options.requiredEnvVars ?? [];
    if (requiredEnvVars.length > 0 && envVarPrefixForTemplate(template) === null) {
      add(
        'warning',
        'env_vars_not_injected_for_template',
        `required_env_vars are declared, but template '${template}' has no verified dotenv injection path.`,
        {
          suggested_fix:
            'Use a React/React-TS template or change the app to read configuration another way.',
        }
      );
    }

    const prefix = envVarPrefixForTemplate(template);
    if (prefix) {
      for (const [filePath, content] of Object.entries(files)) {
        if (!/\.(js|jsx|ts|tsx)$/.test(filePath)) continue;
        for (const envName of requiredEnvVars) {
          const prefixed = `${prefix}${envName}`;
          if (
            content.includes(`process.env.${envName}`) &&
            !content.includes(`process.env.${prefixed}`)
          ) {
            add(
              'warning',
              'possibly_unprefixed_env_var',
              `${filePath}: '${envName}' is declared, but ${template} exposes it as '${prefixed}'.`,
              {
                file: filePath,
                suggested_fix: `Read process.env.${prefixed} instead of process.env.${envName}.`,
              }
            );
          }
        }
      }
    }

    const errors = diagnostics.filter((d) => d.severity === 'error').map((d) => d.message);
    const warnings = diagnostics.filter((d) => d.severity === 'warning').map((d) => d.message);
    return { status: errors.length > 0 ? 'error' : 'success', errors, warnings, diagnostics };
  }

  private hasFile(files: Record<string, string>, candidate: string): boolean {
    const normalized = candidate.startsWith('/') ? candidate : `/${candidate}`;
    return files[normalized] !== undefined || files[normalized.slice(1)] !== undefined;
  }

  private findLikelyEntry(files: Record<string, string>): string | null {
    const candidates = [
      '/src/index.tsx',
      '/src/index.jsx',
      '/src/index.ts',
      '/src/index.js',
      '/src/main.tsx',
      '/src/main.jsx',
      '/src/main.ts',
      '/src/main.js',
      '/index.tsx',
      '/index.jsx',
      '/index.ts',
      '/index.js',
      '/index.html',
    ];
    return candidates.find((candidate) => this.hasFile(files, candidate)) ?? null;
  }

  private extractRelativeImportSpecifiers(source: string): string[] {
    const specs = new Set<string>();
    const patterns = [
      /(?:import|export)\s+(?:type\s+)?(?:[^'";]+?\s+from\s+)?['"](\.{1,2}\/[^'"]+)['"]/g,
      /import\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g,
      /require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g,
    ];
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) {
        if (match[1]) specs.add(match[1]);
      }
    }
    return [...specs];
  }

  private resolveRelativeImport(
    files: Record<string, string>,
    fromFile: string,
    specifier: string
  ): boolean {
    const fromDir = path.posix.dirname(fromFile.startsWith('/') ? fromFile : `/${fromFile}`);
    const base = path.posix.normalize(path.posix.join(fromDir, specifier));
    const candidates = [
      base,
      `${base}.ts`,
      `${base}.tsx`,
      `${base}.js`,
      `${base}.jsx`,
      `${base}.json`,
      `${base}.css`,
      path.posix.join(base, 'index.ts'),
      path.posix.join(base, 'index.tsx'),
      path.posix.join(base, 'index.js'),
      path.posix.join(base, 'index.jsx'),
      path.posix.join(base, 'index.css'),
    ];
    return candidates.some((candidate) => this.hasFile(files, candidate));
  }

  private extractDependenciesFromPackageJson(
    files: Record<string, string>
  ): Record<string, string> | undefined {
    const pkg = files['/package.json'] ?? files['package.json'];
    if (!pkg) return undefined;
    try {
      const parsed = JSON.parse(pkg) as { dependencies?: Record<string, string> };
      return parsed.dependencies && Object.keys(parsed.dependencies).length > 0
        ? parsed.dependencies
        : undefined;
    } catch {
      return undefined;
    }
  }

  private computeHashFromFiles(files: Record<string, string>): string {
    const hash = createHash('md5');
    const sortedKeys = Object.keys(files).sort();
    for (const key of sortedKeys) {
      hash.update(`${key}:${files[key]}`);
    }
    return hash.digest('hex');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers (testable; no service state)
// ─────────────────────────────────────────────────────────────────────────────

const ENV_VAR_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;

export function sanitizeEnvVarNames(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  for (const v of input) {
    if (typeof v !== 'string') continue;
    if (!ENV_VAR_NAME_RE.test(v)) continue;
    seen.add(v);
  }
  return [...seen];
}

/** Strip informational grants that don't need consent. */
export function pickConsentRelevantGrants(grants: AgorGrants): AgorGrants {
  const out: AgorGrants = { ...grants };
  // agor_artifact_id and agor_board_id are pure metadata — no consent.
  delete out.agor_artifact_id;
  delete out.agor_board_id;
  return out;
}

/** Inverse of `pickConsentRelevantGrants`: only the no-consent metadata keys. */
export function pickNoConsentGrants(grants: AgorGrants): AgorGrants {
  const out: AgorGrants = {};
  for (const key of NO_CONSENT_GRANT_KEYS) {
    if (grants[key]) out[key] = true;
  }
  return out;
}

/**
 * Strict subset check: the existing grant must cover every requested env var
 * AND every requested non-informational grant.
 */
function coversRequest(
  grant: { env_vars_set: string[]; agor_grants_set: AgorGrants },
  requiredEnvVars: string[],
  requestedGrants: AgorGrants
): boolean {
  const env = new Set(grant.env_vars_set);
  for (const v of requiredEnvVars) {
    if (!env.has(v)) return false;
  }
  return grantsAreSubset(requestedGrants, grant.agor_grants_set);
}

function grantsAreSubset(needs: AgorGrants, has: AgorGrants): boolean {
  for (const key of Object.keys(GRANT_ENV_VAR_NAMES) as (keyof typeof GRANT_ENV_VAR_NAMES)[]) {
    if ((needs as Record<string, unknown>)[key] && !(has as Record<string, unknown>)[key]) {
      return false;
    }
  }
  return true;
}

/** Escape a `.env` value: quote, escape backslashes/quotes/newlines. */
export function escapeEnvValue(value: string): string {
  if (!value) return '';
  // Always quote — covers spaces, `#`, `=` in the value, etc. Escape CR as
  // well as LF: some dotenv readers treat a bare CR as a record boundary,
  // which would let one managed value synthesize an attacker-selected key.
  return `"${value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')}"`;
}

export function createArtifactsService(
  db: TenantScopeAwareDatabase,
  app: Application,
  options: { runtimeIntrospectionEnabled?: boolean } = {}
): ArtifactsService {
  return new ArtifactsService(db, app, options);
}
