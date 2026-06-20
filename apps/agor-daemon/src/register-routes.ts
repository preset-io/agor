/**
 * Authentication & Custom REST Routes Registration
 *
 * Registers authentication configuration, token refresh, custom REST
 * endpoints (prompt, stop, fork, spawn, upload, etc.), and service-tier hooks.
 * Extracted from index.ts for maintainability.
 */

import { type AgorConfig, loadConfig, resolveBranchStorageConfig } from '@agor/core/config';
import {
  BranchRepository,
  type Database,
  generateId,
  MCPServerRepository,
  MessagesRepository,
  RepoRepository,
  ScheduleRepository,
  SessionMCPServerRepository,
  SessionRepository,
  shortId,
  TaskRepository,
  UsersRepository,
} from '@agor/core/db';
import { MANAGED_ENV_EXECUTION_MODE_DEFAULT } from '@agor/core/environment/webhook';
import type { Application } from '@agor/core/feathers';
import {
  AuthenticationService,
  BadRequest,
  Conflict,
  errorHandler,
  Forbidden,
  LocalStrategy,
  NotAuthenticated,
  NotFound,
} from '@agor/core/feathers';
import { type PermissionDecision, PermissionService } from '@agor/core/permissions';
import type {
  AuthenticatedParams,
  DaemonServicesConfig,
  HookContext,
  Message,
  MessageSource,
  Paginated,
  Params,
  PermissionRequestContent,
  ScheduleID,
  ServiceGroupName,
  ServiceTier,
  Session,
  SessionID,
  SessionMCPServer,
  StreamingEventType,
  Task,
  TaskID,
  User,
  UUID,
} from '@agor/core/types';
import {
  AGENTIC_TOOL_CAPABILITIES,
  hasMinimumRole,
  MessageRole,
  ROLES,
  SERVICE_GROUP_NAMES,
  SessionStatus,
  TaskStatus,
} from '@agor/core/types';
import { NotFoundError } from '@agor/core/utils/errors';
import type { Request } from 'express';
import { rateLimit } from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import { createLaunchAuthService, resolvePublicLaunchAuthSettings } from './auth/launch-auth.js';
import {
  issueRuntimeToken,
  issueRuntimeTokenPair,
  RUNTIME_JWT_AUDIENCE,
  RUNTIME_JWT_ISSUER,
} from './auth/runtime-tokens.js';
import type {
  BoardsServiceImpl,
  BranchesServiceImpl,
  MessagesServiceImpl,
  ReposServiceImpl,
  SessionsServiceImpl,
  TasksServiceImpl,
} from './declarations.js';
import { killExecutorProcess } from './executor-tracking.js';
import type { GatewayService } from './services/gateway.js';
import {
  ScheduleBusyError,
  ScheduleNotReadyError,
  type SchedulerService,
} from './services/scheduler.js';
import type { TerminalsService } from './services/terminals.js';
import { createUserApiKeysService } from './services/user-api-keys.js';
import { markLocalAuthenticationLookup } from './services/users.js';
import { registerProxies } from './setup/proxies.js';
import { applyTierHooks } from './setup/service-tiers.js';
import { appendSystemMessage } from './utils/append-system-message.js';
import { buildAuthRateLimitKey } from './utils/auth-rate-limit-key.js';
import {
  ensureMinimumRole,
  registerAuthenticatedRoute,
  requireMinimumRole,
} from './utils/authorization.js';
import {
  cacheBranchAccess,
  checkSessionOwnerOrAdmin,
  ensureBranchPermission,
  loadScheduleAndBranch,
  PERMISSION_RANK,
  resolveBranchPermission,
} from './utils/branch-authorization.js';
import { buildInitialUserMessage } from './utils/build-initial-user-message.js';
import { buildPrompterPrefixedPrompt } from './utils/build-prompter-prefix.js';
import {
  redactMCPServerSecrets,
  shouldExposeMCPServerSecrets,
} from './utils/mcp-header-secrets.js';
import { canControlCliSession } from './utils/mcp-token-authorization.js';
import { ensureScheduleRunsAsCaller } from './utils/schedule-hooks.js';
import {
  sessionCanStartTask,
  shouldReconcileSessionPromptState,
} from './utils/session-task-state.js';
import { findActiveTasksForSession } from './utils/session-tasks.js';
import { type SessionTurnLocks, withSessionTurnLock } from './utils/session-turn-lock.js';
import { normalizeMessageSource, runExistingTask } from './utils/task-runner.js';
import {
  createUploadMiddleware,
  enforceParsedTotalUploadSize,
  enforceTotalUploadSize,
} from './utils/upload.js';
import { resolveWidget } from './widgets/submissions.js';

const DEBUG_AUTH_EVENTS =
  process.env.AGOR_DEBUG_AUTH_EVENTS === '1' || process.env.DEBUG?.includes('auth-events');

function authEventDebug(...args: unknown[]): void {
  if (DEBUG_AUTH_EVENTS) {
    console.debug(...args);
  }
}

const DEBUG_TASK_QUEUE =
  process.env.AGOR_DEBUG_TASK_QUEUE === '1' || process.env.DEBUG?.includes('task-queue');

function taskQueueDebug(...args: unknown[]): void {
  if (DEBUG_TASK_QUEUE) {
    console.debug(...args);
  }
}

export class AgorLocalStrategy extends LocalStrategy {
  async findEntity(username: string, params: Params) {
    markLocalAuthenticationLookup(params);
    return super.findEntity(username, params);
  }
}

/**
 * Extended Params with route ID parameter.
 */
interface RouteParams extends Params {
  route?: {
    id?: string;
    messageId?: string;
    mcpId?: string;
    name?: string;
  };
  user?: User;
}

export async function markStoppedSessionPromptableAndDrainQueue(
  sessionsService: Pick<SessionsServiceImpl, 'patch' | 'triggerQueueProcessing'>,
  sessionId: SessionID,
  params?: Params
): Promise<void> {
  await sessionsService.patch(
    sessionId,
    {
      status: SessionStatus.IDLE,
      ready_for_prompt: true,
    },
    params
  );

  // Do not rely solely on the sessions.after.patch hook here. Stopping is an
  // explicit "skip current and continue queued work" action, and the STOPPED
  // task patch observes the old RUNNING session state before this patch lands.
  // Trigger the drainer after the session is actually promptable so queued
  // prompts resume even if hook timing/authorization changes regress later.
  await sessionsService.triggerQueueProcessing(sessionId, params);
}

function isServiceAccountRoute(params: RouteParams): boolean {
  return (params.user as { _isServiceAccount?: boolean } | undefined)?._isServiceAccount === true;
}

/**
 * Type guard to check if result is paginated
 */
function isPaginated<T>(result: T[] | Paginated<T>): result is Paginated<T> {
  return !Array.isArray(result) && 'data' in result && 'total' in result;
}

/**
 * Interface for dependencies needed by route registration.
 */
export interface RegisterRoutesContext {
  db: Database;
  app: Application & { io?: import('socket.io').Server };
  config: AgorConfig;
  svcEnabled: (group: string) => boolean;
  svcTier: (group: string) => ServiceTier;
  jwtSecret: string;
  branchRbacEnabled: boolean;
  requireAuth: (context: HookContext) => Promise<HookContext>;
  enforcePasswordChange: (context: HookContext) => Promise<HookContext>;
  superadminOpts: { allowSuperadmin: boolean };
  DB_PATH: string;
  DAEMON_PORT: number;
  DAEMON_VERSION: string;
  /**
   * Resolved build info (sha + builtAt). Surfaced on /health so the UI can
   * detect FE/BE drift after a deploy. The SHA is the canonical version
   * signal for the version-sync banner — see setup/build-info.ts.
   */
  DAEMON_BUILD_INFO: import('./setup/build-info.js').BuildInfo;
  servicesConfig: DaemonServicesConfig;
  /**
   * Resolved security config (CSP/CORS after defaults+extras+override merge).
   * Used by /health to surface the effective policy to admin users.
   */
  resolvedSecurity: import('@agor/core/config').ResolvedSecurity;

  // Service instances from registerServices()
  sessionsService: SessionsServiceImpl;
  messagesService: MessagesServiceImpl;
  boardsService: BoardsServiceImpl | undefined;
  branchRepository: BranchRepository;
  usersRepository: UsersRepository;
  sessionsRepository: SessionRepository;
  sessionMCPServersService: ReturnType<
    typeof import('./services/session-mcp-servers.js').createSessionMCPServersService
  >;
  sessionEnvSelectionsService: ReturnType<
    typeof import('./services/session-env-selections.js').createSessionEnvSelectionsService
  >;
  terminalsService: TerminalsService | null;
}

/**
 * Register authentication configuration, custom REST routes, and tier hooks.
 */
