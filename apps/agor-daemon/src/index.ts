/**
 * Agor Daemon
 *
 * FeathersJS backend providing REST + WebSocket API for session management.
 * Auto-started by CLI, provides unified interface for GUI and CLI clients.
 */

import 'dotenv/config';

// Patch console methods to respect LOG_LEVEL env var
// This allows all console.log/debug calls to be filtered by log level
import { patchConsole } from '@agor/core/utils/logger';

patchConsole();

import { createUserProcessEnvironment, loadConfig, type UnknownJson } from '@agor/core/config';
import { buildCorsConfig } from './setup/cors.js';
import { initializeAnthropicApiKey } from './setup/credentials.js';
import { initializeDatabase } from './setup/database.js';
import { configureChannels, createSocketIOConfig } from './setup/socketio.js';
// Phase 2: Configuration builders
import { configureSwagger } from './setup/swagger.js';
// Setup modules - extracted functions for daemon initialization
// Phase 1: Pure functions
import { loadDaemonVersion } from './setup/version.js';

// Load daemon version at startup (extracted to setup/version.ts)
const DAEMON_VERSION = await loadDaemonVersion(import.meta.url);

import {
  and,
  eq,
  getDatabaseUrl,
  MCPServerRepository,
  MessagesRepository,
  RepoRepository,
  SessionMCPServerRepository,
  type SessionMCPServerRow,
  SessionRepository,
  select,
  sessionMcpServers,
  TaskRepository,
  UsersRepository,
  WorktreeRepository,
} from '@agor/core/db';
import {
  AuthenticationService,
  authenticate,
  errorHandler,
  Forbidden,
  feathers,
  feathersExpress,
  LocalStrategy,
  NotAuthenticated,
  rest,
  socketio,
  validateQuery,
} from '@agor/core/feathers';
import {
  boardCommentQueryValidator,
  boardObjectQueryValidator,
  boardQueryValidator,
  mcpServerQueryValidator,
  repoQueryValidator,
  sessionQueryValidator,
  taskQueryValidator,
  userQueryValidator,
  worktreeQueryValidator,
} from '@agor/core/lib/feathers-validation';
import { type PermissionDecision, PermissionService } from '@agor/core/permissions';
import { registerHandlebarsHelpers } from '@agor/core/templates/handlebars-helpers';
// NOTE: Tools moved to executor package - use executor for SDK execution
// import { ClaudeTool, CodexTool, GeminiTool, OpenCodeTool } from '@agor/core/tools';
import type {
  AuthenticatedParams,
  Board,
  HookContext,
  Id,
  Message,
  Paginated,
  Params,
  PermissionRequestContent,
  Session,
  SessionID,
  Task,
  TaskID,
  User,
} from '@agor/core/types';
import { SessionStatus, TaskStatus } from '@agor/core/types';
import { NotFoundError } from '@agor/core/utils/errors';

// Executor spawning utility for fire-and-forget Unix operations
import {
  configureDaemonUrl,
  createServiceToken,
  getDaemonUrl,
  spawnExecutorFireAndForget,
} from './utils/spawn-executor.js';

// ============================================================================
// GLOBAL ERROR HANDLERS
// Critical for daemon stability - prevents crashes from unhandled errors
// ============================================================================

/**
 * Handle uncaught exceptions
 *
 * IMPORTANT: This catches synchronous errors that bubble up to the event loop.
 * Without this handler, any uncaught exception kills the entire daemon process.
 *
 * Common causes:
 * - Native module crashes (node-pty segfaults)
 * - Errors in setTimeout/setInterval callbacks
 * - Errors in event handler callbacks
 */
process.on('uncaughtException', (error: Error, origin: string) => {
  console.error('💥 [FATAL] Uncaught exception:', {
    error: error.message,
    stack: error.stack,
    origin,
    timestamp: new Date().toISOString(),
  });
  // Log but don't exit - let the process manager (pm2, systemd, tsx watch) handle restart
  // This gives us visibility into what's crashing the daemon
});

/**
 * Handle unhandled promise rejections
 *
 * IMPORTANT: As of Node 15+, unhandled rejections terminate the process.
 * This handler prevents that while logging the error for debugging.
 *
 * Common causes:
 * - Async errors in event handlers
 * - Missing .catch() on promises
 * - Errors in async setTimeout callbacks
 */
process.on('unhandledRejection', (reason: unknown, promise: Promise<unknown>) => {
  console.error('💥 [FATAL] Unhandled promise rejection:', {
    reason: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
    timestamp: new Date().toISOString(),
  });
  // Don't exit - log and continue. The specific operation failed but daemon can continue.
});

/**
 * Type guard to check if result is paginated
 */
function isPaginated<T>(result: T[] | Paginated<T>): result is Paginated<T> {
  return !Array.isArray(result) && 'data' in result && 'total' in result;
}

import compression from 'compression';
import cors from 'cors';
import express from 'express';
import expressStaticGzip from 'express-static-gzip';
import jwt from 'jsonwebtoken';
import type {
  BoardsServiceImpl,
  MessagesServiceImpl,
  ReposServiceImpl,
  SessionsServiceImpl,
  TasksServiceImpl,
} from './declarations';
import { createBoardCommentsService } from './services/board-comments';
import { createBoardObjectsService } from './services/board-objects';
import { createBoardsService } from './services/boards';
import { createConfigService } from './services/config';
import { createContextService } from './services/context';
import { createFileService } from './services/file';
import { createFilesService } from './services/files';
import { createHealthMonitor } from './services/health-monitor';
import { createLeaderboardService } from './services/leaderboard';
import { createMCPServersService } from './services/mcp-servers';
import { createMessagesService } from './services/messages';
import { createReposService } from './services/repos';
import { SchedulerService } from './services/scheduler';
import { createSessionMCPServersService } from './services/session-mcp-servers';
import { createSessionsService } from './services/sessions';
import { createTasksService } from './services/tasks';
import { TerminalsService } from './services/terminals';
import { createUsersService } from './services/users';
import { setupWorktreeOwnersService } from './services/worktree-owners.js';
import { createWorktreesService } from './services/worktrees';
import { AnonymousStrategy } from './strategies/anonymous';
import {
  ensureMinimumRole,
  registerAuthenticatedRoute,
  requireMinimumRole,
} from './utils/authorization';
import { createUploadMiddleware } from './utils/upload';
import {
  ensureCanCreateSession,
  ensureCanPrompt,
  ensureCanView,
  ensureSessionImmutability,
  ensureWorktreePermission,
  filterWorktreesByPermission,
  loadSession,
  loadSessionWorktree,
  loadWorktree,
  loadWorktreeFromSession,
  PERMISSION_RANK,
  resolveSessionContext,
  setSessionUnixUsername,
  validateSessionUnixUsername,
} from './utils/worktree-authorization';

/**
 * Extended Params with route ID parameter
 */
interface RouteParams extends Params {
  route?: {
    id?: string;
    messageId?: string;
    mcpId?: string;
  };
  user?: User;
}

// Determine database URL using centralized logic from @agor/core/db
// Priority:
// 1. If AGOR_DB_DIALECT=postgresql, use DATABASE_URL (required for Postgres)
// 2. Otherwise, use AGOR_DB_PATH or default SQLite path
const DB_PATH = getDatabaseUrl();

