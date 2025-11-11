/**
 * Agor Daemon
 *
 * FeathersJS backend providing REST + WebSocket API for session management.
 * Auto-started by CLI, provides unified interface for GUI and CLI clients.
 */

import 'dotenv/config';

// Read package version once at startup (not on every /health request)
// Use fs.readFile instead of import (works reliably with tsx and node)
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, type UnknownJson } from '@agor/core/config';

let DAEMON_VERSION = '0.0.0';
try {
  const __dirname = dirname(fileURLToPath(import.meta.url));

  // Try to read from ../package.json (development) or ../../package.json (agor-live)
  let pkgPath = join(__dirname, '../package.json');
  let pkgData: string | undefined;

  try {
    pkgData = await readFile(pkgPath, 'utf-8');
  } catch {
    // If ../package.json doesn't exist, try ../../package.json (agor-live structure)
    pkgPath = join(__dirname, '../../package.json');
    try {
      pkgData = await readFile(pkgPath, 'utf-8');
    } catch {
      // Silently fail - will use default version
    }
  }

  if (pkgData) {
    const pkg = JSON.parse(pkgData);
    DAEMON_VERSION = pkg.version || DAEMON_VERSION;
  }
} catch (err) {
  // Fallback if package.json can't be read
  console.warn('⚠️  Could not read package.json for version - using fallback 0.0.0', err);
}

