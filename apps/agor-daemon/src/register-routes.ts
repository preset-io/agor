/**
 * Authentication & Custom REST Routes Registration
 *
 * Registers authentication configuration, token refresh, custom REST
 * endpoints (prompt, stop, fork, spawn, upload, etc.), and service-tier hooks.
 * Extracted from index.ts for maintainability.
 */

import { type AgorConfig, loadConfig } from '@agor/core/config';
import {
  type Database,
  generateId,
  MCPServerRepository,
  MessagesRepository,
  RepoRepository,
  SessionMCPServerRepository,
  SessionRepository,
  TaskRepository,
  UsersRepository,
  WorktreeRepository,
} from '@agor/core/db';
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
  InputRequestContent,
  Message,
  MessageSource,
  Paginated,
  Params,
  PermissionRequestContent,
  ServiceGroupName,
  ServiceTier,
  SessionID,
  StreamingEventType,
  Task,
  User,
  UUID,
  WorktreeID,
} from '@agor/core/types';
import {
  AGENTIC_TOOL_CAPABILITIES,
  hasMinimumRole,
  ROLES,
  SERVICE_GROUP_NAMES,
  SessionStatus,
  TaskStatus,
} from '@agor/core/types';
import { NotFoundError } from '@agor/core/utils/errors';
import type { Request } from 'express';
import { rateLimit } from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import type {
  BoardsServiceImpl,
  MessagesServiceImpl,
  ReposServiceImpl,
  SessionsServiceImpl,
  TasksServiceImpl,
  WorktreesServiceImpl,
} from './declarations.js';
import { killExecutorProcess } from './executor-tracking.js';
import {
  ScheduleBusyError,
  ScheduleNotReadyError,
  type SchedulerService,
} from './services/scheduler.js';
import type { TerminalsService } from './services/terminals.js';
import { createUserApiKeysService } from './services/user-api-keys.js';
import { registerProxies } from './setup/proxies.js';
import { applyTierHooks } from './setup/service-tiers.js';
import { AnonymousStrategy } from './strategies/anonymous.js';
import { buildAuthRateLimitKey } from './utils/auth-rate-limit-key.js';
import {
  ensureMinimumRole,
  registerAuthenticatedRoute,
  requireMinimumRole,
} from './utils/authorization.js';
import {
  createUploadMiddleware,
  enforceParsedTotalUploadSize,
  enforceTotalUploadSize,
} from './utils/upload.js';
import {
  checkSessionOwnerOrAdmin,
  ensureWorktreePermission,
  PERMISSION_RANK,
  resolveWorktreePermission,
} from './utils/worktree-authorization.js';

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

/**
 * Type guard to check if result is paginated
 */
function isPaginated<T>(result: T[] | Paginated<T>): result is Paginated<T> {
  return !Array.isArray(result) && 'data' in result && 'total' in result;
}

/**
 * Sanitize a user-provided field (name, email) before interpolating into prompts.
 * Strips newlines and control characters to prevent prompt injection, and caps length.
 */