// Main async function
async function main() {
  // Initialize Handlebars helpers for template rendering
  registerHandlebarsHelpers();
  console.log('✅ Handlebars helpers registered');

  // Configure Git to fail fast instead of prompting for credentials
  // This prevents git operations from hanging indefinitely in automated environments
  // while still allowing credential helpers (gh auth, SSH keys, credential stores) to work
  process.env.GIT_TERMINAL_PROMPT = '0'; // Disable terminal credential prompts
  process.env.GIT_ASKPASS = 'echo'; // Return empty for any password prompt

  // Load config to get ports and API keys
  const config = await loadConfig();

  // SECURITY: Disable anonymous authentication by default
  // Must explicitly set daemon.allowAnonymous=true in config to enable
  const allowAnonymous = config.daemon?.allowAnonymous === true;
  const authStrategies = allowAnonymous ? ['jwt', 'anonymous'] : ['jwt'];
  const requireAuth = authenticate({ strategies: authStrategies });

  /**
   * Enforces password change requirement.
   * Users with must_change_password=true are blocked from all services except:
   * - users (PATCH for password change, GET for own profile)
   * - authentication (login/logout)
   * - health (public endpoint)
   *
   * NOTE: We fetch fresh user data from DB because JWT token may have stale must_change_password value
   */
  const enforcePasswordChange = async (context: HookContext) => {
    const user = context.params?.user as User | undefined;

    // Skip if no user (anonymous/internal)
    if (!user) {
      return context;
    }

    // Fetch fresh user data from database to check current must_change_password status
    // (JWT token may have stale data after password change)
    let freshUser: User;
    try {
      freshUser = await context.app.service('users').get(user.user_id, { provider: undefined }); // internal call
    } catch {
      // User not found or error - skip enforcement
      return context;
    }

    // Skip if flag not set
    if (!freshUser.must_change_password) {
      return context;
    }

    // Allow authentication service (login/logout/refresh)
    if (context.path === 'authentication' || context.path === 'authentication/refresh') {
      return context;
    }

    // Allow health endpoint
    if (context.path === 'health') {
      return context;
    }

    // Allow users service for specific operations:
    // - GET own profile (to check must_change_password status)
    // - PATCH own profile (to change password)
    if (context.path === 'users') {
      // Allow GET/PATCH on own user record
      if (context.id === freshUser.user_id) {
        if (context.method === 'get') {
          return context;
        }
        // Allow PATCH only if changing password
        if (context.method === 'patch') {
          const data = context.data as { password?: string } | undefined;
          if (data?.password) {
            return context;
          }
          // PATCH without password change - block
          throw new Forbidden('Password change required. Please update your password.', {
            code: 'PASSWORD_CHANGE_REQUIRED',
            user_id: freshUser.user_id,
          });
        }
      }
    }

    // Block all other requests
    throw new Forbidden('Password change required. Please update your password.', {
      code: 'PASSWORD_CHANGE_REQUIRED',
      user_id: freshUser.user_id,
    });
  };

  // Helper: Return empty array for auth in anonymous mode (read-only services don't need auth)
  const getReadAuthHooks = () => (allowAnonymous ? [] : [requireAuth]);

  // SECURITY: Enforce authentication in public deployments
  const isPublicDeployment =
    process.env.CODESPACES === 'true' ||
    process.env.NODE_ENV === 'production' ||
    process.env.RAILWAY_ENVIRONMENT !== undefined ||
    process.env.RENDER !== undefined;

  if (isPublicDeployment && allowAnonymous) {
    console.error('');
    console.error('❌ SECURITY ERROR: Anonymous authentication is enabled in a public deployment');
    console.error('   This would allow unauthorized access to your Agor instance.');
    console.error('   Set daemon.allowAnonymous=false in config or unset it (defaults to false)');
    console.error('');
    process.exit(1);
  }

  // Get daemon port from config (with env var override)
  const envPort = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : undefined;
  const DAEMON_PORT = envPort || config.daemon?.port || 3030;

  // Get UI port from config for CORS (with env var override)
  const envUiPort = process.env.UI_PORT ? Number.parseInt(process.env.UI_PORT, 10) : undefined;
  const UI_PORT = envUiPort || config.ui?.port || 5173;

  // Handle INSTANCE_LABEL env var override (for Docker deployments)
  if (process.env.INSTANCE_LABEL) {
    config.daemon = config.daemon || {};
    config.daemon.instanceLabel = process.env.INSTANCE_LABEL;
  }

  // Initialize Anthropic API key (extracted to setup/credentials.ts)
  // Side effect: sets process.env.ANTHROPIC_API_KEY if found in config
  initializeAnthropicApiKey(config, process.env.ANTHROPIC_API_KEY);

  // Create Feathers app
  const app = feathersExpress(feathers());

  // Configure CORS based on deployment environment (extracted to setup/cors.ts)
  const { origin: corsOrigin } = buildCorsConfig({
    uiPort: UI_PORT,
    isCodespaces: process.env.CODESPACES === 'true',
    corsOriginOverride: process.env.CORS_ORIGIN,
  });

  app.use(
    cors({
      origin: corsOrigin,
      credentials: true,
    })
  );

  // Parse JSON with size limits (security: prevent DoS via large payloads)
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // Serve static UI files in production BEFORE compression middleware
  // This ensures pre-compressed .br files are served directly
  // In development, UI runs on separate Vite dev server
  const isProduction = process.env.NODE_ENV === 'production';
  if (isProduction) {
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const { existsSync } = await import('node:fs');

    // Get directory of the currently executing file
    const dirname =
      typeof __dirname !== 'undefined' ? __dirname : path.dirname(fileURLToPath(import.meta.url));

    // UI is bundled in dist/ui relative to daemon entry point
    // Daemon is at: /path/to/agor-live/dist/daemon/index.js
    // UI is at: /path/to/agor-live/dist/ui/
    const uiPath = path.resolve(dirname, '../ui');

    if (existsSync(uiPath)) {
      console.log(`📂 Serving UI from: ${uiPath}`);

      // Serve pre-compressed gzip files with fallback to uncompressed
      // Gzip works over both HTTP and HTTPS (~70% size reduction)
      app.use(
        '/ui',
        expressStaticGzip(uiPath, {
          enableBrotli: false,
          orderPreference: ['gz'], // Try gzip first, then uncompressed
          serveStatic: {
            maxAge: '1y', // Cache static assets for 1 year (they have content hashes)
          },
        }) as never
      );

      // Serve index.html for all /ui/* routes (SPA fallback)
      app.use('/ui/*', ((_req: unknown, res: express.Response) => {
        res.sendFile(path.join(uiPath, 'index.html'));
      }) as never);

      // Redirect root to UI
      app.use('/', ((req: express.Request, res: express.Response, next: express.NextFunction) => {
        if (req.path === '/' && req.method === 'GET') {
          res.redirect('/ui/');
        } else {
          next();
        }
      }) as never);
    } else {
      console.warn(`⚠️  UI directory not found at ${uiPath} - UI will not be served`);
      console.warn(`   This is expected in development mode (UI runs on port ${UI_PORT})`);
    }
  }

  // Compress dynamic API responses (runs AFTER static file serving)
  // Static files are already pre-compressed and served by expressStaticGzip
  // This only compresses API JSON responses on-the-fly
  app.use(compression() as never);

  // Configure REST and Socket.io with CORS
  app.configure(rest());

  // Generate or load JWT secret (needed for WebSocket authentication)
  let jwtSecret = config.daemon?.jwtSecret;
  if (!jwtSecret) {
    // Generate a random secret and save it to config for persistence
    const crypto = await import('node:crypto');
    jwtSecret = crypto.randomBytes(32).toString('hex');

    // Save to config so it persists across restarts
    const { setConfigValue } = await import('@agor/core/config');
    await setConfigValue('daemon.jwtSecret', jwtSecret);

    console.log('🔑 Generated and saved persistent JWT secret to config');
  } else {
    console.log('🔑 Loaded existing JWT secret from config:', `${jwtSecret.substring(0, 16)}...`);
  }

  // Configure Socket.io with authentication and presence events (extracted to setup/socketio.ts)
  const socketIOConfig = createSocketIOConfig(app, {
    corsOrigin,
    jwtSecret,
    allowAnonymous,
  });
  app.configure(socketio(socketIOConfig.serverOptions, socketIOConfig.callback));

  // Configure channels for event broadcasting (extracted to setup/socketio.ts)
  configureChannels(app);

  // Configure Swagger for API documentation (extracted to setup/swagger.ts)
  configureSwagger(app, { version: DAEMON_VERSION, port: DAEMON_PORT });

  // Initialize database with migrations and seeding (extracted to setup/database.ts)
  const { db } = await initializeDatabase(DB_PATH);

  // Initialize session token service (ALWAYS needed for Feathers/WebSocket executor)
  const { SessionTokenService } = await import('./services/session-token-service.js');
  const sessionTokenService = new SessionTokenService({
    expiration_ms: config.execution?.session_token_expiration_ms || 24 * 60 * 60 * 1000,
    max_uses: config.execution?.session_token_max_uses || -1,
  });

  // Attach sessionTokenService to app (needed for Feathers/WebSocket executor)
  const appRecord = app as unknown as Record<string, unknown>;
  appRecord.sessionTokenService = sessionTokenService;

  // Register core services
  // NOTE: Pass app instance for user preferences access (needed for cross-tool spawning and ready_for_prompt updates)
  const sessionsService = createSessionsService(db, app) as unknown as SessionsServiceImpl;
  app.use('/sessions', sessionsService, {
    events: [
      'task_stop', // Custom event for stopping tasks via WebSocket
      'task_stop_ack', // Executor acknowledges receipt of stop signal
      'task_stopped_complete', // Executor confirms task fully stopped
    ],
  });

  // Wire up custom session methods for Feathers/WebSocket executor architecture
  sessionsService.setExecuteHandler(async (sessionId, data, params) => {
    // Import spawn and path utilities
    const { spawn } = await import('node:child_process');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    // Get session and validate
    const session = await sessionsService.get(sessionId, params);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    // Generate session token for executor authentication
    const appWithExecutor = app as unknown as {
      sessionTokenService?: import('./services/session-token-service').SessionTokenService;
    };
    if (!appWithExecutor.sessionTokenService) {
      throw new Error('Session token service not initialized');
    }
    const sessionToken = await appWithExecutor.sessionTokenService.generateToken(
      sessionId,
      (params as AuthenticatedParams).user?.user_id || 'anonymous'
    );

    // Use the task ID provided by caller (task already created by prompt endpoint)
    const taskId = data.taskId;

    // NOTE: API key resolution is now handled by the executor with proper precedence:
    // 1. Per-user encrypted keys (from database)
    // 2. Global config.yaml keys
    // 3. Environment variables
    // The executor will let SDKs handle OAuth if no key is found.

    // Get worktree path
    let cwd = process.cwd();
    if (session.worktree_id) {
      try {
        const worktree = await app.service('worktrees').get(session.worktree_id, params);
        cwd = worktree.path;
      } catch (error) {
        console.warn(`Could not get worktree path for ${session.worktree_id}:`, error);
      }
    }

    // Spawn executor process with Feathers/WebSocket mode
    const dirname =
      typeof __dirname !== 'undefined' ? __dirname : path.dirname(fileURLToPath(import.meta.url));

    // Try multiple possible paths for executor (development vs bundled)
    const { existsSync } = await import('node:fs');
    const possiblePaths = [
      path.join(dirname, '../executor/cli.js'), // Bundled in agor-live
      path.join(dirname, '../../../packages/executor/bin/agor-executor'), // Development - bin script with fallback to tsx
      path.join(dirname, '../../../packages/executor/dist/cli.js'), // Development from apps/agor-daemon/dist (if built)
    ];

    const executorPath = possiblePaths.find((p) => existsSync(p));
    if (!executorPath) {
      throw new Error(
        `Executor binary not found. Tried:\n${possiblePaths.map((p) => `  - ${p}`).join('\n')}`
      );
    }

    console.log(`[Daemon] Using executor at: ${executorPath}`);

    // Configure daemon URL for executor payloads
    // Uses config.daemon.public_url if set (for k8s), otherwise defaults to localhost
    const daemonUrl = config.daemon?.public_url || `http://localhost:${DAEMON_PORT}`;
    configureDaemonUrl(daemonUrl);

    // =========================================================================
    // DETERMINE UNIX USER FOR EXECUTOR BASED ON unix_user_mode
    // Uses centralized logic from @agor/core/unix
    // =========================================================================
    const {
      resolveUnixUserForImpersonation,
      validateResolvedUnixUser,
      UnixUserNotFoundError,
      buildSpawnArgs,
    } = await import('@agor/core/unix');

    const unixUserMode = (config.execution?.unix_user_mode ?? 'simple') as
      | 'simple'
      | 'insulated'
      | 'opportunistic'
      | 'strict';
    const configExecutorUser = config.execution?.executor_unix_user;
    const sessionUnixUser = session.unix_username;

    console.log('[Daemon] Determining executor Unix user:', {
      sessionId: session.session_id.slice(0, 8),
      unixUserMode,
      sessionUnixUser,
      configExecutorUser,
    });

    // Use centralized impersonation resolution logic
    const impersonationResult = resolveUnixUserForImpersonation({
      mode: unixUserMode,
      userUnixUsername: sessionUnixUser,
      executorUnixUser: configExecutorUser,
    });

    const executorUnixUser = impersonationResult.unixUser;
    const impersonationReason = impersonationResult.reason;

    console.log(`[Daemon] Executor impersonation: ${impersonationReason}`);

    // Determine permission mode: explicit override > session config > 'default'
    // This ensures session settings (like bypassPermissions) are preserved unless explicitly overridden
    // Note: 'default' is not part of the executor's Zod schema, so we convert it to undefined
    const effectivePermissionMode =
      data.permissionMode || session.permission_config?.mode || undefined;
    const permissionModeForPayload =
      effectivePermissionMode === 'default' ? undefined : effectivePermissionMode;

    // Validate Unix user exists for modes that require it
    try {
      validateResolvedUnixUser(unixUserMode, executorUnixUser);
    } catch (err) {
      if (err instanceof UnixUserNotFoundError) {
        throw new Error(
          `${(err as InstanceType<typeof UnixUserNotFoundError>).message}. Ensure the Unix user is created before attempting to execute sessions.`
        );
      }
      throw err;
    }

    // Resolve user environment variables (includes user's encrypted env vars like GITHUB_TOKEN)
    // Use the authenticated user (whoever is executing the command), not session creator
    const userId = (params as AuthenticatedParams).user?.user_id as
      | import('@agor/core/types').UserID
      | undefined;
    const executorEnv = await createUserProcessEnvironment(userId, db);

    // =========================================================================
    // PHASE 4: JSON-OVER-STDIN WITH IMPERSONATION AT SPAWN
    //
    // Impersonation happens at spawn time using buildSpawnArgs():
    // - When asUser is set, spawns via `sudo su - $asUser -c 'node executor --stdin'`
    // - Executor runs directly as target user with fresh group memberships
    // - No "node calling node" indirection
    //
    // Benefits:
    // - Single spawn, not node-within-node
    // - Fresh group memberships (login shell via `su -`)
    // - k8s compatible (can use pod security context instead)
    // =========================================================================

    // Build JSON payload for executor (Phase 2 --stdin mode)
    // Note: asUser is NOT in payload - impersonation happens at spawn time
    const executorPayload = {
      command: 'prompt' as const,
      sessionToken,
      daemonUrl,
      env: executorEnv,
      params: {
        sessionId,
        taskId,
        prompt: data.prompt,
        tool: session.agentic_tool as 'claude-code' | 'gemini' | 'codex' | 'opencode',
        permissionMode: permissionModeForPayload as 'ask' | 'auto' | 'allow-all' | undefined,
        cwd,
      },
    };

    // Build spawn command - handles impersonation via sudo su - when executorUnixUser is set
    const { cmd, args } = buildSpawnArgs('node', [executorPath, '--stdin'], {
      asUser: executorUnixUser || undefined,
      env: executorUnixUser ? executorEnv : undefined, // Only inject env when impersonating
    });

    if (executorUnixUser) {
      console.log(
        `[Daemon] Spawning executor as user: ${executorUnixUser} (${Object.keys(executorEnv).length} env vars)`
      );
    } else {
      console.log(`[Daemon] Spawning executor as current user (no impersonation)`);
    }

    // Spawn executor with --stdin mode, pipe JSON payload via stdin
    const executorProcess = spawn(cmd, args, {
      cwd,
      env: executorUnixUser ? undefined : executorEnv, // When impersonating, env is in the command
      stdio: ['pipe', 'pipe', 'pipe'], // Enable stdin for JSON payload
    });

    // Write JSON payload to stdin
    executorProcess.stdin?.write(JSON.stringify(executorPayload));
    executorProcess.stdin?.end();

    // Log executor output
    executorProcess.stdout?.on('data', (data) => {
      console.log(`[Executor ${sessionId.slice(0, 8)}] ${data.toString().trim()}`);
    });

    executorProcess.stderr?.on('data', (data) => {
      console.error(`[Executor ${sessionId.slice(0, 8)}] ${data.toString().trim()}`);
    });

    executorProcess.on('exit', async (code) => {
      console.log(`[Executor ${sessionId.slice(0, 8)}] Exited with code ${code}`);

      // Safety net: Update session status back to IDLE when executor completes
      // The primary session status update happens in TasksService.patch() when task status changes
      // This is a fallback in case the task status update didn't trigger session status change
      if (code === 0) {
        try {
          // Check if session is still in RUNNING state before updating
          const currentSession = await app.service('sessions').get(sessionId, params);
          if (currentSession.status === SessionStatus.RUNNING) {
            await app.service('sessions').patch(
              sessionId,
              {
                status: SessionStatus.IDLE,
                ready_for_prompt: true,
              },
              params
            );
            console.log(
              `✅ [Executor] Session ${sessionId.slice(0, 8)} status updated to IDLE after executor exit (fallback)`
            );
          } else {
            console.log(
              `ℹ️  [Executor] Session ${sessionId.slice(0, 8)} already in ${currentSession.status} state, skipping IDLE update`
            );
          }
        } catch (error) {
          console.error(`❌ [Executor] Failed to update session status to IDLE:`, error);
        }
      }

      // Revoke session token after executor exits
      appWithExecutor.sessionTokenService?.revokeToken(sessionToken);
    });

    return {
      success: true,
      taskId: taskId,
      status: 'running',
      streaming: data.stream !== false,
    };
  });

  sessionsService.setStopHandler(async (sessionId, data, _params) => {
    // Emit task_stop event for Feathers/WebSocket executors
    app.service('sessions').emit('task_stop', {
      session_id: sessionId,
      task_id: data.taskId,
      timestamp: new Date().toISOString(),
    });

    // NOTE: Stop is handled by the executor listening to WebSocket task:stop event
    // No IPC needed - executor subprocess watches for status changes via WebSocket

    return {
      success: true,
      message: 'Stop signal sent to executor',
    };
  });

  app.use('/tasks', createTasksService(db, app));
  app.use('/leaderboard', createLeaderboardService(db));
  const messagesService = createMessagesService(db) as unknown as MessagesServiceImpl;

  // Register messages service with custom streaming events
  app.use('/messages', messagesService, {
    methods: [
      'find',
      'get',
      'create',
      'update',
      'patch',
      'remove',
      'findBySession',
      'findByTask',
      'findByRange',
      'createMany',
    ],
    events: [
      'streaming:start',
      'streaming:chunk',
      'streaming:end',
      'streaming:error',
      'thinking:start',
      'thinking:chunk',
      'thinking:end',
      'permission_resolved', // Permission approval/denial notification for executors
    ],
    docs: {
      description: 'Conversation messages within AI agent sessions',
      definitions: {
        messages: {
          type: 'object',
          properties: {
            message_id: { type: 'string', format: 'uuid' },
            session_id: { type: 'string', format: 'uuid' },
            task_id: { type: 'string', format: 'uuid' },
            type: {
              type: 'string',
              enum: ['user', 'assistant', 'system', 'tool_use', 'tool_result'],
            },
            role: { type: 'string' },
            content: { type: 'string' },
            created_at: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
    // biome-ignore lint/suspicious/noExplicitAny: feathers-swagger docs option not typed in FeathersJS
  } as any);

  app.use('/boards', createBoardsService(db), {
    methods: [
      'find',
      'get',
      'create',
      'update',
      'patch',
      'remove',
      'toBlob',
      'fromBlob',
      'toYaml',
      'fromYaml',
      'clone',
    ],
  });

  // Register board-objects service (positioned entities on boards)
  app.use('/board-objects', createBoardObjectsService(db));

  // Register board-comments service (human-to-human conversations)
  app.use('/board-comments', createBoardCommentsService(db));

  // Register worktrees service first (repos service needs to access it)
  // NOTE: Pass app instance for environment management (needs to access repos service)
  app.use('/worktrees', createWorktreesService(db, app));

  // Feature flag: Worktree RBAC (default: false)
  const worktreeRbacEnabled = config.execution?.worktree_rbac === true;
  console.log(`[RBAC] Worktree RBAC ${worktreeRbacEnabled ? 'Enabled' : 'Disabled'}`);

  // Register worktree-owners nested route services for RBAC owner management
  // Only register if RBAC is enabled
  if (
    worktreeRbacEnabled &&
    !app.services['worktrees/:id/owners'] &&
    !app.services['worktrees/:id/owners/:userId']
  ) {
    const worktreeRepo = new WorktreeRepository(db);
    setupWorktreeOwnersService(app, worktreeRepo, {
      jwtSecret,
      daemonUser: config.daemon?.unix_user,
    });
  }

  // Unix integration is now handled by the executor via fire-and-forget spawning
  // The daemon no longer manages Unix groups/permissions directly
  // See: packages/executor/src/commands/unix.ts for the sync implementations
  if (worktreeRbacEnabled) {
    const daemonUser = config.daemon?.unix_user || 'agor';
    console.log(`[Unix Integration] Executor-based sync enabled (daemon user: ${daemonUser})`);
  }

  // Register repos service (accesses worktrees via app.service('worktrees'))
  app.use('/repos', createReposService(db, app));

  app.use('/mcp-servers', createMCPServersService(db));

  // JWT test endpoint for MCP servers (server-side to avoid CORS)
  app.use('/mcp-servers/test-jwt', {
    async create(data: {
      api_url: string;
      api_token: string;
      api_secret: string;
      mcp_url?: string;
    }) {
      try {
        // Step 1: Get JWT token
        const response = await fetch(data.api_url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: data.api_token, secret: data.api_secret }),
        });

        if (!response.ok) {
          const errorText = await response.text();
          return {
            success: false,
            error: `JWT fetch failed: HTTP ${response.status}: ${errorText}`,
          };
        }

        const result = (await response.json()) as {
          access_token?: string;
          payload?: { access_token?: string };
        };
        const token = result.access_token || result.payload?.access_token;
        if (!token) {
          return { success: false, error: 'Response missing access_token' };
        }

        return { success: true, tokenValid: true };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  });

  // Require authentication for test-jwt endpoint to prevent abuse
  // (hammering external APIs, using as proxy, resource exhaustion)
  app.service('mcp-servers/test-jwt').hooks({
    before: {
      create: [requireAuth],
    },
  });

  // Discover/Test MCP server capabilities endpoint
  // Accepts either:
  // - mcp_server_id: Test saved server config and persist discovered capabilities
  // - Inline config (url, transport, auth): Test connection without saving (for form validation)
  app.use('/mcp-servers/discover', {
    async create(
      data: {
        mcp_server_id?: string;
        // Inline config for testing unsaved configurations
        url?: string;
        transport?: 'http' | 'sse';
        auth?: {
          type: 'none' | 'bearer' | 'jwt';
          token?: string;
          api_url?: string;
          api_token?: string;
          api_secret?: string;
        };
      },
      params?: AuthenticatedParams
    ) {
      try {
        const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
        const { StreamableHTTPClientTransport } = await import(
          '@modelcontextprotocol/sdk/client/streamableHttp.js'
        );
        const { resolveMCPAuthHeaders } = await import('@agor/core/tools/mcp/jwt-auth');

        const mcpServerRepo = new MCPServerRepository(db);

        // SSRF Protection: Validate URLs to prevent internal network access
        const validateUrl = (url: string): { valid: boolean; error?: string } => {
          try {
            const parsed = new URL(url);
            const hostname = parsed.hostname.toLowerCase();

            // Block localhost and loopback
            if (
              hostname === 'localhost' ||
              hostname === '127.0.0.1' ||
              hostname === '::1' ||
              hostname === '0.0.0.0'
            ) {
              return { valid: false, error: 'Connection to localhost is not allowed' };
            }

            // Block private IP ranges (10.x.x.x, 172.16-31.x.x, 192.168.x.x)
            const ipv4Match = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
            if (ipv4Match) {
              const [, a, b] = ipv4Match.map(Number);
              if (
                a === 10 ||
                (a === 172 && b >= 16 && b <= 31) ||
                (a === 192 && b === 168) ||
                a === 169 // link-local
              ) {
                return { valid: false, error: 'Connection to private IP addresses is not allowed' };
              }
            }

            // Block common internal hostnames
            if (
              hostname.endsWith('.local') ||
              hostname.endsWith('.internal') ||
              hostname.endsWith('.lan')
            ) {
              return { valid: false, error: 'Connection to internal hostnames is not allowed' };
            }

            // Only allow http/https
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
              return { valid: false, error: 'Only HTTP and HTTPS protocols are allowed' };
            }

            return { valid: true };
          } catch {
            return { valid: false, error: 'Invalid URL format' };
          }
        };

        // Determine if inline config is provided (form values take precedence for testing)
        const hasInlineConfig = !!data.url;
        let serverConfig: {
          url: string;
          transport: 'http' | 'sse' | 'stdio';
          auth?: typeof data.auth;
          name?: string;
          scope?: string;
          owner_user_id?: string;
        };
        let serverId: string | undefined;

        if (hasInlineConfig) {
          // Inline config provided - use form values for testing
          // This allows testing unsaved changes in edit mode
          const urlValidation = validateUrl(data.url!);
          if (!urlValidation.valid) {
            return { success: false, error: urlValidation.error };
          }

          serverConfig = {
            url: data.url!,
            transport: data.transport || 'http',
            auth: data.auth,
            name: 'inline-test',
          };

          // If mcp_server_id is also provided, we'll persist capabilities after successful test
          // but still test using the inline config (form values)
          if (data.mcp_server_id) {
            // Verify user has access to this server before allowing capability persistence
            const server = await mcpServerRepo.findById(data.mcp_server_id);
            if (!server) {
              return { success: false, error: 'MCP server not found' };
            }

            // SECURITY: Verify user has access to persist to this MCP server
            if (params?.provider && params.user) {
              const userId = params.user.user_id;
              if (server.scope === 'global' && server.owner_user_id !== userId) {
                return {
                  success: false,
                  error: 'Access denied: only server owner can update this MCP server',
                };
              }
              if (server.scope === 'session') {
                const userRole = params.user.role?.toLowerCase();
                if (userRole !== 'admin' && userRole !== 'owner') {
                  return {
                    success: false,
                    error:
                      'Access denied: admin role required to update session-scoped MCP servers',
                  };
                }
              }
            }
            serverId = data.mcp_server_id;
          }
        } else if (data.mcp_server_id) {
          // No inline config - use saved server config
          const server = await mcpServerRepo.findById(data.mcp_server_id);

          if (!server) {
            return { success: false, error: 'MCP server not found' };
          }

          // SECURITY: Verify user has access to this MCP server
          // Skip authorization for internal calls (params.provider is falsy)
          if (params?.provider && params.user) {
            const userId = params.user.user_id;

            // For global servers, only the owner can discover them
            if (server.scope === 'global' && server.owner_user_id !== userId) {
              return {
                success: false,
                error: 'Access denied: only server owner can discover this MCP server',
              };
            }

            // For session-scoped servers, require admin role
            if (server.scope === 'session') {
              const userRole = params.user.role?.toLowerCase();
              if (userRole !== 'admin' && userRole !== 'owner') {
                return {
                  success: false,
                  error:
                    'Access denied: admin role required to discover session-scoped MCP servers',
                };
              }
            }
          }

          // Validate the saved URL too
          if (server.url) {
            const urlValidation = validateUrl(server.url);
            if (!urlValidation.valid) {
              return { success: false, error: urlValidation.error };
            }
          }

          serverConfig = {
            url: server.url || '',
            transport: (server.transport as 'http' | 'sse') || (server.url ? 'http' : 'stdio'),
            auth: server.auth,
            name: server.name,
            scope: server.scope,
            owner_user_id: server.owner_user_id,
          };
          serverId = data.mcp_server_id;
        } else {
          return { success: false, error: 'Either mcp_server_id or url is required' };
        }

        // Only support HTTP/SSE (stdio requires process spawning)
        if (serverConfig.transport === 'stdio' || !serverConfig.url) {
          return {
            success: false,
            error: `Connection test not supported for stdio servers (requires active session)`,
          };
        }

        console.log('[MCP Discovery] Starting test for:', serverConfig.name || 'inline-config');
        console.log('[MCP Discovery] URL:', serverConfig.url);
        console.log('[MCP Discovery] Transport:', serverConfig.transport);
        console.log('[MCP Discovery] Mode:', hasInlineConfig ? 'inline-test' : 'saved-server');

        // Get auth headers
        const authHeaders = await resolveMCPAuthHeaders(serverConfig.auth);
        console.log('[MCP Discovery] Auth headers present:', !!authHeaders);
        if (authHeaders) {
          console.log('[MCP Discovery] Auth headers keys:', Object.keys(authHeaders));
        }

        // Build headers (auth + Accept for MCP servers that require it)
        const headers: Record<string, string> = {
          Accept: 'application/json, text/event-stream',
        };
        if (authHeaders) {
          Object.assign(headers, authHeaders);
        }

        // Create Streamable HTTP transport (supports both SSE and regular HTTP)
        const httpTransport = new StreamableHTTPClientTransport(new URL(serverConfig.url), {
          requestInit: {
            headers,
          },
        });

        // Create MCP client
        const client = new Client(
          {
            name: 'agor-discovery',
            version: '1.0.0',
          },
          {
            capabilities: {},
          }
        );

        let connected = false;

        try {
          console.log('[MCP Discovery] Connecting to HTTP endpoint...');
          console.log('[MCP Discovery] URL:', serverConfig.url);
          console.log('[MCP Discovery] Headers:', JSON.stringify(headers, null, 2));

          // Add timeout to prevent hanging indefinitely (10s should be plenty)
          const connectTimeout = new Promise<never>((_, reject) => {
            setTimeout(() => {
              console.error(
                '[MCP Discovery] ❌ Connection timeout - server did not respond in 10 seconds'
              );
              console.error(
                '[MCP Discovery] This likely means the MCP SDK cannot establish a connection'
              );
              reject(new Error('Connection timeout after 10 seconds'));
            }, 10000);
          });

          console.log('[MCP Discovery] Calling client.connect()...');
          const connectPromise = client.connect(httpTransport).catch((err) => {
            console.error('[MCP Discovery] ❌ Connection error during connect():', err);
            throw err;
          });

          await Promise.race([connectPromise, connectTimeout]);
          connected = true;
          console.log('[MCP Discovery] ✅ Successfully connected!');

          // List capabilities with timeout (10s should be plenty for most servers)
          const listTimeout = new Promise<never>((_, reject) => {
            setTimeout(() => {
              console.error(
                '[MCP Discovery] ❌ List capabilities timeout - server did not respond in 10 seconds'
              );
              reject(new Error('List capabilities timeout after 10 seconds'));
            }, 10000);
          });

          interface MCPListResult<T> {
            [key: string]: T[];
          }

          type ToolsResult = MCPListResult<{
            name: string;
            description?: string;
            inputSchema?: Record<string, unknown>;
          }>;
          type ResourcesResult = MCPListResult<{
            uri: string;
            name: string;
            mimeType?: string;
          }>;
          type PromptsResult = MCPListResult<{
            name: string;
            description?: string;
            arguments?: Array<{
              name: string;
              description?: string;
              required?: boolean;
            }>;
          }>;

          console.log('[MCP Discovery] Listing tools...');
          const toolsResult = (await Promise.race([
            client.listTools().catch((err) => {
              console.error('[MCP Discovery] ❌ listTools() failed:', err.message);
              throw err;
            }),
            listTimeout,
          ])) as ToolsResult;
          console.log('[MCP Discovery] ✅ Found', toolsResult.tools.length, 'tools');

          console.log('[MCP Discovery] Listing resources...');
          const resourcesResult = (await Promise.race([
            client.listResources().catch((err) => {
              console.warn('[MCP Discovery] ⚠️  listResources() failed:', err.message, '- skipping');
              return { resources: [] } as ResourcesResult;
            }),
            listTimeout,
          ])) as ResourcesResult;
          console.log('[MCP Discovery] ✅ Found', resourcesResult.resources.length, 'resources');

          console.log('[MCP Discovery] Listing prompts...');
          const promptsResult = (await Promise.race([
            client.listPrompts().catch((err) => {
              console.warn('[MCP Discovery] ⚠️  listPrompts() failed:', err.message, '- skipping');
              return { prompts: [] } as PromptsResult;
            }),
            listTimeout,
          ])) as PromptsResult;
          console.log('[MCP Discovery] ✅ Found', promptsResult.prompts.length, 'prompts');

          // Only persist capabilities if testing a saved server (not inline test)
          if (serverId) {
            await mcpServerRepo.update(serverId, {
              tools: toolsResult.tools.map((t) => ({
                name: t.name,
                description: t.description || '',
                input_schema: t.inputSchema,
              })),
              resources: resourcesResult.resources.map((r) => ({
                uri: r.uri,
                name: r.name,
                mimeType: r.mimeType,
              })),
              prompts: promptsResult.prompts.map((p) => ({
                name: p.name,
                description: p.description || '',
                arguments: p.arguments?.map((a) => ({
                  name: a.name,
                  description: a.description || '',
                  required: a.required,
                })),
              })),
            });
          }

          return {
            success: true,
            capabilities: {
              tools: toolsResult.tools.length,
              resources: resourcesResult.resources.length,
              prompts: promptsResult.prompts.length,
            },
            // Include tool/resource names for inline display
            tools: toolsResult.tools.map((t) => ({
              name: t.name,
              description: t.description || '',
            })),
            resources: resourcesResult.resources.map((r) => ({
              name: r.name,
              uri: r.uri,
              mimeType: r.mimeType,
            })),
            prompts: promptsResult.prompts.map((p) => ({
              name: p.name,
              description: p.description || '',
            })),
          };
        } finally {
          // Always close connection if it was established
          if (connected) {
            try {
              await client.close();
              console.log('[MCP Discovery] Connection closed');
            } catch (closeError) {
              console.error('[MCP Discovery] Error closing connection:', closeError);
            }
          }
        }
      } catch (error) {
        console.error('MCP discovery error:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });

  app.service('mcp-servers/discover').hooks({
    before: {
      create: [requireAuth],
    },
  });

  // Register config service for API key management
  const configService = createConfigService(db);
  // Store app reference for service method access
  // biome-ignore lint/suspicious/noExplicitAny: Service needs app reference for cross-service calls
  (configService as any).app = app;
  app.use('/config', configService);

  // Register custom method for API key resolution (used by executors)
  app.use('/config/resolve-api-key', {
    async create(data: { taskId: TaskID; keyName: string }) {
      return await configService.resolveApiKey(data);
    },
  });

  // Register context service (read-only filesystem browser for worktree context/ files)
  // Scans context/ directory in worktree for all .md files recursively
  // Requires worktree_id query parameter
  const worktreeRepository = new WorktreeRepository(db);
  const usersRepository = new UsersRepository(db);
  app.use('/context', createContextService(worktreeRepository));

  // Register file service (read-only filesystem browser for all worktree files)
  // Scans entire worktree for all files recursively (up to 50k files)
  // Excludes node_modules, .git, dist, build, etc.
  // Requires worktree_id query parameter
  app.use('/file', createFileService(worktreeRepository));

  // Register files service for autocomplete search
  app.use('/files', createFilesService(db));

  // Register terminals service for PTY management
  const terminalsService = new TerminalsService(app, db);
  app.use('/terminals', terminalsService, {
    events: ['data', 'exit'], // Custom events for terminal I/O
  });

  // Register session-mcp-servers as a top-level service for WebSocket events
  // This is needed for real-time updates when MCP servers are added/removed from sessions
  const sessionMCPServersService = createSessionMCPServersService(db);
  app.use('/session-mcp-servers', {
    async find(params?: {
      query?: { session_id?: string; mcp_server_id?: string; enabled?: boolean };
    }) {
      // Build query with optional filters
      // Supports filtering by session_id, mcp_server_id, and enabled status
      // Collect all filter conditions
      const conditions: ReturnType<typeof eq>[] = [];

      if (params?.query?.session_id) {
        conditions.push(eq(sessionMcpServers.session_id, params.query.session_id));
      }

      if (params?.query?.mcp_server_id) {
        conditions.push(eq(sessionMcpServers.mcp_server_id, params.query.mcp_server_id));
      }

      if (params?.query?.enabled !== undefined) {
        conditions.push(eq(sessionMcpServers.enabled, params.query.enabled));
      }

      // Build the query with all conditions combined using AND
      let query = select(db).from(sessionMcpServers);
      if (conditions.length > 0) {
        query = query.where(and(...conditions)) as typeof query;
      }

      const rows = await query.all();
      return rows.map((row: SessionMCPServerRow) => ({
        session_id: row.session_id,
        mcp_server_id: row.mcp_server_id,
        enabled: Boolean(row.enabled),
        added_at: new Date(row.added_at),
      }));
    },
  });

  // Register users service (for authentication)
  const usersService = createUsersService(db);
  app.use('/users', usersService);

  // Configure service hooks for authentication and authorization
  app.service('messages').hooks({
    before: {
      all: [requireAuth],
      get: [
        ...(worktreeRbacEnabled
          ? [
              resolveSessionContext(),
              loadSession(sessionsService),
              loadWorktreeFromSession(worktreeRepository),
              ensureCanView(), // Require 'view' permission
            ]
          : []),
      ],
      create: [
        requireMinimumRole('member', 'create messages'),
        ...(worktreeRbacEnabled
          ? [
              resolveSessionContext(),
              loadSession(sessionsService),
              validateSessionUnixUsername(usersRepository), // Defensive check: session.unix_username must match creator's current unix_username
              loadWorktreeFromSession(worktreeRepository),
              ensureCanPrompt(), // Require 'prompt' permission to create messages
            ]
          : []),
      ],
      patch: [
        requireMinimumRole('member', 'update messages'),
        ...(worktreeRbacEnabled
          ? [
              resolveSessionContext(),
              loadSession(sessionsService),
              loadWorktreeFromSession(worktreeRepository),
              ensureCanPrompt(), // Require 'prompt' permission to update messages
            ]
          : []),
      ],
      remove: [
        requireMinimumRole('member', 'delete messages'),
        ...(worktreeRbacEnabled
          ? [
              resolveSessionContext(),
              loadSession(sessionsService),
              loadWorktreeFromSession(worktreeRepository),
              ensureCanPrompt(), // Require 'prompt' permission to delete messages
            ]
          : []),
      ],
    },
    after: {
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

  app.service('board-objects').hooks({
    before: {
      all: [
        // biome-ignore lint/suspicious/noExplicitAny: FeathersJS hook type compatibility
        (validateQuery as any)(boardObjectQueryValidator),
        ...getReadAuthHooks(),
        ...(allowAnonymous ? [] : [requireMinimumRole('member', 'manage board objects')]),
      ],
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

                // biome-ignore lint/suspicious/noExplicitAny: FeathersJS params type not fully typed
                const userId = (context.params as any).user?.user_id;
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
                    const effectivePermission = worktree.others_can ?? 'view';
                    const hasAccess =
                      isOwner || PERMISSION_RANK[effectivePermission] >= PERMISSION_RANK.view;

                    if (hasAccess) {
                      authorizedBoardObjects.push(boardObject);
                    }
                  } else {
                    // No worktree reference - allow access (e.g., zones, other board objects)
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

  app.service('board-comments').hooks({
    before: {
      all: [
        // biome-ignore lint/suspicious/noExplicitAny: FeathersJS hook type compatibility
        (validateQuery as any)(boardCommentQueryValidator),
        ...getReadAuthHooks(),
      ],
      create: [requireMinimumRole('member', 'create board comments')],
      patch: [requireMinimumRole('member', 'update board comments')],
      remove: [requireMinimumRole('member', 'delete board comments')],
      // Board comments are scoped to worktrees - check permissions based on parent board object
      // TODO: Implement worktree-level permission checks for board comments
      // For now, keep existing role-based authorization
    },
  });

  app.service('repos').hooks({
    before: {
      all: [
        // biome-ignore lint/suspicious/noExplicitAny: FeathersJS hook type compatibility
        (validateQuery as any)(repoQueryValidator),
        ...getReadAuthHooks(),
        ...(allowAnonymous ? [] : [requireMinimumRole('member', 'access repositories')]),
      ],
      create: [requireMinimumRole('member', 'create repositories')],
      patch: [requireMinimumRole('member', 'update repositories')],
      remove: [requireMinimumRole('member', 'delete repositories')],
    },
  });

  app.service('worktrees').hooks({
    before: {
      all: [
        // biome-ignore lint/suspicious/noExplicitAny: FeathersJS hook type compatibility
        (validateQuery as any)(worktreeQueryValidator),
        ...getReadAuthHooks(),
        ...(allowAnonymous ? [] : [requireMinimumRole('member', 'access worktrees')]),
      ],
      get: [
        ...(worktreeRbacEnabled
          ? [
              loadWorktree(worktreeRepository),
              ensureCanView(), // Require 'view' permission to read worktree
            ]
          : []),
      ],
      create: [requireMinimumRole('member', 'create worktrees')],
      patch: [
        ...(worktreeRbacEnabled
          ? [
              loadWorktree(worktreeRepository),
              ensureWorktreePermission('all', 'update worktrees'), // Require 'all' permission to update
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
              ensureWorktreePermission('all', 'delete worktrees'), // Require 'all' permission to delete
            ]
          : []),
      ],
    },
    after: {
      find: [
        ...(worktreeRbacEnabled ? [filterWorktreesByPermission(worktreeRepository)] : []), // Filter results by permission
      ],
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

                // Unix Integration: Fire-and-forget sync to executor
                // The executor will handle group creation, user membership, and permissions
                if (worktreeRbacEnabled && jwtSecret) {
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
                    { logPrefix: '[Executor/worktree.create]' }
                  );
                }

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

  app.service('mcp-servers').hooks({
    before: {
      all: [
        // biome-ignore lint/suspicious/noExplicitAny: FeathersJS hook type compatibility
        (validateQuery as any)(mcpServerQueryValidator),
        ...getReadAuthHooks(),
      ],
      create: [requireMinimumRole('admin', 'create MCP servers')],
      patch: [requireMinimumRole('admin', 'update MCP servers')],
      remove: [requireMinimumRole('admin', 'delete MCP servers')],
    },
  });

  app.service('session-mcp-servers').hooks({
    before: {
      all: [requireAuth],
      find: [requireMinimumRole('member', 'list session MCP servers')],
    },
  });

  app.service('config').hooks({
    before: {
      all: [requireAuth],
      find: [requireMinimumRole('admin', 'view configuration')],
      get: [requireMinimumRole('admin', 'view configuration')],
      patch: [requireMinimumRole('admin', 'update configuration')],
    },
  });

  app.service('context').hooks({
    before: {
      all: [requireAuth],
    },
  });

  app.service('files').hooks({
    before: {
      all: [requireAuth, requireMinimumRole('member', 'search files')],
    },
  });

  app.service('terminals').hooks({
    before: {
      all: [requireAuth, requireMinimumRole('admin', 'access terminals')],
    },
  });

  app.service('users').hooks({
    before: {
      all: [
        // biome-ignore lint/suspicious/noExplicitAny: FeathersJS hook type compatibility
        (validateQuery as any)(userQueryValidator),
      ],
      find: [
        (context) => {
          const params = context.params as AuthenticatedParams;

          if (!params.provider) {
            return context;
          }

          if (params.user) {
            ensureMinimumRole(params, 'member', 'list users');
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
          ensureMinimumRole(context.params as AuthenticatedParams, 'member', 'view users');
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
            ensureMinimumRole(params, 'admin', 'create users');
          }

          return context;
        },
      ],
      patch: [
        (context) => {
          const params = context.params as AuthenticatedParams;
          const userId = context.id as string;

          // Field-level restrictions: only admins can modify unix_username, role, and must_change_password
          if (!Array.isArray(context.data)) {
            if (context.data?.unix_username !== undefined) {
              if (!params.user || params.user.role !== 'admin') {
                throw new Forbidden('Only admins can modify unix_username');
              }
            }
            if (context.data?.role !== undefined) {
              if (!params.user || params.user.role !== 'admin') {
                throw new Forbidden('Only admins can modify user roles');
              }
            }
            if (context.data?.must_change_password !== undefined) {
              if (!params.user || params.user.role !== 'admin') {
                throw new Forbidden('Only admins can force password changes');
              }
            }
          }

          // General authorization: admins can patch any user
          if (params.user && params.user.role === 'admin') {
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
      remove: [requireMinimumRole('admin', 'delete users')],
    },
    after: {
      // After user create/patch: optionally ensure Unix user exists and sync password
      create: [
        async (context: HookContext) => {
          // Skip Unix sync if RBAC is disabled
          if (!worktreeRbacEnabled || !jwtSecret) {
            return context;
          }

          const user = context.result as User;
          if (!user.unix_username) {
            return context; // No unix_username set, skip Unix user creation
          }

          // Get plaintext password from request data (for password sync)
          const data = context.data as { password?: string };

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
              },
            },
            { logPrefix: '[Executor/user.create]' }
          );

          return context;
        },
      ],
      patch: [
        async (context: HookContext) => {
          // Skip Unix sync if RBAC is disabled
          if (!worktreeRbacEnabled || !jwtSecret) {
            return context;
          }

          const data = context.data as { unix_username?: string; password?: string };
          const user = context.result as User;

          // Only sync if unix_username or password changed
          if (!data?.unix_username && !data?.password) {
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
              },
            },
            { logPrefix: '[Executor/user.patch]' }
          );

          return context;
        },
      ],
    },
  });

  // Publish service events to authenticated clients only
  // SECURITY: Only connections in 'authenticated' channel (joined on login) receive events
  // This prevents unauthenticated sockets from receiving sensitive data
  app.publish((data, context) => {
    // Skip logging for internal events without path/method (e.g., repository-triggered events)
    if (context.path && context.method) {
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

  // Add hooks to inject created_by from authenticated user and populate repo from worktree
  app.service('sessions').hooks({
    before: {
      all: [
        // biome-ignore lint/suspicious/noExplicitAny: FeathersJS hook type compatibility
        (validateQuery as any)(sessionQueryValidator),
        ...getReadAuthHooks(),
      ],
      get: [
        ...(worktreeRbacEnabled
          ? [
              // Load session's worktree and check permissions
              loadSessionWorktree(sessionsService, worktreeRepository),
              ensureCanView(), // Require 'view' permission on worktree
            ]
          : []),
      ],
      create: [
        requireMinimumRole('member', 'create sessions'),
        ...(worktreeRbacEnabled
          ? [
              setSessionUnixUsername(usersRepository), // Stamp session with creator's unix_username (MUST run first)
              // Check worktree permission BEFORE injecting created_by (need worktree_id)
              async (context: HookContext) => {
                // RBAC: Ensure user can create sessions in this worktree ('all' permission)
                // biome-ignore lint/suspicious/noExplicitAny: FeathersJS data type not fully typed
                const data = context.data as any;
                if (context.params.provider && data?.worktree_id) {
                  try {
                    const worktree = await worktreeRepository.findById(data.worktree_id);
                    if (!worktree) {
                      throw new Forbidden(`Worktree not found: ${data.worktree_id}`);
                    }
                    // biome-ignore lint/suspicious/noExplicitAny: FeathersJS params type not fully typed
                    const userId = (context.params as any).user?.user_id;
                    const isOwner = userId
                      ? await worktreeRepository.isOwner(worktree.worktree_id, userId)
                      : false;

                    // Cache for later hooks
                    // biome-ignore lint/suspicious/noExplicitAny: FeathersJS params type not fully typed
                    (context.params as any).worktree = worktree;
                    // biome-ignore lint/suspicious/noExplicitAny: FeathersJS params type not fully typed
                    (context.params as any).isWorktreeOwner = isOwner;
                  } catch (error) {
                    console.error('Failed to load worktree for RBAC check:', error);
                    throw error;
                  }
                }
                return context;
              },
              ensureCanCreateSession(), // Require 'all' permission to create sessions
            ]
          : []),
        async (context) => {
          // Inject user_id if authenticated, otherwise use 'anonymous'
          const user = (context.params as { user?: { user_id: string; email: string } }).user;
          const userId = user?.user_id || 'anonymous';

          // DEBUG: Log authentication state
          console.log(
            '🔍 Session create hook - user:',
            user ? `${user.user_id} (${user.email})` : 'none',
            '→ userId:',
            userId
          );

          if (Array.isArray(context.data)) {
            context.data.forEach((item: Record<string, unknown>) => {
              if (!item.created_by) item.created_by = userId;
            });
          } else if (context.data && !(context.data as Record<string, unknown>).created_by) {
            (context.data as Record<string, unknown>).created_by = userId;
          }

          // Populate repo field from worktree_id
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
              }
            } catch (error) {
              console.error('Failed to populate repo from worktree:', error);
            }
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
              ensureWorktreePermission('all', 'update sessions'), // Require 'all' permission
            ]
          : []),
      ],
      remove: [
        ...(worktreeRbacEnabled
          ? [
              resolveSessionContext(),
              loadSession(sessionsService),
              loadWorktreeFromSession(worktreeRepository),
              ensureWorktreePermission('all', 'delete sessions'), // Require 'all' permission
            ]
          : []),
      ],
    },
    after: {
      create: [
        async (context) => {
          // Skip MCP setup if MCP server is disabled
          if (config.daemon?.mcpEnabled === false) {
            return context;
          }

          // Generate MCP session token for this session
          const { generateSessionToken } = await import('./mcp/tokens.js');
          const session = context.result as Session;
          const userId = session.created_by || 'anonymous';

          const mcpToken = generateSessionToken(
            userId as import('@agor/core/types').UserID,
            session.session_id
          );

          console.log(
            `🎫 MCP token for session ${session.session_id.substring(0, 8)}: ${mcpToken.substring(0, 16)}...`
          );

          // Store token in session record
          await app.service('sessions').patch(session.session_id, {
            mcp_token: mcpToken,
          });
          console.log(`💾 Stored MCP token in session record`);

          // Note: We no longer auto-attach global MCP servers to sessions.
          // Instead, getMcpServersForSession() will automatically provide ALL
          // global servers plus any session-specific servers assigned to this
          // session. This avoids polluting the session_mcp_servers junction table.

          // Update context.result to include the token
          context.result = { ...session, mcp_token: mcpToken };

          return context;
        },
        // TODO: OpenCode session creation moved to executor - implement via IPC if needed
      ],
      patch: [
        async (context) => {
          // Automatically process queued messages when session becomes IDLE
          // This ensures queued messages are processed regardless of how the session became IDLE
          const session = Array.isArray(context.result) ? context.result[0] : context.result;

          if (session && session.status === 'idle' && session.ready_for_prompt) {
            // Use setImmediate to avoid blocking the patch response
            setImmediate(async () => {
              try {
                console.log(
                  `🔄 [SessionsService.after.patch] Session ${session.session_id.substring(0, 8)} became IDLE, checking for queued messages...`
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

          return context;
        },
      ],
    },
  });

  app.service('leaderboard').hooks({
    before: {
      all: [...getReadAuthHooks()],
    },
  });

  app.service('tasks').hooks({
    before: {
      all: [
        // biome-ignore lint/suspicious/noExplicitAny: FeathersJS hook type compatibility
        (validateQuery as any)(taskQueryValidator),
        requireAuth,
      ],
      get: [
        ...(worktreeRbacEnabled
          ? [
              resolveSessionContext(),
              loadSession(sessionsService),
              loadWorktreeFromSession(worktreeRepository),
              ensureCanView(), // Require 'view' permission
            ]
          : []),
      ],
      create: [
        requireMinimumRole('member', 'create tasks'),
        ...(worktreeRbacEnabled
          ? [
              resolveSessionContext(),
              loadSession(sessionsService),
              validateSessionUnixUsername(usersRepository), // Defensive check: session.unix_username must match creator's current unix_username
              loadWorktreeFromSession(worktreeRepository),
              ensureCanPrompt(), // Require 'prompt' permission to create tasks
            ]
          : []),
        async (context) => {
          // Inject user_id if authenticated, otherwise use 'anonymous'
          const user = (context.params as { user?: { user_id: string; email: string } }).user;
          const userId = user?.user_id || 'anonymous';

          // DEBUG: Log authentication state
          console.log(
            '🔍 Task create hook - user:',
            user ? `${user.user_id} (${user.email})` : 'none',
            '→ userId:',
            userId
          );

          if (Array.isArray(context.data)) {
            context.data.forEach((item) => {
              if (!item.created_by) (item as Record<string, unknown>).created_by = userId;
            });
          } else if (context.data && !context.data.created_by) {
            (context.data as Record<string, unknown>).created_by = userId;
          }
          return context;
        },
      ],
      patch: [
        ...(worktreeRbacEnabled
          ? [
              resolveSessionContext(),
              loadSession(sessionsService),
              loadWorktreeFromSession(worktreeRepository),
              ensureCanPrompt(), // Require 'prompt' permission to update tasks
            ]
          : []),
      ],
      remove: [requireMinimumRole('member', 'delete tasks')],
    },
  });

  app.service('boards').hooks({
    before: {
      all: [
        // biome-ignore lint/suspicious/noExplicitAny: FeathersJS hook type compatibility
        (validateQuery as any)(boardQueryValidator),
        ...getReadAuthHooks(),
      ],
      create: [
        requireMinimumRole('member', 'create boards'),
        async (context: HookContext<Board>) => {
          // Inject user_id if authenticated, otherwise use 'anonymous'
          const userId =
            (context.params as { user?: { user_id: string; email: string } }).user?.user_id ||
            'anonymous';

          if (Array.isArray(context.data)) {
            context.data.forEach((item) => {
              if (!item.created_by) (item as Record<string, unknown>).created_by = userId;
            });
          } else if (context.data && !context.data.created_by) {
            (context.data as Record<string, unknown>).created_by = userId;
          }
          return context;
        },
      ],
      patch: [
        requireMinimumRole('member', 'update boards'),
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
            const result = await boardsService.upsertBoardObject(
              context.id as string,
              objectId as string,
              objectData
            );
            context.result = result;
            // Manually emit 'patched' event for WebSocket broadcasting (ONCE)
            app.service('boards').emit('patched', result);
            // Skip normal patch flow to prevent double emit
            context.dispatch = result;
            return context;
          }

          if (_action === 'removeObject' && objectId) {
            if (!context.id) throw new Error('Board ID required');
            const result = await boardsService.removeBoardObject(
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
            const result = await boardsService.batchUpsertBoardObjects(
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
            const result = await boardsService.deleteZone(
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
      remove: [requireMinimumRole('member', 'delete boards')],
      toBlob: [requireMinimumRole('member', 'export boards')],
      toYaml: [requireMinimumRole('member', 'export boards')],
      fromBlob: [requireMinimumRole('member', 'import boards')],
      fromYaml: [requireMinimumRole('member', 'import boards')],
      clone: [requireMinimumRole('member', 'clone boards')],
    },
    after: {
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

  // Configure authentication options BEFORE creating service
  // Note: jwtSecret is initialized earlier (before Socket.io config)
  const authStrategiesArray = ['jwt', 'local', 'anonymous'];
  if (sessionTokenService) {
    authStrategiesArray.push('session-token');
  }

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
      expiresIn: '7d', // Access token: 7 days (refresh token: 30 days)
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
  // NOTE: We use a custom ServiceJWTStrategy that handles both:
  // 1. Regular user JWTs (standard authentication)
  // 2. Service JWTs (for executor authentication with sub: 'executor-service')
  authentication.register('jwt', new ServiceJWTStrategy());
  authentication.register('local', new LocalStrategy());
  authentication.register('anonymous', new AnonymousStrategy());

  // SECURITY: Simple in-memory rate limiter for authentication endpoints
  const authAttempts = new Map<string, { count: number; resetAt: number }>();
  const AUTH_RATE_LIMIT = 50; // Max attempts (increased for development/multiple tabs)
  const AUTH_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

  const checkAuthRateLimit = (identifier: string): boolean => {
    const now = Date.now();
    const record = authAttempts.get(identifier);

    if (!record || now > record.resetAt) {
      // First attempt or window expired
      authAttempts.set(identifier, { count: 1, resetAt: now + AUTH_WINDOW_MS });
      return true;
    }

    if (record.count >= AUTH_RATE_LIMIT) {
      // Rate limit exceeded
      return false;
    }

    // Increment count
    record.count++;
    return true;
  };

  // Cleanup old rate limit entries every hour
  // FIX: Store interval handle to prevent memory leak
  const rateLimitCleanupInterval = setInterval(
    () => {
      const now = Date.now();
      for (const [key, record] of authAttempts.entries()) {
        if (now > record.resetAt) {
          authAttempts.delete(key);
        }
      }
    },
    60 * 60 * 1000
  );

  // Ensure cleanup interval is cleared on shutdown
  process.once('beforeExit', () => clearInterval(rateLimitCleanupInterval));

  app.use('/authentication', authentication);

  // Initialize SessionTokenService with JWT secret (needed for JWT generation)
  if (sessionTokenService) {
    sessionTokenService.setJwtSecret(jwtSecret);
    console.log('✅ SessionTokenService initialized with JWT secret (will generate JWTs)');
  }

  // Configure docs for authentication service (override global security requirement)
  // biome-ignore lint/suspicious/noExplicitAny: FeathersJS service type not fully typed
  const authService = app.service('authentication') as any;
  authService.docs = {
    description: 'Authentication service for user login and token management',
    // Override global security - login endpoint must be public
    security: [],
  };

  // Hook: Add refresh token to authentication response + rate limiting
  authService.hooks({
    before: {
      create: [
        // biome-ignore lint/suspicious/noExplicitAny: FeathersJS context type not fully typed
        async (context: any) => {
          // SECURITY: Rate limit authentication attempts
          const data = Array.isArray(context.data) ? context.data[0] : context.data;

          // Only rate limit external requests (not internal service calls)
          if (context.params.provider) {
            // biome-ignore lint/suspicious/noExplicitAny: FeathersJS request params are untyped
            const params = context.params as any;
            const ip =
              params.ip ||
              params.headers?.['x-forwarded-for']?.split(',')[0] ||
              params.connection?.remoteAddress ||
              'unknown';
            const identifier = data?.email || ip;

            if (!checkAuthRateLimit(identifier)) {
              console.warn(`⚠️  Rate limit exceeded for authentication attempt: ${identifier}`);
              throw new Error('Too many authentication attempts. Please try again in 15 minutes.');
            }
          }

          // Log authentication attempts for debugging
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
          // Debug: Log authentication result
          console.log('✅ Authentication succeeded:', {
            strategy: context.result?.authentication?.strategy,
            hasUser: !!context.result?.user,
            user_id: context.result?.user?.user_id,
            hasAccessToken: !!context.result?.accessToken,
          });

          // Only add refresh token for non-anonymous authentication
          if (context.result?.user && context.result.user.user_id !== 'anonymous') {
            // Generate refresh token (30 days)
            const refreshToken = jwt.sign(
              {
                sub: context.result.user.user_id,
                type: 'refresh',
              },
              jwtSecret,
              {
                expiresIn: '30d',
                issuer: 'agor',
                audience: 'https://agor.dev',
              }
            );

            // Add refresh token to response
            context.result.refreshToken = refreshToken;
          }
          return context;
        },
      ],
    },
  });

  // Refresh token endpoint
  app.use('/authentication/refresh', {
    async create(data: { refreshToken: string }, params?: Params) {
      // SECURITY: Rate limit refresh token requests
      if (params?.provider) {
        // biome-ignore lint/suspicious/noExplicitAny: FeathersJS request params are untyped
        const p = params as any;
        const ip =
          p.ip ||
          p.headers?.['x-forwarded-for']?.split(',')[0] ||
          p.connection?.remoteAddress ||
          'unknown';
        const identifier = ip;
        if (!checkAuthRateLimit(identifier)) {
          console.warn(`⚠️  Rate limit exceeded for token refresh: ${identifier}`);
          throw new Error('Too many token refresh attempts. Please try again in 15 minutes.');
        }
      }

      try {
        // Verify refresh token
        const decoded = jwt.verify(data.refreshToken, jwtSecret, {
          issuer: 'agor',
          audience: 'https://agor.dev',
        }) as { sub: string; type: string };

        if (decoded.type !== 'refresh') {
          throw new Error('Invalid token type');
        }

        // Get user
        const user = await usersService.get(decoded.sub as import('@agor/core/types').UUID);

        // Generate new access token
        const accessToken = jwt.sign(
          {
            sub: user.user_id,
            type: 'access',
          },
          jwtSecret,
          {
            expiresIn: '7d',
            issuer: 'agor',
            audience: 'https://agor.dev',
          }
        );

        // Generate new refresh token (rotate on each refresh for better security)
        const newRefreshToken = jwt.sign(
          {
            sub: user.user_id,
            type: 'refresh',
          },
          jwtSecret,
          {
            expiresIn: '30d',
            issuer: 'agor',
            audience: 'https://agor.dev',
          }
        );

        // Return new access token, new refresh token, and user
        return {
          accessToken,
          refreshToken: newRefreshToken,
          user: {
            user_id: user.user_id,
            email: user.email,
            name: user.name,
            emoji: user.emoji,
            role: user.role,
          },
        };
      } catch (_error) {
        throw new Error('Invalid or expired refresh token');
      }
    },
  });

  // Configure docs for refresh endpoint (override global security requirement)
  // biome-ignore lint/suspicious/noExplicitAny: FeathersJS service type not fully typed
  const refreshService = app.service('authentication/refresh') as any;
  refreshService.docs = {
    description: 'Token refresh endpoint - obtain a new access token using a refresh token',
    // Override global security - refresh endpoint must be public to obtain new tokens
    security: [],
  };

  // Initialize repositories for ClaudeTool
  const _messagesRepo = new MessagesRepository(db);
  const _sessionsRepo = new SessionRepository(db);
  const _sessionMCPRepo = new SessionMCPServerRepository(db);
  const _mcpServerRepo = new MCPServerRepository(db);
  const _worktreesRepo = new WorktreeRepository(db);
  const _reposRepo = new RepoRepository(db);
  const _tasksRepo = new TaskRepository(db);

  // Initialize PermissionService for UI-based permission prompts
  // Emits WebSocket events via sessions service for permission requests
  const permissionService = new PermissionService((event, data) => {
    // Emit events through sessions service for WebSocket broadcasting
    app.service('sessions').emit(event, data);
  });

  // NOTE: Direct tool execution path disabled - all SDK execution now goes through executor
  // Tools moved to @agor/executor package for isolation
  /*
  // Initialize ClaudeTool with repositories, API key, AND app-level service instances
  // CRITICAL: Must use app.service() to ensure WebSocket events are emitted
  // Using raw repository instances bypasses Feathers event publishing
  const claudeTool = new ClaudeTool(
    messagesRepo,
    sessionsRepo,
    apiKey,
    app.service('messages'),
    sessionMCPRepo,
    mcpServerRepo,
    permissionService,
    app.service('tasks'), // Use service instead of repo for WebSocket events
    app.service('sessions'), // Sessions service for permission persistence (WebSocket broadcast)
    worktreesRepo, // Worktrees repo for fetching worktree paths
    reposRepo, // Repos repo for repo-level permissions
    config.daemon?.mcpEnabled !== false, // Pass MCP enabled flag
    db // Database for resolving user environment variables
  );

  // Handle OPENAI_API_KEY with priority: config.yaml > env var
  // Config service will update process.env when credentials change (hot-reload)
  // CodexTool will read fresh credentials dynamically via getCredential() helper
  if (config.credentials?.OPENAI_API_KEY && !process.env.OPENAI_API_KEY) {
    process.env.OPENAI_API_KEY = config.credentials.OPENAI_API_KEY;
    console.log('✅ Set OPENAI_API_KEY from config for Codex');
  }

  const openaiApiKey = config.credentials?.OPENAI_API_KEY || process.env.OPENAI_API_KEY;
  const codexTool = new CodexTool(
    messagesRepo,
    sessionsRepo,
    sessionMCPRepo,
    worktreesRepo, // Worktrees repo for fetching worktree paths
    reposRepo, // Repos repo for session context
    openaiApiKey,
    app.service('messages'),
    app.service('tasks'),
    db // Database for env var resolution
  );

  if (!openaiApiKey) {
    console.warn('⚠️  No OPENAI_API_KEY found - Codex sessions will fail');
    console.warn('   Run: agor config set credentials.OPENAI_API_KEY <your-key>');
    console.warn('   Or set OPENAI_API_KEY environment variable');
  }

  // Initialize Gemini API key (with OAuth fallback support)
  const geminiApiKey = initializeGeminiApiKey(config, process.env.GEMINI_API_KEY);
  const geminiTool = new GeminiTool(
    messagesRepo,
    sessionsRepo,
    geminiApiKey,
    app.service('messages'),
    app.service('tasks'),
    worktreesRepo,
    reposRepo, // Repos repo for session context
    mcpServerRepo,
    sessionMCPRepo,
    config.daemon?.mcpEnabled !== false, // Pass MCP enabled flag
    db // Database for env var resolution
  );

  // Initialize OpenCodeTool
  // OpenCode server must be running separately: opencode serve --port 4096
  const openCodeServerUrl = config.opencode?.serverUrl || 'http://localhost:4096';
  const opencodeTool = new OpenCodeTool(
    {
      enabled: config.opencode?.enabled !== false,
      serverUrl: openCodeServerUrl,
    },
    app.service('messages')
  );

  if (config.opencode?.enabled !== false) {
    // Check OpenCode server availability on startup (non-blocking)
    opencodeTool.checkInstalled().then((isAvailable) => {
      if (!isAvailable) {
        console.warn('⚠️  OpenCode server not available at', openCodeServerUrl);
        console.warn('   Start OpenCode with: opencode serve --port 4096');
      } else {
        console.log('✅ OpenCode server available at', openCodeServerUrl);
      }
    });
  }
  */

  // Configure custom route for bulk message creation
  registerAuthenticatedRoute(
    app,
    '/messages/bulk',
    {
      async create(data: unknown, params: RouteParams) {
        // Type assertion safe: repository validates message structure
        return messagesService.createMany(data as Message[]);
      },
    },
    {
      create: { role: 'member', action: 'create messages' },
    },
    requireAuth
  );

  // Configure custom route for streaming event broadcasting
  // Called by executor to broadcast real-time events to WebSocket clients
  registerAuthenticatedRoute(
    app,
    '/messages/streaming',
    {
      async create(
        data: {
          event:
            | 'streaming:start'
            | 'streaming:chunk'
            | 'streaming:end'
            | 'streaming:error'
            | 'thinking:start'
            | 'thinking:chunk'
            | 'thinking:end';
          data: Record<string, unknown>;
        },
        params: RouteParams
      ) {
        // Security: Verify session ownership before broadcasting
        // Extract session_id from event data
        const sessionId = data.data.session_id as SessionID | undefined;

        if (!sessionId) {
          throw new Error('session_id is required in streaming event data');
        }

        // Load session via service to ensure authorization hooks run
        try {
          await app.service('sessions').get(sessionId, params);
        } catch (_error) {
          // If user doesn't have access to session, reject the broadcast
          throw new Error('Unauthorized: cannot broadcast events for this session');
        }

        // Broadcast event using app.service().emit() which triggers app.publish()
        app.service('messages').emit(data.event, data.data);
        return { success: true };
      },
    },
    {
      create: { role: 'member', action: 'broadcast streaming events' },
    },
    requireAuth
  );

  // Configure custom methods for sessions service (using sessionsService from line 700)
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

        // Manually broadcast the event to all connected clients
        // Internal service calls don't trigger automatic event publishing even with provider param
        console.log('📡 [FORK] Manually broadcasting created event to all clients');

        // Manually publish to Socket.io using app.io
        // Note: We only emit to Socket.io, not the service, to avoid duplicate events
        if (app.io) {
          app.io.emit('sessions created', forkedSession);
        }

        return forkedSession;
      },
    },
    {
      create: { role: 'member', action: 'fork sessions' },
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

        // Manually broadcast the event to all connected clients
        // Internal service calls don't trigger automatic event publishing even with provider param
        console.log('📡 [SPAWN] Manually broadcasting created event to all clients');

        // Manually publish to Socket.io using app.io
        // Note: We only emit to Socket.io, not the service, to avoid duplicate events
        if (app.io) {
          app.io.emit('sessions created', spawnedSession);
        }

        return spawnedSession;
      },
    },
    {
      create: { role: 'member', action: 'spawn sessions' },
    },
    requireAuth
  );

  // Feathers custom route handler with find method
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
      find: { role: 'member', action: 'view session genealogy' },
    },
    requireAuth
  );

  /**
   * Helper: Safely patch an entity, returning false if it was deleted mid-execution
   * IMPORTANT: Uses app.service() to trigger WebSocket event broadcasting
   */
  async function safePatch<T>(
    serviceName: string,
    id: string,
    data: Partial<T>,
    entityType: string,
    params?: RouteParams
  ): Promise<boolean> {
    try {
      // IMPORTANT: Use app.service() instead of service instance to go through
      // FeathersJS service layer and trigger app.publish() for WebSocket events
      await app.service(serviceName).patch(id, data, params || {});
      return true;
    } catch (error) {
      // Handle entity deletion mid-execution (NotFoundError from DrizzleService)
      // This can happen when worktree → session → task cascade deletes occur
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

  registerAuthenticatedRoute(
    app,
    '/sessions/:id/prompt',
    {
      async create(
        data: {
          prompt: string;
          permissionMode?: import('@agor/core/types').PermissionMode;
          stream?: boolean;
        },
        params: RouteParams
      ) {
        console.log(`📨 [Daemon] Prompt request for session ${params.route?.id?.substring(0, 8)}`);
        console.log(`   Permission mode: ${data.permissionMode || 'not specified'}`);
        console.log(`   Streaming: ${data.stream !== false}`);

        const id = params.route?.id;
        if (!id) throw new Error('Session ID required');
        if (!data.prompt) throw new Error('Prompt required');

        // Get session to find current message count
        const session = await sessionsService.get(id, params);

        // Reject prompts if session is stopping
        if (session.status === SessionStatus.STOPPING) {
          throw new Error('Cannot send prompt: session is currently stopping');
        }

        console.log(`   Session agent: ${session.agentic_tool}`);
        console.log(
          `   Session permission_config.mode: ${session.permission_config?.mode || 'not set'}`
        );
        const messageStartIndex = session.message_count;
        const startTimestamp = new Date().toISOString();

        // Get current git state from session's working directory
        const { getGitState, getCurrentBranch } = await import('@agor/core/git');
        let gitStateAtStart = 'unknown';
        let refAtStart = 'unknown'; // Default to 'unknown' if we can't get branch
        if (session.worktree_id) {
          try {
            const worktreesService = app.service('worktrees');
            const worktree = await worktreesService.get(session.worktree_id, params);
            gitStateAtStart = await getGitState(worktree.path);
            refAtStart = await getCurrentBranch(worktree.path);
          } catch (error) {
            console.warn(`Failed to get git state for worktree ${session.worktree_id}:`, error);
          }
        }

        // PHASE 1: Create task immediately with 'running' status (UI shows task instantly)
        const task = await tasksService.create(
          {
            session_id: id as SessionID,
            status: TaskStatus.RUNNING, // Start as running, will be updated to completed
            started_at: new Date().toISOString(), // Set start time in UTC
            description: data.prompt.substring(0, 120),
            full_prompt: data.prompt,
            message_range: {
              start_index: messageStartIndex,
              end_index: messageStartIndex + 1, // Will be updated after messages created
              start_timestamp: startTimestamp,
              end_timestamp: startTimestamp, // Will be updated when complete
            },
            tool_use_count: 0, // Will be updated after assistant message
            git_state: {
              ref_at_start: refAtStart, // Now always a string (never undefined)
              sha_at_start: gitStateAtStart,
            },
          },
          params
        );

        // Update session with new task
        // NOTE: Session status is automatically updated to RUNNING by TasksService.create() hook
        // when a task is created with RUNNING status. This ensures atomic updates and WebSocket events.
        // IMPORTANT: Use app.service() instead of sessionsService to go through
        // FeathersJS service layer and trigger app.publish() for WebSocket events
        await app.service('sessions').patch(
          id,
          {
            tasks: [...session.tasks, task.task_id],
          },
          params
        );

        // Create streaming callbacks for real-time UI updates
        // Custom events are registered via app.use('/messages', service, { events: [...] })
        const _streamingCallbacks = {
          onStreamStart: (messageId: string, metadata: Record<string, unknown>) => {
            console.debug(
              `📡 [${new Date().toISOString()}] Streaming start: ${messageId.substring(0, 8)}`
            );
            app.service('messages').emit('streaming:start', {
              message_id: messageId,
              ...metadata,
            });
          },
          onStreamChunk: (messageId: string, chunk: string) => {
            app.service('messages').emit('streaming:chunk', {
              message_id: messageId,
              session_id: id,
              chunk,
            });
          },
          onStreamEnd: (messageId: string) => {
            console.debug(
              `📡 [${new Date().toISOString()}] Streaming end: ${messageId.substring(0, 8)}`
            );
            app.service('messages').emit('streaming:end', {
              message_id: messageId,
              session_id: id,
            });
          },
          onStreamError: (messageId: string, error: Error) => {
            console.error(`❌ Streaming error for message ${messageId.substring(0, 8)}:`, error);
            app.service('messages').emit('streaming:error', {
              message_id: messageId,
              session_id: id,
              error: error.message,
            });
          },
          onThinkingStart: (messageId: string, metadata: Record<string, unknown>) => {
            console.debug(
              `📡 [${new Date().toISOString()}] Thinking start: ${messageId.substring(0, 8)}`
            );
            app.service('messages').emit('thinking:start', {
              message_id: messageId,
              ...metadata,
            });
          },
          onThinkingChunk: (messageId: string, chunk: string) => {
            app.service('messages').emit('thinking:chunk', {
              message_id: messageId,
              session_id: id,
              chunk,
            });
          },
          onThinkingEnd: (messageId: string) => {
            console.debug(
              `📡 [${new Date().toISOString()}] Thinking end: ${messageId.substring(0, 8)}`
            );
            app.service('messages').emit('thinking:end', {
              message_id: messageId,
              session_id: id,
            });
          },
        };

        // PHASE 2: Execute prompt in background (COMPLETELY DETACHED from HTTP request context)
        // Use setImmediate to break out of FeathersJS request scope
        // This ensures WebSocket events flush immediately, not batched with request
        const useStreaming = data.stream !== false; // Default to true

        // FEATHERS/WEBSOCKET MODE: Route through new executor architecture
        // Call the executeTask handler which spawns the executor process
        setImmediate(async () => {
          try {
            console.log(
              `🚀 [Daemon] Routing ${session.agentic_tool} to Feathers/WebSocket executor`
            );

            await sessionsService.executeTask(
              id,
              {
                taskId: task.task_id,
                prompt: data.prompt,
                permissionMode: data.permissionMode,
                stream: useStreaming,
              },
              params
            );

            // NOTE: Session status is automatically updated to IDLE by TasksService.patch() hook
            // when the task status changes to a terminal state (COMPLETED, FAILED, STOPPED).
            // DO NOT manually update session status here - it causes the session to go idle
            // immediately after spawning the executor, before the task actually starts running.
            console.log(
              `✅ [Daemon] Executor spawned for session ${id.substring(0, 8)}, waiting for task completion`
            );
          } catch (error) {
            console.error(`❌ [Daemon] Executor spawn failed:`, error);
            // Update task to failed status
            await safePatch(
              'tasks',
              task.task_id,
              {
                status: TaskStatus.FAILED,
                completed_at: new Date().toISOString(),
              },
              'Task',
              params
            );
            // Session status will be automatically updated to IDLE by TasksService.patch() hook
            // when the task status is updated to FAILED above
            console.log(`❌ [Daemon] Executor spawn failed for session ${id.substring(0, 8)}`);
          }
        });

        // Return immediately with task ID - don't wait for Claude to finish!
        return {
          success: true,
          taskId: task.task_id,
          status: TaskStatus.RUNNING,
          streaming: useStreaming, // Inform client whether streaming is enabled
        };
      },
    },
    {
      create: { role: 'member', action: 'execute prompts' },
    },
    requireAuth
  );

  // File upload endpoint
  // POST /sessions/:id/upload - Upload files to session's worktree
  // This uses Express middleware directly because multer needs to process files before Feathers
  const sessionRepo = new SessionRepository(db);
  const worktreeRepo = new WorktreeRepository(db);
  const uploadMiddleware = createUploadMiddleware(sessionRepo, worktreeRepo);

  // Debug logging only in development
  const DEBUG_UPLOAD = process.env.NODE_ENV !== 'production';

  // Add Express route directly for file upload (multer needs raw Express req/res)
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

      // Ensure user is authenticated and has member role
      const params = req.feathers as AuthenticatedParams;
      if (DEBUG_UPLOAD) {
        console.log(`   Auth params:`, {
          hasUser: !!params?.user,
          userId: params?.user?.user_id?.substring(0, 8),
          provider: params?.provider,
        });
      }

      ensureMinimumRole(params, 'member', 'upload files');

      // Verify user has access to this session (session-level ACL)
      const session = await sessionsService.get(sessionId, params);
      if (!session) {
        console.error(`❌ [Upload Handler] Session not found: ${sessionId.substring(0, 8)}`);
        return res.status(404).json({ error: 'Session not found' });
      }

      // Check if user is the session owner
      if (session.created_by !== params.user?.user_id) {
        console.error(
          `❌ [Upload Handler] User ${params.user?.user_id?.substring(0, 8)} not authorized for session ${sessionId.substring(0, 8)}`
        );
        return res.status(403).json({ error: 'Not authorized to upload to this session' });
      }

      if (!files || files.length === 0) {
        console.error('❌ [Upload Handler] No files in request');
        return res.status(400).json({ error: 'No files uploaded' });
      }

      // Get worktree to convert paths to relative
      let worktree: Awaited<ReturnType<typeof worktreeRepo.findById>> | undefined;
      if (session.worktree_id) {
        worktree = await worktreeRepo.findById(session.worktree_id);
      }

      // Convert absolute paths to relative for response
      const uploadedFiles = files.map((f) => {
        let relativePath = f.path;
        // Make path relative to worktree if possible
        if (worktree && f.path.startsWith(worktree.path)) {
          relativePath = f.path.substring(worktree.path.length + 1); // +1 for the leading slash
        }
        return {
          filename: f.filename, // Use sanitized filename from multer
          path: relativePath, // Return relative path, not absolute
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

      // If notifyAgent is true, send a prompt to the agent
      let notificationError: string | null = null;
      if ((notifyAgent === 'true' || notifyAgent === true) && message) {
        try {
          // Replace {filepath} placeholder with actual paths
          const filePaths = uploadedFiles.map((f) => f.path).join(', ');

          const promptText = message.replace(/\{filepath\}/g, filePaths);

          if (DEBUG_UPLOAD) {
            console.log(`   Sending prompt to agent: ${promptText.substring(0, 100)}...`);
          }

          // Use the same prompt service that the UI uses
          const promptService = app.service('/sessions/:id/prompt');

          // biome-ignore lint/suspicious/noExplicitAny: Express 5 + FeathersJS type mismatch
          const promptParams: any = {
            route: { id: sessionId },
            user: params.user,
            // Don't pass provider for internal calls - this bypasses auth hooks
            // provider: params.provider,
          };
          await promptService.create({ prompt: promptText }, promptParams);
        } catch (error) {
          console.error('❌ [Upload Handler] Failed to notify agent:', error);
          notificationError =
            error instanceof Error ? error.message : 'Failed to send notification to agent';
          // Don't throw - we still want to return the uploaded files
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

  // Add logging middleware to debug upload requests
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

  // Custom authentication middleware for multipart uploads
  // We can't use authenticate('jwt', 'anonymous') because it tries to parse the body,
  // which creates a deadlock with multer (multer can't run until auth completes, but
  // auth waits for body to be parsed)
  // biome-ignore lint/suspicious/noExplicitAny: Express 5 type compatibility
  const uploadAuthMiddleware: any = async (req: any, res: any, next: any) => {
    try {
      if (DEBUG_UPLOAD) console.log('🔐 [Upload Auth] Attempting authentication');

      let token = null;

      // First, try Authorization header (Bearer token)
      const authHeader = req.headers.authorization;
      if (authHeader?.startsWith('Bearer ')) {
        token = authHeader.substring(7); // Remove 'Bearer ' prefix
        if (DEBUG_UPLOAD) console.log('   Found token in Authorization header');
      }

      // Fallback to cookies if no Authorization header
      if (!token) {
        const cookies = req.headers.cookie || '';

        // Try different cookie name patterns (don't log cookie values)
        const patterns = [
          /feathers-jwt=([^;]+)/, // Standard Feathers cookie
          /agor-access-token=([^;]+)/, // Agor custom cookie
          /jwt=([^;]+)/, // Simple jwt cookie
        ];

        for (const pattern of patterns) {
          const match = cookies.match(pattern);
          if (match) {
            token = match[1];
            if (DEBUG_UPLOAD) console.log('   Found token in cookie');
            break;
          }
        }
      }

      if (!token) {
        if (DEBUG_UPLOAD) console.log('⚠️  [Upload Auth] No JWT token found, rejecting');
        return res.status(401).json({ error: 'Authentication required' });
      }

      if (DEBUG_UPLOAD) console.log('🔑 [Upload Auth] JWT token found, verifying...');

      // Manually verify the JWT using the same service Feathers uses
      const authService = app.service('authentication');
      const result = await authService.create({
        strategy: 'jwt',
        accessToken: token,
      });

      if (DEBUG_UPLOAD) {
        console.log('✅ [Upload Auth] Authentication successful');
        console.log('   User:', result.user?.user_id?.substring(0, 8));
      }

      // Set up req.feathers like Feathers auth would
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

  app.post(
    '/sessions/:sessionId/upload',
    uploadLogger,
    uploadAuthMiddleware,
    // Add middleware to log after auth
    // biome-ignore lint/suspicious/noExplicitAny: Express 5 type compatibility
    ((req: any, res: any, next: any) => {
      if (DEBUG_UPLOAD) {
        console.log('✅ [Upload Route] Authentication passed');
        console.log('   User:', req.feathers?.user?.user_id?.substring(0, 8) || 'anonymous');
      }
      next();
      // biome-ignore lint/suspicious/noExplicitAny: Express 5 type compatibility
    }) as any,
    // biome-ignore lint/suspicious/noExplicitAny: Express 5 + multer type compatibility
    uploadMiddleware.array('files', 10) as any,
    // Add middleware to log after multer
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
    // Error handler for this route
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

  // Stop execution endpoint
  registerAuthenticatedRoute(
    app,
    '/sessions/:id/stop',
    {
      async create(_data: unknown, params: RouteParams) {
        const id = params.route?.id;
        if (!id) throw new Error('Session ID required');

        // Get session to check status
        const session = await sessionsService.get(id, params);

        // Check if session is actually running or awaiting permission
        if (
          session.status !== SessionStatus.RUNNING &&
          session.status !== SessionStatus.AWAITING_PERMISSION
        ) {
          return {
            success: false,
            reason: `Session is not running (status: ${session.status})`,
          };
        }

        // Find the currently running task(s)
        // Note: Using two separate queries to avoid $in operator which fails schema validation
        let runningTasksArray: Task[] = [];
        // Query for RUNNING tasks
        const runningResult = await tasksService.find({
          query: {
            session_id: id,
            status: TaskStatus.RUNNING,
            $limit: 10,
          },
        });
        const runningFindResult = runningResult as Task[] | Paginated<Task>;
        const runningTasks = isPaginated(runningFindResult)
          ? runningFindResult.data
          : runningFindResult;

        // Query for AWAITING_PERMISSION tasks
        const awaitingResult = await tasksService.find({
          query: {
            session_id: id,
            status: TaskStatus.AWAITING_PERMISSION,
            $limit: 10,
          },
        });
        const awaitingFindResult = awaitingResult as Task[] | Paginated<Task>;
        const awaitingTasks = isPaginated(awaitingFindResult)
          ? awaitingFindResult.data
          : awaitingFindResult;

        runningTasksArray = [...runningTasks, ...awaitingTasks];

        if (runningTasksArray.length === 0) {
          return {
            success: false,
            reason: 'No running tasks found',
          };
        }

        const latestTask = runningTasksArray[runningTasksArray.length - 1];

        // PHASE 1: Atomically update task AND session to STOPPING
        try {
          // Update task status to STOPPING
          await tasksService.patch(latestTask.task_id, {
            status: TaskStatus.STOPPING,
          });

          // Update session status to STOPPING
          await app.service('sessions').patch(
            id,
            {
              status: SessionStatus.STOPPING,
              ready_for_prompt: false, // Prevent new prompts during stop
            },
            params
          );
        } catch (error) {
          return {
            success: false,
            reason: `Failed to update status: ${error instanceof Error ? error.message : 'Unknown error'}`,
          };
        }

        // PHASE 2: Use bulletproof stop handler with ACK protocol
        const { handleStopWithAck } = await import('./services/sessions/hooks/handle-stop.js');

        const result = await handleStopWithAck(
          app,
          id as SessionID,
          latestTask.task_id as TaskID,
          params
        );

        // PHASE 3: Handle failed stop (revert to RUNNING)
        if (!result.success) {
          try {
            await tasksService.patch(latestTask.task_id, {
              status: TaskStatus.RUNNING,
            });

            await app.service('sessions').patch(
              id,
              {
                status: SessionStatus.RUNNING,
                ready_for_prompt: false,
              },
              params
            );
          } catch (error) {
            console.error(`❌ [Daemon] Failed to revert status:`, error);
          }
        }

        return result;
      },
    },
    {
      create: { role: 'member', action: 'stop sessions' },
    },
    requireAuth
  );

  /**
   * POST /sessions/:id/messages/queue
   * GET /sessions/:id/messages/queue
   * Queue management endpoints (create and list)
   *
   * NOTE: Queue deletion is handled via messages service directly (client.service('messages').remove(id))
   * This keeps the client simple and avoids FeathersJS nested route issues
   */
  registerAuthenticatedRoute(
    app,
    '/sessions/:id/messages/queue',
    {
      async create(data: { prompt: string }, params: RouteParams) {
        const sessionId = params.route?.id;
        if (!sessionId) throw new Error('Session ID required');
        if (!data.prompt) throw new Error('Prompt required');

        const _session = await sessionsService.get(sessionId, params);

        // Create queued message with user context preserved in metadata
        // This ensures the message will be processed with the same authentication context
        const messageRepo = new MessagesRepository(db);
        const queuedMessage = await messageRepo.createQueued(sessionId as SessionID, data.prompt, {
          queued_by_user_id: params.user?.user_id,
        });

        console.log(
          `📬 Queued message for session ${sessionId.substring(0, 8)} at position ${queuedMessage.queue_position}`
        );

        // Emit event for real-time UI updates
        app.service('messages').emit('queued', queuedMessage);

        return {
          success: true,
          message: queuedMessage,
        };
      },

      async find(params: RouteParams) {
        const sessionId = params.route?.id;
        if (!sessionId) throw new Error('Session ID required');

        const messageRepo = new MessagesRepository(db);
        const queued = await messageRepo.findQueued(sessionId as SessionID);

        return {
          total: queued.length,
          data: queued,
        };
      },
      // biome-ignore lint/suspicious/noExplicitAny: Service type not compatible with Express
    } as any,
    {
      create: { role: 'member', action: 'queue messages' },
      find: { role: 'member', action: 'view queue' },
    },
    requireAuth
  );

  /**
   * Process the next queued message for a session
   * Called automatically after task completion when session becomes idle
   *
   * NOTE: params argument may be empty when called from callback-triggered queue processing.
   * We reconstruct the original user's authentication context from message metadata.
   *
   * IMPORTANT: Uses promise-based lock to prevent concurrent processing of the same session's queue.
   * Concurrent callers WAIT for the current processing to complete rather than skipping, which
   * ensures we don't miss queued messages due to race conditions.
   *
   * SELF-HEALING: After each message is processed, we check for more queued messages.
   * This ensures callbacks queued during processing are not missed.
   */
  // Promise-based lock: maps session ID to the active processing promise
  // We store the actual processing promise (with .catch() to prevent unhandled rejection)
  // Concurrent callers wait on this promise then retry, ensuring no messages are missed
  const queueProcessingLocks = new Map<SessionID, Promise<void>>();

  // Track if a retry is already scheduled for a session (to avoid duplicate retries)
  const queueRetryScheduled = new Set<SessionID>();

  async function processNextQueuedMessage(
    sessionId: SessionID,
    params: RouteParams
  ): Promise<void> {
    // Check if already processing queue for this session
    const existingLock = queueProcessingLocks.get(sessionId);
    if (existingLock) {
      console.log(
        `⏳ [Queue] Processing in progress for session ${sessionId.substring(0, 8)}, waiting...`
      );
      // Wait for current processing to complete (errors are already handled by the lock)
      await existingLock;
      // After waiting, schedule a retry (if not already scheduled)
      // Use setImmediate to avoid deep recursion and allow other events to process
      if (!queueRetryScheduled.has(sessionId)) {
        queueRetryScheduled.add(sessionId);
        setImmediate(async () => {
          queueRetryScheduled.delete(sessionId);
          try {
            await processNextQueuedMessage(sessionId, params);
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

    // Create the processing promise and store it as the lock
    // CRITICAL: We attach .catch() to prevent unhandled rejection when no one is waiting
    // The actual error is still thrown to the original caller via the unwrapped promise
    const processingPromise = processNextQueuedMessageInternal(sessionId, params);

    // Store with .catch() so if no one is awaiting, Node won't crash on rejection
    queueProcessingLocks.set(
      sessionId,
      processingPromise.catch(() => {
        // Swallow error for waiters - they'll retry anyway
      })
    );

    try {
      await processingPromise;
    } finally {
      // Release lock
      queueProcessingLocks.delete(sessionId);
    }
  }

  async function processNextQueuedMessageInternal(
    sessionId: SessionID,
    params: RouteParams
  ): Promise<void> {
    // Get next queued message
    const messageRepo = new MessagesRepository(db);
    const nextMessage = await messageRepo.getNextQueued(sessionId);

    if (!nextMessage) {
      console.log(`📭 No queued messages for session ${sessionId.substring(0, 8)}`);
      return;
    }

    // Reconstruct authentication context from message metadata
    // If the message was queued by a specific user, use their context
    // Otherwise fall back to provided params (may be empty for callback-triggered queues)
    const userId = nextMessage.metadata?.queued_by_user_id as string | undefined;
    const userRepo = new UsersRepository(db);
    const queuedByUser = userId ? await userRepo.findById(userId) : undefined;

    // Reconstruct params with user context
    const messageParams: RouteParams = queuedByUser
      ? ({
          ...params,
          user: queuedByUser,
        } as RouteParams)
      : params;

    console.log(
      `📬 Processing queued message ${nextMessage.message_id.substring(0, 8)} ` +
        `with user context: ${queuedByUser ? queuedByUser.user_id.substring(0, 8) : 'none'}`
    );

    // Re-fetch session to ensure it's still idle and not awaiting permission
    const session = await sessionsService.get(sessionId, messageParams);

    if (session.status !== SessionStatus.IDLE) {
      // Session is not idle, we cannot process the queue now.
      // The session.patch after-hook will trigger queue processing when session becomes IDLE.
      // Log this so we can track if messages are waiting.
      console.log(
        `⏸️  [Queue] Session ${sessionId.substring(0, 8)} is ${session.status}, message ${nextMessage.message_id.substring(0, 8)} waiting in queue ` +
          `(will be processed when session becomes IDLE via patch hook)`
      );
      return;
    }

    console.log(
      `📬 Processing queued message ${nextMessage.message_id.substring(0, 8)} (position ${nextMessage.queue_position})`
    );

    // Extract prompt from queued message
    // NOTE: Queued messages always have string content (validated in createQueued)
    const prompt = nextMessage.content as string;

    // Verify message still exists (user might have deleted it while we were checking)
    const messagesService = app.service('messages') as unknown as MessagesServiceImpl;
    try {
      const stillExists = await messagesService.get(nextMessage.message_id, messageParams);
      if (!stillExists || stillExists.status !== 'queued') {
        console.log(
          `⚠️  Queued message ${nextMessage.message_id.substring(0, 8)} was deleted or modified, skipping`
        );
        return;
      }
    } catch (_error) {
      console.log(
        `⚠️  Queued message ${nextMessage.message_id.substring(0, 8)} no longer exists, skipping`
      );
      return;
    }

    // Delete the queued message (execution will create new messages)
    // Use the service so the after.remove hook fires and emits the dequeued event
    await messagesService.remove(nextMessage.message_id, messageParams);

    // Trigger prompt execution via existing endpoint
    // This creates task, user message, executes agent, etc.
    // IMPORTANT: Use messageParams (reconstructed from queued message metadata)
    // to preserve the original user's authentication context
    const promptService = app.service('/sessions/:id/prompt') as {
      create: (data: { prompt: string; stream?: boolean }, params: RouteParams) => Promise<unknown>;
    };

    await promptService.create(
      {
        prompt,
        stream: true,
      },
      {
        ...messageParams,
        route: { id: sessionId },
      }
    );

    console.log(`✅ Queued message triggered for session ${sessionId.substring(0, 8)}`);
  }

  // Inject queue processor into sessions service
  // Used by callback system to immediately process queued callbacks
  sessionsService.setQueueProcessor(async (sessionId: SessionID, params?: RouteParams) => {
    try {
      await processNextQueuedMessage(sessionId, params || {});
    } catch (error) {
      console.error(`❌ [Sessions] Failed to process queued message:`, error);
    }
  });

  // Permission decision endpoint
  registerAuthenticatedRoute(
    app,
    '/sessions/:id/permission-decision',
    {
      async create(data: PermissionDecision, params: RouteParams) {
        const id = params.route?.id;
        if (!id) throw new Error('Session ID required');
        if (!data.requestId) throw new Error('requestId required');
        if (typeof data.allow !== 'boolean') throw new Error('allow field required');

        // Find the permission request message
        const messagesService = app.service('messages');
        const messages = await messagesService.find({
          query: {
            session_id: id,
            type: 'permission_request',
            $limit: 100, // Get recent permission requests
          },
        });

        const messageList = isPaginated(messages) ? messages.data : messages;
        const permissionMessage = messageList.find((msg: Message) => {
          // Type-safe access to permission request content
          const content = msg.content as PermissionRequestContent;
          return content?.request_id === data.requestId;
        });

        if (!permissionMessage) {
          throw new Error(`Permission request ${data.requestId} not found`);
        }

        // Type-safe access to permission content
        const permissionContent = permissionMessage.content as PermissionRequestContent;

        // Resolve task_id with fallback for backward compatibility:
        // 1. Try content.task_id (new messages)
        // 2. Fall back to message.task_id (legacy messages or if content was missing it)
        const resolvedTaskId = permissionContent.task_id || permissionMessage.task_id;

        if (!resolvedTaskId) {
          console.error(
            `❌ [Permission] Cannot resolve permission: task_id missing from both content and message. requestId=${data.requestId}`
          );
          throw new Error(
            'Cannot process permission decision: task_id is missing. This permission request may be corrupted.'
          );
        }

        // Update the message to mark it as approved/denied
        // This triggers the messages.patch hook which notifies the executor via IPC (legacy mode)
        await messagesService.patch(permissionMessage.message_id, {
          content: {
            ...permissionContent,
            status: data.allow ? 'approved' : 'denied',
            scope: data.scope,
            approved_by: data.decidedBy,
            approved_at: new Date().toISOString(),
          },
        });

        // Also resolve the in-memory permission request (for direct tool execution)
        permissionService.resolvePermission(data);

        // Emit permission_resolved event for Feathers/WebSocket executor architecture
        // IMPORTANT: Use camelCase property names to match executor's expectations
        app.service('messages').emit('permission_resolved', {
          requestId: data.requestId,
          taskId: resolvedTaskId, // Use resolved task_id with fallback for backward compat
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
      create: { role: 'member', action: 'respond to permission requests' },
    },
    requireAuth
  );

  // Configure custom methods for tasks service
  const tasksService = app.service('tasks') as unknown as TasksServiceImpl;

  // Configure custom route for bulk task creation
  registerAuthenticatedRoute(
    app,
    '/tasks/bulk',
    {
      async create(data: unknown, params: RouteParams) {
        return tasksService.createMany(data as Partial<Task>[]);
      },
    },
    {
      create: { role: 'member', action: 'create tasks' },
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
      create: { role: 'member', action: 'complete tasks' },
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
      create: { role: 'member', action: 'fail tasks' },
    },
    requireAuth
  );

  // Configure custom methods for repos service
  const reposService = app.service('repos') as unknown as ReposServiceImpl;

  registerAuthenticatedRoute(
    app,
    '/repos/local',
    {
      async create(data: { path: string; slug?: string }, params: RouteParams) {
        return reposService.addLocalRepository(data, params);
      },
    },
    {
      create: { role: 'member', action: 'add local repositories' },
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
      create: { role: 'member', action: 'clone repositories' },
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
      create: { role: 'member', action: 'create worktrees' },
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
      remove: { role: 'member', action: 'remove worktrees' },
    },
    requireAuth
  );

  registerAuthenticatedRoute(
    app,
    '/repos/:id/import-agor-yml',
    {
      async create(_data: unknown, params: RouteParams) {
        const id = params.route?.id;
        if (!id) throw new Error('Repo ID required');
        return reposService.importFromAgorYml(id, {}, params);
      },
    },
    {
      create: { role: 'member', action: 'import .agor.yml' },
    },
    requireAuth
  );

  registerAuthenticatedRoute(
    app,
    '/repos/:id/export-agor-yml',
    {
      async create(_data: unknown, params: RouteParams) {
        const id = params.route?.id;
        if (!id) throw new Error('Repo ID required');
        return reposService.exportToAgorYml(id, {}, params);
      },
    },
    {
      create: { role: 'member', action: 'export .agor.yml' },
    },
    requireAuth
  );

  // Configure custom methods for board-comments service (Phase 2: Threading + Reactions)
  const boardCommentsService = app.service('board-comments') as unknown as {
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

  // POST /board-comments/:id/toggle-reaction - Toggle emoji reaction on comment
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
        // Manually emit patched event for real-time updates
        app.service('board-comments').emit('patched', updated);
        return updated;
      },
    },
    {
      create: { role: 'member', action: 'react to board comments' },
    },
    requireAuth
  );

  // POST /board-comments/:id/reply - Create a reply to a comment thread
  registerAuthenticatedRoute(
    app,
    '/board-comments/:id/reply',
    {
      async create(data: Partial<import('@agor/core/types').BoardComment>, params: RouteParams) {
        const id = params.route?.id;
        if (!id) throw new Error('Comment ID required');
        if (!data.content) throw new Error('content required');
        if (!data.created_by) throw new Error('created_by required');
        const reply = await boardCommentsService.createReply(id, data, params);
        // Manually emit created event for real-time updates
        app.service('board-comments').emit('created', reply);
        return reply;
      },
    },
    {
      create: { role: 'member', action: 'reply to board comments' },
    },
    requireAuth
  );

  // Configure custom methods for worktrees service (environment management)
  const worktreesService = app.service(
    'worktrees'
  ) as unknown as import('./declarations').WorktreesServiceImpl;

  // POST /worktrees/:id/start - Start environment
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
      create: { role: 'admin', action: 'start worktree environments' },
    },
    requireAuth
  );

  // POST /worktrees/:id/stop - Stop environment
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
      create: { role: 'admin', action: 'stop worktree environments' },
    },
    requireAuth
  );

  // POST /worktrees/:id/restart - Restart environment
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
      create: { role: 'admin', action: 'restart worktree environments' },
    },
    requireAuth
  );

  // POST /worktrees/:id/nuke - Nuke environment (destructive)
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
      create: { role: 'admin', action: 'nuke worktree environments' },
    },
    requireAuth
  );

  // GET /worktrees/:id/health - Check environment health
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
      find: { role: 'member', action: 'check worktree health' },
    },
    requireAuth
  );

  // POST /worktrees/:id/archive-or-delete - Archive or delete worktree
  registerAuthenticatedRoute(
    app,
    '/worktrees/:id/archive-or-delete',
    {
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
      // biome-ignore lint/suspicious/noExplicitAny: Service type not compatible with Express
    } as any,
    {
      create: { role: 'admin', action: 'archive or delete worktrees' },
    },
    requireAuth
  );

  // POST /worktrees/:id/unarchive - Unarchive worktree
  registerAuthenticatedRoute(
    app,
    '/worktrees/:id/unarchive',
    {
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
      // biome-ignore lint/suspicious/noExplicitAny: Service type not compatible with Express
    } as any,
    {
      create: { role: 'admin', action: 'unarchive worktrees' },
    },
    requireAuth
  );

  // GET /worktrees/logs?worktree_id=xxx - Get environment logs
  registerAuthenticatedRoute(
    app,
    '/worktrees/logs',
    {
      async find(params: Params) {
        console.log('📋 Logs endpoint called');

        // Extract worktree ID from query params
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
      find: { role: 'member', action: 'view worktree logs' },
    },
    requireAuth
  );

  // ===== RBAC: Worktree Owner Management =====
  // Now handled by the worktree-owners service (registered above)

  // Configure custom methods for boards service
  const boardsService = app.service('boards') as unknown as BoardsServiceImpl;

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
      create: { role: 'member', action: 'modify board sessions' },
    },
    requireAuth
  );

  // Configure custom routes for session-MCP relationships
  // (sessionMCPServersService already created above for top-level service)

  // GET /sessions/:id/mcp-servers - List MCP servers for a session
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
      // POST /sessions/:id/mcp-servers - Add MCP server to session
      async create(data: { mcpServerId: string }, params: RouteParams) {
        const id = params.route?.id;
        if (!id) throw new Error('Session ID required');
        if (!data.mcpServerId) throw new Error('MCP Server ID required');

        await sessionMCPServersService.addServer(
          id as import('@agor/core/types').SessionID,
          data.mcpServerId as import('@agor/core/types').MCPServerID,
          params
        );

        // Emit created event for WebSocket subscribers
        const relationship = {
          session_id: id,
          mcp_server_id: data.mcpServerId,
          enabled: true,
          added_at: new Date(),
        };
        app.service('session-mcp-servers').emit('created', relationship);

        return relationship;
      },
      // biome-ignore lint/suspicious/noExplicitAny: Service type not compatible with Express
    } as any,
    {
      find: { role: 'member', action: 'view session MCP servers' },
      create: { role: 'member', action: 'modify session MCP servers' },
    },
    requireAuth
  );

  // DELETE /sessions/:id/mcp-servers/:mcpId - Remove MCP server from session
  registerAuthenticatedRoute(
    app,
    '/sessions/:id/mcp-servers/:mcpId',
    {
      async remove(_id: unknown, params: RouteParams & { route?: { mcpId?: string } }) {
        const id = params.route?.id;
        const mcpId = params.route?.mcpId;
        if (!id) throw new Error('Session ID required');
        if (!mcpId) throw new Error('MCP Server ID required');

        await sessionMCPServersService.removeServer(
          id as import('@agor/core/types').SessionID,
          mcpId as import('@agor/core/types').MCPServerID,
          params
        );

        // Emit removed event for WebSocket subscribers
        const relationship = {
          session_id: id,
          mcp_server_id: mcpId,
        };
        app.service('session-mcp-servers').emit('removed', relationship);

        return relationship;
      },
      // PATCH /sessions/:id/mcp-servers/:mcpId - Toggle MCP server enabled state
      async patch(
        _id: unknown,
        data: { enabled: boolean },
        params: RouteParams & { route?: { mcpId?: string } }
      ) {
        const id = params.route?.id;
        const mcpId = params.route?.mcpId;
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
      remove: { role: 'member', action: 'modify session MCP servers' },
      patch: { role: 'member', action: 'modify session MCP servers' },
    },
    requireAuth
  );

  // Note: Sessions are no longer directly on boards (worktree-only architecture).
  // Sessions are accessed through worktree cards. No cleanup needed on session deletion.

  // Health check endpoint
  // SECURITY: Minimal public endpoint for uptime monitoring
  // Authenticated users can get detailed info, public users get basic status only
  app.use('/health', {
    async find(params?: Params) {
      // Basic status (always public for monitoring systems)
      // IMPORTANT: Include auth config in public response so frontend can decide
      // whether to show login page BEFORE authenticating (avoid chicken-egg problem)
      // Also include instance label/description for UI identification
      const publicResponse = {
        status: 'ok',
        timestamp: Date.now(),
        version: DAEMON_VERSION,
        auth: {
          requireAuth: config.daemon?.requireAuth === true,
          allowAnonymous: allowAnonymous,
        },
        instance: {
          label: config.daemon?.instanceLabel,
          description: config.daemon?.instanceDescription,
        },
      };

      // If user is authenticated (via requireAuth hook check), provide detailed info
      // Check if this is an authenticated request
      // biome-ignore lint/suspicious/noExplicitAny: FeathersJS request params are untyped
      const isAuthenticated = (params as any)?.user !== undefined;

      if (isAuthenticated) {
        // Prepare database info with dialect and masked credentials
        const dialect = process.env.AGOR_DB_DIALECT === 'postgresql' ? 'postgresql' : 'sqlite';
        let databaseInfo: { dialect: string; url?: string; path?: string };

        if (dialect === 'postgresql') {
          // Mask password in PostgreSQL URL
          const maskedUrl = DB_PATH.replace(/:([^:@]+)@/, ':****@');
          databaseInfo = { dialect, url: maskedUrl };
        } else {
          // Show file path for SQLite
          databaseInfo = { dialect, path: DB_PATH };
        }

        return {
          ...publicResponse,
          database: databaseInfo,
          auth: {
            ...publicResponse.auth,
            // biome-ignore lint/suspicious/noExplicitAny: FeathersJS request params are untyped
            user: (params as any)?.user?.email,
            // biome-ignore lint/suspicious/noExplicitAny: FeathersJS request params are untyped
            role: (params as any)?.user?.role,
          },
          encryption: {
            enabled: !!process.env.AGOR_MASTER_SECRET,
            method: process.env.AGOR_MASTER_SECRET ? 'AES-256-GCM' : null,
          },
          mcp: {
            enabled: config.daemon?.mcpEnabled !== false,
          },
        };
      }

      // Public response (no sensitive data)
      return publicResponse;
    },
  });

  // Configure docs for health endpoint (override global security requirement)
  // biome-ignore lint/suspicious/noExplicitAny: FeathersJS service type not fully typed
  const healthService = app.service('health') as any;
  healthService.docs = {
    description: 'Health check endpoint (always public)',
    // Override global security to allow unauthenticated access
    security: [],
  };

  // OpenCode models endpoint - fetch available providers and models dynamically
  app.use('/opencode/models', {
    async find() {
      try {
        // Reload config to get latest OpenCode settings (no caching)
        const freshConfig = await loadConfig();
        const opencodeConfig = freshConfig.opencode;
        if (!opencodeConfig?.enabled) {
          throw new Error('OpenCode is not enabled in configuration');
        }

        const serverUrl = opencodeConfig.serverUrl || 'http://localhost:4096';
        console.log('[OpenCode] Fetching models from server:', serverUrl);

        // Fetch from /config/providers which returns only configured providers
        // with models that are enabled in OpenCode settings
        const response = await fetch(`${serverUrl}/config/providers`);

        if (!response.ok) {
          throw new Error(`OpenCode server returned ${response.status}: ${response.statusText}`);
        }

        // Response structure: { providers: Provider[], default: {[key: string]: string} }
        // Provider has: { id, name, models: {[modelId]: Model} }
        const data = (await response.json()) as {
          providers: Array<{
            id: string;
            name: string;
            models: Record<string, { name?: string }>;
          }>;
          default: Record<string, string>;
        };

        // Use all providers from this endpoint (they're already filtered to configured ones)
        const connectedProviders = data.providers;

        // Transform to frontend-friendly format
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

  // Configure docs for OpenCode models endpoint
  // biome-ignore lint/suspicious/noExplicitAny: FeathersJS service type not fully typed
  const opencodeModelsService = app.service('opencode/models') as any;
  opencodeModelsService.docs = {
    description: 'Get available OpenCode providers and models (requires OpenCode server running)',
    security: [], // Public endpoint - no auth required
  };

  // OpenCode health check endpoint - proxy to test connection
  app.use('/opencode/health', {
    // biome-ignore lint/suspicious/noExplicitAny: FeathersJS params type varies, runtime query param check
    async find(params?: any) {
      try {
        // Use serverUrl from query params if provided, otherwise fall back to saved config
        let serverUrl: string;

        if (params?.query?.serverUrl) {
          // Test with the provided serverUrl (from frontend, not yet saved)
          serverUrl = params.query.serverUrl;
        } else {
          // Fall back to saved config
          const freshConfig = await loadConfig();
          const opencodeConfig = freshConfig.opencode;
          if (!opencodeConfig?.enabled) {
            throw new Error('OpenCode is not enabled in configuration');
          }
          serverUrl = opencodeConfig.serverUrl || 'http://localhost:4096';
        }

        // OpenCode doesn't have a /health endpoint - use /config as a lightweight test
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

  // Configure docs for OpenCode health endpoint
  // biome-ignore lint/suspicious/noExplicitAny: FeathersJS service type not fully typed
  const opencodeHealthService = app.service('opencode/health') as any;
  opencodeHealthService.docs = {
    description: 'Test connection to OpenCode server',
    security: [], // Public endpoint - no auth required
  };

  // Setup MCP routes (if enabled)
  if (config.daemon?.mcpEnabled !== false) {
    const { setupMCPRoutes } = await import('./mcp/routes.js');
    setupMCPRoutes(app);
    console.log('✅ MCP server enabled at POST /mcp');
  } else {
    console.log('🔒 MCP server disabled via config (daemon.mcpEnabled=false)');
  }

  // Global app hooks - enforce password change requirement
  // This runs after authentication and before any service method
  app.hooks({
    before: {
      all: [enforcePasswordChange],
    },
  });

  // Error handling
  app.use(errorHandler());

  // Cleanup orphaned running tasks and sessions from previous daemon instance
  // When daemon restarts (crashes, code changes, etc.), tasks/sessions remain in 'running' state
  console.log('🧹 Cleaning up orphaned tasks and sessions...');

  // Find all orphaned tasks (running, stopping, awaiting_permission)
  const orphanedTasks = await tasksService.getOrphaned();

  if (orphanedTasks.length > 0) {
    console.log(`   Found ${orphanedTasks.length} orphaned task(s)`);
    for (const task of orphanedTasks) {
      await tasksService.patch(task.task_id, {
        status: TaskStatus.STOPPED,
      });
      console.log(`   ✓ Marked task ${task.task_id} as stopped (was: ${task.status})`);
    }
  }

  // Find all running sessions (should be stopped when daemon restarts)
  const orphanedSessionsResult = (await sessionsService.find({
    query: {
      status: SessionStatus.RUNNING,
      $limit: 1000,
    },
  })) as unknown as Paginated<Session>;
  const orphanedSessions = orphanedSessionsResult.data;

  if (orphanedSessions.length > 0) {
    console.log(`   Found ${orphanedSessions.length} orphaned session(s) with RUNNING status`);
    for (const session of orphanedSessions) {
      // IMPORTANT: Use app.service() instead of sessionsService to go through
      // FeathersJS service layer and trigger app.publish() for WebSocket events
      // For internal/system operations, pass empty params object
      await app.service('sessions').patch(
        session.session_id,
        {
          status: SessionStatus.IDLE,
          ready_for_prompt: true, // Set atomically with status
        },
        {}
      );
      console.log(
        `   ✓ Marked session ${session.session_id.substring(0, 8)} as idle (was: ${session.status})`
      );
    }
  }

  // Also check for sessions that had orphaned tasks (even if session status wasn't RUNNING)
  // This handles cases where task was stuck but session status wasn't updated
  const sessionIdsWithOrphanedTasks = new Set(
    orphanedTasks.map((t: Task) => t.session_id as string)
  );
  if (sessionIdsWithOrphanedTasks.size > 0) {
    console.log(
      `   Checking ${sessionIdsWithOrphanedTasks.size} session(s) with orphaned tasks...`
    );
    for (const sessionId of sessionIdsWithOrphanedTasks) {
      const session = await sessionsService.get(sessionId as Id);
      // If session is still marked as RUNNING after orphaned task cleanup, set to IDLE
      if (session.status === SessionStatus.RUNNING) {
        // IMPORTANT: Use app.service() instead of sessionsService to go through
        // FeathersJS service layer and trigger app.publish() for WebSocket events
        // For internal/system operations, pass empty params object
        await app.service('sessions').patch(
          sessionId as Id,
          {
            status: SessionStatus.IDLE,
            ready_for_prompt: true, // Set atomically with status
          },
          {}
        );
        console.log(
          `   ✓ Marked session ${sessionId.substring(0, 8)} as idle (had orphaned tasks)`
        );
      }
    }
  }

  if (orphanedTasks.length === 0 && orphanedSessions.length === 0) {
    console.log('   No orphaned tasks or sessions found');
  }

  // Initialize Health Monitor for periodic environment health checks
  const healthMonitor = await createHealthMonitor(app);

  // Validate master secret for API key encryption
  if (!process.env.AGOR_MASTER_SECRET) {
    // Check if we have a saved secret in config
    const savedSecret = config.daemon?.masterSecret;

    if (savedSecret) {
      // Use saved secret from config
      process.env.AGOR_MASTER_SECRET = savedSecret;
      console.log('🔐 Using saved AGOR_MASTER_SECRET from config');
    } else {
      // Auto-generate a random master secret and persist it in config
      const { randomBytes } = await import('node:crypto');
      const { setConfigValue } = await import('@agor/core/config');

      const generatedSecret = randomBytes(32).toString('hex');
      await setConfigValue('daemon.masterSecret', generatedSecret);
      process.env.AGOR_MASTER_SECRET = generatedSecret;

      console.log('🔐 Generated and saved AGOR_MASTER_SECRET for API key encryption');
      console.log('   Secret stored in ~/.agor/config.yaml');
    }
  } else {
    console.log('🔐 API key encryption enabled (AGOR_MASTER_SECRET set)');
  }

  // Start server and store reference for shutdown
  const server = await app.listen(DAEMON_PORT);

  console.log(`🚀 Agor daemon running at http://localhost:${DAEMON_PORT}`);
  console.log(`   Health: http://localhost:${DAEMON_PORT}/health`);
  console.log(
    `   Authentication: ${config.daemon?.allowAnonymous !== false ? '🔓 Anonymous (default)' : '🔐 Required'}`
  );
  console.log(`   Login: POST http://localhost:${DAEMON_PORT}/authentication`);
  console.log(`   Services:`);
  console.log(`     - /sessions`);
  console.log(`     - /tasks`);
  console.log(`     - /messages`);
  console.log(`     - /boards`);
  console.log(`     - /repos`);
  console.log(`     - /mcp-servers`);
  console.log(`     - /config`);
  console.log(`     - /context`);
  console.log(`     - /users`);

  // Start scheduler service (background worker)
  const schedulerService = new SchedulerService(db, app, {
    tickInterval: 30000, // 30 seconds
    gracePeriod: 120000, // 2 minutes
    debug: process.env.NODE_ENV !== 'production',
  });
  schedulerService.start();
  console.log(`🔄 Scheduler started (tick interval: 30s)`);

  // Graceful shutdown handler
  const shutdown = async (signal: string) => {
    console.log(`\n⏳ Received ${signal}, shutting down gracefully...`);

    try {
      // Clean up health monitor
      healthMonitor.cleanup();

      // Clean up terminal sessions
      console.log('🖥️  Cleaning up terminal sessions...');
      terminalsService.cleanup();

      // Stop scheduler
      console.log('🔄 Stopping scheduler...');
      schedulerService.stop();

      // Close Socket.io connections (this also closes the HTTP server)
      const socketServer = socketIOConfig.getSocketServer();
      if (socketServer) {
        console.log('🔌 Closing Socket.io and HTTP server...');
        // Disconnect all active clients first
        socketServer.disconnectSockets();
        // Give sockets a moment to disconnect
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
        // Now close the server with a timeout
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(() => {
            console.warn('⚠️  Server close timeout, forcing exit');
            resolve();
          }, 2000);

          socketServer?.close(() => {
            clearTimeout(timeout);
            console.log('✅ Server closed');
            resolve();
          });
        });
      } else {
        // Fallback: close HTTP server directly if Socket.io wasn't initialized
        await new Promise<void>((resolve, reject) => {
          server.close((err) => {
            if (err) {
              console.error('❌ Error closing server:', err);
              reject(err);
            } else {
              console.log('✅ HTTP server closed');
              resolve();
            }
          });
        });
      }

      process.exit(0);
    } catch (error) {
      console.error('❌ Error during shutdown:', error);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// Start the daemon
main().catch((error) => {
  console.error('Failed to start daemon:', error);
  process.exit(1);
});
