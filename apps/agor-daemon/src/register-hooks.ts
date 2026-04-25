/**
 * Service Hooks Registration
 *
 * Registers all FeathersJS service hooks (before/after/error)
 * for authentication, authorization, RBAC, and business logic.
 * Extracted from index.ts for maintainability.
 */

import { type AgorConfig, isUnixImpersonationEnabled, type UnknownJson } from '@agor/core/config';
import {
  ArtifactRepository,
  BoardRepository,
  type Database,
  type SessionRepository,
  UserMCPOAuthTokenRepository,
  type UsersRepository,
  type WorktreeRepository,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import { BadRequest, Forbidden, NotAuthenticated } from '@agor/core/feathers';
import {
  boardCommentQueryValidator,
  boardObjectQueryValidator,
  boardQueryValidator,
  mcpServerQueryValidator,
  repoQueryValidator,
  sessionQueryValidator,
  taskQueryValidator,
  typedValidateQuery,
  userQueryValidator,
  worktreeQueryValidator,
} from '@agor/core/lib/feathers-validation';
import type {
  AuthenticatedParams,
  Board,
  HookContext,
  MCPServer,
  Paginated,
  Params,
  Session,
  User,
} from '@agor/core/types';
import { hasMinimumRole, ROLES } from '@agor/core/types';
import type {
  BoardsServiceImpl,
  MessagesServiceImpl,
  SessionsServiceImpl,
} from './declarations.js';

import { gatewayRouteHook } from './hooks/gateway-route.js';
import type { ArtifactsService } from './services/artifacts.js';
import type { GatewayService } from './services/gateway.js';
import {
  ensureMinimumRole,
  registerAuthenticatedRoute,
  requireAdminForEnvConfig,
  requireMinimumRole,
} from './utils/authorization.js';
import { injectCreatedBy } from './utils/inject-created-by.js';
import {
  createServiceToken,
  getDaemonUrl,
  spawnExecutorFireAndForget,
} from './utils/spawn-executor.js';
import {
  ensureCanCreateSession,
  ensureCanPromptInSession,
  ensureCanPromptTargetSession,
  ensureCanView,
  ensureSessionImmutability,
  ensureWorktreePermission,
  loadSession,
  loadSessionWorktree,
  loadWorktree,
  loadWorktreeFromSession,
  PERMISSION_RANK,
  resolveSessionContext,
  scopeFindToAccessibleBoards,
  scopeFindToAccessibleSessions,
  scopeFindToAccessibleWorktrees,
  scopeSessionQuery,
  scopeWorktreeQuery,
  setSessionUnixUsername,
  validateSessionUnixUsername,
} from './utils/worktree-authorization.js';

/**
 * Session fields written as runtime bookkeeping during the prompt/execution
 * lifecycle, on behalf of the session's authenticated user. These are NOT
 * session metadata (name, model_config, permission_config, callback_config).
 *
 * Sources:
 *   - `/sessions/:id/prompt`  → `tasks`, `archived`, `archived_reason`
 *   - `/sessions/:id/stop`    → `status`, `ready_for_prompt`
 *   - executor status updates → `status`, `ready_for_prompt`
 *     (claude/copilot permission-hooks, see packages/executor)
 *   - executor git-SHA capture → `git_state` (per-message current_sha)
 *   - executor opencode init   → `sdk_session_id` (SDK session handle)
 *
 * When a `patch` touches ONLY these fields, the sessions hook chain downgrades
 * the required worktree permission from `'all'` to the same tier that
 * {@link ensureCanPromptInSession} enforces:
 *   - `'prompt'` or `'all'` → can patch any session's prompt-flow fields
 *   - `'session'`           → can patch own session's prompt-flow fields
 *   - `'view'` or `'none'`  → denied
 *
 * Any mixed-field patch (e.g. `{ tasks: [...], name: 'x' }`) fails the
 * `isPromptFlowPatchOnly` check and falls through to the strict `'all'` path,
 * so widening the whitelist here cannot accidentally leak metadata writes.
 *
 * NOTE: `git_state` and `sdk_session_id` are on this list because the executor
 * authenticates as the session creator (see auth/session-token-strategy.ts),
 * not as a service account. Proper long-term fix is to give the executor a
 * service-account token so these patches bypass RBAC entirely.
 */
export const PROMPT_FLOW_PATCH_FIELDS: readonly string[] = [
  'tasks',
  'archived',
  'archived_reason',
  'status',
  'ready_for_prompt',
  'git_state',
  'sdk_session_id',
];

export function isPromptFlowPatchOnly(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const keys = Object.keys(data);
  if (keys.length === 0) return false;
  return keys.every((key) => PROMPT_FLOW_PATCH_FIELDS.includes(key));
}

/**
 * Authorization predicate for emitting an MCP token on `GET /sessions/:id`.
 *
 * The token binds `uid = session.created_by` and lets the bearer act AS the
 * creator on the MCP channel. It must therefore only be handed to callers
 * who are ALREADY allowed to act as that creator:
 *
 *   - the creator themselves, provided they are still `member+` (viewers
 *     never receive a token — see docs: "Viewers never receive an
 *     mcp_token")
 *   - a superadmin (ops access)
 *   - the executor's service identity (spawns the child that uses the
 *     token; see `createServiceToken` in utils/spawn-executor.ts)
 *
 * A plain `member+` with `view` permission on the worktree is NOT enough —
 * giving them the token would let them impersonate the creator, sidestepping
 * the `session`-tier "own sessions only" rule enforced elsewhere.
 *
 * Note: `service` is not part of the user-facing role hierarchy (see
 * `ROLE_RANK` in `@agor/core/types/user.ts`), so `hasMinimumRole('service',
 * ...)` returns false — we check for it by exact-string match instead.
 */
export function canReceiveMcpTokenForSession(params: {
  callerUserId: string | undefined;
  callerRole: string | undefined;
  sessionCreatedBy: string | null | undefined;
}): boolean {
  const { callerUserId, callerRole, sessionCreatedBy } = params;
  const isSuperadmin = hasMinimumRole(callerRole, ROLES.SUPERADMIN);
  const isServiceExecutor = callerRole === 'service';
  const isCreatorMember =
    !!callerUserId && callerUserId === sessionCreatedBy && hasMinimumRole(callerRole, ROLES.MEMBER);
  return isCreatorMember || isSuperadmin || isServiceExecutor;
}

/**
 * Extended Params with route ID parameter (needed by artifact routes in hooks).
 */
interface RouteParams extends Params {
  route?: {
    id?: string;
    messageId?: string;
    mcpId?: string;
  };
  user?: User;
}

/**
 * Interface for dependencies needed by hook registration.
 */
export interface RegisterHooksContext {
  db: Database;
  app: Application & { io?: import('socket.io').Server };
  config: AgorConfig;
  svcEnabled: (group: string) => boolean;
  jwtSecret: string;
  worktreeRbacEnabled: boolean;
  allowAnonymous: boolean;
  requireAuth: (context: HookContext) => Promise<HookContext>;
  getReadAuthHooks: () => Array<(context: HookContext) => Promise<HookContext>>;
  superadminOpts: { allowSuperadmin: boolean };

  // Service instances from registerServices()
  sessionsService: SessionsServiceImpl;
  messagesService: MessagesServiceImpl;
  boardsService: BoardsServiceImpl | undefined;
  worktreeRepository: WorktreeRepository;
  usersRepository: UsersRepository;
  sessionsRepository: SessionRepository;
}

/**
 * Register all FeathersJS service hooks.
 */
export function registerHooks(ctx: RegisterHooksContext): void {
  const {
    db,
    app,
    config,
    svcEnabled,
    jwtSecret,
    worktreeRbacEnabled,
    allowAnonymous,
    requireAuth,
    getReadAuthHooks,
    superadminOpts,
    sessionsService,
    boardsService,
    worktreeRepository,
    usersRepository,
    sessionsRepository,
  } = ctx;

  // Helper: safely get a service (returns undefined if not registered due to tier=off)
  const safeService = (path: string) => {
    try {
      return app.service(path);
    } catch {
      return undefined;
    }
  };

  // Helper to get usersService from app
  const usersService = app.service('users');

  // ============================================================================
  // Messages hooks
  // ============================================================================

  app.service('messages').hooks({
    before: {
      all: [requireAuth],
      find: [
        // RBAC: Scope messages.find() to sessions the caller can access.
        // Without this backstop, any authenticated member could list messages
        // across every session/worktree by omitting the session_id filter.
        ...(worktreeRbacEnabled
          ? [scopeFindToAccessibleSessions(sessionsRepository, superadminOpts)]
          : []),
      ],
      get: [
        ...(worktreeRbacEnabled
          ? [
              resolveSessionContext(),
              loadSession(sessionsService),
              loadWorktreeFromSession(worktreeRepository),
              ensureCanView(superadminOpts), // Require 'view' permission
            ]
          : []),
      ],
      create: [
        requireMinimumRole(ROLES.MEMBER, 'create messages'),
        ...(worktreeRbacEnabled
          ? [
              resolveSessionContext(),
              loadSession(sessionsService),
              validateSessionUnixUsername(usersRepository), // Defensive check: session.unix_username must match creator's current unix_username
              loadWorktreeFromSession(worktreeRepository),
              ensureCanPromptInSession(superadminOpts), // Require 'prompt' (or 'session' for own sessions)
            ]
          : []),
      ],
      patch: [
        requireMinimumRole(ROLES.MEMBER, 'update messages'),
        ...(worktreeRbacEnabled
          ? [
              resolveSessionContext(),
              loadSession(sessionsService),
              loadWorktreeFromSession(worktreeRepository),
              ensureCanPromptInSession(superadminOpts), // Require 'prompt' (or 'session' for own sessions)
            ]
          : []),
      ],
      remove: [
        requireMinimumRole(ROLES.MEMBER, 'delete messages'),
        ...(worktreeRbacEnabled
          ? [
              resolveSessionContext(),
              loadSession(sessionsService),
              loadWorktreeFromSession(worktreeRepository),
              ensureCanPromptInSession(superadminOpts), // Require 'prompt' (or 'session' for own sessions)
            ]
          : []),
      ],
    },
    after: {
      create: [gatewayRouteHook],
      patch: [
        async (context: HookContext<Board>) => {
          // Detect permission resolution and notify executor via IPC
          const message = context.result as import('@agor/core/types').Message;

          // Only process permission_request messages
          if (message.type !== 'permission_request') {
            return context;
          }

          // Check if the message content has approval status
          const content = message.content;
          if (typeof content !== 'object' || !content || Array.isArray(content)) {
            return context;
          }

          const contentObj = content as unknown as Record<string, unknown>;
          const status = contentObj.status;
          if (status !== 'approved' && status !== 'denied') {
            return context;
          }

          // Permission was resolved! Notify the executor via IPC
          console.log(`[daemon] Permission ${status} for request ${contentObj.request_id}`);

          // NOTE: Permission decisions are handled by the executor listening to WebSocket permission events
          // No IPC needed - executor subprocess watches for permission message updates via WebSocket
          console.log('[daemon] Permission decision will be delivered to executor via WebSocket');

          return context;
        },
      ],
    },
  });

  // ============================================================================
  // Board objects hooks
  // ============================================================================

  safeService('board-objects')?.hooks({
    before: {
      all: [
        typedValidateQuery(boardObjectQueryValidator),
        ...getReadAuthHooks(),
        ...(allowAnonymous ? [] : [requireMinimumRole(ROLES.MEMBER, 'manage board objects')]),
      ],
      // NOTE: We deliberately do NOT add scopeFindToAccessibleWorktrees here.
      // Board-objects may reference `worktree_id` (worktree cards) OR `card_id`
      // (kanban cards with no worktree) OR neither (zones, layout objects).
      // The before-hook would filter out rows with null worktree_id, breaking
      // card-only boards. Access control lives in the after-hook below, which
      // correctly preserves card/zone rows while scoping worktree-bound ones.
    },
    after: {
      find: [
        ...(worktreeRbacEnabled
          ? [
              // Filter board-objects based on worktree access permissions
              async (context: HookContext) => {
                // Skip for internal calls
                if (!context.params.provider) {
                  return context;
                }

                const userId = context.params.user?.user_id as
                  | import('@agor/core/types').UUID
                  | undefined;
                if (!userId) {
                  // Not authenticated - return empty results
                  context.result = {
                    total: 0,
                    limit: context.result?.limit ?? 0,
                    skip: context.result?.skip ?? 0,
                    data: [],
                  };
                  return context;
                }

                // Get all board objects from result
                // biome-ignore lint/suspicious/noExplicitAny: BoardObject type not fully available in hook context
                const boardObjects: any[] = context.result?.data ?? context.result ?? [];

                // Filter based on worktree access
                const authorizedBoardObjects = [];
                for (const boardObject of boardObjects) {
                  // Board objects may reference worktrees or sessions
                  if (boardObject.worktree_id) {
                    // Check worktree access
                    const worktree = await worktreeRepository.findById(boardObject.worktree_id);
                    if (!worktree) {
                      continue; // Skip if worktree doesn't exist
                    }

                    const isOwner = await worktreeRepository.isOwner(worktree.worktree_id, userId);
                    const effectivePermission = worktree.others_can ?? 'session';
                    const hasAccess =
                      isOwner || PERMISSION_RANK[effectivePermission] >= PERMISSION_RANK.view;

                    if (hasAccess) {
                      authorizedBoardObjects.push(boardObject);
                    }
                  } else if (boardObject.card_id) {
                    // Card board objects: cards inherit board-level access (no per-card RBAC)
                    authorizedBoardObjects.push(boardObject);
                  } else {
                    // No worktree or card reference - allow access (e.g., zones, other board objects)
                    authorizedBoardObjects.push(boardObject);
                  }
                }

                // Update result
                if (context.result?.data) {
                  context.result.data = authorizedBoardObjects;
                  context.result.total = authorizedBoardObjects.length;
                } else {
                  context.result = authorizedBoardObjects;
                }

                return context;
              },
            ]
          : []),
      ],
    },
  });

  // ============================================================================
  // Card types, cards, artifacts hooks
  // ============================================================================

  safeService('card-types')?.hooks({
    before: {
      all: [...getReadAuthHooks()],
      create: [requireMinimumRole(ROLES.MEMBER, 'create card types')],
      patch: [requireMinimumRole(ROLES.MEMBER, 'update card types')],
      remove: [requireMinimumRole(ROLES.MEMBER, 'delete card types')],
    },
  });

  safeService('cards')?.hooks({
    before: {
      all: [...getReadAuthHooks()],
      create: [requireMinimumRole(ROLES.MEMBER, 'create cards'), injectCreatedBy()],
      patch: [requireMinimumRole(ROLES.MEMBER, 'update cards')],
      remove: [requireMinimumRole(ROLES.MEMBER, 'delete cards')],
    },
  });

  /**
   * Before-hook for artifacts patch/remove: only the creator or an
   * admin/superadmin may modify an artifact. Without this, any `member` could
   * PATCH /artifacts/:id and rename, re-board, archive, or unpublish another
   * user's artifact — role-only gating is not enough.
   *
   * Runs AFTER requireMinimumRole (which guarantees `params.user`), skips
   * internal calls (no provider) and service accounts (executor).
   */
  const ensureArtifactOwnerOrAdmin = () => async (context: HookContext) => {
    if (!context.params.provider) return context;
    const user = (context.params as { user?: User })?.user;
    if (!user) throw new NotAuthenticated('Authentication required');
    if ((user as unknown as { _isServiceAccount?: boolean })._isServiceAccount) return context;
    if (hasMinimumRole(user.role, ROLES.ADMIN)) return context;

    const artifactId = context.id;
    if (artifactId === undefined || artifactId === null) return context;
    const artifactRepo = new ArtifactRepository(db);
    const artifact = await artifactRepo.findById(String(artifactId));
    if (!artifact) {
      throw new Forbidden(`Artifact ${artifactId} not found or not accessible`);
    }
    if (artifact.created_by && artifact.created_by === user.user_id) return context;
    throw new Forbidden(
      "Only the artifact's creator or an admin may modify it. Use agor_artifacts_publish to create your own copy."
    );
  };

  safeService('artifacts')?.hooks({
    before: {
      all: [...getReadAuthHooks()],
      find: [
        // RBAC: Artifacts carry a `worktree_id` (nullable — survives worktree deletion).
        // Scope find() to the worktrees the caller can access. Rows with null
        // worktree_id (orphaned artifacts) will be excluded by the $in filter,
        // which is the safe default — orphans can only be surfaced via explicit
        // board-scoped queries.
        ...(worktreeRbacEnabled
          ? [scopeFindToAccessibleWorktrees(worktreeRepository, superadminOpts)]
          : []),
      ],
      create: [requireMinimumRole(ROLES.MEMBER, 'create artifacts'), injectCreatedBy()],
      patch: [requireMinimumRole(ROLES.MEMBER, 'update artifacts'), ensureArtifactOwnerOrAdmin()],
      remove: [requireMinimumRole(ROLES.MEMBER, 'delete artifacts'), ensureArtifactOwnerOrAdmin()],
    },
  });

  // Custom REST routes for artifact payload and console
  if (svcEnabled('artifacts')) {
    registerAuthenticatedRoute(
      app,
      '/artifacts/:id/payload',
      {
        async find(_params: RouteParams) {
          const artifactId = _params.route?.id;
          if (!artifactId) throw new Error('Artifact ID required');
          const artifactsService = app.service('artifacts') as unknown as ArtifactsService;
          return artifactsService.getPayload(artifactId, _params.user?.user_id);
        },
      },
      { find: { role: ROLES.VIEWER, action: 'get artifact payload' } },
      requireAuth
    );

    registerAuthenticatedRoute(
      app,
      '/artifacts/:id/console',
      {
        async create(
          data: { entries: Array<{ timestamp: number; level: string; message: string }> },
          _params: RouteParams
        ) {
          const artifactId = _params.route?.id;
          if (!artifactId) throw new Error('Artifact ID required');
          const artifactsService = app.service('artifacts') as unknown as ArtifactsService;
          artifactsService.appendConsoleLogs(artifactId, data.entries as never);
          return { success: true };
        },
      },
      {
        create: { role: ROLES.MEMBER, action: 'post artifact console logs' },
      },
      requireAuth
    );

    registerAuthenticatedRoute(
      app,
      '/artifacts/:id/sandpack-error',
      {
        async create(
          data: {
            error: import('@agor/core/types').SandpackError | null;
            status?: string;
          },
          _params: RouteParams
        ) {
          const artifactId = _params.route?.id;
          if (!artifactId) throw new Error('Artifact ID required');
          const artifactsService = app.service('artifacts') as unknown as ArtifactsService;
          artifactsService.setSandpackError(artifactId, data.error, data.status);
          return { success: true };
        },
      },
      {
        create: { role: ROLES.MEMBER, action: 'post artifact sandpack error' },
      },
      requireAuth
    );
  }

  // ============================================================================
  // Board comments, repos, worktrees hooks
  // ============================================================================

  safeService('board-comments')?.hooks({
    before: {
      all: [typedValidateQuery(boardCommentQueryValidator), ...getReadAuthHooks()],
      create: [requireMinimumRole(ROLES.MEMBER, 'create board comments'), injectCreatedBy()],
      patch: [requireMinimumRole(ROLES.MEMBER, 'update board comments')],
      remove: [requireMinimumRole(ROLES.MEMBER, 'delete board comments')],
    },
  });

  app.service('repos').hooks({
    before: {
      all: [
        typedValidateQuery(repoQueryValidator),
        ...getReadAuthHooks(),
        ...(allowAnonymous ? [] : [requireMinimumRole(ROLES.MEMBER, 'access repositories')]),
      ],
      create: [requireMinimumRole(ROLES.MEMBER, 'create repositories'), requireAdminForEnvConfig()],
      update: [requireMinimumRole(ROLES.MEMBER, 'update repositories'), requireAdminForEnvConfig()],
      patch: [requireMinimumRole(ROLES.MEMBER, 'update repositories'), requireAdminForEnvConfig()],
      remove: [requireMinimumRole(ROLES.MEMBER, 'delete repositories')],
    },
  });

  app.service('worktrees').hooks({
    before: {
      all: [
        typedValidateQuery(worktreeQueryValidator),
        ...getReadAuthHooks(),
        ...(allowAnonymous ? [] : [requireMinimumRole(ROLES.MEMBER, 'access worktrees')]),
      ],
      find: [
        // RBAC: Optimized SQL-based filtering (single query with JOIN, no N+1)
        ...(worktreeRbacEnabled ? [scopeWorktreeQuery(worktreeRepository, superadminOpts)] : []),
      ],
      get: [
        ...(worktreeRbacEnabled
          ? [
              loadWorktree(worktreeRepository),
              ensureCanView(superadminOpts), // Require 'view' permission to read worktree
            ]
          : []),
      ],
      create: [
        requireMinimumRole(ROLES.MEMBER, 'create worktrees'),
        requireAdminForEnvConfig(),
        injectCreatedBy(),
      ],
      update: [requireMinimumRole(ROLES.MEMBER, 'update worktrees'), requireAdminForEnvConfig()],
      patch: [
        requireAdminForEnvConfig(),
        ...(worktreeRbacEnabled
          ? [
              loadWorktree(worktreeRepository),
              ensureWorktreePermission('all', 'update worktrees', superadminOpts), // Require 'all' permission to update
            ]
          : []),
        // Capture previous others_fs_access for comparison in after hook
        ...(worktreeRbacEnabled
          ? [
              async (context: HookContext) => {
                const patchData = context.data as Partial<import('@agor/core/types').Worktree>;
                const params = context.params as AuthenticatedParams & {
                  _skipUnixSync?: boolean;
                  _previousOthersFsAccess?: string;
                };
                if (Object.hasOwn(patchData, 'others_fs_access') && !params._skipUnixSync) {
                  // Fetch current value to compare in after hook
                  const worktree = await context.service.get(context.id);
                  params._previousOthersFsAccess = worktree.others_fs_access;
                }
                return context;
              },
            ]
          : []),
      ],
      remove: [
        ...(worktreeRbacEnabled
          ? [
              loadWorktree(worktreeRepository),
              ensureWorktreePermission('all', 'delete worktrees', superadminOpts), // Require 'all' permission to delete
            ]
          : []),
      ],
    },
    after: {
      create: [
        ...(worktreeRbacEnabled
          ? [
              async (context: HookContext) => {
                // RBAC + Unix Integration: Create Unix group and add initial owner
                const worktree = context.result as import('@agor/core/types').Worktree;
                const creatorId = worktree.created_by;

                // Add creator as initial owner
                await worktreeRepository.addOwner(
                  worktree.worktree_id,
                  creatorId as import('@agor/core/types').UUID
                );
                console.log(
                  `[RBAC] Added creator ${creatorId.substring(0, 8)} as owner of worktree ${worktree.worktree_id.substring(0, 8)}`
                );

                // NOTE: unix.sync-worktree is NOT spawned here to avoid race conditions.
                // git.worktree.add executor handles Unix group creation synchronously.
                // unix.sync-worktree is only used when owners are added/removed AFTER creation.

                return context;
              },
            ]
          : []),
      ],
      patch: [
        ...(worktreeRbacEnabled
          ? [
              async (context: HookContext) => {
                // Unix Integration: Sync worktree permissions when others_fs_access changes
                const params = context.params as AuthenticatedParams & {
                  _skipUnixSync?: boolean;
                  _previousOthersFsAccess?: string;
                };

                // Skip if this is flagged to skip Unix sync
                if (params._skipUnixSync) {
                  return context;
                }

                const patchData = context.data as Partial<import('@agor/core/types').Worktree>;

                // Only proceed if others_fs_access was in the patch data
                if (!Object.hasOwn(patchData, 'others_fs_access')) {
                  return context;
                }

                const worktree = context.result as import('@agor/core/types').Worktree;

                // Check if the value actually changed (avoid unnecessary sync)
                const previousValue = params._previousOthersFsAccess;
                if (previousValue === worktree.others_fs_access) {
                  console.log(
                    `[Unix Integration] Worktree ${worktree.worktree_id.substring(0, 8)} others_fs_access unchanged (${previousValue}), skipping`
                  );
                  return context;
                }

                if (!worktree.path) {
                  console.log(
                    `[Unix Integration] Worktree ${worktree.worktree_id.substring(0, 8)} has no path, skipping permission update`
                  );
                  return context;
                }

                // Fire-and-forget sync to executor
                // The executor will handle permission changes idempotently
                if (jwtSecret) {
                  console.log(
                    `[Unix Integration] Syncing permissions for worktree ${worktree.worktree_id.substring(0, 8)} (others_fs_access: ${previousValue} -> ${worktree.others_fs_access})`
                  );
                  const serviceToken = createServiceToken(jwtSecret);
                  spawnExecutorFireAndForget(
                    {
                      command: 'unix.sync-worktree',
                      sessionToken: serviceToken,
                      daemonUrl: getDaemonUrl(),
                      params: {
                        worktreeId: worktree.worktree_id,
                        daemonUser: config.daemon?.unix_user,
                      },
                    },
                    { logPrefix: '[Executor/worktree.patch]' }
                  );
                }

                return context;
              },
            ]
          : []),
      ],
      remove: [
        ...(worktreeRbacEnabled
          ? [
              async (context: HookContext) => {
                // Unix Integration: Delete Unix group when worktree is deleted
                const worktreeId = context.id as import('@agor/core/types').WorktreeID;

                // Fire-and-forget sync with delete flag to executor
                if (jwtSecret) {
                  const serviceToken = createServiceToken(jwtSecret);
                  spawnExecutorFireAndForget(
                    {
                      command: 'unix.sync-worktree',
                      sessionToken: serviceToken,
                      daemonUrl: getDaemonUrl(),
                      params: {
                        worktreeId,
                        daemonUser: config.daemon?.unix_user,
                        delete: true, // Signal to delete the group instead of syncing
                      },
                    },
                    { logPrefix: '[Executor/worktree.remove]' }
                  );
                }

                return context;
              },
            ]
          : []),
      ],
    },
  });

  // ============================================================================
  // MCP servers hooks (with per-user OAuth token injection)
  // ============================================================================

  // Hook to inject per-user OAuth tokens into MCP server responses
  const injectPerUserOAuthTokens = async (context: HookContext) => {
    // Try multiple sources for user ID:
    // 1. params.user (from socket authentication)
    // 2. query.forUserId (explicitly passed from executor for per-user OAuth)
    const queryForUserId = (context.params?.query as Record<string, unknown>)?.forUserId as
      | string
      | undefined;
    const userId = context.params?.user?.user_id || queryForUserId;
    const source = context.params?.user?.user_id
      ? 'socket-auth'
      : queryForUserId
        ? 'query-param'
        : 'none';
    console.log(
      `[MCP OAuth] injectPerUserOAuthTokens called - userId: ${userId || 'NONE'}, ` +
        `source: ${source}, provider: ${context.params?.provider || 'internal'}, ` +
        `method: ${context.method}, resultCount: ${Array.isArray(context.result) ? context.result.length : 1}`
    );
    if (!userId) {
      console.log('[MCP OAuth] No user ID - skipping token injection');
      return context;
    }

    const injectToken = async (server: MCPServer) => {
      if (server.auth?.type !== 'oauth') {
        return server;
      }

      // Tokens for both modes live in user_mcp_oauth_tokens:
      //   - per_user  → row keyed by (userId, serverId)
      //   - shared    → row keyed by (NULL, serverId)
      const mode = server.auth.oauth_mode ?? 'per_user';
      const tokenUserId: import('@agor/core/types').UserID | null =
        mode === 'per_user' ? (userId as import('@agor/core/types').UserID) : null;

      try {
        const userTokenRepo = new UserMCPOAuthTokenRepository(db);
        const row = await userTokenRepo.getToken(tokenUserId, server.mcp_server_id);

        if (!row) {
          console.log(
            `[MCP OAuth] No token row for user=${tokenUserId ?? '<shared>'} server=${server.name}`
          );
          return server;
        }

        // JIT refresh — see `refreshAndPersistToken` for mutexing + invalid_grant cleanup.
        let accessToken = row.oauth_access_token;
        let expiresAt = row.oauth_token_expires_at;
        const { needsRefresh, refreshAndPersistToken, InvalidGrantError } = await import(
          '@agor/core/tools/mcp/oauth-refresh'
        );
        if (needsRefresh(row.oauth_token_expires_at) && row.oauth_refresh_token) {
          console.log(`[MCP OAuth] Token near/past expiry for ${server.name} — refreshing`);
          try {
            accessToken = await refreshAndPersistToken({
              db,
              userId: tokenUserId,
              mcpServerId: server.mcp_server_id,
            });
            // Re-read to pick up the rotated expiry for the UI.
            const fresh = await userTokenRepo.getToken(tokenUserId, server.mcp_server_id);
            if (fresh) expiresAt = fresh.oauth_token_expires_at;
          } catch (refreshErr) {
            if (refreshErr instanceof InvalidGrantError) {
              console.warn(
                `[MCP OAuth] invalid_grant refreshing ${server.name} — user must re-auth`
              );
              return server;
            }
            // Transient error: fall through with the stale access_token. The
            // MCP call may still succeed or fail cleanly at the transport.
            console.warn(
              `[MCP OAuth] Refresh failed for ${server.name} (using stale token):`,
              refreshErr instanceof Error ? refreshErr.message : refreshErr
            );
          }
        }

        return {
          ...server,
          auth: {
            ...server.auth,
            oauth_access_token: accessToken,
            // Surface expiry so the UI can render "expires in X" tooltips.
            // Stored as Date in the repo, emitted as ms epoch to match MCPAuth.
            oauth_token_expires_at:
              expiresAt instanceof Date ? expiresAt.getTime() : (expiresAt ?? undefined),
          },
        };
      } catch (error) {
        console.warn(
          `[MCP OAuth] Failed to resolve OAuth token for ${server.name}:`,
          error instanceof Error ? error.message : error
        );
      }

      return server;
    };

    // Handle both single result and array/paginated results
    if (Array.isArray(context.result)) {
      context.result = await Promise.all(context.result.map(injectToken));
    } else if (context.result?.data && Array.isArray(context.result.data)) {
      context.result.data = await Promise.all(context.result.data.map(injectToken));
    } else if (context.result?.mcp_server_id) {
      context.result = await injectToken(context.result);
    }

    return context;
  };

  // NOTE: mcp-servers is global admin-managed configuration. These rows are
  // not worktree- or session-scoped, so no RBAC find() scoping is applied.
  // Creation/update/removal remain gated by requireMinimumRole(ADMIN).
  safeService('mcp-servers')?.hooks({
    before: {
      all: [typedValidateQuery(mcpServerQueryValidator), ...getReadAuthHooks()],
      create: [requireMinimumRole(ROLES.ADMIN, 'create MCP servers')],
      patch: [requireMinimumRole(ROLES.ADMIN, 'update MCP servers')],
      remove: [requireMinimumRole(ROLES.ADMIN, 'delete MCP servers')],
    },
    after: {
      find: [injectPerUserOAuthTokens],
      get: [injectPerUserOAuthTokens],
    },
  });

  safeService('session-mcp-servers')?.hooks({
    before: {
      all: [requireAuth],
      find: [
        requireMinimumRole(ROLES.MEMBER, 'list session MCP servers'),
        // RBAC: Scope to sessions the caller can access.
        ...(worktreeRbacEnabled
          ? [scopeFindToAccessibleSessions(sessionsRepository, superadminOpts)]
          : []),
      ],
    },
    after: {
      find: [injectPerUserOAuthTokens],
    },
  });

  // Top-level `/session-env-selections` exists mainly to surface WebSocket
  // events emitted by the `/sessions/:id/env-selections` route handlers. Its
  // `find()` must still be gated — without these hooks any authenticated
  // member could read selection metadata for sessions they can't access,
  // bypassing the creator/admin gate on the nested route. Mirror the
  // `/session-mcp-servers` pattern exactly so the two stay consistent.
  safeService('session-env-selections')?.hooks({
    before: {
      all: [requireAuth],
      find: [
        requireMinimumRole(ROLES.MEMBER, 'list session env selections'),
        // RBAC: Scope to sessions the caller can access.
        ...(worktreeRbacEnabled
          ? [scopeFindToAccessibleSessions(sessionsRepository, superadminOpts)]
          : []),
      ],
    },
  });

  // ============================================================================
  // Gateway channels hooks
  // ============================================================================

  // Refresh the gateway's in-memory channel state when channels are mutated.
  // This allows routeMessage() to skip DB lookups entirely when no channels exist.
  // Also starts/stops Socket Mode listeners for created/updated/deleted channels.
  const refreshGatewayChannelState = async (context: HookContext) => {
    const gw = context.app.service('gateway') as unknown as GatewayService;

    // Refresh the hasActiveChannels flag
    gw.refreshChannelState().catch((err: unknown) =>
      console.warn('[gateway] Failed to refresh channel state:', err)
    );

    // Start/stop listener for created/updated channel
    const channel = context.result as { id: string } | undefined;
    if (channel?.id) {
      gw.startListenerForChannel(channel.id).catch((err: unknown) =>
        console.warn(`[gateway] Failed to manage listener for channel ${channel.id}:`, err)
      );
    }

    return context;
  };

  // Stop listener when channel is deleted
  const stopGatewayChannelListener = async (context: HookContext) => {
    const gw = context.app.service('gateway') as unknown as GatewayService;

    // Stop listener for deleted channel (use id from route params)
    const channelId = context.id as string | undefined;
    if (channelId) {
      gw.stopChannelListener(channelId).catch((err: unknown) =>
        console.warn(`[gateway] Failed to stop listener for channel ${channelId}:`, err)
      );
    }

    return context;
  };

  safeService('gateway-channels')?.hooks({
    before: {
      all: [requireAuth],
      create: [
        requireMinimumRole(ROLES.ADMIN, 'create gateway channels'),
        // Encrypt env var values at rest (same pattern as user env vars / API keys)
        async (context: HookContext) => {
          const data = context.data as Record<string, unknown> | undefined;
          const ac = data?.agentic_config as Record<string, unknown> | undefined;
          if (!ac || !Array.isArray(ac.envVars)) return context;
          const { encryptApiKey } = await import('@agor/core/db');
          ac.envVars = (ac.envVars as { key: string; value: string; forceOverride: boolean }[]).map(
            (v) => ({
              ...v,
              value: v.value ? encryptApiKey(v.value) : v.value,
            })
          );
          return context;
        },
      ],
      patch: [
        requireMinimumRole(ROLES.ADMIN, 'update gateway channels'),
        // Resolve redacted env var sentinel values ('••••••••') back to real
        // values from the database. Uses the repository directly to bypass
        // the after-hook redaction that the service layer applies.
        //
        // Semantics:
        // - envVars omitted (undefined) → preserve all existing env vars
        // - envVars = [] (empty array) → explicitly delete all env vars
        // - envVars = [...] with sentinels → substitute real values per key
        async (context: HookContext) => {
          const data = context.data as Record<string, unknown> | undefined;
          if (!data || !context.id) return context;

          let ac = data.agentic_config as Record<string, unknown> | undefined;
          const hadAgenticConfigInPatch = ac !== undefined;
          const ensureAc = (): Record<string, unknown> => {
            if (!ac) {
              ac = {};
              data.agentic_config = ac;
            }
            return ac;
          };

          const SENTINEL = '••••••••';
          const incomingVars = ac?.envVars as
            | { key: string; value: string; forceOverride: boolean }[]
            | undefined;

          // undefined → preserve existing env vars
          if (incomingVars === undefined) {
            try {
              const { GatewayChannelRepository } = await import('@agor/core/db');
              const channelRepo = new GatewayChannelRepository(db);
              const existing = await channelRepo.findById(String(context.id));
              // For patches that omit agentic_config entirely (e.g. enabled toggle),
              // copy existing agentic_config so migration still occurs on save.
              if (!hadAgenticConfigInPatch && existing?.agentic_config) {
                ac = { ...(existing.agentic_config as unknown as Record<string, unknown>) };
                data.agentic_config = ac;
              }
              if (existing?.agentic_config?.envVars) {
                ensureAc().envVars = existing.agentic_config.envVars;
              }
            } catch {
              // Non-fatal
            }
            return context;
          }

          // [] → explicit delete all (no substitution needed)
          if (incomingVars.length === 0) return context;

          // Has entries with potential sentinels — substitute from DB
          const hasSentinels = incomingVars.some((v) => v.value === SENTINEL);
          if (!hasSentinels) {
            ensureAc().envVars = incomingVars;
            return context;
          }

          try {
            const { GatewayChannelRepository } = await import('@agor/core/db');
            const channelRepo = new GatewayChannelRepository(db);
            const existing = await channelRepo.findById(String(context.id));
            const existingVars = existing?.agentic_config?.envVars ?? [];
            const existingByKey = new Map(existingVars.map((v) => [v.key, v.value]));

            // Substitute sentinels with existing values. Encryption-at-rest is
            // handled in GatewayChannelRepository.
            ensureAc().envVars = incomingVars.map((v) => {
              if (v.value === SENTINEL && existingByKey.has(v.key)) {
                return { ...v, value: existingByKey.get(v.key)! };
              }
              return v;
            });
          } catch (error) {
            throw new BadRequest(
              `Failed to resolve redacted gateway env vars: ${error instanceof Error ? error.message : String(error)}`
            );
          }

          return context;
        },
      ],
      remove: [requireMinimumRole(ROLES.ADMIN, 'delete gateway channels')],
    },
    after: {
      all: [
        // Redact sensitive config fields in API responses
        async (context: HookContext) => {
          const redact = (channel: Record<string, unknown>) => {
            if (channel?.config && typeof channel.config === 'object') {
              const config = { ...(channel.config as Record<string, unknown>) };
              for (const field of [
                'bot_token',
                'app_token',
                'signing_secret',
                'private_key',
                'webhook_secret',
              ]) {
                if (config[field]) {
                  config[field] = '••••••••';
                }
              }
              channel.config = config;
            }
            // Redact env var values in agentic_config (keep keys and forceOverride visible)
            if (channel?.agentic_config && typeof channel.agentic_config === 'object') {
              const ac = channel.agentic_config as Record<string, unknown>;
              if (Array.isArray(ac.envVars)) {
                ac.envVars = (
                  ac.envVars as { key: string; value: string; forceOverride: boolean }[]
                ).map((v) => ({ key: v.key, value: '••••••••', forceOverride: v.forceOverride }));
              }
            }
          };
          if (Array.isArray(context.result?.data)) {
            for (const item of context.result.data) redact(item);
          } else if (context.result) {
            redact(context.result as Record<string, unknown>);
          }
          return context;
        },
      ],
      create: [refreshGatewayChannelState],
      patch: [refreshGatewayChannelState],
      remove: [stopGatewayChannelListener, refreshGatewayChannelState],
    },
  });

  // ============================================================================
  // Thread session map, config, context, files, terminals hooks
  // ============================================================================

  safeService('thread-session-map')?.hooks({
    before: {
      all: [requireAuth],
    },
  });

  // Gateway service create (postMessage) authenticates via channel_key, not user auth
  // No hooks needed — auth is handled internally by the service

  app.service('config').hooks({
    before: {
      all: [requireAuth],
      find: [requireMinimumRole(ROLES.ADMIN, 'view configuration')],
      get: [requireMinimumRole(ROLES.ADMIN, 'view configuration')],
      patch: [requireMinimumRole(ROLES.ADMIN, 'update configuration')],
    },
  });

  safeService('context')?.hooks({
    before: {
      all: [requireAuth],
    },
  });

  safeService('files')?.hooks({
    before: {
      all: [
        requireAuth,
        requireMinimumRole(ROLES.MEMBER, 'search files'),
        // RBAC: files service takes a sessionId query param and returns files
        // from that session's worktree. Verify the caller can at least 'view'
        // that worktree before running git ls-files. If sessionId is missing
        // the service itself returns []; we skip the permission check in that
        // case rather than throwing.
        ...(worktreeRbacEnabled
          ? [
              async (context: HookContext) => {
                if (!context.params.provider) return context;
                if (context.params.user?._isServiceAccount) return context;
                const query = context.params.query as { sessionId?: string } | undefined;
                const sessionId = query?.sessionId;
                if (!sessionId) return context;
                context.params.sessionId = sessionId;
                // Delegate to the existing chain now that sessionId is primed.
                await loadSession(sessionsService)(context);
                await loadWorktreeFromSession(worktreeRepository)(context);
                await ensureCanView(superadminOpts)(context);
                return context;
              },
            ]
          : []),
      ],
    },
  });

  // /file (singular): read-only worktree filesystem browser. Takes worktree_id
  // as a query param. Gate with worktree RBAC 'view' permission when enabled.
  safeService('/file')?.hooks({
    before: {
      all: [
        requireAuth,
        requireMinimumRole(ROLES.MEMBER, 'read files'),
        ...(worktreeRbacEnabled
          ? [loadWorktree(worktreeRepository, 'worktree_id'), ensureCanView(superadminOpts)]
          : []),
      ],
    },
  });

  // Terminal access gate:
  // - `execution.allow_web_terminal` defaults to true. Any authenticated user
  //   with role `member` or higher may open a terminal. Worktree-level RBAC
  //   still applies inside the service (see services/terminals.ts).
  // - Setting the flag to false disables the terminal for everyone (including
  //   admins). The modal is hidden from the UI in that case.
  const webTerminalEnabled = config.execution?.allow_web_terminal !== false;
  safeService('terminals')?.hooks({
    before: {
      all: [
        requireAuth,
        (context: HookContext) => {
          if (!webTerminalEnabled) {
            throw new Forbidden(
              'Web terminal is disabled on this instance. Ask an administrator to unset or enable execution.allow_web_terminal in the daemon config.'
            );
          }
          return context;
        },
        requireMinimumRole(ROLES.MEMBER, 'access terminals'),
      ],
    },
  });

  // ============================================================================
  // Users hooks
  // ============================================================================

  app.service('users').hooks({
    before: {
      all: [typedValidateQuery(userQueryValidator)],
      find: [
        (context) => {
          const params = context.params as AuthenticatedParams;

          if (!params.provider) {
            return context;
          }

          if (params.user) {
            ensureMinimumRole(params, ROLES.MEMBER, 'list users');
            return context;
          }

          const query = params.query || {};
          if (query.email) {
            // Allow local authentication lookup, ensure we only return minimal results
            params.query = { ...query, $limit: 1 };
            return context;
          }

          throw new NotAuthenticated('Authentication required');
        },
      ],
      get: [
        (context) => {
          ensureMinimumRole(context.params as AuthenticatedParams, ROLES.MEMBER, 'view users');
          return context;
        },
      ],
      create: [
        async (context: HookContext<Board>) => {
          const params = context.params as AuthenticatedParams;

          if (!params.provider) {
            return context;
          }

          const existing = (await usersService.find({ query: { $limit: 1 } })) as Paginated<User>;
          if (existing.total > 0) {
            ensureMinimumRole(params, ROLES.ADMIN, 'create users');
          }

          // Only superadmins can create superadmin users
          // Guard both 'superadmin' and legacy 'owner' to prevent bypass
          // Cast to include 'owner' for legacy client compatibility (UserRole excludes 'owner')
          const data = context.data as Partial<Omit<User, 'role'> & { role?: string }>;
          if (hasMinimumRole(data?.role, ROLES.SUPERADMIN)) {
            const callerRole = params.user?.role;
            if (!hasMinimumRole(callerRole, ROLES.SUPERADMIN)) {
              throw new Forbidden('Only superadmins can create superadmin users');
            }
          }

          return context;
        },
      ],
      patch: [
        async (context) => {
          const params = context.params as AuthenticatedParams;
          const userId = context.id as string;
          const callerRole = params.user?.role;
          const callerIsAdmin = hasMinimumRole(callerRole, ROLES.ADMIN);

          // Field-level restrictions: only admins can modify unix_username, role, and must_change_password
          if (!Array.isArray(context.data)) {
            if (context.data?.unix_username !== undefined) {
              if (!callerIsAdmin) {
                throw new Forbidden('Only admins can modify unix_username');
              }
            }
            if (context.data?.role !== undefined) {
              if (!callerIsAdmin) {
                throw new Forbidden('Only admins can modify user roles');
              }
              // Only superadmins can assign the superadmin role
              // Guard both 'superadmin' and legacy 'owner' to prevent bypass
              if (
                hasMinimumRole(context.data.role, ROLES.SUPERADMIN) &&
                !hasMinimumRole(callerRole, ROLES.SUPERADMIN)
              ) {
                // Bootstrap: allow first superadmin promotion if none exist yet
                // Note: usersService.find() doesn't filter by role, so filter in JS
                const allUsers = (await usersService.find({})) as Paginated<User>;
                const hasSuperadmin = allUsers.data.some((u) => u.role === ROLES.SUPERADMIN);
                if (hasSuperadmin) {
                  throw new Forbidden('Only superadmins can assign the superadmin role');
                }
              }
            }
            if (context.data?.must_change_password !== undefined) {
              if (!callerIsAdmin) {
                throw new Forbidden('Only admins can force password changes');
              }
            }
          }

          // General authorization: admins can patch any user
          if (callerIsAdmin) {
            return context;
          }

          // Any authenticated user can update their own profile (except unix_username and role, checked above)
          if (params.user && params.user.user_id === userId) {
            return context;
          }

          // Otherwise forbidden
          throw new Forbidden('You can only update your own profile');
        },
      ],
      remove: [requireMinimumRole(ROLES.ADMIN, 'delete users')],
    },
    after: {
      // After user create/patch: optionally ensure Unix user exists and sync password
      create: [
        async (context: HookContext) => {
          // Need JWT secret for service tokens (required by executor)
          if (!jwtSecret) {
            return context;
          }

          const user = context.result as User;
          if (!user.unix_username) {
            return context; // No unix_username set, skip Unix operations
          }

          // Get plaintext password from request data (for password sync)
          const data = context.data as { password?: string };

          // Respect sync_unix_passwords config (defaults to true)
          // When false, skip all Unix sync operations (user creation, groups, password)
          const shouldSync = config.execution?.sync_unix_passwords ?? true;

          if (!shouldSync) {
            return context;
          }

          // Fire-and-forget sync to executor
          console.log(`[Unix Integration] Syncing Unix user for: ${user.unix_username}`);
          const serviceToken = createServiceToken(jwtSecret);
          spawnExecutorFireAndForget(
            {
              command: 'unix.sync-user',
              sessionToken: serviceToken,
              daemonUrl: getDaemonUrl(),
              params: {
                userId: user.user_id,
                password: data?.password, // Pass through for password sync
                configureGitSafeDirectory: isUnixImpersonationEnabled(), // Configure git when impersonating
              },
            },
            { logPrefix: '[Executor/user.create]' }
          );

          return context;
        },
      ],
      patch: [
        async (context: HookContext) => {
          // Need JWT secret for service tokens (required by executor)
          if (!jwtSecret) {
            return context;
          }

          const data = context.data as { unix_username?: string; password?: string };
          const user = context.result as User;

          // Only sync if unix_username or password changed
          if (!data?.unix_username && !data?.password) {
            return context;
          }

          // Skip if user doesn't have unix_username (would fail in executor anyway)
          if (!user.unix_username) {
            return context;
          }

          // Respect sync_unix_passwords config (defaults to true)
          // When false, skip all Unix sync operations (user creation, groups, password)
          const shouldSync = config.execution?.sync_unix_passwords ?? true;

          if (!shouldSync) {
            return context;
          }

          // Fire-and-forget sync to executor
          console.log(`[Unix Integration] Syncing Unix user for: ${user.unix_username}`);
          const serviceToken = createServiceToken(jwtSecret);
          spawnExecutorFireAndForget(
            {
              command: 'unix.sync-user',
              sessionToken: serviceToken,
              daemonUrl: getDaemonUrl(),
              params: {
                userId: user.user_id,
                password: data?.password, // Pass through for password sync
                configureGitSafeDirectory: isUnixImpersonationEnabled(), // Configure git when impersonating
              },
            },
            { logPrefix: '[Executor/user.patch]' }
          );

          return context;
        },
      ],
    },
  });

  // ============================================================================
  // Publish service events
  // ============================================================================

  // Publish service events to authenticated clients only
  // SECURITY: Only connections in 'authenticated' channel (joined on login) receive events
  // This prevents unauthenticated sockets from receiving sensitive data
  app.publish((data, context) => {
    // Skip logging for streaming events (too verbose) and internal events without path/method
    const isStreamingEvent =
      context.path === 'messages/streaming' ||
      (context.path === 'messages' && context.event?.startsWith('streaming:'));
    if (context.path && context.method && !isStreamingEvent) {
      console.log(
        `📡 [Publish] ${context.path} ${context.method}`,
        context.id
          ? `id: ${typeof context.id === 'string' ? context.id.substring(0, 8) : context.id}`
          : '',
        `channels: ${app.channel('authenticated').length}`
      );
    }
    // Broadcast only to authenticated clients (joined to channel on login)
    return app.channel('authenticated');
  });

  // ============================================================================
  // Sessions hooks
  // ============================================================================

  app.service('sessions').hooks({
    before: {
      all: [typedValidateQuery(sessionQueryValidator), ...getReadAuthHooks()],
      find: [
        // RBAC: Optimized SQL-based filtering (single query with JOIN on worktrees, no N+1)
        ...(worktreeRbacEnabled ? [scopeSessionQuery(sessionsRepository, superadminOpts)] : []),
      ],
      get: [
        ...(worktreeRbacEnabled
          ? [
              // Load session's worktree and check permissions
              loadSessionWorktree(sessionsService, worktreeRepository),
              ensureCanView(superadminOpts), // Require 'view' permission on worktree
            ]
          : []),
      ],
      create: [
        requireMinimumRole(ROLES.MEMBER, 'create sessions'),
        ...(worktreeRbacEnabled
          ? [
              setSessionUnixUsername(usersRepository), // Stamp session with creator's unix_username (MUST run first)
              // Check worktree permission BEFORE injecting created_by (need worktree_id)
              async (context: HookContext) => {
                // RBAC: Ensure user can create sessions in this worktree ('all' permission)
                const data = context.data as Partial<Session>;
                if (context.params.provider && data?.worktree_id) {
                  try {
                    const worktree = await worktreeRepository.findById(data.worktree_id);
                    if (!worktree) {
                      throw new Forbidden(`Worktree not found: ${data.worktree_id}`);
                    }
                    const userId = context.params.user?.user_id as
                      | import('@agor/core/types').UUID
                      | undefined;
                    const isOwner = userId
                      ? await worktreeRepository.isOwner(worktree.worktree_id, userId)
                      : false;

                    // Cache for later hooks (RBACParams fields)
                    context.params.worktree = worktree;
                    context.params.isWorktreeOwner = isOwner;
                  } catch (error) {
                    console.error('Failed to load worktree for RBAC check:', error);
                    throw error;
                  }
                }
                return context;
              },
              ensureCanCreateSession(superadminOpts), // Require 'all' permission to create sessions
            ]
          : []),
        injectCreatedBy(),
        async (context) => {
          // Populate repo field and auto-populate git_state from worktree_id
          if (!Array.isArray(context.data) && context.data?.worktree_id) {
            try {
              const worktree = await context.app.service('worktrees').get(context.data.worktree_id);
              if (worktree) {
                const repo = await context.app.service('repos').get(worktree.repo_id);
                if (repo) {
                  (context.data as Record<string, unknown>).repo = {
                    repo_id: repo.repo_id,
                    repo_slug: repo.slug,
                    worktree_name: worktree.name,
                    cwd: worktree.path,
                    managed_worktree: true,
                  };
                  console.log(`✅ Populated repo.cwd from worktree: ${worktree.path}`);
                }

                // Auto-populate git_state if not provided (UI and gateway don't set it)
                // IMPORTANT: Must use sudo -u to get fresh Unix group memberships
                // because the daemon process has stale groups from startup.
                // Without fresh groups, git can't read ACL-protected repo files.
                const existingGitState = (context.data as Record<string, unknown>).git_state as
                  | { base_sha?: string }
                  | undefined;
                if (!existingGitState?.base_sha && worktree.path) {
                  try {
                    const { captureGitStateViaShell } = await import(
                      './utils/git-shell-capture.js'
                    );
                    const gitState = await captureGitStateViaShell(worktree.path);
                    (context.data as Record<string, unknown>).git_state = {
                      ref: gitState.ref || worktree.name || 'unknown',
                      base_sha: gitState.sha,
                      current_sha: gitState.sha,
                    };
                    console.log(
                      `✅ Auto-populated git_state from worktree: ref=${gitState.ref}, sha=${gitState.sha.substring(0, 8)}`
                    );
                  } catch (gitError) {
                    console.warn('Failed to auto-populate git_state from worktree:', gitError);
                  }
                }
              }
            } catch (error) {
              console.error('Failed to populate repo from worktree:', error);
            }
          }

          // Validate user has prompt permission on callback target session's worktree
          const cbConfig = (context.data as Record<string, unknown> | undefined)?.callback_config as
            | { callback_session_id?: string }
            | undefined;
          if (cbConfig?.callback_session_id) {
            // Use authenticated user, NOT context.data.created_by (which could be client-supplied)
            const authenticatedUserId =
              (context.params as { user?: { user_id: string } }).user?.user_id || 'anonymous';
            await ensureCanPromptTargetSession(
              cbConfig.callback_session_id,
              authenticatedUserId,
              context.app,
              worktreeRepository
            );
          }

          return context;
        },
      ],
      patch: [
        ...(worktreeRbacEnabled
          ? [
              ensureSessionImmutability(), // Prevent changing session.created_by and unix_username
              resolveSessionContext(),
              loadSession(sessionsService),
              loadWorktreeFromSession(worktreeRepository),
              // Branch permission by patch type:
              //   - Prompt-flow patches (tasks, archived, status, …) are bookkeeping
              //     emitted by /sessions/:id/prompt and /sessions/:id/stop on behalf
              //     of the authenticated user. They need only the same tier as
              //     prompting the session (session-tier for own, prompt-tier for
              //     others), matching the permission table in CLAUDE.md.
              //   - Everything else is session metadata and still requires 'all'.
              // Mixed-field patches fail isPromptFlowPatchOnly and fall through to
              // the strict 'all' path, so there's no partial-trust footgun.
              (context: HookContext) => {
                if (isPromptFlowPatchOnly(context.data)) {
                  return ensureCanPromptInSession(superadminOpts)(context);
                }
                return ensureWorktreePermission(
                  'all',
                  'update session metadata',
                  superadminOpts
                )(context);
              },
            ]
          : []),
        // Validate user has prompt permission on callback target session's worktree
        async (context) => {
          const patchCbConfig = (context.data as Record<string, unknown> | undefined)
            ?.callback_config as { callback_session_id?: string } | undefined;
          if (patchCbConfig?.callback_session_id) {
            const userId =
              (context.params as { user?: { user_id: string } }).user?.user_id || 'anonymous';
            await ensureCanPromptTargetSession(
              patchCbConfig.callback_session_id,
              userId,
              context.app,
              worktreeRepository
            );
          }
          return context;
        },
      ],
      remove: [
        ...(worktreeRbacEnabled
          ? [
              resolveSessionContext(),
              loadSession(sessionsService),
              loadWorktreeFromSession(worktreeRepository),
              ensureWorktreePermission('all', 'delete sessions', superadminOpts), // Require 'all' permission
            ]
          : []),
      ],
    },
    after: {
      get: [
        async (context) => {
          // Regenerate MCP token for fetched session (deterministic, no DB storage)
          if (config.daemon?.mcpEnabled === false) {
            return context;
          }

          const session = context.result as Session;
          const callerUser = (context.params as AuthenticatedParams).user;

          // Rationale for the narrow gate lives on canReceiveMcpTokenForSession.
          if (
            !canReceiveMcpTokenForSession({
              callerUserId: callerUser?.user_id,
              callerRole: callerUser?.role,
              sessionCreatedBy: session.created_by,
            })
          ) {
            return context;
          }

          const { generateSessionToken } = await import('./mcp/tokens.js');
          const userId = session.created_by || 'anonymous';

          const jwtSecret = app.settings.authentication?.secret;
          if (!jwtSecret) {
            console.error('❌ JWT secret not configured - cannot generate MCP token');
            return context;
          }

          const mcpToken = await generateSessionToken(
            app,
            session.session_id,
            userId as import('@agor/core/types').UserID
          );

          console.log(`🔄 Regenerated MCP token for session ${session.session_id.substring(0, 8)}`);

          // Add token to result (not stored in DB, regenerated on-demand with
          // a fresh `jti` and `exp`)
          context.result = { ...session, mcp_token: mcpToken };

          return context;
        },
      ],
      create: [
        async (context) => {
          // Skip MCP setup if MCP server is disabled
          if (config.daemon?.mcpEnabled === false) {
            return context;
          }

          // Gate MCP token issuance on member+ role (see `after: get` note).
          const callerRole = (context.params as AuthenticatedParams).user?.role;
          if (!hasMinimumRole(callerRole, ROLES.MEMBER)) {
            return context;
          }

          // Mint MCP token for this session (jti + exp + gen embedded)
          const { generateSessionToken } = await import('./mcp/tokens.js');
          const session = context.result as Session;
          const userId = session.created_by || 'anonymous';

          // Get JWT secret from app settings
          const jwtSecret = app.settings.authentication?.secret;
          if (!jwtSecret) {
            console.error('❌ JWT secret not configured - cannot generate MCP token');
            return context;
          }

          const mcpToken = await generateSessionToken(
            app,
            session.session_id,
            userId as import('@agor/core/types').UserID
          );

          console.log(`🎫 MCP token issued for session ${session.session_id.substring(0, 8)}`);

          // Note: We no longer auto-attach global MCP servers to sessions.
          // Instead, getMcpServersForSession() will automatically provide ALL
          // global servers plus any session-specific servers assigned to this
          // session. This avoids polluting the session_mcp_servers junction table.

          // Update context.result to include the token
          context.result = { ...session, mcp_token: mcpToken };

          return context;
        },
        // TODO: OpenCode session creation moved to executor - implement via IPC if needed

        // Unix Integration: When a non-owner creates a session in a worktree with
        // others_fs_access != 'none', ensure they're added to the worktree and repo
        // unix groups. Without this, non-owners can't access the .git/ directory
        // (which uses 2770 = no others access) even if the worktree directory itself
        // allows "others" access via ACLs.
        ...(worktreeRbacEnabled
          ? [
              async (context: HookContext) => {
                const session = context.result as Session;

                // Only for sessions with a worktree and unix_username
                if (!session.worktree_id || !session.unix_username) {
                  return context;
                }

                // Check if user is NOT an owner (owners are already handled by sync)
                const isOwner = context.params?.isWorktreeOwner;
                if (isOwner) {
                  return context;
                }

                // Load worktree to check others_fs_access
                try {
                  const worktree = await worktreeRepository.findById(session.worktree_id);
                  if (
                    !worktree ||
                    !worktree.others_fs_access ||
                    worktree.others_fs_access === 'none'
                  ) {
                    return context;
                  }

                  // Fire-and-forget: trigger unix.sync-worktree to add session user to groups
                  if (jwtSecret) {
                    console.log(
                      `[Unix Integration] Non-owner session created in worktree ${session.worktree_id.substring(0, 8)} ` +
                        `by ${session.unix_username} (others_fs_access: ${worktree.others_fs_access}), syncing group membership`
                    );
                    const serviceToken = createServiceToken(jwtSecret);
                    spawnExecutorFireAndForget(
                      {
                        command: 'unix.sync-worktree',
                        sessionToken: serviceToken,
                        daemonUrl: getDaemonUrl(),
                        params: {
                          worktreeId: session.worktree_id,
                          daemonUser: config.daemon?.unix_user,
                        },
                      },
                      { logPrefix: '[Executor/session.create.unix-group]' }
                    );
                  }
                } catch (error) {
                  // Don't fail session creation if unix sync fails
                  console.error(
                    `[Unix Integration] Failed to trigger group sync for session ${session.session_id.substring(0, 8)}:`,
                    error
                  );
                }

                return context;
              },
            ]
          : []),
      ],
      patch: [
        async (context) => {
          // Automatically process queued tasks when session becomes IDLE
          // This ensures queued tasks are processed regardless of how the session became IDLE
          const session = Array.isArray(context.result) ? context.result[0] : context.result;

          if (session && session.status === 'idle') {
            // Flush GitHub message buffer (fire-and-forget).
            // When a GitHub-connected session finishes its turn, post the last
            // buffered message as a PR/issue comment. Must happen before queue
            // processing so the response is posted before the next prompt starts.
            setImmediate(async () => {
              try {
                const gatewayService = context.app.service('gateway') as unknown as GatewayService;
                await gatewayService.flushGitHubBuffer(session.session_id);
              } catch (error) {
                console.warn(
                  `[gateway] Failed to flush GitHub buffer for session ${session.session_id.substring(0, 8)}:`,
                  error
                );
              }
            });

            if (session.ready_for_prompt) {
              // Use setImmediate to avoid blocking the patch response
              setImmediate(async () => {
                try {
                  console.log(
                    `🔄 [SessionsService.after.patch] Session ${session.session_id.substring(0, 8)} became IDLE, checking for queued tasks...`
                  );

                  await sessionsService.triggerQueueProcessing(session.session_id, context.params);
                } catch (error) {
                  console.error(
                    `❌ [SessionsService.after.patch] Failed to process queue for session ${session.session_id.substring(0, 8)}:`,
                    error
                  );
                  // Don't throw - queue processing failure shouldn't break session patches
                }
              });
            }
          }

          return context;
        },
      ],
    },
  });

  // ============================================================================
  // Leaderboard hooks
  // ============================================================================

  if (svcEnabled('leaderboard')) {
    app.service('leaderboard').hooks({
      before: {
        all: [...getReadAuthHooks()],
      },
    });
  }

  // ============================================================================
  // Tasks hooks
  // ============================================================================

  app.service('tasks').hooks({
    before: {
      all: [typedValidateQuery(taskQueryValidator), requireAuth],
      find: [
        // RBAC: Scope tasks.find() to sessions the caller can access.
        ...(worktreeRbacEnabled
          ? [scopeFindToAccessibleSessions(sessionsRepository, superadminOpts)]
          : []),
      ],
      get: [
        ...(worktreeRbacEnabled
          ? [
              resolveSessionContext(),
              loadSession(sessionsService),
              loadWorktreeFromSession(worktreeRepository),
              ensureCanView(superadminOpts), // Require 'view' permission
            ]
          : []),
      ],
      create: [
        requireMinimumRole(ROLES.MEMBER, 'create tasks'),
        ...(worktreeRbacEnabled
          ? [
              resolveSessionContext(),
              loadSession(sessionsService),
              validateSessionUnixUsername(usersRepository), // Defensive check: session.unix_username must match creator's current unix_username
              loadWorktreeFromSession(worktreeRepository),
              ensureCanPromptInSession(superadminOpts), // Require 'prompt' (or 'session' for own sessions)
            ]
          : []),
        injectCreatedBy(),
      ],
      patch: [
        ...(worktreeRbacEnabled
          ? [
              resolveSessionContext(),
              loadSession(sessionsService),
              loadWorktreeFromSession(worktreeRepository),
              ensureCanPromptInSession(superadminOpts), // Require 'prompt' (or 'session' for own sessions)
            ]
          : []),
      ],
      remove: [
        requireMinimumRole(ROLES.MEMBER, 'delete tasks'),
        // RBAC: deleting a task requires 'all' permission on the worktree
        // (mirrors sessions.remove). Without this, any member with 'session'
        // access could delete tasks owned by other users on shared worktrees.
        ...(worktreeRbacEnabled
          ? [
              resolveSessionContext(),
              loadSession(sessionsService),
              loadWorktreeFromSession(worktreeRepository),
              ensureWorktreePermission('all', 'delete tasks', superadminOpts),
            ]
          : []),
      ],
    },
  });

  // ============================================================================
  // Boards hooks
  // ============================================================================

  // BoardRepository for RBAC find-scope hook (single instance reused across
  // requests). Cheap to construct — just wraps the shared db handle.
  const boardRepository = new BoardRepository(db);

  safeService('boards')?.hooks({
    before: {
      all: [typedValidateQuery(boardQueryValidator), ...getReadAuthHooks()],
      find: [
        // RBAC: restrict boards.find to boards the caller created or has a
        // worktree on. Runs at the SQL layer via BoardRepository.findVisibleBoardIds
        // to avoid hydrating every accessible worktree in-memory.
        ...(worktreeRbacEnabled
          ? [scopeFindToAccessibleBoards(boardRepository, superadminOpts)]
          : []),
      ],
      create: [requireMinimumRole(ROLES.MEMBER, 'create boards'), injectCreatedBy()],
      patch: [
        requireMinimumRole(ROLES.MEMBER, 'update boards'),
        async (context: HookContext<Board>) => {
          // Handle atomic board object operations via _action parameter
          const contextData = context.data || {};
          const { _action, objectId, objectData, objects, deleteAssociatedSessions } =
            contextData as UnknownJson;

          if (_action === 'upsertObject') {
            if (!objectId || !objectData) {
              console.error('❌ upsertObject called without objectId or objectData!', {
                objectId,
                hasObjectData: !!objectData,
              });
              // Return early to prevent normal patch flow
              throw new Error('upsertObject requires objectId and objectData');
            }
            if (!context.id) throw new Error('Board ID required');
            const result = await boardsService!.upsertBoardObject(
              context.id as string,
              objectId as string,
              objectData
            );
            context.result = result;
            console.log('🔄 [boards patch hook] Emitting patched event for upsertObject', {
              board_id: result.board_id.substring(0, 8),
              objectId,
              objectsCount: Object.keys(result.objects || {}).length,
              objects: result.objects,
            });
            // Manually emit 'patched' event for WebSocket broadcasting (ONCE)
            app.service('boards').emit('patched', result);
            // Skip normal patch flow to prevent double emit
            context.dispatch = result;
            return context;
          }

          if (_action === 'removeObject' && objectId) {
            if (!context.id) throw new Error('Board ID required');
            const result = await boardsService!.removeBoardObject(
              context.id as string,
              objectId as string
            );
            context.result = result;
            // Manually emit 'patched' event for WebSocket broadcasting (ONCE)
            app.service('boards').emit('patched', result);
            // Skip normal patch flow to prevent double emit
            context.dispatch = result;
            return context;
          }

          if (_action === 'batchUpsertObjects' && objects) {
            if (!context.id) throw new Error('Board ID required');
            const result = await boardsService!.batchUpsertBoardObjects(
              context.id as string,
              objects
            );
            context.result = result;
            // Manually emit 'patched' event for WebSocket broadcasting (ONCE)
            app.service('boards').emit('patched', result);
            // Skip normal patch flow to prevent double emit
            context.dispatch = result;
            return context;
          }

          if (_action === 'deleteZone' && objectId) {
            if (!context.id) throw new Error('Board ID required');
            // Look up zone position for coordinate translation
            const board = await boardsService!.get(context.id as string);
            const zoneObj = board?.objects?.[objectId as string];
            const zonePosition =
              zoneObj && 'x' in zoneObj && 'y' in zoneObj
                ? { x: zoneObj.x, y: zoneObj.y }
                : undefined;

            // Clear zone_id on board objects before deleting the zone
            // Converts relative positions to absolute so entities don't jump
            const boardObjectsService = app.service(
              'board-objects'
            ) as unknown as import('./services/board-objects').BoardObjectsService;
            await boardObjectsService.clearZoneReferences(
              context.id as import('@agor/core/types').BoardID,
              objectId as string,
              zonePosition
            );
            const result = await boardsService!.deleteZone(
              context.id as string,
              objectId as string,
              deleteAssociatedSessions ?? false
            );
            context.result = result.board;
            // Manually emit 'patched' event for WebSocket broadcasting
            app.service('boards').emit('patched', result.board);
            return context;
          }

          return context;
        },
      ],
      remove: [requireMinimumRole(ROLES.MEMBER, 'delete boards')],
      toBlob: [requireMinimumRole(ROLES.MEMBER, 'export boards')],
      toYaml: [requireMinimumRole(ROLES.MEMBER, 'export boards')],
      fromBlob: [requireMinimumRole(ROLES.MEMBER, 'import boards')],
      fromYaml: [requireMinimumRole(ROLES.MEMBER, 'import boards')],
      clone: [requireMinimumRole(ROLES.MEMBER, 'clone boards')],
    },
    after: {
      // Strip private artifact objects from board.objects for non-owners
      get: [
        async (context: HookContext<Board>) => {
          const board = context.result;
          if (!board?.objects) return context;
          const userId = (context.params as { user?: { user_id: string } }).user?.user_id;
          const artifactObjectIds = Object.entries(board.objects)
            .filter(([, obj]) => obj && (obj as { type?: string }).type === 'artifact')
            .map(([id, obj]) => ({
              id,
              artifactId: (obj as { artifact_id?: string }).artifact_id,
            }));
          if (artifactObjectIds.length === 0) return context;

          const artifactRepo = new ArtifactRepository(db);
          const filtered = { ...board.objects };
          for (const { id, artifactId } of artifactObjectIds) {
            if (!artifactId) continue;
            try {
              const artifact = await artifactRepo.findById(artifactId);
              if (!artifact) {
                delete filtered[id]; // orphaned reference
              } else if (!artifact.public && artifact.created_by !== userId) {
                delete filtered[id]; // private, not owned
              }
            } catch {
              // artifact not found, remove stale reference
              delete filtered[id];
            }
          }
          context.result = { ...board, objects: filtered };
          return context;
        },
      ],
      find: [
        async (context: HookContext<Board>) => {
          const result = context.result;
          if (!result) return context;
          const boards = Array.isArray(result) ? result : (result as { data: Board[] }).data;
          if (!boards?.length) return context;
          const userId = (context.params as { user?: { user_id: string } }).user?.user_id;
          const artifactRepo = new ArtifactRepository(db);

          for (const board of boards) {
            if (!board.objects) continue;
            const artifactEntries = Object.entries(board.objects).filter(
              ([, obj]) => obj && (obj as { type?: string }).type === 'artifact'
            );
            if (artifactEntries.length === 0) continue;

            const filtered = { ...board.objects };
            for (const [id, obj] of artifactEntries) {
              const artifactId = (obj as { artifact_id?: string }).artifact_id;
              if (!artifactId) continue;
              try {
                const artifact = await artifactRepo.findById(artifactId);
                if (!artifact || (!artifact.public && artifact.created_by !== userId)) {
                  delete filtered[id];
                }
              } catch {
                delete filtered[id];
              }
            }
            board.objects = filtered;
          }
          return context;
        },
      ],
      // Emit created events for custom methods that create boards
      // Custom methods don't automatically trigger app.publish(), so we emit manually
      clone: [
        async (context: HookContext<Board>) => {
          if (context.result) {
            app.service('boards').emit('created', context.result);
          }
          return context;
        },
      ],
      fromBlob: [
        async (context: HookContext<Board>) => {
          if (context.result) {
            app.service('boards').emit('created', context.result);
          }
          return context;
        },
      ],
      fromYaml: [
        async (context: HookContext<Board>) => {
          if (context.result) {
            app.service('boards').emit('created', context.result);
          }
          return context;
        },
      ],
    },
    // biome-ignore lint/suspicious/noExplicitAny: Custom service methods not in default hook map
  } as any);

  // ============================================================================
  // Board archive/unarchive routes (hooks only — services registered elsewhere)
  // ============================================================================

  if (boardsService) {
    app.use('/boards/:id/archive', {
      async create(_data: unknown, params: RouteParams) {
        const id = params.route?.id;
        if (!id) throw new Error('Board ID required');
        return boardsService.archive(id, params);
      },
    });

    app.service('/boards/:id/archive').hooks({
      before: {
        create: [requireAuth, requireMinimumRole(ROLES.MEMBER, 'archive boards')],
      },
    });

    // POST /boards/:id/unarchive - Unarchive a board
    app.use('/boards/:id/unarchive', {
      async create(_data: unknown, params: RouteParams) {
        const id = params.route?.id;
        if (!id) throw new Error('Board ID required');
        return boardsService.unarchive(id, params);
      },
    });

    app.service('/boards/:id/unarchive').hooks({
      before: {
        create: [requireAuth, requireMinimumRole(ROLES.MEMBER, 'unarchive boards')],
      },
    });
  } // end boards archive/unarchive
}