function sanitizeUserField(value: string, maxLength = 100): string {
  return value
    .replace(/[\r\n\t]/g, ' ')
    .trim()
    .substring(0, maxLength);
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
  worktreeRbacEnabled: boolean;
  allowAnonymous: boolean;
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
  worktreeRepository: WorktreeRepository;
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
    worktreeRbacEnabled,
    allowAnonymous,
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
    worktreeRepository,
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

  const authStrategiesArray = ['api-key', 'jwt', 'local', 'anonymous'];
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
      audience: 'https://agor.dev',
      issuer: 'agor',
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
  authentication.register('jwt', new ServiceJWTStrategy());
  authentication.register('local', new LocalStrategy());
  authentication.register('anonymous', new AnonymousStrategy());

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
    before: {
      create: [
        // biome-ignore lint/suspicious/noExplicitAny: FeathersJS context type not fully typed
        async (context: any) => {
          const data = Array.isArray(context.data) ? context.data[0] : context.data;
          console.log('🔐 Authentication attempt:', {
            strategy: data?.strategy,
            email: data?.email,
            hasPassword: !!data?.password,
          });
          return context;
        },
      ],
    },
    after: {
      create: [
        // biome-ignore lint/suspicious/noExplicitAny: FeathersJS context type not fully typed
        async (context: any) => {
          console.log('✅ Authentication succeeded:', {
            strategy: context.result?.authentication?.strategy,
            hasUser: !!context.result?.user,
            user_id: context.result?.user?.user_id,
            hasAccessToken: !!context.result?.accessToken,
          });

          if (context.result?.user && context.result.user.user_id !== 'anonymous') {
            const refreshToken = jwt.sign(
              {
                sub: context.result.user.user_id,
                type: 'refresh',
              },
              jwtSecret,
              {
                expiresIn: REFRESH_TOKEN_TTL,
                issuer: 'agor',
                audience: 'https://agor.dev',
              }
            );

            context.result.refreshToken = refreshToken;
          }
          return context;
        },
      ],
    },
  });

  // ============================================================================
  // Refresh token endpoint
  // ============================================================================

  app.use('/authentication/refresh', {
    async create(data: { refreshToken: string }, _params?: Params) {
      // Rate limiting handled by express-rate-limit at the
      // /authentication mount point (path-prefix match catches /refresh).
      try {
        const decoded = jwt.verify(data.refreshToken, jwtSecret, {
          issuer: 'agor',
          audience: 'https://agor.dev',
        }) as { sub: string; type: string };

        if (decoded.type !== 'refresh') {
          throw new Error('Invalid token type');
        }

        const user = await usersService.get(decoded.sub as import('@agor/core/types').UUID);

        // Use the SAME ACCESS_TOKEN_TTL as the auth-service config above —
        // otherwise this endpoint silently downgrades the access-token
        // hardening. Refresh tokens get the standard 30-day TTL.
        const accessToken = jwt.sign({ sub: user.user_id, type: 'access' }, jwtSecret, {
          expiresIn: ACCESS_TOKEN_TTL,
          issuer: 'agor',
          audience: 'https://agor.dev',
        });

        const newRefreshToken = jwt.sign({ sub: user.user_id, type: 'refresh' }, jwtSecret, {
          expiresIn: REFRESH_TOKEN_TTL,
          issuer: 'agor',
          audience: 'https://agor.dev',
        });

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
          accessToken,
          refreshToken: newRefreshToken,
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
      if (!authParams?.user || !authParams.user.user_id) {
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

      const accessToken = jwt.sign(
        {
          sub: targetUser.user_id,
          type: 'access',
          impersonated_by: caller.user_id,
          is_impersonated: true,
          jti,
        },
        jwtSecret,
        {
          expiresIn: Math.ceil(expiryMs / 1000),
          issuer: 'agor',
          audience: 'https://agor.dev',
        }
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
  const _worktreesRepo = new WorktreeRepository(db);
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
        const _ = params;
        app.service('tasks').emit(data.event, data.data);
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
        console.log(`🔀 Forking session: ${id.substring(0, 8)}`);
        const forkedSession = await sessionsService.fork(id, data, params);
        console.log(`✅ Fork created: ${forkedSession.session_id.substring(0, 8)}`);

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
        console.log(`🌱 Spawning session from: ${id.substring(0, 8)}`);
        const spawnedSession = await sessionsService.spawn(id, data, params);
        console.log(`✅ Spawn created: ${spawnedSession.session_id.substring(0, 8)}`);

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
      async find(_data: unknown, params: RouteParams) {
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
        console.log(
          `⚠️  ${entityType} ${id.substring(0, 8)} was deleted mid-execution - skipping update`
        );
        return false;
      }
      throw error;
    }
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

    // Recapture git state — the sentinels stored on a queued row are
    // intentionally invalid; this is the moment we pin real values.
    const { captureGitStateViaShell } = await import('./utils/git-shell-capture.js');
    let gitStateAtStart = 'unknown';
    let refAtStart = 'unknown';
    if (session.worktree_id) {
      try {
        const worktree = await app.service('worktrees').get(session.worktree_id, params);
        const gitState = await captureGitStateViaShell(worktree.path);
        gitStateAtStart = gitState.sha;
        refAtStart = gitState.ref;
        if (gitStateAtStart === 'unknown') {
          console.warn(
            `[Git State] captureGitStateViaShell returned 'unknown' for worktree ${worktree.path} (ref: ${refAtStart})`
          );
        }
      } catch (error) {
        console.warn(
          `[Git State] Failed to get git state for worktree ${session.worktree_id}:`,
          error
        );
      }
    }

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

        const userMessage: Message = {
          message_id: generateId() as UUID,
          session_id: task.session_id,
          // Callback messages are typed `system` so the UI shows the special
          // Agor-callback styling. Normal prompts stay `user`.
          type: isCallback ? 'system' : 'user',
          role: 'user' as Message['role'],
          index: messageStartIndex,
          timestamp: startTimestamp,
          content_preview: task.full_prompt.substring(0, 200),
          content: task.full_prompt,
          task_id: task.task_id,
          metadata: Object.keys(messageMetadata).length > 0 ? messageMetadata : undefined,
        };
        await app.service('messages').create(userMessage, params);
      } catch (msgErr) {
        // Don't fail the spawn — the executor's createUserMessage fallback
        // (with skip-if-exists) will write the row when it connects.
        console.warn(
          `⚠️  [Daemon] Failed to write initial user-message row for task ${task.task_id.substring(0, 8)} (executor will retry):`,
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

    // Build prompter context — preserved from the previous inline impl.
    let promptForExecutor = task.full_prompt;
    const prompterUserId = params.user?.user_id;
    if (prompterUserId && prompterUserId !== session.created_by) {
      try {
        const prompterUserRepo = new UsersRepository(db);
        const prompterUser = await prompterUserRepo.findById(prompterUserId);
        if (prompterUser) {
          const prompterName = sanitizeUserField(prompterUser.name || prompterUser.email);
          const prompterEmail = sanitizeUserField(prompterUser.email);
          promptForExecutor = `[Prompted by: ${prompterName} (${prompterEmail})]\n\n${task.full_prompt}`;
        }
      } catch (err) {
        console.warn(
          `[Prompt] Failed to look up prompter user ${prompterUserId.substring(0, 8)}:`,
          err
        );
      }
    }

    const useStreaming = options.stream !== false;
    const sessionId = task.session_id;
    const taskId = task.task_id;

    // Background spawn + failure handling. Returning the patched Task to the
    // caller before this resolves matches the previous behavior — the HTTP
    // response should not block on the executor process being live.
    setImmediate(async () => {
      try {
        console.log(
          `🚀 [Daemon] Routing ${session.agentic_tool} to Feathers/WebSocket executor (task ${taskId.substring(0, 8)})`
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
          `✅ [Daemon] Executor spawned for session ${sessionId.substring(0, 8)}, waiting for task completion`
        );
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(
          `❌ [Daemon] Executor spawn failed for session=${sessionId.substring(0, 8)} task=${taskId.substring(0, 8)} agent=${session.agentic_tool} unix_username=${session.unix_username ?? 'null'}: ${errorMessage}`,
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
          const sysIndex = await sessionsRepository.countMessages(sessionId);
          const errorContent = `⚠️ The agent failed to start.\n\n${errorMessage}`;
          const sysMessage: Message = {
            message_id: generateId() as UUID,
            session_id: sessionId,
            type: 'system',
            role: 'assistant' as Message['role'],
            index: sysIndex,
            timestamp: new Date().toISOString(),
            content_preview: errorContent.substring(0, 200),
            content: errorContent,
            task_id: taskId,
            metadata: { is_meta: true },
          };
          await app.service('messages').create(sysMessage, params);
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
        },
        params: RouteParams
      ) {
        console.log(`📨 [Daemon] Prompt request for session ${params.route?.id?.substring(0, 8)}`);
        console.log(`   Permission mode: ${data.permissionMode || 'not specified'}`);
        console.log(`   Streaming: ${data.stream !== false}`);
        console.log(`   Message source: ${data.messageSource || 'not specified'}`);

        let id = params.route?.id;
        if (!id) throw new Error('Session ID required');
        if (!data.prompt) throw new Error('Prompt required');

        // Validate and normalize messageSource
        let messageSource: 'gateway' | 'agor' | undefined = data.messageSource;
        if (
          messageSource !== undefined &&
          messageSource !== 'gateway' &&
          messageSource !== 'agor'
        ) {
          console.warn(
            `[Daemon] Invalid messageSource value: ${messageSource}, defaulting based on provider`
          );
          messageSource = params.provider ? 'agor' : undefined;
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
            `📦 [Prompt] Auto-unarchiving session ${id.substring(0, 8)} (was archived: ${session.archived_reason || 'unknown reason'})`
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
        const taskRepo = new TaskRepository(db);
        const queuedTasks = await taskRepo.findQueued(id as SessionID);
        const shouldQueue = session.status !== SessionStatus.IDLE || queuedTasks.length > 0;
        const createdBy = params.user?.user_id ?? 'anonymous';

        if (shouldQueue) {
          const queuedTask = await taskRepo.createPending({
            session_id: id as SessionID,
            full_prompt: data.prompt,
            created_by: createdBy,
            status: TaskStatus.QUEUED,
            metadata: {
              ...(params.user?.user_id ? { queued_by_user_id: params.user.user_id } : {}),
              ...(messageSource ? { source: messageSource } : {}),
            },
          });

          console.log(
            `📬 [Prompt] Auto-queued task for session ${id.substring(0, 8)} at position ${queuedTask.queue_position} ` +
              `(session status: ${session.status}, existing queue items: ${queuedTasks.length})`
          );

          app.service('tasks').emit('queued', queuedTask);

          if (session.status === SessionStatus.IDLE) {
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

        console.log(`   Session agent: ${session.agentic_tool}`);
        console.log(
          `   Session permission_config.mode: ${session.permission_config?.mode || 'not set'}`
        );

        // Idle path: create a CREATED task, then hand off to spawnTaskExecutor
        // which is the sole place that populates message_range / git_state,
        // writes the user-message row, and spawns the executor. Both this
        // path and processNextQueuedTask go through that helper so behavior
        // stays in lockstep.
        const task = await taskRepo.createPending({
          session_id: id as SessionID,
          full_prompt: data.prompt,
          created_by: createdBy,
          status: TaskStatus.CREATED,
          metadata: messageSource ? { source: messageSource } : undefined,
        });
        // Bypassing the service means no native 'created' emit; do it here
        // so reactive clients see the new task before the executor spawns.
        app.service('tasks').emit('created', task);

        const runningTask = await spawnTaskExecutor(
          task,
          {
            permissionMode: data.permissionMode,
            stream: data.stream !== false,
            messageSource,
          },
          params
        );

        return runningTask;
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
  // `agor_worktrees_set_zone(triggerTemplate: true)` always_new branch)
  // does render → validate → resolve defaults → create session → attach MCPs
  // → prompt in one round-trip.
  // ============================================================================

  registerAuthenticatedRoute(
    app,
    '/worktrees/:id/fire-zone-trigger',
    {
      async create(data: { zoneId?: string }, params: RouteParams) {
        const worktreeId = params.route?.id;
        if (!worktreeId) throw new BadRequest('Worktree ID required');
        if (typeof data?.zoneId !== 'string' || !data.zoneId.trim()) {
          throw new BadRequest('zoneId (string) is required');
        }

        const worktree = await app.service('worktrees').get(worktreeId, params);
        if (!worktree.board_id) {
          throw new BadRequest('Worktree is not on a board; cannot resolve zone');
        }
        const board = await app.service('boards').get(worktree.board_id, params);

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
        if (!zoneObj || zoneObj.type !== 'zone') {
          throw new BadRequest(`Zone ${data.zoneId} not found on board ${worktree.board_id}`);
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
            worktree,
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
  const worktreeRepo = new WorktreeRepository(db);
  const uploadMiddleware = createUploadMiddleware(sessionRepo, worktreeRepo);
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
        console.log(`📎 [Upload Handler] Processing for session ${sessionId?.substring(0, 8)}`);
        console.log(`   Destination: ${destination || 'worktree'}`);
        console.log(`   Notify agent: ${notifyAgent === 'true' || notifyAgent === true}`);
        console.log(`   Files received: ${files?.length || 0}`);
      }

      const params = req.feathers as AuthenticatedParams;
      if (DEBUG_UPLOAD) {
        console.log(`   Auth params:`, {
          hasUser: !!params?.user,
          userId: params?.user?.user_id?.substring(0, 8),
          provider: params?.provider,
        });
      }

      ensureMinimumRole(params, ROLES.MEMBER, 'upload files');

      const session = await sessionsService.get(sessionId, params);
      if (!session) {
        console.error(`❌ [Upload Handler] Session not found: ${sessionId.substring(0, 8)}`);
        return res.status(404).json({ error: 'Session not found' });
      }

      // Worktree RBAC: mirror ensureCanPromptInSession semantics.
      // - 'prompt'/'all' → upload to any session
      // - 'session'      → upload only to own sessions
      // - 'view'/'none'  → denied
      // Fail-closed: if RBAC is enabled but worktree can't be resolved, deny.
      // When RBAC is disabled, any authenticated member can upload.
      if (worktreeRbacEnabled) {
        const userId = params.user?.user_id as UUID;
        if (!session.worktree_id) {
          return res.status(403).json({ error: 'Not authorized to upload to this session' });
        }
        const wt = await worktreeRepo.findById(session.worktree_id);
        if (!wt) {
          return res.status(404).json({ error: 'Worktree not found' });
        }
        const isOwner = await worktreeRepo.isOwner(wt.worktree_id, userId);
        const effectiveLevel = resolveWorktreePermission(
          wt,
          userId,
          isOwner,
          params.user?.role,
          superadminOpts.allowSuperadmin
        );

        const canUpload =
          PERMISSION_RANK[effectiveLevel] >= PERMISSION_RANK.prompt ||
          (effectiveLevel === 'session' && session.created_by === userId);

        if (!canUpload) {
          console.error(
            `❌ [Upload Handler] User ${userId.substring(0, 8)} has '${effectiveLevel}' permission, cannot upload to worktree ${wt.worktree_id.substring(0, 8)}`
          );
          return res.status(403).json({ error: 'Not authorized to upload to this session' });
        }
      }

      if (!files || files.length === 0) {
        console.error('❌ [Upload Handler] No files in request');
        return res.status(400).json({ error: 'No files uploaded' });
      }

      let worktree: Awaited<ReturnType<typeof worktreeRepo.findById>> | undefined;
      if (session.worktree_id) {
        worktree = await worktreeRepo.findById(session.worktree_id);
      }

      const uploadedFiles = files.map((f) => {
        let relativePath = f.path;
        if (worktree && f.path.startsWith(worktree.path)) {
          relativePath = f.path.substring(worktree.path.length + 1);
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
      console.log('   Session ID param:', req.params.sessionId?.substring(0, 8));
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
        console.log('   User:', result.user?.user_id?.substring(0, 8));
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
        console.log('   User:', req.feathers?.user?.user_id?.substring(0, 8) || 'anonymous');
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

        const targetTasksArray: Task[] = [];

        for (const status of [
          TaskStatus.RUNNING,
          TaskStatus.AWAITING_PERMISSION,
          TaskStatus.STOPPING,
        ]) {
          const result = await tasksService.find({
            query: { session_id: id, status, $limit: 10 },
          });
          const findResult = result as Task[] | Paginated<Task>;
          const tasks = isPaginated(findResult) ? findResult.data : findResult;
          targetTasksArray.push(...tasks);
        }

        if (targetTasksArray.length === 0) {
          console.warn(
            `⚠️  [Stop] No active tasks for session ${id.substring(0, 8)}, resetting to IDLE${stopReason ? ` (reason: ${stopReason})` : ''}`
          );
          // ready_for_prompt: true so the post-patch hook drains any QUEUED tasks.
          // Stop is "skip current", not "wipe everything" — queued prompts represent
          // user intent and should still execute.
          await app.service('sessions').patch(
            id,
            {
              status: SessionStatus.IDLE,
              ready_for_prompt: true,
            },
            params
          );
          return {
            success: true,
            status: SessionStatus.IDLE,
            reason: 'No active tasks found, session reset to idle',
          };
        }

        targetTasksArray.sort((a, b) => {
          const timeA = new Date(a.started_at || a.created_at).getTime();
          const timeB = new Date(b.started_at || b.created_at).getTime();
          return timeB - timeA;
        });
        const latestTask = targetTasksArray[0];

        console.log(
          `🛑 [Stop] Stopping task ${latestTask.task_id.substring(0, 8)} for session ${id.substring(0, 8)}${stopReason ? ` (reason: ${stopReason})` : ''}`
        );

        const processKilled = killExecutorProcess(id);
        if (!processKilled) {
          console.warn(
            `⚠️  [Stop] No tracked process for session ${id.substring(0, 8)} — executor may have already exited`
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
          // ready_for_prompt: true so the post-patch hook drains any QUEUED tasks.
          // Stop is "skip current", not "wipe everything" — queued prompts represent
          // user intent and should still execute.
          await app.service('sessions').patch(
            id,
            {
              status: SessionStatus.IDLE,
              ready_for_prompt: true,
            },
            params
          );
        } catch (error) {
          console.error(`❌ [Stop] Failed to patch session to IDLE:`, error);
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

  // Queue processing implementation — task-centric.
  const queueProcessingLocks = new Map<SessionID, Promise<void>>();
  const queueRetryScheduled = new Set<SessionID>();

  async function processNextQueuedTask(sessionId: SessionID, params: RouteParams): Promise<void> {
    const existingLock = queueProcessingLocks.get(sessionId);
    if (existingLock) {
      console.log(
        `⏳ [Queue] Processing in progress for session ${sessionId.substring(0, 8)}, waiting...`
      );
      await existingLock;
      if (!queueRetryScheduled.has(sessionId)) {
        queueRetryScheduled.add(sessionId);
        setImmediate(async () => {
          queueRetryScheduled.delete(sessionId);
          try {
            await processNextQueuedTask(sessionId, params);
          } catch (error) {
            console.error(
              `❌ [Queue] Retry failed for session ${sessionId.substring(0, 8)}:`,
              error
            );
          }
        });
      }
      return;
    }

    const processingPromise = processNextQueuedTaskInternal(sessionId, params);

    queueProcessingLocks.set(
      sessionId,
      processingPromise.catch(() => {
        // Swallow error for waiters
      })
    );

    try {
      await processingPromise;
    } finally {
      queueProcessingLocks.delete(sessionId);
    }
  }

  async function processNextQueuedTaskInternal(
    sessionId: SessionID,
    params: RouteParams
  ): Promise<void> {
    const taskRepo = new TaskRepository(db);
    const nextTask = await taskRepo.getNextQueued(sessionId);

    if (!nextTask) {
      console.log(`📭 No queued tasks for session ${sessionId.substring(0, 8)}`);
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
      `📬 Processing queued task ${nextTask.task_id.substring(0, 8)} ` +
        `(position ${nextTask.queue_position}) ` +
        `with user context: ${queuedByUser ? queuedByUser.user_id.substring(0, 8) : 'none'}`
    );

    const session = await sessionsService.get(sessionId, taskParams);

    if (session.status !== SessionStatus.IDLE) {
      console.log(
        `⏸️  [Queue] Session ${sessionId.substring(0, 8)} is ${session.status}, task ${nextTask.task_id.substring(0, 8)} waiting in queue ` +
          `(will be processed when session becomes IDLE via patch hook)`
      );
      return;
    }

    // Re-read the task — defend against the case where it was already drained
    // by a concurrent caller, or removed by an admin via DELETE /tasks/:id.
    const stillQueued = await taskRepo.findById(nextTask.task_id);
    if (!stillQueued || stillQueued.status !== TaskStatus.QUEUED) {
      console.log(`⚠️  Queued task ${nextTask.task_id.substring(0, 8)} no longer queued, skipping`);
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

    console.log(`✅ Queued task drained for session ${sessionId.substring(0, 8)}`);
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
  // Input response endpoint
  // ============================================================================

  registerAuthenticatedRoute(
    app,
    '/sessions/:id/input-response',
    {
      async create(
        data: {
          requestId: string;
          taskId?: string;
          answers: Record<string, string>;
          annotations?: Record<string, { markdown?: string; notes?: string }>;
          respondedBy: string;
        },
        params: RouteParams
      ) {
        const id = params.route?.id;
        if (!id) throw new Error('Session ID required');
        if (!data.requestId) throw new Error('requestId required');
        if (!data.answers) throw new Error('answers required');

        const messagesServiceInst = app.service('messages');
        const messages = await messagesServiceInst.find({
          query: {
            session_id: id,
            type: 'input_request',
          },
        });

        const messageList = isPaginated(messages) ? messages.data : messages;
        const inputMessage = messageList.find((msg: Message) => {
          const content = msg.content as InputRequestContent;
          return content?.request_id === data.requestId;
        });

        if (!inputMessage) {
          throw new Error(`Input request ${data.requestId} not found`);
        }

        const inputContent = inputMessage.content as InputRequestContent;

        if (inputContent?.status && inputContent.status !== 'pending') {
          return {
            success: false,
            alreadyResolved: true,
            status: inputContent.status,
            message: `Input request already ${inputContent.status}`,
          };
        }

        const resolvedTaskId = inputContent.task_id || inputMessage.task_id;

        if (!resolvedTaskId) {
          throw new Error('Cannot process input response: task_id is missing.');
        }

        await messagesServiceInst.patch(inputMessage.message_id, {
          content: {
            ...inputContent,
            status: 'answered',
            answers: data.answers,
            annotations: data.annotations,
            answered_by: data.respondedBy,
            answered_at: new Date().toISOString(),
          },
        });

        app.service('messages').emit('input_resolved', {
          requestId: data.requestId,
          taskId: resolvedTaskId,
          sessionId: id,
          answers: data.answers,
          annotations: data.annotations,
          respondedBy: data.respondedBy,
        });

        return { success: true };
      },
    },
    {
      create: { role: ROLES.MEMBER, action: 'respond to input requests' },
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
        data: { url: string; name?: string; destination?: string },
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
    '/repos/:id/worktrees',
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
          boardId?: string;
        },
        params: RouteParams
      ) {
        const id = params.route?.id;
        if (!id) throw new Error('Repo ID required');
        return reposService.createWorktree(
          id,
          { ...data, refType: data.refType ?? 'branch' },
          params
        );
      },
    },
    {
      create: { role: ROLES.MEMBER, action: 'create worktrees' },
    },
    requireAuth
  );

  registerAuthenticatedRoute(
    app,
    '/repos/:id/worktrees/:name',
    {
      async remove(_id: unknown, params: RouteParams & { route?: { name?: string } }) {
        const id = params.route?.id;
        const name = params.route?.name;
        if (!id) throw new Error('Repo ID required');
        if (!name) throw new Error('Worktree name required');
        return reposService.removeWorktree(id, name, params);
      },
    },
    {
      remove: { role: ROLES.MEMBER, action: 'remove worktrees' },
    },
    requireAuth
  );

  registerAuthenticatedRoute(
    app,
    '/repos/:id/import-agor-yml',
    {
      async create(data: { worktree_id: string }, params: RouteParams) {
        const id = params.route?.id;
        if (!id) throw new Error('Repo ID required');
        if (!data?.worktree_id) throw new Error('worktree_id is required');
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
      async create(data: { worktree_id: string }, params: RouteParams) {
        const id = params.route?.id;
        if (!id) throw new Error('Repo ID required');
        if (!data?.worktree_id) throw new Error('worktree_id is required');
        return reposService.exportToAgorYml(id, data, params);
      },
    },
    {
      // Admin-only, matching Import and repo.environment edit. Export writes a
      // file to the worktree working tree, so even though the content is
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
    },
    {
      find: { role: ROLES.MEMBER, action: 'list API keys' },
      create: { role: ROLES.MEMBER, action: 'create API keys' },
    },
    requireAuth
  );

  registerAuthenticatedRoute(
    app,
    '/api/v1/user/api-keys/:id',
    {
      // biome-ignore lint/suspicious/noExplicitAny: Feathers service type
      async patch(data: { name?: string }, params: any) {
        const id = params.route?.id;
        if (!id) throw new BadRequest('API key ID required');
        return userApiKeysService.patch(id, data, params);
      },
      // biome-ignore lint/suspicious/noExplicitAny: Feathers service type
      async remove(_id: unknown, params: any) {
        const keyId = params.route?.id;
        if (!keyId) throw new BadRequest('API key ID required');
        return userApiKeysService.remove(keyId, params);
      },
    },
    {
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
  // Worktree environment management routes
  // ============================================================================

  const worktreesService = app.service('worktrees') as unknown as WorktreesServiceImpl;

  registerAuthenticatedRoute(
    app,
    '/worktrees/:id/start',
    {
      async create(_data: unknown, params: RouteParams) {
        const id = params.route?.id;
        if (!id) throw new Error('Worktree ID required');
        return worktreesService.startEnvironment(
          id as import('@agor/core/types').WorktreeID,
          params
        );
      },
    },
    {
      // Role is enforced at the service layer via managed_envs_minimum_role
      // (default: member). This route-level gate is just "authenticated", so
      // it accepts the lowest authenticated role (viewer). The service gate
      // is the single source of truth for whether the user can actually
      // trigger the command.
      create: { role: ROLES.VIEWER, action: 'start worktree environments' },
    },
    requireAuth
  );

  registerAuthenticatedRoute(
    app,
    '/worktrees/:id/stop',
    {
      async create(_data: unknown, params: RouteParams) {
        const id = params.route?.id;
        if (!id) throw new Error('Worktree ID required');
        return worktreesService.stopEnvironment(
          id as import('@agor/core/types').WorktreeID,
          params
        );
      },
    },
    {
      // Service-layer enforcement via managed_envs_minimum_role
      create: { role: ROLES.VIEWER, action: 'stop worktree environments' },
    },
    requireAuth
  );

  registerAuthenticatedRoute(
    app,
    '/worktrees/:id/restart',
    {
      async create(_data: unknown, params: RouteParams) {
        const id = params.route?.id;
        if (!id) throw new Error('Worktree ID required');
        return worktreesService.restartEnvironment(
          id as import('@agor/core/types').WorktreeID,
          params
        );
      },
    },
    {
      // Service-layer enforcement via managed_envs_minimum_role
      create: { role: ROLES.VIEWER, action: 'restart worktree environments' },
    },
    requireAuth
  );

  registerAuthenticatedRoute(
    app,
    '/worktrees/:id/nuke',
    {
      async create(_data: unknown, params: RouteParams) {
        const id = params.route?.id;
        if (!id) throw new Error('Worktree ID required');
        return worktreesService.nukeEnvironment(
          id as import('@agor/core/types').WorktreeID,
          params
        );
      },
    },
    {
      // Service-layer enforcement via managed_envs_minimum_role
      create: { role: ROLES.VIEWER, action: 'nuke worktree environments' },
    },
    requireAuth
  );

  registerAuthenticatedRoute(
    app,
    '/worktrees/:id/render-environment',
    {
      async create(data: unknown, params: RouteParams) {
        const id = params.route?.id;
        if (!id) throw new Error('Worktree ID required');
        return worktreesService.renderEnvironment(
          id as import('@agor/core/types').WorktreeID,
          data as { variant?: string } | undefined,
          params
        );
      },
    },
    {
      // Baseline trigger gate via managed_envs_minimum_role; variant changes
      // are additionally admin-gated inside the service method.
      create: { role: ROLES.VIEWER, action: 'render worktree environment' },
    },
    requireAuth
  );

  registerAuthenticatedRoute(
    app,
    '/worktrees/:id/health',
    {
      async find(_data: unknown, params: RouteParams) {
        const id = params.route?.id;
        if (!id) throw new Error('Worktree ID required');
        return worktreesService.checkHealth(id as import('@agor/core/types').WorktreeID, params);
      },
      // biome-ignore lint/suspicious/noExplicitAny: Service type not compatible with Express
    } as any,
    {
      find: { role: ROLES.MEMBER, action: 'check worktree health' },
    },
    requireAuth
  );

  // Archive/delete worktree
  app.use('/worktrees/:id/archive-or-delete', {
    async create(data: unknown, params: RouteParams) {
      const id = params.route?.id;
      if (!id) throw new Error('Worktree ID required');
      const options = data as {
        metadataAction: 'archive' | 'delete';
        filesystemAction: 'preserved' | 'cleaned' | 'deleted';
      };
      return worktreesService.archiveOrDelete(
        id as import('@agor/core/types').WorktreeID,
        options,
        params
      );
    },
  });

  app.service('/worktrees/:id/archive-or-delete').hooks({
    before: {
      create: [
        requireAuth,
        requireMinimumRole(ROLES.MEMBER, 'archive or delete worktrees'),
        async (context: HookContext) => {
          const id = context.params.route?.id;
          if (!id) throw new Error('Worktree ID required');

          const worktree = await worktreeRepository.findById(id);
          if (!worktree) {
            throw new Forbidden(`Worktree not found: ${id}`);
          }

          const userId = context.params.user?.user_id as
            | import('@agor/core/types').UUID
            | undefined;
          const isOwner = userId
            ? await worktreeRepository.isOwner(worktree.worktree_id, userId)
            : false;

          context.params.worktree = worktree;
          context.params.isWorktreeOwner = isOwner;

          return context;
        },
        worktreeRbacEnabled
          ? ensureWorktreePermission('all', 'archive or delete worktrees', superadminOpts)
          : (context: HookContext) => {
              const isOwner = context.params.isWorktreeOwner;
              const userRole = context.params.user?.role;

              if (!isOwner && !hasMinimumRole(userRole, ROLES.ADMIN)) {
                throw new Forbidden(
                  'You must be the worktree owner or a global admin to archive/delete worktrees'
                );
              }
              return context;
            },
      ],
    },
  });

  // Unarchive worktree
  app.use('/worktrees/:id/unarchive', {
    async create(data: unknown, params: RouteParams) {
      const id = params.route?.id;
      if (!id) throw new Error('Worktree ID required');
      const options = data as { boardId?: import('@agor/core/types').BoardID };
      return worktreesService.unarchive(
        id as import('@agor/core/types').WorktreeID,
        options,
        params
      );
    },
  });

  app.service('/worktrees/:id/unarchive').hooks({
    before: {
      create: [
        requireAuth,
        requireMinimumRole(ROLES.MEMBER, 'unarchive worktrees'),
        async (context: HookContext) => {
          const id = context.params.route?.id;
          if (!id) throw new Error('Worktree ID required');

          const worktree = await worktreeRepository.findById(id);
          if (!worktree) {
            throw new Forbidden(`Worktree not found: ${id}`);
          }

          const userId = context.params.user?.user_id as
            | import('@agor/core/types').UUID
            | undefined;
          const isOwner = userId
            ? await worktreeRepository.isOwner(worktree.worktree_id, userId)
            : false;

          context.params.worktree = worktree;
          context.params.isWorktreeOwner = isOwner;

          return context;
        },
        worktreeRbacEnabled
          ? ensureWorktreePermission('all', 'unarchive worktrees', superadminOpts)
          : (context: HookContext) => {
              const isOwner = context.params.isWorktreeOwner;
              const userRole = context.params.user?.role;

              if (!isOwner && !hasMinimumRole(userRole, ROLES.ADMIN)) {
                throw new Forbidden(
                  'You must be the worktree owner or a global admin to unarchive worktrees'
                );
              }
              return context;
            },
      ],
    },
  });

  // ============================================================================
  // Execute-schedule-now: manually trigger a scheduled run for a worktree
  // ============================================================================
  // Reuses the scheduler's spawn code path so scheduled and manual triggers
  // produce indistinguishable sessions (beyond a triggered_manually marker).
  // Requires worktree-level 'all' permission (same tier as editing the schedule).
  app.use('/worktrees/:id/execute-schedule-now', {
    async create(_data: unknown, params: RouteParams) {
      const id = params.route?.id;
      if (!id) throw new BadRequest('Worktree ID required');

      const scheduler = app.get('scheduler') as SchedulerService | undefined;
      if (!scheduler) {
        throw new NotFound('Scheduler service is not enabled on this instance.');
      }

      const triggeredBy = params.user?.user_id;
      if (!triggeredBy) {
        // Should already be caught by requireAuth, but guard anyway so the
        // scheduler isn't passed an undefined userId.
        throw new NotAuthenticated('Authentication required to trigger schedule.');
      }

      try {
        const session = await scheduler.executeScheduleNow({
          worktreeId: id as WorktreeID,
          triggeredBy: triggeredBy as UUID,
        });
        return {
          session_id: session.session_id,
          worktree_id: session.worktree_id,
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

  app.service('/worktrees/:id/execute-schedule-now').hooks({
    before: {
      create: [
        requireAuth,
        requireMinimumRole(ROLES.MEMBER, 'execute scheduled runs'),
        async (context: HookContext) => {
          const id = context.params.route?.id;
          if (!id) throw new BadRequest('Worktree ID required');

          const worktree = await worktreeRepository.findById(id);
          if (!worktree) {
            throw new NotFound(`Worktree not found: ${id}`);
          }

          const userId = context.params.user?.user_id as UUID | undefined;
          const isOwner = userId
            ? await worktreeRepository.isOwner(worktree.worktree_id, userId)
            : false;

          context.params.worktree = worktree;
          context.params.isWorktreeOwner = isOwner;
          return context;
        },
        worktreeRbacEnabled
          ? ensureWorktreePermission('all', 'execute scheduled runs', superadminOpts)
          : (context: HookContext) => {
              const isOwner = context.params.isWorktreeOwner;
              const userRole = context.params.user?.role;
              if (!isOwner && !hasMinimumRole(userRole, ROLES.ADMIN)) {
                throw new Forbidden(
                  'You must be the worktree owner or a global admin to execute scheduled runs'
                );
              }
              return context;
            },
      ],
    },
  });

  // Worktree logs
  registerAuthenticatedRoute(
    app,
    '/worktrees/logs',
    {
      async find(params: Params) {
        console.log('📋 Logs endpoint called');

        const id = params?.query?.worktree_id;

        if (!id) {
          console.error('❌ No worktree_id in query params');
          throw new Error('worktree_id query parameter required');
        }

        console.log('✅ Found worktree ID:', id);
        return worktreesService.getLogs(id as import('@agor/core/types').WorktreeID, params);
      },
      // biome-ignore lint/suspicious/noExplicitAny: Service type not compatible with Express
    } as any,
    {
      // Service-layer enforcement via managed_envs_minimum_role
      find: { role: ROLES.VIEWER, action: 'view worktree logs' },
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

  // ============================================================================
  // Session MCP servers routes
  // ============================================================================

  if (svcEnabled('mcp_servers'))
    registerAuthenticatedRoute(
      app,
      '/sessions/:id/mcp-servers',
      {
        async find(_data: unknown, params: RouteParams) {
          const id = params.route?.id;
          if (!id) throw new Error('Session ID required');
          const enabledOnly =
            params.query?.enabledOnly === 'true' || params.query?.enabledOnly === true;
          return sessionMCPServersService.listServers(
            id as import('@agor/core/types').SessionID,
            enabledOnly,
            params
          );
        },
        async create(data: { mcpServerId: string }, params: RouteParams) {
          const id = params.route?.id;
          if (!id) throw new Error('Session ID required');
          if (!data.mcpServerId) throw new Error('MCP Server ID required');

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
  // Worktree `all` permission does NOT grant access — selections expose the
  // creator's private credentials to the executor process.
  // ============================================================================

  // Route-side RBAC wrapper: loads the session, then delegates to the shared
  // `checkSessionOwnerOrAdmin` helper used by the Feathers hook. Keeps the
  // policy in a single place (see `utils/worktree-authorization.ts`) and
  // respects the daemon's configured `allowSuperadmin` via `superadminOpts`.
  const requireSessionOwnerOrAdmin = async (
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
      async find(_data: unknown, params: RouteParams): Promise<string[]> {
        const id = params.route?.id;
        if (!id) throw new BadRequest('Session ID required');
        // Read permission: session creator OR admin (no worktree tier).
        await requireSessionOwnerOrAdmin(id, params);
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
        await requireSessionOwnerOrAdmin(id, params);
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
        await requireSessionOwnerOrAdmin(id, params);
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
        await requireSessionOwnerOrAdmin(id, params);
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
          requireAuth: config.daemon?.requireAuth === true,
          allowAnonymous: allowAnonymous,
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
          },
        },
        services: servicesConfig,
        features: {
          // Web terminal availability: UI should hide terminal buttons when false.
          // Server-side gate in register-hooks.ts is the source of truth; this
          // flag exists so the UI can skip rendering buttons that would fail.
          // Defaults to true when the config key is unset.
          webTerminal: config.execution?.allow_web_terminal !== false,
          // Minimum role required to trigger managed environment commands
          // (start / stop / nuke / logs). UI uses this to disable + tooltip
          // the trigger buttons for users below the threshold. The server-side
          // gate in services/worktrees.ts is the source of truth.
          // Value: 'none' | 'viewer' | 'member' | 'admin' | 'superadmin'.
          // Defaults to 'member' when unset.
          managedEnvsMinimumRole: config.execution?.managed_envs_minimum_role ?? 'member',
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
            worktreeRbac: config.execution?.worktree_rbac === true,
            unixUserMode: config.execution?.unix_user_mode ?? 'simple',
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
    worktrees: ['worktrees'],
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