import {
  createDatabaseAsync,
  MCPServerRepository,
  MessagesRepository,
  RepoRepository,
  SessionMCPServerRepository,
  SessionRepository,
  sessionMcpServers,
  TaskRepository,
  WorktreeRepository,
} from '@agor/core/db';
import {
  AuthenticationService,
  authenticate,
  errorHandler,
  Forbidden,
  feathers,
  feathersExpress,
  JWTStrategy,
  LocalStrategy,
  NotAuthenticated,
  rest,
  socketio,
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
import { ClaudeTool, CodexTool, GeminiTool, OpenCodeTool } from '@agor/core/tools';
import type {
  AuthenticatedParams,
  Id,
  Message,
  Paginated,
  Params,
  Session,
  SessionID,
  Task,
  User,
} from '@agor/core/types';
import { SessionStatus, TaskStatus } from '@agor/core/types';
import {
  calculateContextWindowUsage,
  calculateCumulativeContextWindow,
  getContextWindowLimit,
  getSessionContextUsage,
} from '@agor/core/utils/context-window';
import { NotFoundError } from '@agor/core/utils/errors';
import type { TokenUsage } from '@agor/core/utils/pricing';
// Import Claude SDK's PermissionMode type for ClaudeTool method signatures
// (Agor's PermissionMode is a superset of all tool permission modes)
import type { PermissionMode as ClaudePermissionMode } from '@anthropic-ai/claude-agent-sdk';
import { validateQuery } from '@feathersjs/schema';

/**
 * Type guard to check if result is paginated
 */
function isPaginated<T>(result: T[] | Paginated<T>): result is Paginated<T> {
  return !Array.isArray(result) && 'data' in result && 'total' in result;
}

/**
 * Calculate context window for a completed task (Claude Code only)
 *
 * For Claude Code sessions, fetches all tasks and messages to calculate cumulative
 * conversation size with compaction handling. For other tools, uses simple calculation.
 *
 * @param session - Current session
 * @param usage - Token usage from the completed task
 * @param tasksService - Tasks service for querying all session tasks
 * @param messagesService - Messages service for detecting compaction events
 * @returns Context window usage in tokens, or undefined if calculation fails
 */
async function calculateTaskContextWindow(
  session: Session,
  usage: TokenUsage | undefined,
  tasksService: TasksServiceImpl,
  messagesService: MessagesServiceImpl
): Promise<number | undefined> {
  if (session.agentic_tool !== 'claude-code') {
    // For non-Claude Code tools, use simple calculation
    return calculateContextWindowUsage(usage);
  }

  try {
    // Fetch all tasks and messages for this session
    const allTasksResult = (await tasksService.find({
      query: { session_id: session.session_id, $limit: 10000 },
    })) as Task[] | Paginated<Task>;
    const allTasks: Task[] = isPaginated(allTasksResult) ? allTasksResult.data : allTasksResult;

    const allMessagesResult = (await messagesService.find({
      query: { session_id: session.session_id, $limit: 10000 },
    })) as Message[] | Paginated<Message>;
    const allMessages: Message[] = isPaginated(allMessagesResult)
      ? allMessagesResult.data
      : allMessagesResult;

    // Calculate cumulative context window (input + output tokens)
    return calculateCumulativeContextWindow(allTasks, allMessages);
  } catch (err) {
    console.warn(
      `⚠️  Failed to calculate cumulative context window for session ${session.session_id}:`,
      err
    );
    // Fallback to simple calculation
    return calculateContextWindowUsage(usage);
  }
}

import cors from 'cors';
import express from 'express';
import swagger from 'feathers-swagger';
import jwt from 'jsonwebtoken';
import type { Socket } from 'socket.io';
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
import { createWorktreesService } from './services/worktrees';
import { AnonymousStrategy } from './strategies/anonymous';
import { ensureMinimumRole, requireMinimumRole } from './utils/authorization';

/**
 * Extended Params with route ID parameter
 */
interface RouteParams extends Params {
  route?: {
    id?: string;
    messageId?: string;
    mcpId?: string;
  };
}

/**
 * FeathersJS extends Socket.io socket with authentication context
 */
interface FeathersSocket extends Socket {
  feathers?: {
    user?: User;
  };
}

// Expand ~ to home directory in database path
import { expandPath, extractDbFilePath } from '@agor/core/utils/path';

const DB_PATH = expandPath(process.env.AGOR_DB_PATH || 'file:~/.agor/agor.db');

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

  // Handle ANTHROPIC_API_KEY with priority: config.yaml > env var
  // Config service will update process.env when credentials change (hot-reload)
  // Tools will read fresh credentials dynamically via getCredential() helper
  if (config.credentials?.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_API_KEY) {
    process.env.ANTHROPIC_API_KEY = config.credentials.ANTHROPIC_API_KEY;
    console.log('✅ Set ANTHROPIC_API_KEY from config for Claude Code');
  }

  const apiKey = config.credentials?.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;

  // Note: API key is optional - it can be configured per-tool or use Claude CLI's auth
  // Only show info message if no key is found (not a warning since it's not required)
  if (!apiKey) {
    console.log('ℹ️  No ANTHROPIC_API_KEY found - will use Claude CLI auth if available');
    console.log('   To use API key: agor config set credentials.ANTHROPIC_API_KEY <key>');
    console.log('   Or run: claude login');
  }

  // Create Feathers app
  const app = feathersExpress(feathers());

  // Enable CORS for all REST API requests
  // Support UI port and 3 additional ports (for parallel dev servers)
  const corsOrigins = [
    `http://localhost:${UI_PORT}`,
    `http://localhost:${UI_PORT + 1}`,
    `http://localhost:${UI_PORT + 2}`,
    `http://localhost:${UI_PORT + 3}`,
  ];

  // SECURITY: Configure CORS based on deployment environment
  let corsOrigin:
    | boolean
    | string[]
    | ((
        origin: string | undefined,
        callback: (err: Error | null, allow?: boolean) => void
      ) => void);

  if (process.env.CORS_ORIGIN === '*') {
    // Explicit wildcard - allow all origins (use with caution!)
    console.warn('⚠️  CORS set to allow ALL origins (CORS_ORIGIN=*)');
    corsOrigin = true;
  } else if (process.env.CODESPACES === 'true') {
    // Codespaces: Only allow GitHub Codespaces domains and localhost
    console.log('🔒 CORS configured for GitHub Codespaces (*.github.dev, *.githubpreview.dev)');
    corsOrigin = (origin, callback) => {
      // Allow requests with no origin (like mobile apps, curl, Postman)
      if (!origin) {
        return callback(null, true);
      }

      // Allow GitHub Codespaces domains
      const allowedPatterns = [
        /\.github\.dev$/,
        /\.githubpreview\.dev$/,
        /\.preview\.app\.github\.dev$/,
        /^https?:\/\/localhost(:\d+)?$/,
      ];

      const isAllowed = allowedPatterns.some(pattern => pattern.test(origin));

      if (isAllowed) {
        callback(null, true);
      } else {
        console.warn(`⚠️  CORS rejected origin: ${origin}`);
        callback(new Error('Not allowed by CORS'));
      }
    };
  } else {
    // Local development: Allow localhost ports only
    corsOrigin = corsOrigins;
  }

  app.use(
    cors({
      origin: corsOrigin,
      credentials: true,
    })
  );

  // Parse JSON with size limits (security: prevent DoS via large payloads)
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // Serve static UI files in production (when installed as npm package)
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

      // Use type assertion for Express static middleware (FeathersJS type compatibility)
      app.use('/ui', express.static(uiPath) as never);

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

  // Store Socket.io instance for graceful shutdown
  let socketServer: import('socket.io').Server | null = null;

  app.configure(
    socketio(
      {
        cors: {
          origin: corsOrigin,
          methods: ['GET', 'POST', 'PATCH', 'DELETE'],
          credentials: true,
        },
        // Socket.io server options for better connection management
        pingTimeout: 60000, // How long to wait for pong before considering connection dead
        pingInterval: 25000, // How often to ping clients
        maxHttpBufferSize: 1e6, // 1MB max message size
        transports: ['websocket', 'polling'], // Prefer WebSocket
      },
      io => {
        // Store Socket.io server instance for shutdown
        socketServer = io;

        // Track active connections for debugging
        let activeConnections = 0;
        let lastLoggedCount = 0;

        // SECURITY: Add authentication middleware for WebSocket connections
        io.use(async (socket, next) => {
          try {
            // Extract authentication token from handshake
            // Clients can send token via:
            // 1. socket.io auth object: io('url', { auth: { token: 'xxx' } })
            // 2. Authorization header: io('url', { extraHeaders: { Authorization: 'Bearer xxx' } })
            const token =
              socket.handshake.auth?.token ||
              socket.handshake.headers?.authorization?.replace('Bearer ', '');

            if (!token) {
              // SECURITY: Always allow unauthenticated socket connections
              // This is required for the login flow to work (client needs to connect before authenticating)
              // Service-level hooks (requireAuth) will enforce authentication for protected endpoints
              // The /authentication endpoint explicitly allows unauthenticated access for login
              if (allowAnonymous) {
                console.log(
                  `🔓 WebSocket connection without auth (anonymous allowed): ${socket.id}`
                );
              } else {
                console.log(`🔓 WebSocket connection without auth (for login flow): ${socket.id}`);
              }
              // Don't set socket.feathers.user - will be handled by FeathersJS auth
              return next();
            }

            // Verify JWT token
            const decoded = jwt.verify(token, jwtSecret, {
              issuer: 'agor',
              audience: 'https://agor.dev',
            }) as { sub: string; type: string };

            if (decoded.type !== 'access') {
              return next(new Error('Invalid token type'));
            }

            // Fetch user from database
            const user = await app
              .service('users')
              .get(decoded.sub as import('@agor/core/types').UUID);

            // Attach user to socket (FeathersJS convention)
            (socket as FeathersSocket).feathers = { user };

            console.log(
              `🔐 WebSocket authenticated: ${socket.id} (user: ${user.user_id.substring(0, 8)})`
            );
            next();
          } catch (error) {
            console.error(`❌ WebSocket authentication failed for ${socket.id}:`, error);
            next(new Error('Invalid or expired authentication token'));
          }
        });

        // Configure Socket.io for cursor presence events
        io.on('connection', socket => {
          activeConnections++;
          const user = (socket as FeathersSocket).feathers?.user;
          console.log(
            `🔌 Socket.io connection established: ${socket.id} (user: ${user ? user.user_id.substring(0, 8) : 'anonymous'}, total: ${activeConnections})`
          );

          // Log connection lifespan after 5 seconds to identify long-lived connections
          setTimeout(() => {
            if (socket.connected) {
              console.log(
                `⏱️  Socket ${socket.id} still connected after 5s (likely persistent connection)`
              );
            }
          }, 5000);

          // Helper to get user ID from socket's Feathers connection
          const getUserId = () => {
            // In FeathersJS, the authenticated user is stored in socket.feathers
            const user = (socket as FeathersSocket).feathers?.user;
            return user?.user_id || 'anonymous';
          };

          // Handle cursor movement events
          socket.on('cursor-move', (data: import('@agor/core/types').CursorMoveEvent) => {
            const userId = getUserId();

            // Broadcast cursor position to all users on the same board except sender
            const broadcastData = {
              userId,
              boardId: data.boardId,
              x: data.x,
              y: data.y,
              timestamp: data.timestamp,
            } as import('@agor/core/types').CursorMovedEvent;

            socket.broadcast.emit('cursor-moved', broadcastData);
          });

          // Handle cursor leave events (user navigates away from board)
          socket.on('cursor-leave', (data: import('@agor/core/types').CursorLeaveEvent) => {
            const userId = getUserId();

            socket.broadcast.emit('cursor-left', {
              userId,
              boardId: data.boardId,
              timestamp: Date.now(),
            });
          });

          // Track disconnections
          socket.on('disconnect', reason => {
            activeConnections--;
            console.log(
              `🔌 Socket.io disconnected: ${socket.id} (reason: ${reason}, remaining: ${activeConnections})`
            );
          });

          // Handle socket errors
          socket.on('error', error => {
            console.error(`❌ Socket.io error on ${socket.id}:`, error);
          });
        });

        // Log connection metrics only when count changes (every 30 seconds)
        // FIX: Store interval handle to prevent memory leak
        const metricsInterval = setInterval(() => {
          if (activeConnections !== lastLoggedCount) {
            console.log(`📊 Active WebSocket connections: ${activeConnections}`);
            lastLoggedCount = activeConnections;
          }
        }, 30000);

        // Ensure interval is cleared on shutdown
        process.once('beforeExit', () => clearInterval(metricsInterval));
      }
    )
  );

  // Configure channels to broadcast events to authenticated clients
  // Join all new connections to 'everybody' channel initially
  app.on('connection', (connection: unknown) => {
    app.channel('everybody').join(connection as never);
    console.log('🔌 New connection joined everybody channel');
  });

  // Note: The 'login' event is fired by FeathersJS authentication service
  // However, socket re-authentication might not always trigger this event
  // So we use a broadcast-all approach with the 'everybody' channel
  app.on('login', (authResult: unknown, context: { connection?: unknown }) => {
    if (context.connection) {
      const result = authResult as { user?: { user_id?: string; email?: string } };
      console.log('✅ Login event fired:', result.user?.user_id, result.user?.email);
    }
  });

  app.on('logout', (_authResult: unknown, context: { connection?: unknown }) => {
    if (context.connection) {
      console.log('👋 Logout event fired');
    }
  });

  // Configure Swagger for API documentation
  app.configure(
    swagger({
      openApiVersion: 3,
      docsPath: '/docs',
      docsJsonPath: '/docs.json',
      ui: swagger.swaggerUI({ docsPath: '/docs' }),
      specs: {
        info: {
          title: 'Agor API',
          description: 'REST and WebSocket API for Agor agent orchestration platform',
          version: DAEMON_VERSION,
        },
        servers: [{ url: `http://localhost:${DAEMON_PORT}`, description: 'Local daemon' }],
        components: {
          securitySchemes: {
            BearerAuth: {
              type: 'http',
              scheme: 'bearer',
              bearerFormat: 'JWT',
            },
          },
        },
        // Apply BearerAuth globally to all endpoints (except public endpoints like /health, /login)
        security: [{ BearerAuth: [] }],
      },
    })
  );

  // Initialize database (auto-create if it doesn't exist)
  console.log(`📦 Connecting to database: ${DB_PATH}`);

  // Extract file path from DB_PATH (remove 'file:' prefix and expand ~)
  const dbFilePath = extractDbFilePath(DB_PATH);
  const dbDir = dbFilePath.substring(0, dbFilePath.lastIndexOf('/'));

  // Ensure database directory exists
  const { mkdir, access } = await import('node:fs/promises');
  const { constants } = await import('node:fs');

  try {
    await access(dbDir, constants.F_OK);
  } catch {
    console.log(`📁 Creating database directory: ${dbDir}`);
    await mkdir(dbDir, { recursive: true });
  }

  // Check if database file exists (create message if needed)
  try {
    await access(dbFilePath, constants.F_OK);
  } catch {
    console.log('🆕 Database does not exist - will create on first connection');
  }

  // Create database with foreign keys enabled
  const db = await createDatabaseAsync({ url: DB_PATH });

  // Check if migrations are needed
  console.log('🔍 Checking database migration status...');
  const { checkMigrationStatus, seedInitialData } = await import('@agor/core/db');
  const migrationStatus = await checkMigrationStatus(db);

  if (migrationStatus.hasPending) {
    console.error('');
    console.error('❌ Database migrations required!');
    console.error('');
    console.error(`   Found ${migrationStatus.pending.length} pending migration(s):`);
    migrationStatus.pending.forEach(tag => {
      console.error(`     - ${tag}`);
    });
    console.error('');
    console.error('⚠️  For safety, please backup your database before running migrations:');
    console.error(`   cp ~/.agor/agor.db ~/.agor/agor.db.backup-$(date +%s)`);
    console.error('');
    console.error('Then run migrations with:');
    console.error('   agor db migrate');
    console.error('');
    console.error('After migrations complete successfully, restart the daemon.');
    console.error('');
    process.exit(1);
  }

  console.log('✅ Database migrations up to date');

  // Seed initial data (idempotent - only creates if missing)
  console.log('🌱 Seeding initial data...');
  await seedInitialData(db);

  console.log('✅ Database ready');

  // Register core services
  // NOTE: Pass app instance for user preferences access (needed for cross-tool spawning and ready_for_prompt updates)
  app.use('/sessions', createSessionsService(db, app));
  app.use('/tasks', createTasksService(db, app));
  app.use('/leaderboard', createLeaderboardService(db));
  const messagesService = createMessagesService(db) as unknown as MessagesServiceImpl;

  // Register messages service with custom streaming events
  app.use('/messages', messagesService, {
    events: [
      'streaming:start',
      'streaming:chunk',
      'streaming:end',
      'streaming:error',
      'thinking:start',
      'thinking:chunk',
      'thinking:end',
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

  app.use('/boards', createBoardsService(db));

  // Register board-objects service (positioned entities on boards)
  app.use('/board-objects', createBoardObjectsService(db));

  // Register board-comments service (human-to-human conversations)
  app.use('/board-comments', createBoardCommentsService(db));

  // Register worktrees service first (repos service needs to access it)
  // NOTE: Pass app instance for environment management (needs to access repos service)
  app.use('/worktrees', createWorktreesService(db, app));

  // Register repos service (accesses worktrees via app.service('worktrees'))
  app.use('/repos', createReposService(db, app));

  app.use('/mcp-servers', createMCPServersService(db));

  // Register config service for API key management
  app.use('/config', createConfigService());

  // Register context service (read-only filesystem browser for worktree context/ files)
  // Scans context/ directory in worktree for all .md files recursively
  // Requires worktree_id query parameter
  const worktreeRepository = new WorktreeRepository(db);
  app.use('/context', createContextService(worktreeRepository));

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
    async find() {
      // Return all session-MCP relationships
      // This allows the UI to fetch all relationships in one call
      const rows = await db.select().from(sessionMcpServers).all();
      return rows.map(row => ({
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
      create: [requireMinimumRole('member', 'create messages')],
      patch: [requireMinimumRole('member', 'update messages')],
      remove: [requireMinimumRole('member', 'delete messages')],
    },
    // No custom 'after' hooks needed - FeathersJS automatically emits 'removed' event
    // with the full message object (including status, session_id, etc.)
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
      create: [requireMinimumRole('member', 'create worktrees')],
      patch: [requireMinimumRole('member', 'update worktrees')],
      remove: [requireMinimumRole('member', 'delete worktrees')],
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
        context => {
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
        context => {
          ensureMinimumRole(context.params as AuthenticatedParams, 'member', 'view users');
          return context;
        },
      ],
      create: [
        async context => {
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
        context => {
          const params = context.params as AuthenticatedParams;
          const userId = context.id as string;

          // Admins can patch any user
          if (params.user && params.user.role === 'admin') {
            return context;
          }

          // Any authenticated user can update their own profile
          if (params.user && params.user.user_id === userId) {
            return context;
          }

          // Otherwise forbidden
          throw new Forbidden('You can only update your own profile');
        },
      ],
      remove: [requireMinimumRole('admin', 'delete users')],
    },
  });

  // Publish service events to all connected clients
  // All services have requireAuth hooks, so only authenticated users can access them
  // This means any connection that successfully calls a service is authenticated
  app.publish(() => {
    // Broadcast to all connected clients (they're all authenticated due to requireAuth)
    return app.channel('everybody');
  });

  // Add hooks to inject created_by from authenticated user and populate repo from worktree
  app.service('sessions').hooks({
    before: {
      all: [
        // biome-ignore lint/suspicious/noExplicitAny: FeathersJS hook type compatibility
        (validateQuery as any)(sessionQueryValidator),
        ...getReadAuthHooks(),
      ],
      create: [
        requireMinimumRole('member', 'create sessions'),
        async context => {
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
            context.data.forEach(item => {
              if (!item.created_by) (item as Record<string, unknown>).created_by = userId;
            });
          } else if (context.data && !context.data.created_by) {
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
      patch: [requireMinimumRole('member', 'update sessions')],
      remove: [requireMinimumRole('member', 'delete sessions')],
    },
    after: {
      create: [
        async context => {
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

          // Auto-attach global MCP servers to this session
          try {
            const { MCPServerRepository } = await import('@agor/core/db');
            const { SessionMCPServerRepository } = await import('@agor/core/db');
            const mcpServerRepo = new MCPServerRepository(db);
            const sessionMcpServerRepo = new SessionMCPServerRepository(db);

            const globalServers = await mcpServerRepo.findAll({ scope: 'global', enabled: true });

            if (globalServers.length > 0) {
              console.log(
                `🔗 [Session MCP] Auto-attaching ${globalServers.length} global MCP server(s) to session ${session.session_id.substring(0, 8)}...`
              );

              for (const server of globalServers) {
                await sessionMcpServerRepo.addServer(session.session_id, server.mcp_server_id);
                console.log(`   ✅ Attached global MCP server: ${server.name}`);
              }
            } else {
              console.log(`📭 [Session MCP] No global MCP servers to attach`);
            }
          } catch (error) {
            console.error('⚠️  Failed to auto-attach global MCP servers:', error);
            // Don't fail session creation if MCP attachment fails
          }

          // Update context.result to include the token
          context.result = { ...session, mcp_token: mcpToken };

          return context;
        },
        // Create OpenCode session if agentic_tool is 'opencode'
        async context => {
          const session = context.result as Session;

          if (session.agentic_tool === 'opencode') {
            try {
              const model = session.model_config?.model;
              const provider = session.model_config?.provider;
              console.log(
                `🔧 [OpenCode] Creating OpenCode session for Agor session ${session.session_id.substring(0, 8)} with model: ${model || 'default'} provider: ${provider || 'default'}...`
              );

              // Create OpenCode session via OpenCodeTool
              const sessionWithRepo = session as Session & {
                repo?: { repo_slug?: string; cwd?: string };
              };
              const ocSession = await opencodeTool.createSession?.({
                title: session.title || 'Agor Session',
                projectName: sessionWithRepo.repo?.repo_slug || 'default',
                workingDirectory: sessionWithRepo.repo?.cwd,
                model: model,
                provider: provider,
              });

              if (ocSession?.sessionId) {
                console.log(`✅ [OpenCode] Created OpenCode session: ${ocSession.sessionId}`);

                // Map Agor session ID to OpenCode session ID
                opencodeTool.setSessionContext(session.session_id, ocSession.sessionId);
                console.log(
                  `🗺️  [OpenCode] Mapped Agor session ${session.session_id.substring(0, 8)} → OpenCode session ${ocSession.sessionId}`
                );

                // Store OpenCode session ID in Agor session metadata
                await app.service('sessions').patch(session.session_id, {
                  sdk_session_id: ocSession.sessionId,
                });

                console.log(`💾 [OpenCode] Stored OpenCode session ID in Agor session metadata`);

                // Update context.result to include the OpenCode session ID
                context.result = { ...session, sdk_session_id: ocSession.sessionId };
              }
            } catch (error) {
              console.error('⚠️  [OpenCode] Failed to create OpenCode session:', error);
              // Don't fail Agor session creation if OpenCode session creation fails
            }
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
      create: [
        requireMinimumRole('member', 'create tasks'),
        async context => {
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
            context.data.forEach(item => {
              if (!item.created_by) (item as Record<string, unknown>).created_by = userId;
            });
          } else if (context.data && !context.data.created_by) {
            (context.data as Record<string, unknown>).created_by = userId;
          }
          return context;
        },
      ],
      patch: [requireMinimumRole('member', 'update tasks')],
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
        async context => {
          // Inject user_id if authenticated, otherwise use 'anonymous'
          const userId =
            (context.params as { user?: { user_id: string; email: string } }).user?.user_id ||
            'anonymous';

          if (Array.isArray(context.data)) {
            context.data.forEach(item => {
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
        async context => {
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
    },
  });

  // Configure authentication options BEFORE creating service
  // Note: jwtSecret is initialized earlier (before Socket.io config)
  app.set('authentication', {
    secret: jwtSecret,
    entity: 'user',
    entityId: 'user_id',
    service: 'users',
    authStrategies: ['jwt', 'local', 'anonymous'],
    jwtOptions: {
      header: { typ: 'access' },
      audience: 'https://agor.dev',
      issuer: 'agor',
      algorithm: 'HS256',
      expiresIn: '1h', // Access token: 1 hour
    },
    local: {
      usernameField: 'email',
      passwordField: 'password',
    },
  });

  // Configure authentication
  const authentication = new AuthenticationService(app);

  authentication.register('jwt', new JWTStrategy());
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
            expiresIn: '1h',
            issuer: 'agor',
            audience: 'https://agor.dev',
          }
        );

        // Return new access token and user
        return {
          accessToken,
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
  const messagesRepo = new MessagesRepository(db);
  const sessionsRepo = new SessionRepository(db);
  const sessionMCPRepo = new SessionMCPServerRepository(db);
  const mcpServerRepo = new MCPServerRepository(db);
  const worktreesRepo = new WorktreeRepository(db);
  const reposRepo = new RepoRepository(db);
  const _tasksRepo = new TaskRepository(db);

  // Initialize PermissionService for UI-based permission prompts
  // Emits WebSocket events via sessions service for permission requests
  const permissionService = new PermissionService((event, data) => {
    // Emit events through sessions service for WebSocket broadcasting
    app.service('sessions').emit(event, data);
  });

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
    config.daemon?.mcpEnabled !== false // Pass MCP enabled flag
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

  // Handle GEMINI_API_KEY with priority: config.yaml > env var
  // Config service will update process.env when credentials change (hot-reload)
  // GeminiTool will read fresh credentials dynamically via refreshAuth()
  if (config.credentials?.GEMINI_API_KEY && !process.env.GEMINI_API_KEY) {
    process.env.GEMINI_API_KEY = config.credentials.GEMINI_API_KEY;
    console.log('✅ Set GEMINI_API_KEY from config for Gemini');
  }

  const geminiApiKey = config.credentials?.GEMINI_API_KEY || process.env.GEMINI_API_KEY;
  const geminiTool = new GeminiTool(
    messagesRepo,
    sessionsRepo,
    geminiApiKey,
    app.service('messages'),
    app.service('tasks'),
    worktreesRepo,
    mcpServerRepo,
    sessionMCPRepo,
    config.daemon?.mcpEnabled !== false, // Pass MCP enabled flag
    db // Database for env var resolution
  );

  if (!geminiApiKey) {
    console.warn('⚠️  No GEMINI_API_KEY found - Gemini sessions will fail');
    console.warn('   Run: agor config set credentials.GEMINI_API_KEY <your-key>');
    console.warn('   Or set GEMINI_API_KEY environment variable');
  }

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
    opencodeTool.checkInstalled().then(isAvailable => {
      if (!isAvailable) {
        console.warn('⚠️  OpenCode server not available at', openCodeServerUrl);
        console.warn('   Start OpenCode with: opencode serve --port 4096');
      } else {
        console.log('✅ OpenCode server available at', openCodeServerUrl);
      }
    });
  }

  // Configure custom route for bulk message creation
  app.use('/messages/bulk', {
    async create(data: unknown, params: RouteParams) {
      ensureMinimumRole(params, 'member', 'create messages');
      // Type assertion safe: repository validates message structure
      return messagesService.createMany(data as Message[]);
    },
  });

  // Configure custom methods for sessions service
  const sessionsService = app.service('sessions') as unknown as SessionsServiceImpl;
  app.use('/sessions/:id/fork', {
    async create(data: { prompt: string; task_id?: string }, params: RouteParams) {
      ensureMinimumRole(params, 'member', 'fork sessions');
      const id = params.route?.id;
      if (!id) throw new Error('Session ID required');
      console.log(`🔀 Forking session: ${id.substring(0, 8)}`);
      const forkedSession = await sessionsService.fork(id, data, params);
      console.log(`✅ Fork created: ${forkedSession.session_id.substring(0, 8)}`);
      return forkedSession;
    },
  });

  app.use('/sessions/:id/spawn', {
    async create(
      data: { prompt: string; title?: string; agent?: string; task_id?: string },
      params: RouteParams
    ) {
      ensureMinimumRole(params, 'member', 'spawn sessions');
      const id = params.route?.id;
      if (!id) throw new Error('Session ID required');
      console.log(`🌱 Spawning session from: ${id.substring(0, 8)}`);
      const spawnedSession = await sessionsService.spawn(id, data, params);
      console.log(`✅ Spawn created: ${spawnedSession.session_id.substring(0, 8)}`);
      return spawnedSession;
    },
  });

  // Feathers custom route handler with find method
  app.use('/sessions/:id/genealogy', {
    async find(_data: unknown, params: RouteParams) {
      ensureMinimumRole(params, 'member', 'view session genealogy');
      const id = params.route?.id;
      if (!id) throw new Error('Session ID required');
      return sessionsService.getGenealogy(id, params);
    },
    // biome-ignore lint/suspicious/noExplicitAny: FeathersJS route handler type mismatch with Express RouteParams
  } as any);

  /**
   * Helper: Safely patch an entity, returning false if it was deleted mid-execution
   */
  async function safePatch<T>(
    service: {
      get: (id: string) => Promise<T>;
      patch: (id: string, data: Partial<T>) => Promise<T>;
    },
    id: string,
    data: Partial<T>,
    entityType: string
  ): Promise<boolean> {
    try {
      await service.patch(id, data);
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

  /**
   * Helper: Check if an entity still exists
   */
  async function entityExists<T>(
    service: { get: (id: string) => Promise<T> },
    id: string
  ): Promise<T | null> {
    try {
      return await service.get(id);
    } catch (error) {
      // Handle NotFoundError or legacy error messages
      if (
        error instanceof NotFoundError ||
        (error instanceof Error && error.message.includes('No record found'))
      ) {
        return null;
      }
      throw error;
    }
  }

  app.use('/sessions/:id/prompt', {
    async create(
      data: {
        prompt: string;
        permissionMode?: import('@agor/core/types').PermissionMode;
        stream?: boolean;
      },
      params: RouteParams
    ) {
      ensureMinimumRole(params, 'member', 'execute prompts');
      console.log(`📨 [Daemon] Prompt request for session ${params.route?.id?.substring(0, 8)}`);
      console.log(`   Permission mode: ${data.permissionMode || 'not specified'}`);
      console.log(`   Streaming: ${data.stream !== false}`);

      const id = params.route?.id;
      if (!id) throw new Error('Session ID required');
      if (!data.prompt) throw new Error('Prompt required');

      // Get session to find current message count
      const session = await sessionsService.get(id, params);
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

      // Update session with new task immediately and set status to running
      await sessionsService.patch(id, {
        tasks: [...session.tasks, task.task_id],
        status: SessionStatus.RUNNING,
      });

      // Create streaming callbacks for real-time UI updates
      // Custom events are registered via app.use('/messages', service, { events: [...] })
      const streamingCallbacks: import('@agor/core/tools').StreamingCallbacks = {
        onStreamStart: (messageId, metadata) => {
          console.debug(
            `📡 [${new Date().toISOString()}] Streaming start: ${messageId.substring(0, 8)}`
          );
          app.service('messages').emit('streaming:start', {
            message_id: messageId,
            ...metadata,
          });
        },
        onStreamChunk: (messageId, chunk) => {
          app.service('messages').emit('streaming:chunk', {
            message_id: messageId,
            session_id: id,
            chunk,
          });
        },
        onStreamEnd: messageId => {
          console.debug(
            `📡 [${new Date().toISOString()}] Streaming end: ${messageId.substring(0, 8)}`
          );
          app.service('messages').emit('streaming:end', {
            message_id: messageId,
            session_id: id,
          });
        },
        onStreamError: (messageId, error) => {
          console.error(`❌ Streaming error for message ${messageId.substring(0, 8)}:`, error);
          app.service('messages').emit('streaming:error', {
            message_id: messageId,
            session_id: id,
            error: error.message,
          });
        },
        onThinkingStart: (messageId, metadata) => {
          console.debug(
            `📡 [${new Date().toISOString()}] Thinking start: ${messageId.substring(0, 8)}`
          );
          app.service('messages').emit('thinking:start', {
            message_id: messageId,
            ...metadata,
          });
        },
        onThinkingChunk: (messageId, chunk) => {
          app.service('messages').emit('thinking:chunk', {
            message_id: messageId,
            session_id: id,
            chunk,
          });
        },
        onThinkingEnd: messageId => {
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
      setImmediate(() => {
        // Route to appropriate tool based on session agent
        let executeMethod: Promise<{
          userMessageId: import('@agor/core/types').MessageID;
          assistantMessageIds: import('@agor/core/types').MessageID[];
        }>;

        if (session.agentic_tool === 'codex') {
          // Use CodexTool for Codex sessions
          executeMethod = useStreaming
            ? codexTool.executePromptWithStreaming(
                id as SessionID,
                data.prompt,
                task.task_id,
                data.permissionMode,
                streamingCallbacks
              )
            : codexTool.executePrompt(
                id as SessionID,
                data.prompt,
                task.task_id,
                data.permissionMode
              );
        } else if (session.agentic_tool === 'gemini') {
          // Use GeminiTool for Gemini sessions
          executeMethod = useStreaming
            ? geminiTool.executePromptWithStreaming(
                id as SessionID,
                data.prompt,
                task.task_id,
                data.permissionMode,
                streamingCallbacks
              )
            : geminiTool.executePrompt(
                id as SessionID,
                data.prompt,
                task.task_id,
                data.permissionMode
              );
        } else if (session.agentic_tool === 'opencode') {
          // Use OpenCodeTool for OpenCode sessions
          // OpenCode doesn't support executePromptWithStreaming, so always use executeTask
          console.log('[Daemon] Routing to OpenCodeTool.executeTask');

          // Extract model, provider, and OpenCode session ID from session
          const model = session.model_config?.model;
          const provider = session.model_config?.provider;
          const opencodeSessionId = (session as { sdk_session_id?: string }).sdk_session_id;

          console.log(
            '[Daemon] Using Agor session ID:',
            id,
            'with model:',
            model,
            'provider:',
            provider,
            'OpenCode session:',
            opencodeSessionId
          );

          // Store session context in OpenCodeTool before calling executeTask
          if (opencodeSessionId) {
            opencodeTool.setSessionContext(id as SessionID, opencodeSessionId, model, provider);
          }

          executeMethod = (
            opencodeTool.executeTask?.(
              id as SessionID,
              data.prompt,
              task.task_id,
              useStreaming ? streamingCallbacks : undefined
            ) || Promise.reject(new Error('OpenCode executeTask not available'))
          ).then(result => {
            console.log('[Daemon] OpenCodeTool.executeTask completed:', result);
            return {
              userMessageId: `user-${task.task_id}` as import('@agor/core/types').MessageID,
              assistantMessageIds: [],
            };
          });
        } else {
          // Use ClaudeTool for Claude Code sessions (default)
          executeMethod = useStreaming
            ? claudeTool.executePromptWithStreaming(
                id as SessionID,
                data.prompt,
                task.task_id,
                data.permissionMode as ClaudePermissionMode | undefined,
                streamingCallbacks
              )
            : claudeTool.executePrompt(
                id as SessionID,
                data.prompt,
                task.task_id,
                data.permissionMode as ClaudePermissionMode | undefined
              );
        }

        executeMethod
          .then(async result => {
            try {
              // PHASE 3: Mark task as completed and update message count
              // (Messages already created with task_id, no need to patch)
              const endTimestamp = new Date().toISOString();
              const totalMessages = 1 + result.assistantMessageIds.length; // user + assistants

              // Check if task still exists and get current status
              const currentTask = await entityExists(tasksService, task.task_id);
              if (!currentTask) {
                console.log(
                  `⚠️  Task ${task.task_id.substring(0, 8)} was deleted mid-execution - aborting completion`
                );
                return;
              }

              // Don't overwrite terminal states
              if (
                currentTask.status === TaskStatus.FAILED ||
                currentTask.status === TaskStatus.AWAITING_PERMISSION ||
                currentTask.status === TaskStatus.STOPPING ||
                currentTask.status === TaskStatus.STOPPED
              ) {
                console.log(
                  `⚠️  Task ${task.task_id} already in terminal state: ${currentTask.status} - not marking as completed`
                );

                // Still update message range for completeness
                await safePatch(
                  tasksService,
                  task.task_id,
                  {
                    message_range: {
                      start_index: messageStartIndex,
                      end_index: messageStartIndex + totalMessages - 1,
                      start_timestamp: startTimestamp,
                      end_timestamp: endTimestamp,
                    },
                  },
                  'Task'
                );
              } else {
                // Safe to mark as completed
                // Calculate estimated cost if usage data is available
                let usage: typeof task.usage | undefined;
                if ('tokenUsage' in result && result.tokenUsage) {
                  const tokenUsage = result.tokenUsage as TokenUsage;
                  const { calculateTokenCost } = await import('@agor/core/utils/pricing');
                  const estimatedCost = calculateTokenCost(tokenUsage, session.agentic_tool);

                  // Calculate total_tokens if SDK didn't provide it
                  const totalTokens =
                    tokenUsage.total_tokens ||
                    (tokenUsage.input_tokens || 0) + (tokenUsage.output_tokens || 0);

                  // Spread tokenUsage (type-safe) and add calculated fields
                  usage = {
                    ...tokenUsage,
                    total_tokens: totalTokens,
                    estimated_cost_usd: estimatedCost,
                  };
                }

                // Calculate tool_use_count from all messages in this task
                let toolUseCount = 0;
                try {
                  const taskMessagesResult = (await messagesService.find({
                    query: { task_id: task.task_id, $limit: 10000 },
                  })) as Message[] | Paginated<Message>;
                  const taskMessages: Message[] = isPaginated(taskMessagesResult)
                    ? taskMessagesResult.data
                    : taskMessagesResult;
                  toolUseCount = taskMessages.reduce(
                    (sum: number, msg: Message) => sum + (msg.tool_uses?.length || 0),
                    0
                  );
                } catch (err) {
                  console.warn(
                    `⚠️  Failed to calculate tool_use_count for task ${task.task_id}:`,
                    err
                  );
                  // Continue with toolUseCount = 0
                }

                // Calculate cumulative context window for Claude Code sessions
                // This represents the actual conversation size (input + output tokens)
                // across all tasks, with compaction handling
                const contextWindow = await calculateTaskContextWindow(
                  session,
                  usage,
                  tasksService,
                  messagesService
                );

                const updated = await safePatch(
                  tasksService,
                  task.task_id,
                  {
                    status: TaskStatus.COMPLETED,
                    message_range: {
                      start_index: messageStartIndex,
                      end_index: messageStartIndex + totalMessages - 1,
                      start_timestamp: startTimestamp,
                      end_timestamp: endTimestamp,
                    },
                    tool_use_count: toolUseCount,
                    usage,
                    // Save execution metadata from result
                    duration_ms:
                      'durationMs' in result
                        ? (result.durationMs as number | undefined)
                        : undefined,
                    agent_session_id:
                      'agentSessionId' in result
                        ? (result.agentSessionId as string | undefined)
                        : undefined,
                    context_window: contextWindow,
                    context_window_limit:
                      'contextWindowLimit' in result
                        ? (result.contextWindowLimit as number | undefined)
                        : undefined,
                    model: 'model' in result ? (result.model as string | undefined) : undefined,
                    model_usage:
                      'modelUsage' in result
                        ? (result.modelUsage as Task['model_usage'])
                        : undefined,
                  },
                  'Task'
                );

                if (updated) {
                  console.log(`✅ Task ${task.task_id} completed successfully`);
                }
              }

              // Calculate session-level context window usage from all tasks
              // Algorithm from https://codelynx.dev/posts/calculate-claude-code-context
              const allTasks = await tasksService.find({
                query: { session_id: id },
                paginate: false,
              });
              const tasksArray = Array.isArray(allTasks) ? allTasks : [];

              const currentContextUsage = getSessionContextUsage(tasksArray as Task[]);
              const contextWindowLimit = getContextWindowLimit(tasksArray as Task[]);

              if (currentContextUsage !== undefined) {
                const percentage = contextWindowLimit
                  ? ((currentContextUsage / contextWindowLimit) * 100).toFixed(1)
                  : 'N/A';
                console.log(
                  `📊 Session context: ${currentContextUsage.toLocaleString()}/${contextWindowLimit?.toLocaleString() || '?'} (${percentage}%)`
                );
              }

              await safePatch(
                sessionsService,
                id,
                {
                  message_count: session.message_count + totalMessages,
                  status: SessionStatus.IDLE,
                  current_context_usage: currentContextUsage,
                  context_window_limit: contextWindowLimit,
                  last_context_update_at:
                    currentContextUsage !== undefined ? new Date().toISOString() : undefined,
                },
                'Session'
              );

              // Check for queued messages and auto-process next one
              // NOTE: Only process queue if task completed successfully
              // If task failed, stop queue to prevent cascading failures
              setImmediate(async () => {
                try {
                  // Check if the task completed successfully
                  const completedTask = await tasksService.get(task.task_id, params);
                  if (completedTask.status === TaskStatus.COMPLETED) {
                    await processNextQueuedMessage(id as SessionID, params);
                  } else {
                    console.log(
                      `⚠️  Task ${task.task_id.substring(0, 8)} failed - halting queue processing for session ${id.substring(0, 8)}`
                    );
                  }
                } catch (error) {
                  // Handle task deletion mid-execution (e.g., worktree deleted during execution)
                  // This can happen when:
                  // 1. User deletes worktree while session is running
                  // 2. Database cascade: worktree → session → task (all deleted)
                  // 3. Task completion tries to check status but task is gone
                  if (error instanceof NotFoundError) {
                    console.log(
                      `⚠️  Task ${task.task_id.substring(0, 8)} was deleted mid-execution (likely worktree deleted) - skipping queue processing`
                    );
                    return;
                  }
                  console.error(`❌ Error processing queued message for session ${id}:`, error);
                }
              });
            } catch (error) {
              console.error(`❌ Error completing task ${task.task_id}:`, error);
              // Try to mark task as failed (may also fail if deleted)
              await safePatch(tasksService, task.task_id, { status: TaskStatus.FAILED }, 'Task');
            }
          })
          .catch(async error => {
            console.error(`❌ Error executing prompt for task ${task.task_id}:`, error);

            // Check if error might be due to stale/invalid Agent SDK resume session
            // Only clear sdk_session_id if we're confident the session is stale, not just any error
            const errorMessage =
              error.message || (typeof error === 'string' ? error : JSON.stringify(error, null, 2));
            const isExitCode1 = errorMessage.includes('Claude Code process exited with code 1');
            const hasResumeSession = !!session.sdk_session_id;

            // Check if this is specifically a stale Claude Code session error
            const isStaleSession =
              errorMessage.includes('No conversation found with session ID') ||
              errorMessage.includes('session does not exist');

            // Additional heuristics to detect config issues (vs stale session):
            // - Error mentions missing directory/file (config issue)
            // - Error mentions permission denied (permission issue)
            // - Error mentions API key (auth issue)
            const isLikelyConfigIssue =
              (errorMessage.includes('does not exist') &&
                !errorMessage.includes('conversation') &&
                !errorMessage.includes('session')) ||
              errorMessage.includes('not a directory') ||
              errorMessage.includes('Permission denied') ||
              errorMessage.includes('ENOENT') ||
              errorMessage.includes('API key');

            if (isStaleSession && hasResumeSession) {
              // Explicit stale session error - clear and let user retry
              console.warn(
                `⚠️  Stale Claude Code session detected: ${session.sdk_session_id?.substring(0, 8)}`
              );
              console.warn(`   Clearing session ID - next prompt will start fresh`);

              await safePatch(sessionsService, id, { sdk_session_id: undefined }, 'Session');
            } else if (isExitCode1 && hasResumeSession && !isLikelyConfigIssue) {
              // Generic exit code 1 with resume session (not explicitly stale)
              console.warn(
                `⚠️  Unexpected exit code 1 with resume session ${session.sdk_session_id?.substring(0, 8)}`
              );
              console.warn(
                `   Session should have been validated before SDK call - clearing as safety measure`
              );

              await safePatch(sessionsService, id, { sdk_session_id: undefined }, 'Session');
            } else if (isExitCode1 && hasResumeSession && isLikelyConfigIssue) {
              console.error(`❌ Exit code 1 due to configuration issue:`);
              console.error(`   ${errorMessage.substring(0, 200)}`);
              console.error(`   NOT clearing resume session - fix the configuration issue above`);
            } else if (isExitCode1 && !hasResumeSession) {
              console.error(`❌ Exit code 1 on fresh session (no resume):`);
              console.error(`   ${errorMessage.substring(0, 200)}`);
              console.error(`   Check: CWD exists, Claude Code installed, API key valid`);
            }

            // Mark task as failed with error message and set session back to idle
            await safePatch(
              tasksService,
              task.task_id,
              {
                status: TaskStatus.FAILED,
                report: errorMessage, // Save error message so UI can display it
              },
              'Task'
            );

            await safePatch(sessionsService, id, { status: SessionStatus.IDLE }, 'Session');
          });
      });

      // Return immediately with task ID - don't wait for Claude to finish!
      return {
        success: true,
        taskId: task.task_id,
        status: TaskStatus.RUNNING,
        streaming: useStreaming, // Inform client whether streaming is enabled
      };
    },
  });

  // Stop execution endpoint
  app.use('/sessions/:id/stop', {
    async create(_data: unknown, params: RouteParams) {
      ensureMinimumRole(params, 'member', 'stop sessions');
      const id = params.route?.id;
      if (!id) throw new Error('Session ID required');

      console.log(`🛑 [Daemon] Stop request for session ${id.substring(0, 8)}`);

      // Get session to find which tool to use
      const session = await sessionsService.get(id, params);

      // Check if session is actually running
      if (session.status !== SessionStatus.RUNNING) {
        return {
          success: false,
          reason: `Session is not running (status: ${session.status})`,
        };
      }

      // Find the currently running task(s)
      // Use find query instead of mapping over all tasks for better performance
      const runningTasks = await tasksService.find({
        query: {
          session_id: id,
          status: { $in: [TaskStatus.RUNNING, TaskStatus.AWAITING_PERMISSION] },
          $limit: 10,
        },
      });

      // Extract data array if paginated
      // Note: FeathersJS Service.find() can return T | T[] | Paginated<Task> depending on query params
      // We cast to the expected union type since we know we're querying for multiple results
      const findResult = runningTasks as Task[] | Paginated<Task>;
      const runningTasksArray = isPaginated(findResult) ? findResult.data : findResult;

      // PHASE 1: Immediately update status to 'stopping' (UI feedback before SDK call)
      if (runningTasksArray.length > 0) {
        const latestTask = runningTasksArray[runningTasksArray.length - 1];

        try {
          await Promise.race([
            tasksService.patch(latestTask.task_id, {
              status: TaskStatus.STOPPING,
            }),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('Task patch timeout')), 5000)
            ),
          ]);
        } catch (error) {
          console.error(`Failed to update task to stopping:`, error);
          // Continue anyway, we'll still try to stop the SDK
        }
      }

      // PHASE 2: Route to appropriate tool based on session agent and call stopTask
      let result: {
        success: boolean;
        partialResult?: Partial<{ taskId: string; status: 'completed' | 'failed' | 'cancelled' }>;
        reason?: string;
      };

      if (session.agentic_tool === 'codex') {
        result = (await codexTool.stopTask?.(id)) || {
          success: false,
          reason: 'stopTask not implemented',
        };
      } else if (session.agentic_tool === 'gemini') {
        result = (await geminiTool.stopTask?.(id)) || {
          success: false,
          reason: 'stopTask not implemented',
        };
      } else if (session.agentic_tool === 'opencode') {
        // OpenCode doesn't support stopTask
        result = {
          success: false,
          reason: 'stopTask not implemented for OpenCode',
        };
      } else {
        // Claude Code (default)
        result = (await claudeTool.stopTask?.(id)) || {
          success: false,
          reason: 'stopTask not implemented',
        };
      }

      // PHASE 3: Update final status based on stop result
      if (result.success) {
        // Update session status back to idle
        await sessionsService.patch(id, {
          status: SessionStatus.IDLE,
        });

        // Update task status to 'stopped'
        if (runningTasksArray.length > 0) {
          const latestTask = runningTasksArray[runningTasksArray.length - 1];
          await tasksService.patch(latestTask.task_id, {
            status: TaskStatus.STOPPED,
            message_range: {
              ...latestTask.message_range,
              end_timestamp: new Date().toISOString(),
            },
          });
          console.log(`✅ Task ${latestTask.task_id.substring(0, 8)} stopped`);
        }
      } else {
        // Stop failed, revert to running
        if (runningTasksArray.length > 0) {
          const latestTask = runningTasksArray[runningTasksArray.length - 1];
          await tasksService.patch(latestTask.task_id, {
            status: TaskStatus.RUNNING, // Revert to running
          });
        }
      }

      return result;
    },
  });

  /**
   * POST /sessions/:id/messages/queue
   * GET /sessions/:id/messages/queue
   * Queue management endpoints (create and list)
   *
   * NOTE: Queue deletion is handled via messages service directly (client.service('messages').remove(id))
   * This keeps the client simple and avoids FeathersJS nested route issues
   */
  app.use('/sessions/:id/messages/queue', {
    async create(data: { prompt: string }, params: RouteParams) {
      ensureMinimumRole(params, 'member', 'queue messages');

      const sessionId = params.route?.id;
      if (!sessionId) throw new Error('Session ID required');
      if (!data.prompt) throw new Error('Prompt required');

      const session = await sessionsService.get(sessionId, params);

      // Create queued message
      const messageRepo = new MessagesRepository(db);
      const queuedMessage = await messageRepo.createQueued(sessionId as SessionID, data.prompt);

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
      ensureMinimumRole(params, 'member', 'view queue');

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
  } as any);

  /**
   * Process the next queued message for a session
   * Called automatically after task completion when session becomes idle
   */
  async function processNextQueuedMessage(
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

    // Re-fetch session to ensure it's still idle and not awaiting permission
    const session = await sessionsService.get(sessionId, params);

    if (session.status !== SessionStatus.IDLE) {
      console.log(
        `⚠️  Session ${sessionId.substring(0, 8)} is ${session.status}, skipping queue processing`
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
      const stillExists = await messagesService.get(nextMessage.message_id, params);
      if (!stillExists || stillExists.status !== 'queued') {
        console.log(
          `⚠️  Queued message ${nextMessage.message_id.substring(0, 8)} was deleted or modified, skipping`
        );
        return;
      }
    } catch (error) {
      console.log(
        `⚠️  Queued message ${nextMessage.message_id.substring(0, 8)} no longer exists, skipping`
      );
      return;
    }

    // Delete the queued message (execution will create new messages)
    // Use the service so the after.remove hook fires and emits the dequeued event
    await messagesService.remove(nextMessage.message_id, params);

    // Trigger prompt execution via existing endpoint
    // This creates task, user message, executes agent, etc.
    const promptService = app.service('/sessions/:id/prompt') as {
      create: (data: { prompt: string; stream?: boolean }, params: RouteParams) => Promise<unknown>;
    };

    await promptService.create(
      {
        prompt,
        stream: true,
      },
      {
        ...params,
        route: { id: sessionId },
      }
    );

    console.log(`✅ Queued message triggered for session ${sessionId.substring(0, 8)}`);
  }

  // Permission decision endpoint
  app.use('/sessions/:id/permission-decision', {
    async create(data: PermissionDecision, params: RouteParams) {
      ensureMinimumRole(params, 'member', 'respond to permission requests');
      const id = params.route?.id;
      if (!id) throw new Error('Session ID required');
      if (!data.requestId) throw new Error('requestId required');
      if (typeof data.allow !== 'boolean') throw new Error('allow field required');

      // Resolve the pending permission request
      permissionService.resolvePermission(data);

      return { success: true };
    },
  });

  // Configure custom methods for tasks service
  const tasksService = app.service('tasks') as unknown as TasksServiceImpl;

  // Configure custom route for bulk task creation
  app.use('/tasks/bulk', {
    async create(data: unknown, params: RouteParams) {
      ensureMinimumRole(params, 'member', 'create tasks');
      return tasksService.createMany(data as Partial<Task>[]);
    },
  });

  app.use('/tasks/:id/complete', {
    async create(
      data: { git_state?: { sha_at_end?: string; commit_message?: string } },
      params: RouteParams
    ) {
      ensureMinimumRole(params, 'member', 'complete tasks');
      const id = params.route?.id;
      if (!id) throw new Error('Task ID required');
      return tasksService.complete(id, data, params);
    },
  });

  app.use('/tasks/:id/fail', {
    async create(data: { error?: string }, params: RouteParams) {
      ensureMinimumRole(params, 'member', 'fail tasks');
      const id = params.route?.id;
      if (!id) throw new Error('Task ID required');
      return tasksService.fail(id, data, params);
    },
  });

  // Configure custom methods for repos service
  const reposService = app.service('repos') as unknown as ReposServiceImpl;
  app.use('/repos/clone', {
    async create(data: { url: string; name?: string; destination?: string }, params: RouteParams) {
      ensureMinimumRole(params, 'member', 'clone repositories');
      return reposService.cloneRepository(data, params);
    },
  });

  app.use('/repos/:id/worktrees', {
    async create(data: { name: string; ref: string; createBranch?: boolean }, params: RouteParams) {
      ensureMinimumRole(params, 'member', 'create worktrees');
      const id = params.route?.id;
      if (!id) throw new Error('Repo ID required');
      return reposService.createWorktree(id, data, params);
    },
  });

  app.use('/repos/:id/worktrees/:name', {
    async remove(_id: unknown, params: RouteParams & { route?: { name?: string } }) {
      ensureMinimumRole(params, 'member', 'remove worktrees');
      const id = params.route?.id;
      const name = params.route?.name;
      if (!id) throw new Error('Repo ID required');
      if (!name) throw new Error('Worktree name required');
      return reposService.removeWorktree(id, name, params);
    },
  });

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
  app.use('/board-comments/:id/toggle-reaction', {
    async create(data: { user_id: string; emoji: string }, params: RouteParams) {
      ensureMinimumRole(params, 'member', 'react to board comments');
      const id = params.route?.id;
      if (!id) throw new Error('Comment ID required');
      if (!data.user_id) throw new Error('user_id required');
      if (!data.emoji) throw new Error('emoji required');
      const updated = await boardCommentsService.toggleReaction(id, data, params);
      // Manually emit patched event for real-time updates
      app.service('board-comments').emit('patched', updated);
      return updated;
    },
  });

  // POST /board-comments/:id/reply - Create a reply to a comment thread
  app.use('/board-comments/:id/reply', {
    async create(data: Partial<import('@agor/core/types').BoardComment>, params: RouteParams) {
      ensureMinimumRole(params, 'member', 'reply to board comments');
      const id = params.route?.id;
      if (!id) throw new Error('Comment ID required');
      if (!data.content) throw new Error('content required');
      if (!data.created_by) throw new Error('created_by required');
      const reply = await boardCommentsService.createReply(id, data, params);
      // Manually emit created event for real-time updates
      app.service('board-comments').emit('created', reply);
      return reply;
    },
  });

  // Configure custom methods for worktrees service (environment management)
  const worktreesService = app.service(
    'worktrees'
  ) as unknown as import('./declarations').WorktreesServiceImpl;

  // POST /worktrees/:id/start - Start environment
  app.use('/worktrees/:id/start', {
    async create(_data: unknown, params: RouteParams) {
      ensureMinimumRole(params, 'admin', 'start worktree environments');
      const id = params.route?.id;
      if (!id) throw new Error('Worktree ID required');
      return worktreesService.startEnvironment(id as import('@agor/core/types').WorktreeID, params);
    },
  });

  // POST /worktrees/:id/stop - Stop environment
  app.use('/worktrees/:id/stop', {
    async create(_data: unknown, params: RouteParams) {
      ensureMinimumRole(params, 'admin', 'stop worktree environments');
      const id = params.route?.id;
      if (!id) throw new Error('Worktree ID required');
      return worktreesService.stopEnvironment(id as import('@agor/core/types').WorktreeID, params);
    },
  });

  // POST /worktrees/:id/restart - Restart environment
  app.use('/worktrees/:id/restart', {
    async create(_data: unknown, params: RouteParams) {
      ensureMinimumRole(params, 'admin', 'restart worktree environments');
      const id = params.route?.id;
      if (!id) throw new Error('Worktree ID required');
      return worktreesService.restartEnvironment(
        id as import('@agor/core/types').WorktreeID,
        params
      );
    },
  });

  // GET /worktrees/:id/health - Check environment health
  app.use('/worktrees/:id/health', {
    async find(_data: unknown, params: RouteParams) {
      ensureMinimumRole(params, 'member', 'check worktree health');
      const id = params.route?.id;
      if (!id) throw new Error('Worktree ID required');
      return worktreesService.checkHealth(id as import('@agor/core/types').WorktreeID, params);
    },
    // biome-ignore lint/suspicious/noExplicitAny: Service type not compatible with Express
  } as any);

  // POST /worktrees/:id/archive-or-delete - Archive or delete worktree
  app.use('/worktrees/:id/archive-or-delete', {
    async create(data: unknown, params: RouteParams) {
      ensureMinimumRole(params, 'admin', 'archive or delete worktrees');
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
  } as any);

  // POST /worktrees/:id/unarchive - Unarchive worktree
  app.use('/worktrees/:id/unarchive', {
    async create(data: unknown, params: RouteParams) {
      ensureMinimumRole(params, 'admin', 'unarchive worktrees');
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
  } as any);

  // GET /worktrees/logs?worktree_id=xxx - Get environment logs
  app.use('/worktrees/logs', {
    async find(params: Params) {
      console.log('📋 Logs endpoint called');

      ensureMinimumRole(params || {}, 'member', 'view worktree logs');

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
  } as any);

  // Configure custom methods for boards service
  const boardsService = app.service('boards') as unknown as BoardsServiceImpl;
  app.use('/boards/:id/sessions', {
    async create(data: { sessionId: string }, params: RouteParams) {
      ensureMinimumRole(params, 'member', 'modify board sessions');
      const id = params.route?.id;
      if (!id) throw new Error('Board ID required');
      if (!data.sessionId) throw new Error('Session ID required');
      return boardsService.addSession(id, data.sessionId, params);
    },
  });

  // Configure custom routes for session-MCP relationships
  // (sessionMCPServersService already created above for top-level service)

  // GET /sessions/:id/mcp-servers - List MCP servers for a session
  app.use('/sessions/:id/mcp-servers', {
    async find(_data: unknown, params: RouteParams) {
      ensureMinimumRole(params, 'member', 'view session MCP servers');
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
      ensureMinimumRole(params, 'member', 'modify session MCP servers');
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
  } as any);

  // DELETE /sessions/:id/mcp-servers/:mcpId - Remove MCP server from session
  app.use('/sessions/:id/mcp-servers/:mcpId', {
    async remove(_id: unknown, params: RouteParams & { route?: { mcpId?: string } }) {
      ensureMinimumRole(params, 'member', 'modify session MCP servers');
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
      ensureMinimumRole(params, 'member', 'modify session MCP servers');
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
  } as any);

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
      const publicResponse = {
        status: 'ok',
        timestamp: Date.now(),
        version: DAEMON_VERSION,
        auth: {
          requireAuth: config.daemon?.requireAuth === true,
          allowAnonymous: allowAnonymous,
        },
      };

      // If user is authenticated (via requireAuth hook check), provide detailed info
      // Check if this is an authenticated request
      // biome-ignore lint/suspicious/noExplicitAny: FeathersJS request params are untyped
      const isAuthenticated = (params as any)?.user !== undefined;

      if (isAuthenticated) {
        return {
          ...publicResponse,
          database: DB_PATH,
          auth: {
            ...publicResponse.auth,
            // biome-ignore lint/suspicious/noExplicitAny: FeathersJS request params are untyped
            user: (params as any)?.user?.email,
            // biome-ignore lint/suspicious/noExplicitAny: FeathersJS request params are untyped
            role: (params as any)?.user?.role,
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
        const opencodeConfig = config.opencode;
        if (!opencodeConfig?.enabled) {
          throw new Error('OpenCode is not enabled in configuration');
        }

        const serverUrl = opencodeConfig.serverUrl || 'http://localhost:4096';
        const response = await fetch(`${serverUrl}/config/providers`);

        if (!response.ok) {
          throw new Error(`OpenCode server returned ${response.status}: ${response.statusText}`);
        }

        // biome-ignore lint/suspicious/noExplicitAny: OpenCode API response structure not formally typed
        const data = (await response.json()) as { providers?: any[]; default?: string };

        // Transform to frontend-friendly format
        // OpenCode returns: { providers: [{id, name, models: {modelId: {id, name, ...}}}] }
        // We need to convert models object to array
        // biome-ignore lint/suspicious/noExplicitAny: Dynamic provider structure from OpenCode API
        const transformedProviders = (data.providers || []).map((provider: any) => ({
          id: provider.id,
          name: provider.name,
          models: provider.models
            ? // biome-ignore lint/suspicious/noExplicitAny: Dynamic model metadata from OpenCode API
              Object.entries(provider.models).map(([modelId, modelMeta]: [string, any]) => ({
                id: modelId,
                name: modelMeta.name || modelId,
              }))
            : [],
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
    async find() {
      try {
        const opencodeConfig = config.opencode;
        if (!opencodeConfig?.enabled) {
          throw new Error('OpenCode is not enabled in configuration');
        }

        const serverUrl = opencodeConfig.serverUrl || 'http://localhost:4096';
        const response = await fetch(`${serverUrl}/health`);

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
      await sessionsService.patch(session.session_id, {
        status: SessionStatus.IDLE,
      });
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
        await sessionsService.patch(sessionId as Id, {
          status: SessionStatus.IDLE,
        });
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
      if (socketServer) {
        console.log('🔌 Closing Socket.io and HTTP server...');
        // Disconnect all active clients first
        socketServer.disconnectSockets();
        // Give sockets a moment to disconnect
        await new Promise<void>(resolve => setTimeout(resolve, 100));
        // Now close the server with a timeout
        await new Promise<void>(resolve => {
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
          server.close(err => {
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
main().catch(error => {
  console.error('Failed to start daemon:', error);
  process.exit(1);
});