export async function registerRoutes(ctx: RegisterRoutesContext): Promise<void> {
  const {
    db,
    app,
    config,
    svcEnabled,
    svcTier,
    jwtSecret,
    branchRbacEnabled,
    requireAuth,
    enforcePasswordChange,
    superadminOpts,
    DB_PATH,
    DAEMON_PORT: _DAEMON_PORT,
    DAEMON_VERSION,
    DAEMON_BUILD_INFO,
    servicesConfig,
    resolvedSecurity,
    sessionsService,
    messagesService,
    boardsService,
    branchRepository,
    usersRepository: _usersRepository,
    sessionsRepository,
    sessionMCPServersService,
    sessionEnvSelectionsService,
    terminalsService: _terminalsService,
  } = ctx;

  const usersService = app.service('users');
  const tasksService = app.service('tasks') as unknown as TasksServiceImpl;
  const reposService = app.service('repos') as unknown as ReposServiceImpl;

  // Helper: safely get a service (returns undefined if not registered due to tier=off)
  const safeService = (path: string) => {
    try {
      return app.service(path);
    } catch {
      return undefined;
    }
  };

  // Get sessionTokenService from app record
  const appRecord = app as unknown as Record<string, unknown>;
  const sessionTokenService = appRecord.sessionTokenService as
    | import('./services/session-token-service.js').SessionTokenService
    | undefined;

  // ============================================================================
  // Authentication Configuration
  // ============================================================================

  const authStrategiesArray = ['api-key', 'jwt', 'local'];
  if (sessionTokenService) {
    authStrategiesArray.push('session-token');
  }

  // Access token TTL — short by design. The /authentication/refresh route
  // (and the after-hook below) issues a 30-day refresh token so users stay
  // logged in across browser restarts; the access token itself stays
  // short-lived so that a leaked one expires quickly. Both the auth-service
  // config AND the refresh endpoint MUST use this constant — if they drift,
  // the refresh path silently downgrades the security of the auth path.
  const ACCESS_TOKEN_TTL = '15m';
  const REFRESH_TOKEN_TTL = '30d';

  app.set('authentication', {
    secret: jwtSecret,
    entity: 'user',
    entityId: 'user_id',
    service: 'users',
    authStrategies: authStrategiesArray,
    jwtOptions: {
      header: { typ: 'access' },
      audience: RUNTIME_JWT_AUDIENCE,
      issuer: RUNTIME_JWT_ISSUER,
      algorithm: 'HS256',
      expiresIn: ACCESS_TOKEN_TTL,
    },
    local: {
      usernameField: 'email',
      passwordField: 'password',
    },
  });

  // Configure authentication
  const authentication = new AuthenticationService(app);

  // Import custom JWT strategy that handles service tokens
  const { ServiceJWTStrategy } = await import('./auth/service-jwt-strategy.js');

  // Register authentication strategies
  authentication.register('jwt', new ServiceJWTStrategy(sessionTokenService));
  authentication.register('local', new AgorLocalStrategy());

  // Register API key authentication strategy
  const { ApiKeyStrategy } = await import('./auth/api-key-strategy.js');
  const apiKeyStrategy = new ApiKeyStrategy();
  authentication.register('api-key', apiKeyStrategy);

  // Initialize API key strategy with dependencies
  const { UserApiKeysRepository } = await import('@agor/core/db');
  const userApiKeysRepo = new UserApiKeysRepository(db);
  apiKeyStrategy.setDependencies(userApiKeysRepo, usersService);

  // SECURITY: Rate-limit the authentication + refresh endpoints.
  //
  // express-rate-limit gives us standardized response headers
  // (`RateLimit-Limit/Remaining/Reset`, IETF draft-7) and `Retry-After` for
  // free, plus battle-tested concurrency / clock-skew handling. The default
  // in-memory MemoryStore is fine for solo/team deployments; multi-instance
  // operators can plug in a distributed store (redis, memcached) later
  // without touching this call site.
  //
  // Mounted at `/authentication` so it covers BOTH the Feathers auth service
  // (POST /authentication) and the custom refresh endpoint
  // (POST /authentication/refresh) — Express's path-prefix matching means
  // a single middleware handles both, and the keyGenerator branches on the
  // sub-path to choose the right composite key.
  const AUTH_RATE_LIMIT_MAX = 50;
  const AUTH_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

  const authRateLimiter = rateLimit({
    windowMs: AUTH_RATE_LIMIT_WINDOW_MS,
    limit: AUTH_RATE_LIMIT_MAX,
    // Modern IETF draft-7 headers (RateLimit-*) — clients can back off.
    standardHeaders: 'draft-7',
    // Drop the legacy X-RateLimit-* set; they're noisy and non-standard.
    legacyHeaders: false,
    // Composite key on (ip, email). For the refresh sub-path the body has
    // no email, so we bucket purely by IP. Trust only Express's resolved
    // `req.ip` (which respects `app.set('trust proxy', n)`) — never
    // X-Forwarded-For directly.
    keyGenerator: (req: Request): string => buildAuthRateLimitKey(req),
    message: 'Too many authentication attempts. Please try again in 15 minutes.',
  });

  // Mount BEFORE the auth service so the limiter intercepts first. The same
  // middleware also covers /authentication/refresh below thanks to Express
  // path-prefix matching.
  // biome-ignore lint/suspicious/noExplicitAny: Feathers Application vs Express middleware overload
  app.use('/authentication', authRateLimiter as any);

  app.use('/authentication', authentication);

  // Initialize SessionTokenService with JWT secret
  if (sessionTokenService) {
    sessionTokenService.setJwtSecret(jwtSecret);
    console.log('✅ SessionTokenService initialized with JWT secret (will generate JWTs)');
  }

  // Configure docs for authentication service
  // biome-ignore lint/suspicious/noExplicitAny: FeathersJS service type not fully typed
  const authService = app.service('authentication') as any;
  authService.docs = {
    description: 'Authentication service for user login and token management',
    security: [],
  };

  // Hook: Add refresh token to authentication response.
  // Rate limiting is enforced by express-rate-limit middleware mounted on
  // `/authentication` above — by the time we reach this hook the limiter
  // has already 429'd any over-quota request.
  authService.hooks({
    after: {
      create: [
        // biome-ignore lint/suspicious/noExplicitAny: FeathersJS context type not fully typed
        async (context: any) => {
          authEventDebug('✅ Authentication succeeded:', {
            strategy: context.result?.authentication?.strategy,
            hasUser: !!context.result?.user,
            user_id: context.result?.user?.user_id,
            hasAccessToken: !!context.result?.accessToken,
          });

          if (context.result?.user) {
            context.result.refreshToken = issueRuntimeToken(
              { sub: context.result.user.user_id, type: 'refresh' },
              jwtSecret,
              REFRESH_TOKEN_TTL
            );
          }
          return context;
        },
      ],
    },
  });

  // ============================================================================
  // One-time launch-code authentication endpoint
  // ============================================================================

  // biome-ignore lint/suspicious/noExplicitAny: Feathers Application vs Express middleware overload
  app.use('/auth/launch', authRateLimiter as any);
  app.use(
    '/auth/launch',
    createLaunchAuthService({
      db,
      config,
      jwtSecret,
      accessTokenTtl: ACCESS_TOKEN_TTL,
      refreshTokenTtl: REFRESH_TOKEN_TTL,
      usersService,
    })
  );

  // biome-ignore lint/suspicious/noExplicitAny: FeathersJS service type not fully typed
  const launchAuthService = app.service('auth/launch') as any;
  launchAuthService.docs = {
    description: 'One-time launch-code authentication endpoint for trusted external launch issuers',
    security: [],
  };

  // ============================================================================
  // Refresh token endpoint
  // ============================================================================

  app.use('/authentication/refresh', {
    async create(data: { refreshToken: string }, _params?: Params) {
      // Rate limiting handled by express-rate-limit at the
      // /authentication mount point (path-prefix match catches /refresh).
      try {
        const decoded = jwt.verify(data.refreshToken, jwtSecret, {
          issuer: RUNTIME_JWT_ISSUER,
          audience: RUNTIME_JWT_AUDIENCE,
        }) as { sub: string; type: string };

        if (decoded.type !== 'refresh') {
          throw new Error('Invalid token type');
        }

        const user = await usersService.get(decoded.sub as import('@agor/core/types').UUID);

        // Use the SAME ACCESS_TOKEN_TTL as the auth-service config above —
        // otherwise this endpoint silently downgrades the access-token
        // hardening. Refresh tokens get the standard 30-day TTL.
        const tokens = issueRuntimeTokenPair(user, jwtSecret, ACCESS_TOKEN_TTL, REFRESH_TOKEN_TTL);

        // Return the full user object — matches what POST /authentication
        // returns via the FeathersJS auth service. Stripping fields here
        // (previously: only user_id/email/name/emoji/role) silently dropped
        // `must_change_password` after every token refresh, breaking the
        // forced-password-change UI guard in App.tsx and showing the user a
        // black page with "Failed to load data — Password change required."
        // instead of the change-password modal. `usersService.get` already
        // omits secrets (password hash, raw API keys, raw env var values)
        // via rowToUser — see services/users.ts.
        return {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          user,
        };
      } catch (_error) {
        // Must throw NotAuthenticated (not plain Error) so the UI's
        // isDefiniteAuthFailure classifier (apps/agor-ui/src/utils/authErrors.ts)
        // recognizes a dead refresh token as a 401-class failure and clears
        // session state. A plain Error has no status/name and gets treated as
        // transient, leading the single-flight refresh loop to keep retrying.
        throw new NotAuthenticated('Invalid or expired refresh token');
      }
    },
  });

  // biome-ignore lint/suspicious/noExplicitAny: FeathersJS service type not fully typed
  const refreshService = app.service('authentication/refresh') as any;
  refreshService.docs = {
    description: 'Token refresh endpoint - obtain a new access token using a refresh token',
    security: [],
  };

  // ============================================================================
  // Impersonation endpoint
  // ============================================================================

  const MAX_IMPERSONATION_EXPIRY_MS = 3_600_000; // 1 hour hard cap

  app.use('/authentication/impersonate', {
    async create(data: { user_id?: string; expiry_ms?: number }, params?: Params) {
      // 1. Caller must be authenticated
      const authParams = params as AuthenticatedParams;
      if (!authParams?.user?.user_id) {
        throw new NotAuthenticated('Authentication required');
      }

      const caller = authParams.user;

      // 2. Caller must have role: superadmin
      if (!hasMinimumRole(caller.role, ROLES.SUPERADMIN)) {
        throw new Forbidden('Superadmin role required for impersonation');
      }

      // 3. Caller token must NOT be an impersonated token (block recursive impersonation)
      // biome-ignore lint/suspicious/noExplicitAny: JWT payload has dynamic fields
      const authPayload = (authParams as any).authentication?.payload;
      if (authPayload?.is_impersonated === true) {
        throw new Forbidden('Cannot impersonate from an already-impersonated token');
      }

      // 4. user_id must be provided
      if (!data?.user_id) {
        throw new BadRequest('user_id is required');
      }

      // 5. Validate expiry_ms if provided
      if (data.expiry_ms != null) {
        if (typeof data.expiry_ms !== 'number' || !Number.isFinite(data.expiry_ms)) {
          throw new BadRequest('expiry_ms must be a finite number');
        }
        if (data.expiry_ms <= 0) {
          throw new BadRequest('expiry_ms must be a positive number');
        }
      }

      // 6. Target user must exist (uses usersService for consistency with refresh endpoint)
      let targetUser: User;
      try {
        targetUser = await usersService.get(data.user_id as import('@agor/core/types').UUID);
      } catch {
        throw new NotFound(`User not found: ${data.user_id}`);
      }

      // 8. Compute expiry (default 1h, capped at 1h)
      const configuredMax =
        config.daemon?.impersonation_token_expiry_ms ?? MAX_IMPERSONATION_EXPIRY_MS;
      const maxExpiry = Math.min(configuredMax, MAX_IMPERSONATION_EXPIRY_MS);
      const requestedExpiry = data.expiry_ms ?? maxExpiry;
      const expiryMs = Math.min(requestedExpiry, maxExpiry);

      // 9. Generate token
      const jti = generateId();
      const expiresAt = new Date(Date.now() + expiryMs);

      const accessToken = issueRuntimeToken(
        {
          sub: targetUser.user_id,
          type: 'access',
          impersonated_by: caller.user_id,
          is_impersonated: true,
          jti,
        },
        jwtSecret,
        Math.ceil(expiryMs / 1000)
      );

      // 10. Audit log
      console.log(
        `[auth] impersonation issued: caller=${caller.user_id} target=${targetUser.user_id} jti=${jti} exp=${expiresAt.toISOString()}`
      );

      return {
        accessToken,
        user: {
          user_id: targetUser.user_id,
          email: targetUser.email,
          name: targetUser.name,
          emoji: targetUser.emoji,
          role: targetUser.role,
        },
      };
    },
  });

  // Apply auth hooks to impersonation endpoint
  // biome-ignore lint/suspicious/noExplicitAny: FeathersJS service type not fully typed
  const impersonateService = app.service('authentication/impersonate') as any;
  impersonateService.docs = {
    description:
      'Impersonation endpoint - superadmins can issue short-lived tokens scoped to any user',
  };
  impersonateService.hooks({
    before: {
      create: [requireAuth],
    },
  });

  // ============================================================================
  // Initialize repositories and permission service
  // ============================================================================

  const _messagesRepo = new MessagesRepository(db);
  const _sessionsRepo = new SessionRepository(db);
  const _sessionMCPRepo = new SessionMCPServerRepository(db);
  const _mcpServerRepo = new MCPServerRepository(db);
  const _branchesRepo = new BranchRepository(db);
  const _reposRepo = new RepoRepository(db);
  const _tasksRepo = new TaskRepository(db);

  const permissionService = new PermissionService((event, data) => {
    app.service('sessions').emit(event, data);
  });

  // ============================================================================
  // HTTP proxies (off by default; mounted only when config.proxies has entries)
  // ============================================================================

  registerProxies(app, config, jwtSecret);

  // ============================================================================
  // Messages bulk + streaming routes
  // ============================================================================

  registerAuthenticatedRoute(
    app,
    '/messages/bulk',
    {
      async create(data: unknown, params: RouteParams) {
        return messagesService.createMany(data as Message[]);
      },
    },
    {
      create: { role: ROLES.MEMBER, action: 'create messages' },
    },
    requireAuth
  );

  registerAuthenticatedRoute(
    app,
    '/messages/streaming',
    {
      async create(
        data: {
          event: StreamingEventType;
          data: Record<string, unknown>;
        },
        params: RouteParams
      ) {
        app.service('messages').emit(data.event, data.data);
        if (
          isServiceAccountRoute(params) &&
          (data.event === 'streaming:start' ||
            data.event === 'streaming:chunk' ||
            data.event === 'streaming:end' ||
            data.event === 'streaming:error')
        ) {
          void (app.service('gateway') as unknown as GatewayService).handleMessageStreamingEvent(
            data.event,
            data.data
          );
        }
        return { success: true };
      },
    },
    {
      create: { role: ROLES.MEMBER, action: 'broadcast streaming events' },
    },
    requireAuth
  );

  registerAuthenticatedRoute(
    app,
    '/tasks/streaming',
    {
      async create(
        data: {
          event: 'tool:start' | 'tool:complete' | 'thinking:chunk';
          data: Record<string, unknown>;
        },
        params: RouteParams
      ) {
        app.service('tasks').emit(data.event, data.data);
        if (isServiceAccountRoute(params) && data.event === 'tool:start') {
          const sessionId =
            typeof data.data.session_id === 'string' ? data.data.session_id : undefined;
          const toolName =
            typeof data.data.tool_name === 'string' ? data.data.tool_name : undefined;
          if (sessionId) {
            void (app.service('gateway') as unknown as GatewayService).updateProgress({
              session_id: sessionId,
              state: 'working',
              task_id: typeof data.data.task_id === 'string' ? data.data.task_id : undefined,
              tool_name: toolName,
            });
          }
        }
        return { success: true };
      },
    },
    {
      create: { role: ROLES.MEMBER, action: 'broadcast task streaming events' },
    },
    requireAuth
  );

  // ============================================================================
  // Sessions custom routes (fork, spawn, genealogy, prompt, stop, queue)
  // ============================================================================

  registerAuthenticatedRoute(
    app,
    '/sessions/:id/fork',
    {
      async create(data: { prompt: string; task_id?: string }, params: RouteParams) {
        const id = params.route?.id;
        if (!id) throw new Error('Session ID required');
        console.log(`🔀 Forking session: ${shortId(id)}`);
        const forkedSession = await sessionsService.fork(id, data, params);
        console.log(`✅ Fork created: ${shortId(forkedSession.session_id)}`);

        console.log('📡 [FORK] Manually broadcasting created event to all clients');

        if (app.io) {
          app.io.emit('sessions created', forkedSession);
        }

        return forkedSession;
      },
    },
    {
      create: { role: ROLES.MEMBER, action: 'fork sessions' },
    },
    requireAuth
  );

  registerAuthenticatedRoute(
    app,
    '/sessions/:id/spawn',
    {
      async create(data: Partial<import('@agor/core/types').SpawnConfig>, params: RouteParams) {
        const id = params.route?.id;
        if (!id) throw new Error('Session ID required');
        console.log(`🌱 Spawning session from: ${shortId(id)}`);
        const spawnedSession = await sessionsService.spawn(id, data, params);
        console.log(`✅ Spawn created: ${shortId(spawnedSession.session_id)}`);

        console.log('📡 [SPAWN] Manually broadcasting created event to all clients');

        if (app.io) {
          app.io.emit('sessions created', spawnedSession);
        }

        return spawnedSession;
      },
    },
    {
      create: { role: ROLES.MEMBER, action: 'spawn sessions' },
    },
    requireAuth
  );

  registerAuthenticatedRoute(
    app,
    '/sessions/:id/genealogy',
    {
      async find(params: RouteParams) {
        const id = params.route?.id;
        if (!id) throw new Error('Session ID required');
        return sessionsService.getGenealogy(id, params);
      },
      // biome-ignore lint/suspicious/noExplicitAny: FeathersJS route handler type mismatch with Express RouteParams
    } as any,
    {
      find: { role: ROLES.MEMBER, action: 'view session genealogy' },
    },
    requireAuth
  );

  /**
   * Restart the Zellij pane for a Claude Code CLI session.
   *
   * Closes the existing `cli-<short>` tab (if any) and re-spawns `claude`
   * inside a fresh tab against the same JSONL. The session's
   * `cli_state.watcher_offset` is preserved so the watcher resumes
   * tailing from wherever it left off — no events are lost across the
   * restart.
   *
   * Use this when claude has crashed / been Ctrl-C'd inside the pane,
   * when auth changes and you want a clean process, or when the Zellij
   * pane's foreground has fallen back to bash after `claude` exited.
   */
  registerAuthenticatedRoute(
    app,
    '/sessions/:id/restart-cli',
    {
      async create(_data: unknown, params: RouteParams) {
        const id = params.route?.id;
        if (!id) throw new Error('Session ID required');
        const session = await sessionsService.get(id, params);
        if (session.agentic_tool !== 'claude-code-cli') {
          throw new Error(
            `Restart is only supported for claude-code-cli sessions; this session is ${session.agentic_tool}`
          );
        }
        const targetUserId = session.created_by;
        if (!targetUserId) throw new Error('Session has no created_by — cannot route restart');
        if (
          params.provider &&
          !canControlCliSession({
            callerUserId: params.user?.user_id,
            callerRole: params.user?.role,
            sessionCreatedBy: session.created_by,
          })
        ) {
          throw new Forbidden('You can only restart Claude CLI sessions you created.');
        }

        const tabName = `cli-${shortId(session.session_id)}`;
        const channel = `user/${targetUserId}/terminal`;

        // 1) Hard-kill any live `claude` process bound to this session.
        //    Zellij's `close-tab` SHOULD propagate SIGHUP to its
        //    foreground, but in practice claude sometimes survives the
        //    pane death long enough to collide on session-id uniqueness
        //    ("Session ID … is already in use") when the new spawn
        //    fires. `pkill -f` against the argv pattern is the reliable
        //    kill. Match BOTH `--session-id <X>` (first launch) and
        //    `--resume <X>` (post-restart spawn) — same code path
        //    `buildClaudeCliSpawn` emits.
        try {
          const { spawn: spawnProc } = await import('node:child_process');
          const killProc = spawnProc(
            'pkill',
            ['-f', `claude .*(--session-id|--resume) ${session.session_id}`],
            { stdio: 'ignore' }
          );
          await new Promise<void>((resolve) => {
            killProc.on('exit', () => resolve());
            killProc.on('error', () => resolve());
            // Defensive cap — pkill should be <100ms.
            setTimeout(() => {
              try {
                killProc.kill();
              } catch {
                /* already exited */
              }
              resolve();
            }, 2000);
          });
        } catch (err) {
          console.warn('[claude-cli-integration] pkill failed, proceeding anyway', err);
        }

        // 2) Atomic close-all + create-with-command via `forceRecreate`.
        //
        // Previous implementation emitted `close` then waited 800ms
        // then re-ran `onCliSessionCreated` which emitted `create`.
        // Two problems:
        //   - `close` only closed the focused tab (one of potentially
        //     several duplicates from earlier racing executors), so
        //     the subsequent `create` would see surviving siblings
        //     and auto-converse to `focus` — restart "succeeded" but
        //     claude never actually respawned.
        //   - The 800ms timer was a guess against an uncoordinated
        //     race between executors.
        //
        // With `forceRecreate: true` the executor closes EVERY tab
        // matching `tabName` first, then issues `new-tab --layout`
        // with the freshly-built claude argv — atomic in the
        // executor's tab-event loop. No timer, no surviving stale
        // tab, no auto-converse. Restart actually restarts.
        const branch = (await app.service('branches').get(session.branch_id, params)) as {
          path?: string;
        };
        const cwd = branch?.path;
        if (!cwd) throw new Error('Branch has no path; cannot restart');
        const { buildSpawnConfigForSession, writeClaudeCliMcpConfigForSession } = await import(
          './services/claude-cli-integration.js'
        );
        const { buildClaudeCliSpawn } = await import('@agor/core/claude-cli');
        const mcpConfigPath = await writeClaudeCliMcpConfigForSession(app, session, {
          actor: params.user ?? null,
        });
        const spawnCfg = buildSpawnConfigForSession(session, cwd, { mcpConfigPath });
        const built = buildClaudeCliSpawn(spawnCfg);
        if (app.io) {
          app.io.to(channel).emit('terminal:tab', {
            userId: targetUserId,
            action: 'create',
            tabName,
            cwd,
            command: built.bin,
            commandArgs: built.args,
            forceRecreate: true,
          });
        }

        return { ok: true, tabName };
      },
      // biome-ignore lint/suspicious/noExplicitAny: FeathersJS route handler type mismatch
    } as any,
    {
      create: { role: ROLES.MEMBER, action: 'restart claude CLI session' },
    },
    requireAuth
  );

  /**
   * Per-session "turn" lock — single source of truth for "who's allowed to
   * spawn an executor for this session right now" mutual exclusion. Shared
   * by `/sessions/:id/prompt`'s idle branch, `/tasks/:id/run`, and the
   * queue processor's drain loop. See `utils/session-turn-lock.ts`.
   *
   * Without this, two concurrent prompts on the same idle session could
   * both observe `status === 'idle'` and both spawn executors — a race
   * that pre-dates the `/tasks/:id/run` route but is now fixed across all
   * three entry points.
   */
  const sessionTurnLocks: SessionTurnLocks = new Map();

  /**
   * Helper: Safely patch an entity, returning false if it was deleted mid-execution
   */
  async function safePatch<T>(
    serviceName: string,
    id: string,
    data: Partial<T>,
    entityType: string,
    params?: RouteParams
  ): Promise<boolean> {
    try {
      await app.service(serviceName).patch(id, data, params || {});
      return true;
    } catch (error) {
      if (
        error instanceof NotFoundError ||
        (error instanceof Error && error.message.includes('No record found'))
      ) {
        console.log(`⚠️  ${entityType} ${shortId(id)} was deleted mid-execution - skipping update`);
        return false;
      }
      throw error;
    }
  }

  async function reconcileSessionPromptStateIfStuck(
    session: Session,
    taskRepo: TaskRepository,
    params: RouteParams,
    options: { ignoredTaskIds?: readonly string[] } = {}
  ): Promise<Session> {
    if (session.status !== SessionStatus.FAILED || session.ready_for_prompt === true) {
      return session;
    }

    const sessionTasks = await taskRepo.findBySession(session.session_id);
    if (!shouldReconcileSessionPromptState(session, sessionTasks, options)) return session;

    console.warn(
      `🧹 [PromptState] Repairing stuck session ${shortId(session.session_id)} ` +
        `(status=${session.status}, ready_for_prompt=${session.ready_for_prompt})`
    );
    return (await app.service('sessions').patch(
      session.session_id,
      {
        status: SessionStatus.IDLE,
        ready_for_prompt: true,
      },
      params
    )) as Session;
  }

  /**
   * spawnTaskExecutor — sole transition point for `tasks.status` going from
   * `created` / `queued` → `running`.
   *
   * Both the IDLE branch of POST /sessions/:id/prompt and the queued-task
   * drainer call this helper. Centralising the transition guarantees that:
   *
   *   - `message_range.start_index`, `git_state.{ref,sha}_at_start`, and
   *     `started_at` are recomputed against fresh state right before the
   *     executor is spawned (sentinels on the stored row are only ever
   *     visible while `status='queued'`).
   *   - The initial user-message row is written by the daemon synchronously,
   *     before the executor process is forked. Without this, any crash
   *     during executor startup loses the prompt from the chat transcript
   *     even though `tasks.full_prompt` still has the text. Gated by
   *     `config.execution.daemon_writes_user_message` (kill switch — see
   *     §5.E of `docs/never-lose-prompt-design.md`).
   *   - `task.metadata.is_agor_callback` / `task.metadata.source` are
   *     re-stamped onto the new message so the UI's callback styling
   *     (`MessageBlock.tsx`) survives the queue → run transition.
   *   - Spawn failures synthesise a `type:'system'` error message so the
   *     chat surfaces *why* the assistant didn't respond, instead of silently
   *     leaving a ghost task in FAILED with no transcript trace.
   *
   * The session.tasks list is appended here too, so callers don't have to
   * remember to do it themselves.
   */
  async function spawnTaskExecutor(
    task: Task,
    options: {
      permissionMode?: import('@agor/core/types').PermissionMode;
      stream?: boolean;
      messageSource?: MessageSource;
    },
    params: RouteParams
  ): Promise<Task> {
    const session = await sessionsService.get(task.session_id, params);

    // Recompute message_range.start_index against the live message count.
    const messageStartIndex = await sessionsRepository.countMessages(task.session_id);
    const startTimestamp = new Date().toISOString();

    // The daemon transitions the task to RUNNING and writes required sentinel
    // git fields before executor spawn. The executor overwrites these with the
    // authoritative task-start git state from inside the managed checkout.
    const gitStateAtStart = 'unknown';
    const refAtStart = 'unknown';

    // Patch task: queued/created → running, with real ranges. queue_position
    // is cleared here so a draining task is no longer considered queued.
    const updatedTask = (await app.service('tasks').patch(
      task.task_id,
      {
        status: TaskStatus.RUNNING,
        started_at: startTimestamp,
        queue_position: undefined,
        message_range: {
          start_index: messageStartIndex,
          end_index: messageStartIndex + 1,
          start_timestamp: startTimestamp,
          end_timestamp: startTimestamp,
        },
        git_state: {
          ref_at_start: refAtStart,
          sha_at_start: gitStateAtStart,
        },
      },
      params
    )) as Task;

    // Alt D — write the user-message row before spawning. Gated by kill switch.
    // The executor's createUserMessage has a skip-if-exists guard so a duplicate
    // write is harmless if the daemon path is enabled.
    if (config.execution?.daemon_writes_user_message !== false) {
      try {
        const isCallback = task.metadata?.is_agor_callback === true;
        const messageMetadata: Message['metadata'] = {};
        if (isCallback) {
          messageMetadata.is_agor_callback = true;
        }
        // Prefer task.metadata.source (set when the task was queued) over
        // the request's messageSource — the latter applies only to the
        // current draining tick, the former to where the prompt originated.
        const source = task.metadata?.source ?? options.messageSource;
        if (source) {
          messageMetadata.source = source;
        }

        const userMessage = buildInitialUserMessage({
          sessionId: task.session_id,
          taskId: task.task_id,
          index: messageStartIndex,
          timestamp: startTimestamp,
          content: task.full_prompt,
          // Callback messages are typed `system` so the UI shows the special
          // Agor-callback styling. Normal prompts stay `user`.
          type: isCallback ? 'system' : 'user',
          metadata: Object.keys(messageMetadata).length > 0 ? messageMetadata : undefined,
        });
        await app.service('messages').create(userMessage, params);
      } catch (msgErr) {
        // Don't fail the spawn — the executor's createUserMessage fallback
        // (with skip-if-exists) will write the row when it connects.
        console.warn(
          `⚠️  [Daemon] Failed to write initial user-message row for task ${shortId(task.task_id)} (executor will retry):`,
          msgErr
        );
      }
    }

    // Flip session to RUNNING and append to session.tasks. Done here so both
    // callers (idle prompt and queue drain) get this for free.
    //
    // The session-status flip used to fall out of `TasksService.create` when
    // the IDLE path created a task with `status: RUNNING` directly. Now the
    // IDLE path creates `status: CREATED` and we patch to RUNNING here, which
    // `TasksService.patch` does NOT mirror onto the session. Without this
    // explicit patch, `session.status` stays IDLE while a task is RUNNING,
    // causing the queue gate in the prompt route to wave subsequent prompts
    // through instead of queuing them.
    await app.service('sessions').patch(
      task.session_id,
      {
        status: SessionStatus.RUNNING,
        ready_for_prompt: false,
        tasks: [...session.tasks, task.task_id],
      },
      params
    );

    // Tag the bytes shipped to the executor with `[Prompted by: ...]` when a
    // non-owner is prompting. The prompter identity comes from `task.created_by`
    // (NOT `params.user`): every persisted Task row requires `created_by`
    // (`createPending` for the prompt/queue/callback paths, `create`/`createMany`
    // for pre-created tasks run via `/tasks/:id/run`), so it survives the queue
    // / hook / drain hop intact. `params.user` can drop on hook-triggered drains
    // that don't carry `queued_by_user_id` and is therefore not authoritative.
    // See `./utils/build-prompter-prefix.ts` for the helper + tests.
    const { prompt: promptForExecutor } = await buildPrompterPrefixedPrompt({
      rawPrompt: task.full_prompt,
      sessionCreatedBy: session.created_by,
      prompterUserId: task.created_by,
      usersRepo: new UsersRepository(db),
    });

    const useStreaming = options.stream !== false;
    const sessionId = task.session_id;
    const taskId = task.task_id;

    // Claude Code CLI: there is no in-process executor. The `claude` REPL
    // is already running in the user's Zellij pane. "Prompting" the
    // session = injecting the prompt text + a newline into that pane's
    // PTY stdin, exactly as if the user typed it. The watcher (which is
    // already tailing the session's JSONL) picks up the resulting turn.
    //
    // The Agor textarea + MCP `agor_sessions_prompt` both flow through
    // this code path; for CLI sessions we short-circuit before
    // `executeTask` and emit `terminal:input` instead.
    if (session.agentic_tool === 'claude-code-cli') {
      // Hand the task off to the watcher BEFORE we PTY-inject. The watcher
      // claims this task on the next `user_message` JSONL line and links
      // every subsequent assistant/tool message to it — then closes it on
      // `turn_end`. Without this stash, the watcher would mint a *new*
      // task on that user line and we'd end up with two task rows per
      // turn (the empty one from /prompt + the one the watcher minted).
      //
      // Import lazily to avoid pulling claude-cli-integration into the
      // hot-path of every non-CLI prompt.
      const { setPendingCliTask } = await import('./services/claude-cli-integration.js');
      setPendingCliTask(sessionId as SessionID, taskId as TaskID, messageStartIndex);

      setImmediate(async () => {
        try {
          const targetUserId = session.created_by;
          if (!targetUserId) {
            throw new Error('CLI session has no created_by — cannot route PTY injection');
          }
          const channel = `user/${targetUserId}/terminal`;
          const tabName = `cli-${shortId(session.session_id)}`;
          const io = (
            app as unknown as {
              io?: { to(r: string): { emit(ev: string, p: unknown): void } };
            }
          ).io;

          // Focus the session's tab BEFORE injecting input. Zellij sends
          // terminal:input to whichever pane is currently focused, so
          // without this step a prompt typed in the Agor textarea while
          // the user happens to be viewing a sibling tab (e.g. the
          // branch's `test-branch` bash) would land in bash and
          // produce `bash: hello: command not found`. The 150ms delay
          // gives Zellij time to process the focus before the input
          // bytes arrive.
          io?.to(channel).emit('terminal:tab', {
            userId: targetUserId,
            action: 'focus',
            tabName,
          });
          await new Promise((r) => setTimeout(r, 150));

          // Append \r so the REPL submits. Zellij forwards raw bytes
          // unchanged to claude's pseudo-tty. If the user is currently
          // mid-typing into the REPL, the bytes interleave — documented
          // race per the analysis doc § Blind spot #2.
          const payload = `${promptForExecutor}\r`;
          io?.to(channel).emit('terminal:input', { userId: targetUserId, input: payload });
          console.log(
            `[claude-cli] PTY-injected prompt into ${channel} → tab ${tabName} (task ${shortId(taskId)}, ${promptForExecutor.length} chars)`
          );
          // Task lifecycle is now owned by the watcher's sink: it closes
          // the task and patches the session back to IDLE on `turn_end`.
          // We deliberately do NOT pre-complete here.
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[claude-cli] PTY injection failed for task ${shortId(taskId)}: ${msg}`);
          await safePatch(
            'tasks',
            taskId,
            {
              status: TaskStatus.FAILED,
              completed_at: new Date().toISOString(),
              error_message: `PTY injection failed: ${msg}`,
            },
            'Task',
            params
          );
          // Failure path: also flip the session back to IDLE so the user
          // can retry. The success path lets the watcher handle this on
          // turn_end.
          await app
            .service('sessions')
            .patch(sessionId, { status: SessionStatus.IDLE, ready_for_prompt: true }, params)
            .catch(() => {
              /* best-effort */
            });
        }
      });
      return updatedTask;
    }

    // Background spawn + failure handling. Returning the patched Task to the
    // caller before this resolves matches the previous behavior — the HTTP
    // response should not block on the executor process being live.
    setImmediate(async () => {
      try {
        console.log(
          `🚀 [Daemon] Routing ${session.agentic_tool} to Feathers/WebSocket executor (task ${shortId(taskId)})`
        );

        await sessionsService.executeTask(
          sessionId,
          {
            taskId,
            prompt: promptForExecutor,
            permissionMode: options.permissionMode,
            stream: useStreaming,
            messageSource: options.messageSource,
          },
          params
        );

        console.log(
          `✅ [Daemon] Executor spawned for session ${shortId(sessionId)}, waiting for task completion`
        );
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(
          `❌ [Daemon] Executor spawn failed for session=${shortId(sessionId)} task=${shortId(taskId)} agent=${session.agentic_tool} unix_username=${session.unix_username ?? 'null'}: ${errorMessage}`,
          error
        );
        await safePatch(
          'tasks',
          taskId,
          {
            status: TaskStatus.FAILED,
            completed_at: new Date().toISOString(),
            error_message: errorMessage,
          },
          'Task',
          params
        );

        // Synthesize a system message so the chat surfaces *why* the agent
        // didn't respond. Without this the transcript shows only the user
        // prompt and silence even though the task list reads FAILED.
        try {
          // Recompute the next index instead of trusting `messageStartIndex
          // + 1` — the daemon-write user-message above is wrapped in a
          // try/catch and may have been swallowed, leaving a gap at
          // `messageStartIndex`. countMessages always reports the live row
          // count, so it lands the system error at the true tail whether
          // the user-message row exists or not (no gap, no collision).
          const errorContent = `⚠️ The agent failed to start.\n\n${errorMessage}`;
          await appendSystemMessage({
            app,
            db,
            sessionId,
            taskId,
            content: errorContent,
            role: MessageRole.ASSISTANT,
            metadata: { is_meta: true },
            params,
          });
        } catch (sysErr) {
          console.warn(
            '[Daemon] Failed to write system error message after spawn failure:',
            sysErr
          );
        }

        try {
          app.service('tasks').emit('failed', {
            task_id: taskId,
            session_id: sessionId,
            error_message: errorMessage,
          });
        } catch (emitErr) {
          console.warn('[Daemon] Failed to emit tasks:failed event:', emitErr);
        }
      }
    });

    return updatedTask;
  }

  // ============================================================================
  // Prompt endpoint
  // ============================================================================

  registerAuthenticatedRoute(
    app,
    '/sessions/:id/prompt',
    {
      async create(
        data: {
          prompt: string;
          permissionMode?: import('@agor/core/types').PermissionMode;
          stream?: boolean;
          messageSource?: MessageSource;
          /**
           * Optional extra task metadata merged onto the queued/created task.
           * Used by internal callers (e.g. widget submissions) to stamp
           * traceability fields like `system_authored` / `widget_id`.
           * External callers receive no validation on this field — it's
           * trusted because the route is RBAC-gated.
           */
          metadata?: Partial<import('@agor/core/types').TaskMetadata>;
        },
        params: RouteParams
      ) {
        console.log(
          `📨 [Daemon] Prompt request for session ${params.route?.id ? shortId(params.route.id) : 'unknown'}`
        );
        console.log(`   Permission mode: ${data.permissionMode || 'not specified'}`);
        console.log(`   Streaming: ${data.stream !== false}`);
        console.log(`   Message source: ${data.messageSource || 'not specified'}`);

        let id = params.route?.id;
        if (!id) throw new Error('Session ID required');
        if (!data.prompt) throw new Error('Prompt required');

        // Validate and normalize messageSource
        const messageSource = normalizeMessageSource(data.messageSource, params);
        if (messageSource !== data.messageSource && data.messageSource !== undefined) {
          console.warn(
            `[Daemon] Invalid messageSource value: ${data.messageSource}, defaulted based on provider`
          );
        }

        let session = await sessionsService.get(id, params);
        id = session.session_id;

        // Early validation: reject unsupported tools when stateless_fs_mode is enabled
        if (config.execution?.stateless_fs_mode) {
          const toolName = session.agentic_tool as import('@agor/core/types').AgenticToolName;
          const capabilities = AGENTIC_TOOL_CAPABILITIES[toolName];
          if (capabilities && !capabilities.supportsStatelessFsMode) {
            const supported = Object.entries(AGENTIC_TOOL_CAPABILITIES)
              .filter(([, caps]) => caps.supportsStatelessFsMode)
              .map(([name]) => name)
              .join(', ');
            throw new Error(
              `stateless_fs_mode is enabled but tool '${toolName}' does not support it. Supported tools: ${supported}`
            );
          }
        }

        // Auto-unarchive on prompt
        if (session.archived) {
          console.log(
            `📦 [Prompt] Auto-unarchiving session ${shortId(id)} (was archived: ${session.archived_reason || 'unknown reason'})`
          );
          session = (await sessionsService.patch(
            id,
            { archived: false, archived_reason: undefined },
            params
          )) as typeof session;
        }

        if (session.status === SessionStatus.STOPPING) {
          throw new Error('Cannot send prompt: session is currently stopping');
        }

        // The route is one path: always materialize a Task. Whether it runs
        // immediately or gets queued is the *response*, not a different code
        // path. Sentinels and queue-position assignment live in
        // `taskRepo.createPending` so callers don't reassemble them by hand.
        //
        // Wrapped in `withSessionTurnLock` so the queue-vs-idle decision and
        // the subsequent spawn are atomic with respect to other entry points
        // (`/tasks/:id/run`, the queue drainer). Without this, two concurrent
        // prompts on an idle session could both observe `status === 'idle'`
        // and both spawn executors. Inside the lock the session is re-read,
        // so the decision is made against the freshest possible state.
        const taskRepo = new TaskRepository(db);
        if (!params.user?.user_id) {
          throw new NotAuthenticated('Authentication required to prompt a session');
        }
        const createdBy = params.user.user_id;

        return await withSessionTurnLock(sessionTurnLocks, id as SessionID, async () => {
          let lockedSession = await sessionsService.get(id, params);
          if (lockedSession.status === SessionStatus.STOPPING) {
            // The earlier STOPPING check was against pre-lock state — re-check
            // here so a session that entered STOPPING while we waited for our
            // turn doesn't accept a prompt.
            throw new Error('Cannot send prompt: session is currently stopping');
          }
          lockedSession = await reconcileSessionPromptStateIfStuck(lockedSession, taskRepo, params);
          const queuedTasks = await taskRepo.findQueued(id as SessionID);
          const shouldQueue =
            !sessionCanStartTask(lockedSession.status, lockedSession.ready_for_prompt) ||
            queuedTasks.length > 0;

          if (shouldQueue) {
            const queuedTask = await taskRepo.createPending({
              session_id: id as SessionID,
              full_prompt: data.prompt,
              created_by: createdBy,
              status: TaskStatus.QUEUED,
              metadata: {
                ...(params.user?.user_id ? { queued_by_user_id: params.user.user_id } : {}),
                ...(messageSource ? { source: messageSource } : {}),
                ...(data.metadata ?? {}),
              },
            });

            console.log(
              `📬 [Prompt] Auto-queued task for session ${shortId(id)} at position ${queuedTask.queue_position} ` +
                `(session status: ${lockedSession.status}, existing queue items: ${queuedTasks.length})`
            );

            app.service('tasks').emit('queued', queuedTask);

            if (sessionCanStartTask(lockedSession.status, lockedSession.ready_for_prompt)) {
              setImmediate(async () => {
                try {
                  await sessionsService.triggerQueueProcessing(id as SessionID, params);
                } catch (error) {
                  console.error(
                    `❌ [Prompt] Failed to trigger queue processing after auto-queue:`,
                    error
                  );
                }
              });
            }

            // Uniform response: the entity is always a Task. Caller inspects
            // `task.status` (`'queued'` here) and `task.queue_position` to know
            // what happened.
            return queuedTask;
          }

          console.log(`   Session agent: ${lockedSession.agentic_tool}`);
          console.log(
            `   Session permission_config.mode: ${lockedSession.permission_config?.mode || 'not set'}`
          );

          // Idle path: create a CREATED task, then hand off to spawnTaskExecutor
          // which is the sole place that populates message_range / git_state,
          // writes the user-message row, and spawns the executor. Both this
          // path and processNextQueuedTask go through that helper so behavior
          // stays in lockstep.
          const idleTaskMetadata: import('@agor/core/types').TaskMetadata = {
            ...(messageSource ? { source: messageSource } : {}),
            ...(data.metadata ?? {}),
          };
          const task = await taskRepo.createPending({
            session_id: id as SessionID,
            full_prompt: data.prompt,
            created_by: createdBy,
            status: TaskStatus.CREATED,
            metadata: Object.keys(idleTaskMetadata).length > 0 ? idleTaskMetadata : undefined,
          });
          // Bypassing the service means no native 'created' emit; do it here
          // so reactive clients see the new task before the executor spawns.
          app.service('tasks').emit('created', task);

          return await spawnTaskExecutor(
            task,
            {
              permissionMode: data.permissionMode,
              stream: data.stream !== false,
              messageSource,
            },
            params
          );
        });
      },
    },
    {
      create: { role: ROLES.MEMBER, action: 'execute prompts' },
    },
    requireAuth
  );

  // ============================================================================
  // Task run endpoint
  //
  // Explicit executor trigger for an already-created task. Lets pure-REST
  // harnesses (Python, Go, shell+curl — anything without an MCP client) drive
  // the executor by POSTing a Task row first (`POST /tasks`) and then poking
  // it awake here. Wraps `spawnTaskExecutor` via `runExistingTask` (status
  // revalidation) under `withSessionTurnLock` — the same shared session-level
  // mutex that `/sessions/:id/prompt`'s idle branch and the queue drainer
  // also acquire — so the on-the-wire effect is identical to "create a task
  // and run it now."
  //
  // Only CREATED tasks on IDLE sessions are accepted. QUEUED tasks are
  // rejected with a hint to wait for the queue drainer (running them out of
  // order would violate the queue-position invariant); busy sessions are
  // rejected with a hint to use `POST /sessions/:id/prompt` (which owns the
  // atomic create-and-queue path). Splitting the two responsibilities keeps
  // this endpoint a narrow "run this thing now" trigger.
  // ============================================================================

  registerAuthenticatedRoute(
    app,
    '/tasks/:id/run',
    {
      async create(
        data: {
          permissionMode?: import('@agor/core/types').PermissionMode;
          stream?: boolean;
          messageSource?: MessageSource;
        },
        params: RouteParams
      ) {
        const taskId = params.route?.id;
        if (!taskId) throw new BadRequest('Task ID required');

        const taskRepo = new TaskRepository(db);
        const task = await taskRepo.findById(taskId);
        if (!task) {
          throw new NotFound(`Task ${taskId} not found`);
        }

        // Only CREATED tasks may be triggered. QUEUED tasks must drain in
        // queue-position order via the queue processor — running them out of
        // order would violate the invariant documented in
        // `context/concepts/task-queueing.md`. Terminal/in-flight states are
        // rejected so the caller doesn't try to revive a finished task or
        // race a live executor.
        if (task.status !== TaskStatus.CREATED) {
          const hint =
            task.status === TaskStatus.QUEUED
              ? `Queued tasks drain automatically in queue-position order ` +
                `when the session becomes idle — wait for it, or stop the ` +
                `currently running task to free the queue.`
              : `Only 'created' tasks may be triggered.`;
          throw new Conflict(
            `Task ${shortId(taskId)} cannot be run: status is '${task.status}'. ${hint}`
          );
        }

        // Branch RBAC — defense in depth. Without this, a member with
        // 'view' permission could trigger execution; the eventual
        // `tasks.patch` inside spawnTaskExecutor would still 403 via the
        // `ensureCanPromptInSession` hook, but only after we'd done extra
        // work and emitted partial state. Mirrors the upload route's
        // pattern (~L1467) and `ensureCanPromptInSession` semantics —
        // including the service-account / no-provider bypasses so executor
        // callbacks aren't held to the same checks as user requests.
        const isInternalCall = !params.provider;
        const isServiceAccount =
          (params.user as { _isServiceAccount?: boolean } | undefined)?._isServiceAccount === true;
        if (branchRbacEnabled && task.session_id && !isInternalCall && !isServiceAccount) {
          const session = await sessionsService.get(task.session_id, params);
          if (!session.branch_id) {
            // Sessions without branches are out of RBAC scope; fall through.
          } else {
            const userId = params.user?.user_id as UUID | undefined;
            if (!userId) {
              throw new Forbidden('Authentication required to run tasks');
            }
            const wt = await branchRepository.findById(session.branch_id);
            if (!wt) {
              throw new NotFound(`Branch ${session.branch_id} not found`);
            }
            const isOwner = await branchRepository.isOwner(wt.branch_id, userId);
            const branchPermission = await branchRepository.resolveUserPermission(wt, userId);
            const effectiveLevel = resolveBranchPermission(
              wt,
              userId,
              isOwner,
              params.user?.role,
              superadminOpts.allowSuperadmin,
              branchPermission
            );
            const canRun =
              PERMISSION_RANK[effectiveLevel] >= PERMISSION_RANK.prompt ||
              (effectiveLevel === 'session' && session.created_by === userId);
            if (!canRun) {
              throw new Forbidden(
                `You have '${effectiveLevel}' permission on this branch, which does not ` +
                  `allow running tasks. Need 'prompt' or 'all' (or 'session' for own sessions).`
              );
            }
          }
        }

        // Acquire the session-turn lock before validating session state and
        // spawning. This is what closes the race against concurrent
        // /tasks/:id/run on different tasks of the same session, against
        // /sessions/:id/prompt's idle branch, and against the queue
        // drainer — they all serialize through `sessionTurnLocks`.
        return await withSessionTurnLock(sessionTurnLocks, task.session_id, async () => {
          // Re-read session state inside the lock — it may have flipped to
          // RUNNING while we waited for our turn.
          const session = await reconcileSessionPromptStateIfStuck(
            await sessionsService.get(task.session_id, params),
            taskRepo,
            params,
            { ignoredTaskIds: [task.task_id] }
          );

          if (session.status === SessionStatus.STOPPING) {
            throw new BadRequest('Cannot run task: session is currently stopping');
          }
          if (!sessionCanStartTask(session.status, session.ready_for_prompt)) {
            throw new Conflict(
              `Cannot run task ${shortId(taskId)}: session is '${session.status}'. ` +
                `To enqueue a prompt on a busy session, POST to /sessions/:id/prompt instead — ` +
                `it creates and queues a task atomically.`
            );
          }

          return await runExistingTask(
            task,
            {
              permissionMode: data.permissionMode,
              stream: data.stream !== false,
              messageSource: normalizeMessageSource(data.messageSource, params),
            },
            params,
            {
              findTaskById: (id) => taskRepo.findById(id),
              spawnFn: spawnTaskExecutor,
            }
          );
        });
      },
    },
    {
      create: { role: ROLES.MEMBER, action: 'execute prompts' },
    },
    requireAuth
  );

  // ============================================================================
  // Spawn-subsession prompt endpoint
  //
  // Renders the bundled spawn-subsession meta-prompt server-side and forwards
  // it to /sessions/:id/prompt in a single round-trip. Clients send raw
  // `{userPrompt, config}` instead of doing the render-then-prompt dance.
  // The daemon owns the meta-prompt template, so the UI bundle stays
  // Handlebars-free.
  // ============================================================================

  registerAuthenticatedRoute(
    app,
    '/sessions/:id/spawn-prompt',
    {
      async create(
        data: {
          userPrompt?: string;
          /**
           * Permission mode for the *parent* session's prompt. The spawn
           * config's `permissionMode` (child's intended mode) is rendered into
           * the meta-prompt; this field governs how the parent prompt is sent.
           */
          parentPermissionMode?: import('@agor/core/types').PermissionMode;
          // Remaining fields are spawn-subsession context (incl. the *child*
          // session's permissionMode/modelConfig/etc) — see
          // `SpawnSubsessionContext` in @agor/core for the shape.
          [key: string]: unknown;
        },
        params: RouteParams
      ) {
        const id = params.route?.id;
        if (!id) throw new BadRequest('Session ID required');
        if (typeof data?.userPrompt !== 'string') {
          throw new BadRequest('userPrompt (string) is required');
        }

        const { renderSpawnSubsessionPrompt } = await import(
          '@agor/core/templates/spawn-subsession-template'
        );
        // Render the meta-prompt against the child-session config (the rest
        // of `data`). `parentPermissionMode` is intentionally excluded — it's
        // the parent's send-mode, not part of the template.
        const { parentPermissionMode, ...spawnContext } = data;
        const metaPrompt = renderSpawnSubsessionPrompt(
          spawnContext as unknown as import('@agor/core/templates/spawn-subsession-template').SpawnSubsessionContext
        );

        const promptService = app.service('/sessions/:id/prompt');
        return promptService.create(
          { prompt: metaPrompt, permissionMode: parentPermissionMode, messageSource: 'agor' },
          { ...params, route: { id } }
        );
      },
    },
    {
      create: { role: ROLES.MEMBER, action: 'send spawn-subsession prompts' },
    },
    requireAuth
  );

  // ============================================================================
  // Zone-trigger fire endpoint (always_new behaviour)
  //
  // Daemon is the source of truth for the zone's trigger template / agent /
  // label — the UI only sends the zone id. The shared
  // `fireAlwaysNewZoneTrigger` helper (also used by the MCP
  // `agor_branches_set_zone(triggerTemplate: true)` always_new branch)
  // does render → validate → resolve defaults → create session → attach MCPs
  // → prompt in one round-trip.
  // ============================================================================

  registerAuthenticatedRoute(
    app,
    '/branches/:id/fire-zone-trigger',
    {
      async create(data: { zoneId?: string }, params: RouteParams) {
        const branchId = params.route?.id;
        if (!branchId) throw new BadRequest('Branch ID required');
        if (typeof data?.zoneId !== 'string' || !data.zoneId.trim()) {
          throw new BadRequest('zoneId (string) is required');
        }

        const branch = await app.service('branches').get(branchId, params);
        if (!branch.board_id) {
          throw new BadRequest('Branch is not on a board; cannot resolve zone');
        }
        const board = await app.service('boards').get(branch.board_id, params);

        // Zones live on `board.objects` keyed by zone id; type === 'zone'.
        const zoneObj = (board as { objects?: Record<string, unknown> }).objects?.[data.zoneId] as
          | {
              type?: string;
              label?: string;
              status?: string;
              trigger?: {
                template?: string;
                agent?: import('@agor/core/types').AgenticToolName;
                behavior?: string;
              };
            }
          | undefined;
        if (zoneObj?.type !== 'zone') {
          throw new BadRequest(`Zone ${data.zoneId} not found on board ${branch.board_id}`);
        }
        if (zoneObj.trigger?.behavior !== 'always_new') {
          // This endpoint is the always_new server-side action. show_picker
          // zones flow through the modal-driven explicit-target path, not this
          // route — refuse instead of silently creating a session.
          throw new BadRequest(
            `Zone "${zoneObj.label}" trigger behaviour is "${zoneObj.trigger?.behavior}", expected "always_new"`
          );
        }

        const userId = params.user?.user_id;
        if (!userId) throw new BadRequest('Authenticated user required');
        const user = await app.service('users').get(userId, params);

        const { fireAlwaysNewZoneTrigger } = await import('./services/zone-trigger.js');
        try {
          return await fireAlwaysNewZoneTrigger({
            app,
            params,
            branch,
            board,
            zone: zoneObj,
            user,
            userId: userId as string,
          });
        } catch (err) {
          // Surface helper validation errors as BadRequest for HTTP semantics.
          const message = err instanceof Error ? err.message : String(err);
          throw new BadRequest(message);
        }
      },
    },
    {
      create: { role: ROLES.MEMBER, action: 'fire zone triggers' },
    },
    requireAuth
  );

  // ============================================================================
  // File upload endpoint
  // ============================================================================

  const sessionRepo = new SessionRepository(db);
  const branchRepo = new BranchRepository(db);
  const uploadMiddleware = createUploadMiddleware(sessionRepo, branchRepo);
  const DEBUG_UPLOAD = process.env.NODE_ENV !== 'production';

  // biome-ignore lint/suspicious/noExplicitAny: Express 5 + multer type compatibility
  const uploadHandler: any = async (req: any, res: any, next: any) => {
    try {
      if (DEBUG_UPLOAD) {
        console.log('🚀 [Upload Handler] Request received');
        console.log('   Headers:', {
          contentType: req.headers['content-type'],
          authorization: req.headers.authorization ? 'present' : 'missing',
          cookie: req.headers.cookie ? 'present' : 'missing',
        });
      }

      const { sessionId } = req.params;
      const { destination, notifyAgent, message } = req.body;
      const files = req.files as Express.Multer.File[];

      if (DEBUG_UPLOAD) {
        console.log(
          `📎 [Upload Handler] Processing for session ${sessionId ? shortId(sessionId) : 'unknown'}`
        );
        console.log(`   Destination: ${destination || 'branch'}`);
        console.log(`   Notify agent: ${notifyAgent === 'true' || notifyAgent === true}`);
        console.log(`   Files received: ${files?.length || 0}`);
      }

      const params = req.feathers as AuthenticatedParams;
      if (DEBUG_UPLOAD) {
        console.log(`   Auth params:`, {
          hasUser: !!params?.user,
          userId: params?.user?.user_id ? shortId(params.user.user_id) : undefined,
          provider: params?.provider,
        });
      }

      ensureMinimumRole(params, ROLES.MEMBER, 'upload files');

      const session = await sessionsService.get(sessionId, params);
      if (!session) {
        console.error(`❌ [Upload Handler] Session not found: ${shortId(sessionId)}`);
        return res.status(404).json({ error: 'Session not found' });
      }

      // Branch RBAC: mirror ensureCanPromptInSession semantics.
      // - 'prompt'/'all' → upload to any session
      // - 'session'      → upload only to own sessions
      // - 'view'/'none'  → denied
      // Fail-closed: if RBAC is enabled but branch can't be resolved, deny.
      // When RBAC is disabled, any authenticated member can upload.
      if (branchRbacEnabled) {
        const userId = params.user?.user_id as UUID;
        if (!session.branch_id) {
          return res.status(403).json({ error: 'Not authorized to upload to this session' });
        }
        const wt = await branchRepo.findById(session.branch_id);
        if (!wt) {
          return res.status(404).json({ error: 'Branch not found' });
        }
        const isOwner = await branchRepo.isOwner(wt.branch_id, userId);
        const branchPermission = await branchRepo.resolveUserPermission(wt, userId);
        const effectiveLevel = resolveBranchPermission(
          wt,
          userId,
          isOwner,
          params.user?.role,
          superadminOpts.allowSuperadmin,
          branchPermission
        );

        const canUpload =
          PERMISSION_RANK[effectiveLevel] >= PERMISSION_RANK.prompt ||
          (effectiveLevel === 'session' && session.created_by === userId);

        if (!canUpload) {
          console.error(
            `❌ [Upload Handler] User ${shortId(userId)} has '${effectiveLevel}' permission, cannot upload to branch ${shortId(wt.branch_id)}`
          );
          return res.status(403).json({ error: 'Not authorized to upload to this session' });
        }
      }

      if (!files || files.length === 0) {
        console.error('❌ [Upload Handler] No files in request');
        return res.status(400).json({ error: 'No files uploaded' });
      }

      let branch: Awaited<ReturnType<typeof branchRepo.findById>> | undefined;
      if (session.branch_id) {
        branch = await branchRepo.findById(session.branch_id);
      }

      const uploadedFiles = files.map((f) => {
        let relativePath = f.path;
        if (branch && f.path.startsWith(branch.path)) {
          relativePath = f.path.substring(branch.path.length + 1);
        }
        return {
          filename: f.filename,
          path: relativePath,
          size: f.size,
          mimeType: f.mimetype,
        };
      });

      if (DEBUG_UPLOAD) {
        console.log(`   Uploaded ${uploadedFiles.length} file(s):`);
        uploadedFiles.forEach((f) => {
          console.log(`     - ${f.filename} (${(f.size / 1024).toFixed(2)} KB)`);
        });
      }

      let notificationError: string | null = null;
      if ((notifyAgent === 'true' || notifyAgent === true) && message) {
        try {
          const filePaths = uploadedFiles.map((f) => f.path).join(', ');
          const promptText = message.replace(/\{filepath\}/g, filePaths);

          if (DEBUG_UPLOAD) {
            console.log(`   Sending prompt to agent: ${promptText.substring(0, 100)}...`);
          }

          const promptService = app.service('/sessions/:id/prompt');
          // biome-ignore lint/suspicious/noExplicitAny: Express 5 + FeathersJS type mismatch
          const promptParams: any = {
            route: { id: sessionId },
            user: params.user,
          };
          await promptService.create({ prompt: promptText }, promptParams);
        } catch (error) {
          console.error('❌ [Upload Handler] Failed to notify agent:', error);
          notificationError =
            error instanceof Error ? error.message : 'Failed to send notification to agent';
        }
      }

      res.json({
        success: true,
        files: uploadedFiles,
        ...(notificationError && { warning: notificationError }),
      });
    } catch (error) {
      next(error);
    }
  };

  // biome-ignore lint/suspicious/noExplicitAny: Express 5 type compatibility
  const uploadLogger: any = (req: any, res: any, next: any) => {
    if (DEBUG_UPLOAD) {
      console.log('📥 [Upload Route] Request received');
      console.log('   Method:', req.method);
      console.log('   URL:', req.url);
      console.log('   Content-Type:', req.headers['content-type']);
      console.log('   Has auth header:', !!req.headers.authorization);
      console.log(
        '   Session ID param:',
        req.params.sessionId ? shortId(req.params.sessionId) : 'unknown'
      );
    }
    next();
  };

  // biome-ignore lint/suspicious/noExplicitAny: Express 5 type compatibility
  const uploadAuthMiddleware: any = async (req: any, res: any, next: any) => {
    try {
      if (DEBUG_UPLOAD) console.log('🔐 [Upload Auth] Attempting authentication');

      let token = null;

      // Bearer-only. We previously fell back to feathers-jwt / agor-access-token
      // / jwt cookies, which made the upload endpoint vulnerable to CSRF (a
      // forged form-post would inherit the user's cookie). All in-tree callers
      // (UI FileUpload component) already send `Authorization: Bearer …`.
      const authHeader = req.headers.authorization;
      if (authHeader?.startsWith('Bearer ')) {
        token = authHeader.substring(7);
        if (DEBUG_UPLOAD) console.log('   Found token in Authorization header');
      }

      if (!token) {
        if (DEBUG_UPLOAD) console.log('⚠️  [Upload Auth] No JWT token found, rejecting');
        return res.status(401).json({ error: 'Authentication required' });
      }

      if (DEBUG_UPLOAD) console.log('🔑 [Upload Auth] JWT token found, verifying...');

      const authService = app.service('authentication');
      const result = await authService.create({
        strategy: 'jwt',
        accessToken: token,
      });

      if (DEBUG_UPLOAD) {
        console.log('✅ [Upload Auth] Authentication successful');
        console.log('   User:', result.user?.user_id ? shortId(result.user.user_id) : 'unknown');
      }

      req.feathers = {
        user: result.user,
        provider: 'rest',
        authentication: result.authentication,
      };

      next();
    } catch (error) {
      console.error('❌ [Upload Auth] Authentication failed:', error);
      res.status(401).json({ error: 'Authentication required' });
    }
  };

  // biome-ignore lint/suspicious/noExplicitAny: Express route method not on FeathersJS Application type
  (app as any).post(
    '/sessions/:sessionId/upload',
    uploadLogger,
    uploadAuthMiddleware,
    // biome-ignore lint/suspicious/noExplicitAny: Express 5 type compatibility
    ((req: any, res: any, next: any) => {
      if (DEBUG_UPLOAD) {
        console.log('✅ [Upload Route] Authentication passed');
        console.log(
          '   User:',
          req.feathers?.user?.user_id ? shortId(req.feathers.user.user_id) : 'unknown'
        );
      }
      next();
      // biome-ignore lint/suspicious/noExplicitAny: Express 5 type compatibility
    }) as any,
    // Cheap pre-multer Content-Length check — short-circuits before we spend
    // time writing oversize uploads to disk.
    // biome-ignore lint/suspicious/noExplicitAny: Express 5 type compatibility
    enforceTotalUploadSize() as any,
    // biome-ignore lint/suspicious/noExplicitAny: Express 5 + multer type compatibility
    uploadMiddleware.array('files', 10) as any,
    // Defence-in-depth aggregate-size check using the actual file sizes that
    // multer wrote — catches Content-Length-spoofing clients.
    // biome-ignore lint/suspicious/noExplicitAny: Express 5 type compatibility
    enforceParsedTotalUploadSize() as any,
    // biome-ignore lint/suspicious/noExplicitAny: Express 5 type compatibility
    ((req: any, res: any, next: any) => {
      if (DEBUG_UPLOAD) {
        console.log('✅ [Upload Route] Multer processing complete');
        console.log('   Files parsed:', req.files?.length || 0);
      }
      next();
      // biome-ignore lint/suspicious/noExplicitAny: Express 5 type compatibility
    }) as any,
    uploadHandler,
    // biome-ignore lint/suspicious/noExplicitAny: Express 5 type compatibility
    ((err: any, req: any, res: any, next: any) => {
      console.error('❌ [Upload Route] Error occurred:', err.message);
      console.error('   Stack:', err.stack);
      res.status(err.status || 500).json({
        error: err.message || 'Upload failed',
        details: err.toString(),
      });
      // biome-ignore lint/suspicious/noExplicitAny: Express 5 type compatibility
    }) as any
  );

  // ============================================================================
  // Stop endpoint
  // ============================================================================

  registerAuthenticatedRoute(
    app,
    '/sessions/:id/stop',
    {
      async create(data: unknown, params: RouteParams) {
        const id = params.route?.id;
        if (!id) throw new Error('Session ID required');
        const stopReason =
          data && typeof data === 'object' && 'reason' in data && typeof data.reason === 'string'
            ? data.reason
            : undefined;

        const session = await sessionsService.get(id, params);

        const activeStates: SessionStatus[] = [
          SessionStatus.RUNNING,
          SessionStatus.AWAITING_PERMISSION,
          SessionStatus.STOPPING,
        ];
        if (!activeStates.includes(session.status as SessionStatus)) {
          return {
            success: false,
            reason: `Session cannot be stopped (status: ${session.status})`,
          };
        }

        // `TasksService.find()` short-circuits on session_id and silently
        // ignores the status filter; use the shared helper that filters in
        // process. Already recency-DESC sorted.
        const targetTasksArray = await findActiveTasksForSession(app as never, id as SessionID);

        if (targetTasksArray.length === 0) {
          console.warn(
            `⚠️  [Stop] No active tasks for session ${shortId(id)}, resetting to IDLE${stopReason ? ` (reason: ${stopReason})` : ''}`
          );
          // Stop is "skip current", not "wipe everything" — queued prompts represent
          // user intent and should still execute. Mark promptable, then explicitly
          // trigger the drainer instead of depending only on the post-patch hook.
          await markStoppedSessionPromptableAndDrainQueue(sessionsService, id as SessionID, params);
          return {
            success: true,
            status: SessionStatus.IDLE,
            reason: 'No active tasks found, session reset to idle',
          };
        }

        const latestTask = targetTasksArray[0];

        console.log(
          `🛑 [Stop] Stopping task ${shortId(latestTask.task_id)} for session ${shortId(id)}${stopReason ? ` (reason: ${stopReason})` : ''}`
        );

        const processKilled = killExecutorProcess(id);
        if (!processKilled) {
          console.warn(
            `⚠️  [Stop] No tracked process for session ${shortId(id)} — executor may have already exited`
          );
        }

        try {
          await tasksService.patch(latestTask.task_id, {
            status: TaskStatus.STOPPED,
            completed_at: new Date().toISOString(),
          });
        } catch (error) {
          console.error(`❌ [Stop] Failed to patch task to STOPPED:`, error);
        }

        try {
          // Stop is "skip current", not "wipe everything" — queued prompts represent
          // user intent and should still execute. Mark promptable, then explicitly
          // trigger the drainer instead of depending only on the post-patch hook.
          await markStoppedSessionPromptableAndDrainQueue(sessionsService, id as SessionID, params);
        } catch (error) {
          console.error(`❌ [Stop] Failed to mark session promptable or drain queue:`, error);
        }

        return { success: true, status: SessionStatus.IDLE };
      },
    },
    {
      create: { role: ROLES.MEMBER, action: 'stop sessions' },
    },
    requireAuth
  );

  // ============================================================================
  // Queue listing — task-centric (was message-centric pre-never-lose-prompt).
  // The queue is the set of tasks with status='queued', ranked by
  // queue_position. Each queued task carries the full prompt + metadata; on
  // drain it transitions queued → running via spawnTaskExecutor.
  //
  // Enqueueing goes through `POST /sessions/:id/prompt` — the daemon decides
  // run-vs-queue based on session state and reports it back via `task.status`.
  // ============================================================================

  registerAuthenticatedRoute(
    app,
    '/sessions/:id/tasks/queue',
    {
      async find(params: RouteParams) {
        const sessionId = params.route?.id;
        if (!sessionId) throw new Error('Session ID required');

        const taskQueueRepo = new TaskRepository(db);
        const queued = await taskQueueRepo.findQueued(sessionId as SessionID);

        return {
          total: queued.length,
          data: queued,
        };
      },
      // biome-ignore lint/suspicious/noExplicitAny: Service type not compatible with Express
    } as any,
    {
      find: { role: ROLES.MEMBER, action: 'view queue' },
    },
    requireAuth
  );

  // Queue processing implementation — task-centric. Acquires the shared
  // `sessionTurnLocks` (declared near the top of registerRoutes) so the
  // drainer can't race `/sessions/:id/prompt` or `/tasks/:id/run` for the
  // same session. The retry-on-existing-lock indirection (vs. a plain
  // `withSessionTurnLock` wrapper) preserves the original "if drain is in
  // flight, schedule a retry instead of stacking concurrent drainers"
  // semantics — important because callbacks can fire processNextQueuedTask
  // from arbitrary points in the lifecycle.
  const queueRetryScheduled = new Set<SessionID>();

  async function processNextQueuedTask(sessionId: SessionID, params: RouteParams): Promise<void> {
    const existingLock = sessionTurnLocks.get(sessionId);
    if (existingLock) {
      console.log(`⏳ [Queue] Session turn in progress for ${shortId(sessionId)}, waiting...`);
      await existingLock.catch(() => undefined);
      if (!queueRetryScheduled.has(sessionId)) {
        queueRetryScheduled.add(sessionId);
        setImmediate(async () => {
          queueRetryScheduled.delete(sessionId);
          try {
            await processNextQueuedTask(sessionId, params);
          } catch (error) {
            console.error(`❌ [Queue] Retry failed for session ${shortId(sessionId)}:`, error);
          }
        });
      }
      return;
    }

    let resolveLock!: () => void;
    const lockPromise = new Promise<void>((resolve) => {
      resolveLock = resolve;
    });
    sessionTurnLocks.set(sessionId, lockPromise);

    try {
      await processNextQueuedTaskInternal(sessionId, params);
    } finally {
      sessionTurnLocks.delete(sessionId);
      resolveLock();
    }
  }

  async function processNextQueuedTaskInternal(
    sessionId: SessionID,
    params: RouteParams
  ): Promise<void> {
    const taskRepo = new TaskRepository(db);
    const nextTask = await taskRepo.getNextQueued(sessionId);

    if (!nextTask) {
      taskQueueDebug(`📭 No queued tasks for session ${shortId(sessionId)}`);
      return;
    }

    const userId = nextTask.metadata?.queued_by_user_id;
    const userRepo = new UsersRepository(db);
    const queuedByUser = userId ? await userRepo.findById(userId) : undefined;

    const taskParams: RouteParams = queuedByUser
      ? ({
          ...params,
          user: queuedByUser,
        } as RouteParams)
      : params;

    console.log(
      `📬 Processing queued task ${shortId(nextTask.task_id)} ` +
        `(position ${nextTask.queue_position}) ` +
        `with user context: ${queuedByUser ? shortId(queuedByUser.user_id) : 'none'}`
    );

    const session = await reconcileSessionPromptStateIfStuck(
      await sessionsService.get(sessionId, taskParams),
      taskRepo,
      taskParams
    );

    if (!sessionCanStartTask(session.status, session.ready_for_prompt)) {
      console.log(
        `⏸️  [Queue] Session ${shortId(sessionId)} is ${session.status}, task ${shortId(nextTask.task_id)} waiting in queue ` +
          `(will be processed when session becomes IDLE via patch hook)`
      );
      return;
    }

    // Re-read the task — defend against the case where it was already drained
    // by a concurrent caller, or removed by an admin via DELETE /tasks/:id.
    const stillQueued = await taskRepo.findById(nextTask.task_id);
    if (!stillQueued || stillQueued.status !== TaskStatus.QUEUED) {
      console.log(`⚠️  Queued task ${shortId(nextTask.task_id)} no longer queued, skipping`);
      return;
    }

    // spawnTaskExecutor handles the QUEUED → RUNNING transition (recomputes
    // message_range/git_state, writes the user-message row, appends to
    // session.tasks, spawns the executor). We pass the messageSource from
    // task.metadata so callback styling survives the queue → run hop.
    const source = nextTask.metadata?.source;
    await spawnTaskExecutor(
      stillQueued,
      {
        stream: true,
        messageSource: source,
      },
      taskParams
    );

    console.log(`✅ Queued task drained for session ${shortId(sessionId)}`);
  }

  // Inject queue processor into sessions service.
  sessionsService.setQueueProcessor(async (sessionId: SessionID, params?: RouteParams) => {
    try {
      await processNextQueuedTask(sessionId, params || {});
    } catch (error) {
      console.error(`❌ [Sessions] Failed to process queued task:`, error);
    }
  });

  // ============================================================================
  // Permission decision endpoint
  // ============================================================================

  registerAuthenticatedRoute(
    app,
    '/sessions/:id/permission-decision',
    {
      async create(data: PermissionDecision, params: RouteParams) {
        const id = params.route?.id;
        if (!id) throw new Error('Session ID required');
        if (!data.requestId) throw new Error('requestId required');
        if (typeof data.allow !== 'boolean') throw new Error('allow field required');

        const messagesServiceInst = app.service('messages');
        const messages = await messagesServiceInst.find({
          query: {
            session_id: id,
            type: 'permission_request',
          },
        });

        const messageList = isPaginated(messages) ? messages.data : messages;
        const permissionMessage = messageList.find((msg: Message) => {
          const content = msg.content as PermissionRequestContent;
          return content?.request_id === data.requestId;
        });

        if (!permissionMessage) {
          throw new Error(`Permission request ${data.requestId} not found`);
        }

        const permissionContent = permissionMessage.content as PermissionRequestContent;

        if (permissionContent?.status && permissionContent.status !== 'pending') {
          return {
            success: false,
            alreadyResolved: true,
            status: permissionContent.status,
            message: `Permission request already ${permissionContent.status}`,
          };
        }

        const resolvedTaskId = permissionContent.task_id || permissionMessage.task_id;

        if (!resolvedTaskId) {
          console.error(
            `❌ [Permission] Cannot resolve permission: task_id missing from both content and message. requestId=${data.requestId}`
          );
          throw new Error(
            'Cannot process permission decision: task_id is missing. This permission request may be corrupted.'
          );
        }

        await messagesServiceInst.patch(permissionMessage.message_id, {
          content: {
            ...permissionContent,
            status: data.allow ? 'approved' : 'denied',
            scope: data.scope,
            approved_by: data.decidedBy,
            approved_at: new Date().toISOString(),
          },
        });

        permissionService.resolvePermission(data);

        app.service('messages').emit('permission_resolved', {
          requestId: data.requestId,
          taskId: resolvedTaskId,
          sessionId: id,
          allow: data.allow,
          reason: data.reason,
          remember: data.remember,
          scope: data.scope,
          decidedBy: data.decidedBy,
        });

        return { success: true };
      },
    },
    {
      create: { role: ROLES.MEMBER, action: 'respond to permission requests' },
    },
    requireAuth
  );

  // ============================================================================
  // Widget submission / dismissal endpoints
  //
  // See `docs/internal/in-conversation-widgets-design-2026-05-19.md`. The
  // resolver handles auth, idempotency, registry dispatch, message patching,
  // auto-resume task queueing, and the `widget:resolved` broadcast.
  // ============================================================================

  const widgetResolverDeps = {
    // biome-ignore lint/suspicious/noExplicitAny: Feathers Application shape
    app: app as any,
    isBranchOwner: async (branchId: string, userId: UUID) =>
      branchRepository.isOwner(branchId as import('@agor/core/types').BranchID, userId),
    resolveBranchPermission: async (branch: import('@agor/core/types').Branch, userId: UUID) =>
      branchRepository.resolveUserPermission(branch, userId),
  };

  registerAuthenticatedRoute(
    app,
    '/widgets/:id/submit',
    {
      async create(data: Record<string, unknown>, params: RouteParams) {
        const widgetId = params.route?.id;
        if (!widgetId) throw new Error('Widget ID required');
        if (!params.user?.user_id) {
          throw new NotAuthenticated('Authentication required to submit a widget');
        }
        return resolveWidget(
          widgetId,
          { kind: 'submit', body: data ?? {} },
          { user_id: params.user.user_id as UUID, role: params.user.role as string | undefined },
          widgetResolverDeps
        );
      },
    },
    {
      create: { role: ROLES.MEMBER, action: 'submit widgets' },
    },
    requireAuth
  );

  registerAuthenticatedRoute(
    app,
    '/widgets/:id/dismiss',
    {
      async create(_data: unknown, params: RouteParams) {
        const widgetId = params.route?.id;
        if (!widgetId) throw new Error('Widget ID required');
        if (!params.user?.user_id) {
          throw new NotAuthenticated('Authentication required to dismiss a widget');
        }
        return resolveWidget(
          widgetId,
          { kind: 'dismiss' },
          { user_id: params.user.user_id as UUID, role: params.user.role as string | undefined },
          widgetResolverDeps
        );
      },
    },
    {
      create: { role: ROLES.MEMBER, action: 'dismiss widgets' },
    },
    requireAuth
  );

  // ============================================================================
  // Tasks custom routes
  // ============================================================================

  registerAuthenticatedRoute(
    app,
    '/tasks/bulk',
    {
      async create(data: unknown, params: RouteParams) {
        return tasksService.createMany(data as Partial<Task>[]);
      },
    },
    {
      create: { role: ROLES.MEMBER, action: 'create tasks' },
    },
    requireAuth
  );

  registerAuthenticatedRoute(
    app,
    '/tasks/:id/complete',
    {
      async create(
        data: { git_state?: { sha_at_end?: string; commit_message?: string } },
        params: RouteParams
      ) {
        const id = params.route?.id;
        if (!id) throw new Error('Task ID required');
        return tasksService.complete(id, data, params);
      },
    },
    {
      create: { role: ROLES.MEMBER, action: 'complete tasks' },
    },
    requireAuth
  );

  registerAuthenticatedRoute(
    app,
    '/tasks/:id/fail',
    {
      async create(data: { error?: string }, params: RouteParams) {
        const id = params.route?.id;
        if (!id) throw new Error('Task ID required');
        return tasksService.fail(id, data, params);
      },
    },
    {
      create: { role: ROLES.MEMBER, action: 'fail tasks' },
    },
    requireAuth
  );

  // ============================================================================
  // Repos custom routes
  // ============================================================================

  registerAuthenticatedRoute(
    app,
    '/repos/local',
    {
      async create(data: { path: string; slug?: string }, params: RouteParams) {
        return reposService.addLocalRepository(data, params);
      },
    },
    {
      create: { role: ROLES.MEMBER, action: 'add local repositories' },
    },
    requireAuth
  );

  registerAuthenticatedRoute(
    app,
    '/repos/clone',
    {
      async create(
        data: { url: string; name?: string; slug?: string; default_branch?: string },
        params: RouteParams
      ) {
        return reposService.cloneRepository(data, params);
      },
    },
    {
      create: { role: ROLES.MEMBER, action: 'clone repositories' },
    },
    requireAuth
  );

  registerAuthenticatedRoute(
    app,
    '/repos/:id/branches',
    {
      async create(
        data: {
          name: string;
          ref: string;
          createBranch?: boolean;
          refType?: 'branch' | 'tag';
          pullLatest?: boolean;
          sourceBranch?: string;
          issue_url?: string;
          pull_request_url?: string;
          boardId: string;
          /** Explicit board position. Omit to let the service compute a
           *  smart default — preferred for MCP/agent callers. The UI
           *  passes the viewport center so the new card lands where the
           *  user invoked the dialog. */
          position?: { x: number; y: number };
          // Branch storage model — see context/explorations/clone-redesign.md.
          storage_mode?: 'worktree' | 'clone';
          clone_depth?: number;
        },
        params: RouteParams
      ) {
        const id = params.route?.id;
        if (!id) throw new Error('Repo ID required');
        return reposService.createBranch(
          id,
          { ...data, refType: data.refType ?? 'branch' },
          params
        );
      },
    },
    {
      create: { role: ROLES.MEMBER, action: 'create branches' },
    },
    requireAuth
  );

  registerAuthenticatedRoute(
    app,
    '/repos/:id/branches/:name',
    {
      async remove(_id: unknown, params: RouteParams & { route?: { name?: string } }) {
        const id = params.route?.id;
        const name = params.route?.name;
        if (!id) throw new Error('Repo ID required');
        if (!name) throw new Error('Branch name required');
        return reposService.removeBranch(id, name, params);
      },
    },
    {
      remove: { role: ROLES.MEMBER, action: 'remove branches' },
    },
    requireAuth
  );

  registerAuthenticatedRoute(
    app,
    '/repos/:id/import-agor-yml',
    {
      async create(data: { branch_id: string }, params: RouteParams) {
        const id = params.route?.id;
        if (!id) throw new Error('Repo ID required');
        if (!data?.branch_id) throw new Error('branch_id is required');
        return reposService.importFromAgorYml(id, data, params);
      },
    },
    {
      create: { role: ROLES.ADMIN, action: 'import environment config from .agor.yml' },
    },
    requireAuth
  );

  registerAuthenticatedRoute(
    app,
    '/repos/:id/export-agor-yml',
    {
      async create(data: { branch_id: string }, params: RouteParams) {
        const id = params.route?.id;
        if (!id) throw new Error('Repo ID required');
        if (!data?.branch_id) throw new Error('branch_id is required');
        return reposService.exportToAgorYml(id, data, params);
      },
    },
    {
      // Admin-only, matching Import and repo.environment edit. Export writes a
      // file to the branch working tree, so even though the content is
      // derivable, the side effect warrants the same permission bar as import.
      create: { role: ROLES.ADMIN, action: 'export .agor.yml' },
    },
    requireAuth
  );

  // ============================================================================
  // User API Keys routes
  // ============================================================================

  const userApiKeysService = createUserApiKeysService(userApiKeysRepo);

  registerAuthenticatedRoute(
    app,
    '/api/v1/user/api-keys',
    {
      async find(params: AuthenticatedParams) {
        return userApiKeysService.find(params);
      },
      async create(data: { name: string }, params: AuthenticatedParams) {
        return userApiKeysService.create(data, params);
      },
      async patch(id: string, data: { name?: string }, params: AuthenticatedParams) {
        if (!id) throw new BadRequest('API key ID required');
        return userApiKeysService.patch(id, data, params);
      },
      async remove(id: string, params: AuthenticatedParams) {
        if (!id) throw new BadRequest('API key ID required');
        return userApiKeysService.remove(id, params);
      },
    },
    {
      find: { role: ROLES.MEMBER, action: 'list API keys' },
      create: { role: ROLES.MEMBER, action: 'create API keys' },
      patch: { role: ROLES.MEMBER, action: 'update API keys' },
      remove: { role: ROLES.MEMBER, action: 'delete API keys' },
    },
    requireAuth
  );

  // ============================================================================
  // Board comments custom routes (threading + reactions)
  // ============================================================================

  const boardCommentsService = safeService('board-comments') as unknown as {
    toggleReaction: (
      id: string,
      data: { user_id: string; emoji: string },
      params?: unknown
    ) => Promise<import('@agor/core/types').BoardComment>;
    createReply: (
      parentId: string,
      data: Partial<import('@agor/core/types').BoardComment>,
      params?: unknown
    ) => Promise<import('@agor/core/types').BoardComment>;
  };

  if (boardCommentsService)
    registerAuthenticatedRoute(
      app,
      '/board-comments/:id/toggle-reaction',
      {
        async create(data: { user_id: string; emoji: string }, params: RouteParams) {
          const id = params.route?.id;
          if (!id) throw new Error('Comment ID required');
          if (!data.user_id) throw new Error('user_id required');
          if (!data.emoji) throw new Error('emoji required');
          const updated = await boardCommentsService.toggleReaction(id, data, params);
          app.service('board-comments').emit('patched', updated);
          return updated;
        },
      },
      {
        create: { role: ROLES.MEMBER, action: 'react to board comments' },
      },
      requireAuth
    );

  if (boardCommentsService)
    registerAuthenticatedRoute(
      app,
      '/board-comments/:id/reply',
      {
        async create(data: Partial<import('@agor/core/types').BoardComment>, params: RouteParams) {
          const id = params.route?.id;
          if (!id) throw new Error('Comment ID required');
          if (!data.content) throw new Error('content required');
          // Always attribute the reply to the authenticated caller — never trust
          // a client-supplied `created_by`. `requireAuth` upstream guarantees
          // `params.user.user_id`.
          const callerId = (params as { user?: { user_id?: string } }).user?.user_id;
          if (!callerId) throw new Error('Authentication required');
          data.created_by = callerId as import('@agor/core/types').UserID;
          const reply = await boardCommentsService.createReply(id, data, params);
          app.service('board-comments').emit('created', reply);
          return reply;
        },
      },
      {
        create: { role: ROLES.MEMBER, action: 'reply to board comments' },
      },
      requireAuth
    );

  // ============================================================================
  // Branch environment management routes
  // ============================================================================

  const branchesService = app.service('branches') as unknown as BranchesServiceImpl;

  registerAuthenticatedRoute(
    app,
    '/branches/:id/start',
    {
      async create(_data: unknown, params: RouteParams) {
        const id = params.route?.id;
        if (!id) throw new Error('Branch ID required');
        return branchesService.startEnvironment(id as import('@agor/core/types').BranchID, params);
      },
    },
    {
      // Branch `all`/admin control is enforced at the service layer. This
      // route-level gate is just "authenticated" so the service remains
      // the single source of truth across REST, WebSocket, and MCP.
      create: { role: ROLES.VIEWER, action: 'start branch environments' },
    },
    requireAuth
  );

  registerAuthenticatedRoute(
    app,
    '/branches/:id/stop',
    {
      async create(_data: unknown, params: RouteParams) {
        const id = params.route?.id;
        if (!id) throw new Error('Branch ID required');
        return branchesService.stopEnvironment(id as import('@agor/core/types').BranchID, params);
      },
    },
    {
      // Branch `all`/admin control is enforced at the service layer.
      create: { role: ROLES.VIEWER, action: 'stop branch environments' },
    },
    requireAuth
  );

  registerAuthenticatedRoute(
    app,
    '/branches/:id/restart',
    {
      async create(_data: unknown, params: RouteParams) {
        const id = params.route?.id;
        if (!id) throw new Error('Branch ID required');
        return branchesService.restartEnvironment(
          id as import('@agor/core/types').BranchID,
          params
        );
      },
    },
    {
      // Branch `all`/admin control is enforced at the service layer.
      create: { role: ROLES.VIEWER, action: 'restart branch environments' },
    },
    requireAuth
  );

  registerAuthenticatedRoute(
    app,
    '/branches/:id/nuke',
    {
      async create(_data: unknown, params: RouteParams) {
        const id = params.route?.id;
        if (!id) throw new Error('Branch ID required');
        return branchesService.nukeEnvironment(id as import('@agor/core/types').BranchID, params);
      },
    },
    {
      // Branch `all`/admin control is enforced at the service layer.
      create: { role: ROLES.VIEWER, action: 'nuke branch environments' },
    },
    requireAuth
  );

  registerAuthenticatedRoute(
    app,
    '/branches/:id/render-environment',
    {
      async create(data: unknown, params: RouteParams) {
        const id = params.route?.id;
        if (!id) throw new Error('Branch ID required');
        return branchesService.renderEnvironment(
          id as import('@agor/core/types').BranchID,
          data as { variant?: string } | undefined,
          params
        );
      },
    },
    {
      // Branch `all`/admin control is enforced at the service layer.
      create: { role: ROLES.VIEWER, action: 'render branch environment' },
    },
    requireAuth
  );

  registerAuthenticatedRoute(
    app,
    '/branches/:id/health',
    {
      async find(params: RouteParams) {
        const id = params.route?.id;
        if (!id) throw new Error('Branch ID required');
        return branchesService.checkHealth(id as import('@agor/core/types').BranchID, params);
      },
      // biome-ignore lint/suspicious/noExplicitAny: Service type not compatible with Express
    } as any,
    {
      find: { role: ROLES.VIEWER, action: 'check branch health' },
    },
    requireAuth
  );

  // Archive/delete branch
  app.use('/branches/:id/archive-or-delete', {
    async create(data: unknown, params: RouteParams) {
      const id = params.route?.id;
      if (!id) throw new Error('Branch ID required');
      const options = data as {
        metadataAction: 'archive' | 'delete';
        filesystemAction: 'preserved' | 'cleaned' | 'deleted';
      };
      return branchesService.archiveOrDelete(
        id as import('@agor/core/types').BranchID,
        options,
        params
      );
    },
  });

  app.service('/branches/:id/archive-or-delete').hooks({
    before: {
      create: [
        requireAuth,
        requireMinimumRole(ROLES.MEMBER, 'archive or delete branches'),
        async (context: HookContext) => {
          const id = context.params.route?.id;
          if (!id) throw new Error('Branch ID required');

          const branch = await branchRepository.findById(id);
          if (!branch) {
            throw new Forbidden(`Branch not found: ${id}`);
          }

          await cacheBranchAccess(context.params, branchRepository, branch);

          return context;
        },
        branchRbacEnabled
          ? ensureBranchPermission('all', 'archive or delete branches', superadminOpts)
          : (context: HookContext) => {
              const isOwner = context.params.isBranchOwner;
              const userRole = context.params.user?.role;

              if (!isOwner && !hasMinimumRole(userRole, ROLES.ADMIN)) {
                throw new Forbidden(
                  'You must be the branch owner or a global admin to archive/delete branches'
                );
              }
              return context;
            },
      ],
    },
  });

  // Unarchive branch
  app.use('/branches/:id/unarchive', {
    async create(data: unknown, params: RouteParams) {
      const id = params.route?.id;
      if (!id) throw new Error('Branch ID required');
      const options = data as { boardId?: import('@agor/core/types').BoardID };
      return branchesService.unarchive(id as import('@agor/core/types').BranchID, options, params);
    },
  });

  app.service('/branches/:id/unarchive').hooks({
    before: {
      create: [
        requireAuth,
        requireMinimumRole(ROLES.MEMBER, 'unarchive branches'),
        async (context: HookContext) => {
          const id = context.params.route?.id;
          if (!id) throw new Error('Branch ID required');

          const branch = await branchRepository.findById(id);
          if (!branch) {
            throw new Forbidden(`Branch not found: ${id}`);
          }

          await cacheBranchAccess(context.params, branchRepository, branch);

          return context;
        },
        branchRbacEnabled
          ? ensureBranchPermission('all', 'unarchive branches', superadminOpts)
          : (context: HookContext) => {
              const isOwner = context.params.isBranchOwner;
              const userRole = context.params.user?.role;

              if (!isOwner && !hasMinimumRole(userRole, ROLES.ADMIN)) {
                throw new Forbidden(
                  'You must be the branch owner or a global admin to unarchive branches'
                );
              }
              return context;
            },
      ],
    },
  });

  // ============================================================================
  // Run-now (canonical): manually trigger a scheduled run for a schedule.
  // ============================================================================
  // Reuses the scheduler's spawn code path so scheduled and manual triggers
  // produce indistinguishable sessions (beyond a triggered_manually marker).
  // Requires branch-level 'all' permission on the schedule's parent branch
  // (same tier as editing the schedule); see §4.4 of the design doc.
  const scheduleRepository = new ScheduleRepository(db);

  app.use('/schedules/:id/run-now', {
    async create(_data: unknown, params: RouteParams) {
      const id = params.route?.id;
      if (!id) throw new BadRequest('Schedule ID required');

      const scheduler = app.get('scheduler') as SchedulerService | undefined;
      if (!scheduler) {
        throw new NotFound('Scheduler service is not enabled on this instance.');
      }

      const triggeredBy = params.user?.user_id;
      if (!triggeredBy) {
        throw new NotAuthenticated('Authentication required to trigger schedule.');
      }

      try {
        const session = await scheduler.executeScheduleNow({
          scheduleId: id as ScheduleID,
          triggeredBy: triggeredBy as UUID,
        });
        return {
          session_id: session.session_id,
          schedule_id: session.schedule_id,
          branch_id: session.branch_id,
          scheduled_run_at: session.scheduled_run_at,
          triggered_manually: true,
        };
      } catch (err) {
        if (err instanceof ScheduleBusyError) {
          throw new Conflict(err.message, { code: err.code });
        }
        if (err instanceof ScheduleNotReadyError) {
          throw new BadRequest(err.message, { code: err.code });
        }
        throw err;
      }
    },
  });

  app.service('/schedules/:id/run-now').hooks({
    before: {
      create: [
        requireAuth,
        requireMinimumRole(ROLES.MEMBER, 'run schedule'),
        // Reuse the canonical hook so caching semantics (params.schedule
        // / params.branch / params.isBranchOwner) match every other
        // schedule-touching path.
        loadScheduleAndBranch(scheduleRepository, branchRepository),
        ensureScheduleRunsAsCaller(superadminOpts),
        branchRbacEnabled
          ? ensureBranchPermission('all', 'run schedule', superadminOpts)
          : (context: HookContext) => {
              const isOwner = context.params.isBranchOwner;
              const userRole = context.params.user?.role;
              if (!isOwner && !hasMinimumRole(userRole, ROLES.ADMIN)) {
                throw new Forbidden(
                  'You must be the branch owner or a global admin to run schedules'
                );
              }
              return context;
            },
      ],
    },
  });

  // ============================================================================
  // Back-compat shim: POST /branches/:id/execute-schedule-now
  // ============================================================================
  // Pre-#1253 callers fired a single per-branch schedule via this route.
  // Now that a branch can have N schedules, the unambiguous case is "exactly
  // one schedule on this branch" — we forward to that schedule's run-now.
  // Zero or multiple → 400 with a pointer to /schedules/:id/run-now.
  app.use('/branches/:id/execute-schedule-now', {
    async create(_data: unknown, params: RouteParams) {
      const branchId = params.route?.id;
      if (!branchId) throw new BadRequest('Branch ID required');

      const scheduler = app.get('scheduler') as SchedulerService | undefined;
      if (!scheduler) {
        throw new NotFound('Scheduler service is not enabled on this instance.');
      }

      const triggeredBy = params.user?.user_id;
      if (!triggeredBy) {
        throw new NotAuthenticated('Authentication required to trigger schedule.');
      }

      const branch = await branchRepository.findById(branchId);
      if (!branch) throw new NotFound(`Branch not found: ${branchId}`);

      const branchSchedules = await scheduleRepository.findByBranchId(branch.branch_id);
      if (branchSchedules.length === 0) {
        throw new BadRequest(
          `Branch "${branch.name}" has no schedules. Create one and call POST /schedules/:id/run-now instead.`,
          { code: 'no_schedules' }
        );
      }
      if (branchSchedules.length > 1) {
        throw new BadRequest(
          `Branch "${branch.name}" has ${branchSchedules.length} schedules. ` +
            `This route is back-compat only for the single-schedule case. ` +
            `Pick one and call POST /schedules/:id/run-now.`,
          { code: 'ambiguous_schedule' }
        );
      }

      try {
        const session = await scheduler.executeScheduleNow({
          scheduleId: branchSchedules[0].schedule_id,
          triggeredBy: triggeredBy as UUID,
        });
        return {
          session_id: session.session_id,
          schedule_id: session.schedule_id,
          branch_id: session.branch_id,
          scheduled_run_at: session.scheduled_run_at,
          triggered_manually: true,
        };
      } catch (err) {
        if (err instanceof ScheduleBusyError) {
          throw new Conflict(err.message, { code: err.code });
        }
        if (err instanceof ScheduleNotReadyError) {
          throw new BadRequest(err.message, { code: err.code });
        }
        throw err;
      }
    },
  });

  app.service('/branches/:id/execute-schedule-now').hooks({
    before: {
      create: [
        requireAuth,
        requireMinimumRole(ROLES.MEMBER, 'execute scheduled runs'),
        async (context: HookContext) => {
          const id = context.params.route?.id;
          if (!id) throw new BadRequest('Branch ID required');

          const branch = await branchRepository.findById(id);
          if (!branch) {
            throw new NotFound(`Branch not found: ${id}`);
          }

          await cacheBranchAccess(context.params, branchRepository, branch);
          return context;
        },
        branchRbacEnabled
          ? ensureBranchPermission('all', 'execute scheduled runs', superadminOpts)
          : (context: HookContext) => {
              const isOwner = context.params.isBranchOwner;
              const userRole = context.params.user?.role;
              if (!isOwner && !hasMinimumRole(userRole, ROLES.ADMIN)) {
                throw new Forbidden(
                  'You must be the branch owner or a global admin to execute scheduled runs'
                );
              }
              return context;
            },
      ],
    },
  });

  // Branch logs
  registerAuthenticatedRoute(
    app,
    '/branches/logs',
    {
      async find(params: Params) {
        const id = params?.query?.branch_id;

        if (!id) {
          throw new Error('branch_id query parameter required');
        }

        return branchesService.getLogs(id as import('@agor/core/types').BranchID, params);
      },
      // biome-ignore lint/suspicious/noExplicitAny: Service type not compatible with Express
    } as any,
    {
      // Branch `all`/admin control is enforced at the service layer.
      find: { role: ROLES.VIEWER, action: 'view branch logs' },
    },
    requireAuth
  );

  // ============================================================================
  // Boards custom routes
  // ============================================================================

  if (boardsService) {
    registerAuthenticatedRoute(
      app,
      '/boards/:id/sessions',
      {
        async create(data: { sessionId: string }, params: RouteParams) {
          const id = params.route?.id;
          if (!id) throw new Error('Board ID required');
          if (!data.sessionId) throw new Error('Session ID required');
          return boardsService.addSession(id, data.sessionId, params);
        },
      },
      {
        create: { role: ROLES.MEMBER, action: 'modify board sessions' },
      },
      requireAuth
    );
  }

  // Route-side wrapper for session-scoped runtime configuration. These
  // settings can influence what a session process receives, so branch-level
  // read/write tiers are not enough: only the session creator or a global
  // admin/superadmin may read or mutate them.
  const requireSessionScopedConfigOwnerOrAdmin = async (
    sessionId: string,
    // biome-ignore lint/suspicious/noExplicitAny: FeathersJS params type
    params: any
  ): Promise<void> => {
    const user = params?.user;
    if (!user) {
      throw new NotAuthenticated('Authentication required');
    }
    // Fast-path for service accounts — skip the session lookup entirely.
    if (user._isServiceAccount) return;

    const session = await sessionsService.get(sessionId, { provider: undefined });
    if (!session) {
      throw new NotFound(`Session not found: ${sessionId}`);
    }
    checkSessionOwnerOrAdmin(user, session, superadminOpts);
  };

  // ============================================================================
  // Session MCP servers routes
  // ============================================================================

  if (svcEnabled('mcp_servers'))
    registerAuthenticatedRoute(
      app,
      '/sessions/:id/mcp-servers',
      {
        async find(params: RouteParams) {
          const id = params.route?.id;
          if (!id) throw new Error('Session ID required');
          await requireSessionScopedConfigOwnerOrAdmin(id, params);
          const enabledOnly =
            params.query?.enabledOnly === 'true' || params.query?.enabledOnly === true;
          const includeGlobal =
            params.query?.includeGlobal === 'true' || params.query?.includeGlobal === true;
          const includeMetadata =
            params.query?.includeMetadata === 'true' || params.query?.includeMetadata === true;
          const mcpService = app.service('mcp-servers');
          const userId = params.user?.user_id;
          const rawLookupParams = {
            ...params,
            provider: undefined,
            query: {
              ...(userId ? { forUserId: userId } : {}),
            },
          };
          if (includeMetadata) {
            const linksResult = await app.service('session-mcp-servers').find({
              ...params,
              provider: undefined,
              query: {
                session_id: id,
                ...(enabledOnly ? { enabled: true } : {}),
                $limit: 1000,
              },
            });
            const links = (Array.isArray(linksResult) ? linksResult : linksResult.data) as Array<
              SessionMCPServer & { added_at: Date | string | number }
            >;
            const withMetadata = await Promise.all(
              links.map(async (link) => {
                try {
                  const server = await mcpService.get(link.mcp_server_id, rawLookupParams);
                  return {
                    server,
                    added_at: new Date(link.added_at).getTime(),
                    enabled: Boolean(link.enabled),
                  };
                } catch (_error) {
                  return null;
                }
              })
            );
            const entries = withMetadata.filter(
              (entry): entry is Exclude<(typeof withMetadata)[number], null> => entry !== null
            );
            return shouldExposeMCPServerSecrets(params, {
              allowSessionToken: true,
              sessionId: id,
            })
              ? entries
              : entries.map((entry) => ({
                  ...entry,
                  server: redactMCPServerSecrets(entry.server),
                }));
          }
          const sessionServerRefs = await sessionMCPServersService.listServers(
            id as import('@agor/core/types').SessionID,
            enabledOnly,
            params
          );
          const sessionServers = await Promise.all(
            sessionServerRefs.map(async (server) => {
              try {
                return await mcpService.get(server.mcp_server_id, rawLookupParams);
              } catch (_error) {
                return server;
              }
            })
          );
          const globalQuery = {
            scope: 'global',
            ...(enabledOnly ? { enabled: true } : {}),
            ...(userId ? { forUserId: userId } : {}),
            $limit: 1000,
          };
          const globalResult = includeGlobal
            ? await mcpService.find({
                ...params,
                provider: undefined,
                query: globalQuery,
              })
            : [];
          const globalServers = Array.isArray(globalResult) ? globalResult : globalResult.data;
          const servers = includeGlobal
            ? [
                ...new Map(
                  [...globalServers, ...sessionServers].map((server) => [
                    server.mcp_server_id,
                    server,
                  ])
                ).values(),
              ]
            : sessionServers;
          return shouldExposeMCPServerSecrets(params, {
            allowSessionToken: true,
            sessionId: id,
          })
            ? servers
            : servers.map(redactMCPServerSecrets);
        },
        async create(data: { mcpServerId: string }, params: RouteParams) {
          const id = params.route?.id;
          if (!id) throw new Error('Session ID required');
          if (!data.mcpServerId) throw new Error('MCP Server ID required');
          await requireSessionScopedConfigOwnerOrAdmin(id, params);

          await sessionMCPServersService.addServer(
            id as import('@agor/core/types').SessionID,
            data.mcpServerId as import('@agor/core/types').MCPServerID,
            params
          );

          const relationship = {
            session_id: id,
            mcp_server_id: data.mcpServerId,
            enabled: true,
            added_at: new Date(),
          };
          app.service('session-mcp-servers').emit('created', relationship);

          return relationship;
        },
        async remove(mcpId: string, params: RouteParams) {
          const id = params.route?.id;
          if (!id) throw new Error('Session ID required');
          if (!mcpId) throw new Error('MCP Server ID required');
          await requireSessionScopedConfigOwnerOrAdmin(id, params);

          await sessionMCPServersService.removeServer(
            id as import('@agor/core/types').SessionID,
            mcpId as import('@agor/core/types').MCPServerID,
            params
          );

          const relationship = {
            session_id: id,
            mcp_server_id: mcpId,
          };
          app.service('session-mcp-servers').emit('removed', relationship);

          return relationship;
        },
        async patch(mcpId: string, data: { enabled: boolean }, params: RouteParams) {
          const id = params.route?.id;
          if (!id) throw new Error('Session ID required');
          if (!mcpId) throw new Error('MCP Server ID required');
          if (typeof data.enabled !== 'boolean') throw new Error('enabled field required');
          await requireSessionScopedConfigOwnerOrAdmin(id, params);
          return sessionMCPServersService.toggleServer(
            id as import('@agor/core/types').SessionID,
            mcpId as import('@agor/core/types').MCPServerID,
            data.enabled,
            params
          );
        },
        // biome-ignore lint/suspicious/noExplicitAny: Service type not compatible with Express
      } as any,
      {
        find: { role: ROLES.MEMBER, action: 'view session MCP servers' },
        create: { role: ROLES.MEMBER, action: 'modify session MCP servers' },
        remove: { role: ROLES.MEMBER, action: 'modify session MCP servers' },
        patch: { role: ROLES.MEMBER, action: 'modify session MCP servers' },
      },
      requireAuth
    );

  // ============================================================================
  // Session env selections (v0.5 env-var-access)
  //
  // Routes:
  //   GET    /sessions/:id/env-selections           — list selected env var names
  //   POST   /sessions/:id/env-selections           — add one: { envVarName }
  //   DELETE /sessions/:id/env-selections/:name     — remove one
  //   PATCH  /sessions/:id/env-selections           — replace all: { envVarNames: [] }
  //
  // RBAC: only the session's creator or a global admin/superadmin may mutate.
  // Branch `all` permission does NOT grant access — selections expose the
  // creator's private credentials to the executor process.
  // ============================================================================

  // Validate + normalize an `envVarNames` payload: every entry must be a
  // non-empty string, with leading/trailing whitespace trimmed and duplicates
  // removed (first occurrence wins).
  const normalizeEnvVarNames = (value: unknown): string[] => {
    if (!Array.isArray(value)) {
      throw new BadRequest('envVarNames (array of strings) required');
    }
    const seen = new Set<string>();
    const out: string[] = [];
    for (const entry of value) {
      if (typeof entry !== 'string') {
        throw new BadRequest('envVarNames entries must be strings');
      }
      const trimmed = entry.trim();
      if (!trimmed) {
        throw new BadRequest('envVarNames entries must be non-empty');
      }
      if (!seen.has(trimmed)) {
        seen.add(trimmed);
        out.push(trimmed);
      }
    }
    return out;
  };

  registerAuthenticatedRoute(
    app,
    '/sessions/:id/env-selections',
    {
      // GET returns the selected env var names as a plain `string[]` — both
      // the comment above and the UI consumer expect names, not full rows.
      async find(params: RouteParams): Promise<string[]> {
        const id = params.route?.id;
        if (!id) throw new BadRequest('Session ID required');
        // Read permission: session creator OR admin (no branch tier).
        await requireSessionScopedConfigOwnerOrAdmin(id, params);
        const rows = await sessionEnvSelectionsService.list(id as SessionID, params);
        return rows.map((r) => r.env_var_name);
      },
      async create(data: { envVarName: string }, params: RouteParams) {
        const id = params.route?.id;
        if (!id) throw new BadRequest('Session ID required');
        if (!data?.envVarName || typeof data.envVarName !== 'string') {
          throw new BadRequest('envVarName required');
        }
        const name = data.envVarName.trim();
        if (!name) throw new BadRequest('envVarName must be non-empty');
        await requireSessionScopedConfigOwnerOrAdmin(id, params);
        await sessionEnvSelectionsService.add(id as SessionID, name, params);
        const relationship = {
          session_id: id,
          env_var_name: name,
        };
        try {
          app.service('session-env-selections').emit('created', relationship);
        } catch {
          // Event emission is non-fatal
        }
        return relationship;
      },
      async remove(name: string, params: RouteParams) {
        const id = params.route?.id;
        if (!id) throw new BadRequest('Session ID required');
        if (!name) throw new BadRequest('env var name required');
        await requireSessionScopedConfigOwnerOrAdmin(id, params);
        await sessionEnvSelectionsService.remove(id as SessionID, name, params);
        const relationship = {
          session_id: id,
          env_var_name: name,
        };
        try {
          app.service('session-env-selections').emit('removed', relationship);
        } catch {
          // Event emission is non-fatal
        }
        return relationship;
      },
      async patch(_nullId: null, data: { envVarNames: string[] }, params: RouteParams) {
        const id = params.route?.id;
        if (!id) throw new BadRequest('Session ID required');
        const envVarNames = normalizeEnvVarNames(data?.envVarNames);
        await requireSessionScopedConfigOwnerOrAdmin(id, params);
        await sessionEnvSelectionsService.setAll(id as SessionID, envVarNames, params);
        try {
          app
            .service('session-env-selections')
            .emit('patched', { session_id: id, env_var_names: envVarNames });
        } catch {
          // Event emission is non-fatal
        }
        return { session_id: id, env_var_names: envVarNames };
      },
      // biome-ignore lint/suspicious/noExplicitAny: Service type not compatible with Express
    } as any,
    {
      find: { role: ROLES.MEMBER, action: 'view session env selections' },
      create: { role: ROLES.MEMBER, action: 'modify session env selections' },
      remove: { role: ROLES.MEMBER, action: 'modify session env selections' },
      patch: { role: ROLES.MEMBER, action: 'modify session env selections' },
    },
    requireAuth
  );

  // ============================================================================
  // Health endpoint
  // ============================================================================

  app.use('/health', {
    async find(params?: AuthenticatedParams) {
      const publicLaunchAuth = resolvePublicLaunchAuthSettings(config);
      const publicResponse = {
        status: 'ok',
        timestamp: Date.now(),
        version: DAEMON_VERSION,
        // Build identity for the version-sync banner (apps/agor-ui ConnectionStatus).
        // SHA precedence is resolved at startup — see setup/build-info.ts.
        // Tabs capture this SHA on first connect and prompt a refresh whenever
        // a later handshake reports a different value. 'dev' disables the check.
        buildSha: DAEMON_BUILD_INFO.sha,
        builtAt: DAEMON_BUILD_INFO.builtAt,
        auth: {
          requireAuth: true,
          externalLaunch: publicLaunchAuth,
        },
        instance: {
          label: config.daemon?.instanceLabel,
          description: config.daemon?.instanceDescription,
        },
        onboarding: {
          assistantPending:
            config.onboarding?.assistantPending ??
            config.onboarding?.persistedAgentPending ??
            false,
          frameworkRepoUrl: config.onboarding?.frameworkRepoUrl,
          systemCredentials: {
            ANTHROPIC_API_KEY: !!(
              config.credentials?.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY
            ),
            ANTHROPIC_AUTH_TOKEN: !!(
              config.credentials?.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_AUTH_TOKEN
            ),
            ANTHROPIC_BASE_URL: !!(
              config.credentials?.ANTHROPIC_BASE_URL || process.env.ANTHROPIC_BASE_URL
            ),
            OPENAI_API_KEY: !!(config.credentials?.OPENAI_API_KEY || process.env.OPENAI_API_KEY),
            GEMINI_API_KEY: !!(config.credentials?.GEMINI_API_KEY || process.env.GEMINI_API_KEY),
            CURSOR_API_KEY: !!(config.credentials?.CURSOR_API_KEY || process.env.CURSOR_API_KEY),
          },
        },
        services: servicesConfig,
        features: {
          // Web terminal availability: UI should hide terminal buttons when false.
          // Server-side gate in register-hooks.ts is the source of truth; this
          // flag exists so the UI can skip rendering buttons that would fail.
          // Defaults to true when the config key is unset.
          webTerminal: config.execution?.allow_web_terminal !== false,
          // Legacy managed-environment minimum-role value retained for
          // compatibility with older clients. Current environment control
          // authorization is enforced by the branches service from effective
          // branch `all` permission or admin access.
          // Value: 'none' | 'viewer' | 'member' | 'admin' | 'superadmin'.
          // Defaults to 'member' when unset.
          managedEnvsMinimumRole: config.execution?.managed_envs_minimum_role ?? 'member',
          // How managed environment lifecycle fields execute. In
          // webhook-only mode the UI/MCP may still show env controls, but
          // non-URL rendered commands are rejected server-side.
          managedEnvsExecutionMode:
            config.execution?.managed_envs_execution_mode ?? MANAGED_ENV_EXECUTION_MODE_DEFAULT,
          // True when the daemon runs in a multi-user Unix isolation mode
          // (insulated/strict). UI hides "trust everyone on this instance"
          // surfaces when true. Server-side gates (e.g. ArtifactsService.
          // grantTrust) are the source of truth and reject regardless.
          multiUser: (config.execution?.unix_user_mode ?? 'simple') !== 'simple',
          // Cursor SDK provider is available as a beta surface. The legacy
          // cursor_sdk_enabled flag is retained in config for compatibility but
          // no longer gates provider visibility.
          cursorSdk: true,
          // Resolved branch storage policy. The daemon still enforces this at
          // create time; the UI uses it to pick the right default and disable
          // unavailable storage modes before submit.
          branchStorage: resolveBranchStorageConfig(),
        },
      };

      const isAuthenticated = params?.user !== undefined;

      if (isAuthenticated) {
        const dialect = process.env.AGOR_DB_DIALECT === 'postgresql' ? 'postgresql' : 'sqlite';
        let databaseInfo: { dialect: string; url?: string; path?: string };

        if (dialect === 'postgresql') {
          const maskedUrl = DB_PATH.replace(/:([^:@]+)@/, ':****@');
          databaseInfo = { dialect, url: maskedUrl };
        } else {
          databaseInfo = { dialect, path: DB_PATH };
        }

        return {
          ...publicResponse,
          database: databaseInfo,
          auth: {
            ...publicResponse.auth,
            user: params?.user?.email,
            role: params?.user?.role,
          },
          encryption: {
            enabled: !!process.env.AGOR_MASTER_SECRET,
            method: process.env.AGOR_MASTER_SECRET ? 'AES-256-GCM' : null,
          },
          mcp: {
            enabled: config.daemon?.mcpEnabled !== false,
          },
          // Execution mode surfaced so admins can confirm which security tier
          // the daemon booted under. Docker env overrides (AGOR_SET_RBAC_FLAG,
          // AGOR_SET_UNIX_MODE) are written into ~/.agor/config.yaml by the
          // entrypoint before boot, so `config.execution` reflects them.
          execution: {
            branchRbac: config.execution?.branch_rbac === true,
            unixUserMode: config.execution?.unix_user_mode ?? 'simple',
            managedEnvsExecutionMode:
              config.execution?.managed_envs_execution_mode ?? MANAGED_ENV_EXECUTION_MODE_DEFAULT,
          },
          // Resolved security posture — admins can confirm in Settings → About
          // which CSP/CORS policy the daemon booted with, without tailing logs
          // or reading response headers by hand. Keep the shape tight: the
          // full CSP header value is the one piece operators actually need
          // when debugging a blocked resource.
          security: {
            csp: {
              enabled: !resolvedSecurity.csp.disabled,
              reportOnly: resolvedSecurity.csp.reportOnly,
              reportUri: resolvedSecurity.csp.reportUri,
              header: resolvedSecurity.csp.headerValue,
            },
            cors: {
              mode: resolvedSecurity.cors.mode,
              credentials: resolvedSecurity.cors.credentials,
              originCount: resolvedSecurity.cors.origins.length,
              allowSandpack: resolvedSecurity.cors.allowSandpack,
            },
          },
        };
      }

      return publicResponse;
    },
  });

  // biome-ignore lint/suspicious/noExplicitAny: FeathersJS service type not fully typed
  const healthService = app.service('health') as any;
  healthService.docs = {
    description: 'Health check endpoint (always public)',
    security: [],
  };

  // ============================================================================
  // OpenCode models + health endpoints
  // ============================================================================

  app.use('/opencode/models', {
    async find() {
      try {
        const freshConfig = await loadConfig();
        const opencodeConfig = freshConfig.opencode;
        if (!opencodeConfig?.enabled) {
          throw new Error('OpenCode is not enabled in configuration');
        }

        const serverUrl = opencodeConfig.serverUrl || 'http://localhost:4096';
        console.log('[OpenCode] Fetching models from server:', serverUrl);

        const response = await fetch(`${serverUrl}/config/providers`);

        if (!response.ok) {
          throw new Error(`OpenCode server returned ${response.status}: ${response.statusText}`);
        }

        const data = (await response.json()) as {
          providers: Array<{
            id: string;
            name: string;
            models: Record<string, { name?: string }>;
          }>;
          default: Record<string, string>;
        };

        const connectedProviders = data.providers;

        const transformedProviders = connectedProviders.map((provider) => ({
          id: provider.id,
          name: provider.name,
          models: Object.entries(provider.models)
            .map(([modelId, modelMeta]) => ({
              id: modelId,
              name: modelMeta.name || modelId,
            }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        }));

        return {
          providers: transformedProviders,
          default: data.default,
          serverUrl: serverUrl,
        };
      } catch (error) {
        console.error('[OpenCode] Failed to fetch models:', error);
        throw new Error(
          `Failed to fetch OpenCode models: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    },
  });

  // biome-ignore lint/suspicious/noExplicitAny: FeathersJS service type not fully typed
  const opencodeModelsService = app.service('opencode/models') as any;
  opencodeModelsService.docs = {
    description: 'Get available OpenCode providers and models (requires OpenCode server running)',
    security: [],
  };

  app.use('/opencode/health', {
    // biome-ignore lint/suspicious/noExplicitAny: FeathersJS params type varies, runtime query param check
    async find(params?: any) {
      try {
        let serverUrl: string;

        if (params?.query?.serverUrl) {
          serverUrl = params.query.serverUrl;
        } else {
          const freshConfig = await loadConfig();
          const opencodeConfig = freshConfig.opencode;
          if (!opencodeConfig?.enabled) {
            throw new Error('OpenCode is not enabled in configuration');
          }
          serverUrl = opencodeConfig.serverUrl || 'http://localhost:4096';
        }

        const response = await fetch(`${serverUrl}/config`);

        return {
          connected: response.ok,
          status: response.status,
          serverUrl: serverUrl,
        };
      } catch (error) {
        console.error('[OpenCode] Health check failed:', error);
        return {
          connected: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });

  // biome-ignore lint/suspicious/noExplicitAny: FeathersJS service type not fully typed
  const opencodeHealthService = app.service('opencode/health') as any;
  opencodeHealthService.docs = {
    description: 'Test connection to OpenCode server',
    security: [],
  };

  // ============================================================================
  // Apply service tier hooks
  // ============================================================================

  const SERVICE_GROUP_PATHS: Partial<Record<ServiceGroupName, string[]>> = {
    core: ['sessions', 'tasks', 'messages'],
    branches: ['branches'],
    repos: ['repos'],
    users: ['users'],
    boards: ['boards', 'board-objects', 'board-comments'],
    cards: ['cards', 'card-types'],
    artifacts: ['artifacts'],
    gateway: ['gateway', 'gateway-channels', 'thread-session-map'],
    terminals: ['terminals'],
    file_browser: ['file', 'files', 'context'],
    mcp_servers: ['mcp-servers', 'session-mcp-servers'],
    leaderboard: ['leaderboard'],
    knowledge: [
      'kb/namespaces',
      'kb/documents',
      'kb/versions',
      'kb/search',
      'kb/settings',
      'kb/indexing/status',
      'kb/indexing/reindex',
      'kb/graph',
    ],
  };

  const mappedGroups = new Set(Object.keys(SERVICE_GROUP_PATHS));
  for (const name of SERVICE_GROUP_NAMES) {
    if (!mappedGroups.has(name)) {
      console.warn(
        `[services] Service group '${name}' has no path mapping — tier hooks will not apply`
      );
    }
  }

  for (const [group, paths] of Object.entries(SERVICE_GROUP_PATHS)) {
    const tier = svcTier(group as string);
    if (tier === 'on' || tier === 'off') continue;
    for (const path of paths) {
      try {
        applyTierHooks(app, path, tier);
      } catch {
        // Service may not be registered
      }
    }
  }

  // ============================================================================
  // MCP routes
  // ============================================================================

  if (config.daemon?.mcpEnabled !== false) {
    const { setupMCPRoutes } = await import('./mcp/server.js');
    const toolSearchEnabled = config.daemon?.mcpToolSearch !== false;
    setupMCPRoutes(app, db, toolSearchEnabled, servicesConfig);
    console.log(
      `✅ MCP server enabled at POST /mcp${toolSearchEnabled ? ' (tool search mode)' : ''}`
    );
  } else {
    console.log('🔒 MCP server disabled via config (daemon.mcpEnabled=false)');
  }

  // ============================================================================
  // Global app hooks + error handler
  // ============================================================================

  app.hooks({
    before: {
      all: [enforcePasswordChange],
    },
  });

  // biome-ignore lint/suspicious/noExplicitAny: FeathersJS app.use expects service path, but errorHandler is Express middleware
  (app as any).use(errorHandler());
}
