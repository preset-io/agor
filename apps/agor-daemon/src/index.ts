/**
 * Agor Daemon
 *
 * FeathersJS backend providing REST + WebSocket API for session management.
 * Auto-started by CLI, provides unified interface for GUI and CLI clients.
 */

import 'dotenv/config';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, type UnknownJson } from '@agor/core/config';
import {
  createDatabase,
  MCPServerRepository,
  MessagesRepository,
  SessionMCPServerRepository,
  SessionRepository,
  sessionMcpServers,
  TaskRepository,
} from '@agor/core/db';
import { type PermissionDecision, PermissionService } from '@agor/core/permissions';
import { ClaudeTool, CodexTool, GeminiTool } from '@agor/core/tools';
import type { SessionID, TaskStatus, User } from '@agor/core/types';
import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import { AuthenticationService, JWTStrategy } from '@feathersjs/authentication';
import { LocalStrategy } from '@feathersjs/authentication-local';
import feathersExpress, { errorHandler, rest } from '@feathersjs/express';
import type { Params } from '@feathersjs/feathers';
import { feathers } from '@feathersjs/feathers';
import socketio from '@feathersjs/socketio';
import cors from 'cors';
import express from 'express';
import jwt from 'jsonwebtoken';
import type { Socket } from 'socket.io';
import { createBoardsService } from './services/boards';
import { createContextService } from './services/context';
import { createMCPServersService } from './services/mcp-servers';
import { createMessagesService } from './services/messages';
import { createReposService } from './services/repos';
import { createSessionMCPServersService } from './services/session-mcp-servers';
import { createSessionsService } from './services/sessions';
import { createTasksService } from './services/tasks';
import { createUsersService } from './services/users';
import { AnonymousStrategy } from './strategies/anonymous';

/**
 * Extended Params with route ID parameter
 */
interface RouteParams extends Params {
  route?: {
    id?: string;
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

const DB_PATH = process.env.AGOR_DB_PATH || 'file:~/.agor/agor.db';

// Main async function
async function main() {
  // Load config to get ports and API keys
  const config = await loadConfig();

  // Get daemon port from config (with env var override)
  const envPort = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : undefined;
  const DAEMON_PORT = envPort || config.daemon?.port || 3030;

  // Get UI port from config for CORS
  const UI_PORT = config.ui?.port || 5173;

  const apiKey = config.credentials?.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    console.warn('⚠️  No ANTHROPIC_API_KEY found in config or environment');
    console.warn('   Run: agor config set credentials.ANTHROPIC_API_KEY <your-key>');
    console.warn('   Or set ANTHROPIC_API_KEY environment variable');
    console.warn('   Note: Claude CLI can also use its own stored credentials (~/.claude/)');
  }
  // NOTE: Do NOT set process.env.ANTHROPIC_API_KEY here!
  // The Claude CLI has its own authentication system and setting the env var
  // can interfere with it. The SDK will pass apiKey as an option instead.

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

  app.use(
    cors({
      origin: corsOrigins,
      credentials: true,
    })
  );

  // Parse JSON
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Configure REST and Socket.io with CORS
  app.configure(rest());

  // Store Socket.io instance for graceful shutdown
  let socketServer: import('socket.io').Server | null = null;

  app.configure(
    socketio(
      {
        cors: {
          origin: corsOrigins,
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

        // Configure Socket.io for cursor presence events
        io.on('connection', socket => {
          activeConnections++;
          console.log(
            `🔌 Socket.io connection established: ${socket.id} (total: ${activeConnections})`
          );

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

        // Log connection metrics periodically (every 30 seconds)
        setInterval(() => {
          if (activeConnections > 0) {
            console.log(`📊 Active WebSocket connections: ${activeConnections}`);
          }
        }, 30000);
      }
    )
  );

  // Configure channels to broadcast events to all connected clients
  app.on('connection', connection => {
    // Join all connections to the 'everybody' channel
    app.channel('everybody').join(connection);
  });

  // Publish all service events to all connected clients
  app.publish(() => {
    return app.channel('everybody');
  });

  // Initialize database
  console.log(`📦 Connecting to database: ${DB_PATH}`);
  const db = createDatabase({ url: DB_PATH });

  // Register core services
  app.use('/sessions', createSessionsService(db));
  app.use('/tasks', createTasksService(db));
  const messagesService = createMessagesService(db);

  // Register messages service with custom streaming events
  app.use('/messages', messagesService, {
    events: ['streaming:start', 'streaming:chunk', 'streaming:end', 'streaming:error'],
  });

  app.use('/boards', createBoardsService(db));
  app.use('/repos', createReposService(db));
  app.use('/mcp-servers', createMCPServersService(db));

  // Register context service (read-only filesystem browser)
  // Scans context/ folder for all .md files
  // Currently: <project-root>/context/
  // Future: May move to ~/.agor/context/
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const contextPath = resolve(__dirname, '../../..', 'context');
  app.use('/context', createContextService(contextPath));

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

  // Add hooks to inject created_by from authenticated user
  app.service('sessions').hooks({
    before: {
      create: [
        async context => {
          // Inject user_id if authenticated, otherwise use 'anonymous'
          // biome-ignore lint/suspicious/noExplicitAny: Context params extended with user field
          const user = (context.params as any).user;
          const userId = user?.user_id || 'anonymous';

          // DEBUG: Log authentication state
          console.log(
            '🔍 Session create hook - user:',
            user ? `${user.user_id} (${user.email})` : 'none',
            '→ userId:',
            userId
          );

          if (Array.isArray(context.data)) {
            // biome-ignore lint/suspicious/noExplicitAny: Hook data type
            context.data.forEach((item: any) => {
              if (!item.created_by) item.created_by = userId;
            });
          } else if (context.data && !context.data.created_by) {
            // biome-ignore lint/suspicious/noExplicitAny: Hook data type
            (context.data as any).created_by = userId;
          }
          return context;
        },
      ],
    },
  });

  app.service('tasks').hooks({
    before: {
      create: [
        async context => {
          // Inject user_id if authenticated, otherwise use 'anonymous'
          // biome-ignore lint/suspicious/noExplicitAny: Context params extended with user field
          const user = (context.params as any).user;
          const userId = user?.user_id || 'anonymous';

          // DEBUG: Log authentication state
          console.log(
            '🔍 Task create hook - user:',
            user ? `${user.user_id} (${user.email})` : 'none',
            '→ userId:',
            userId
          );

          if (Array.isArray(context.data)) {
            // biome-ignore lint/suspicious/noExplicitAny: Hook data type
            context.data.forEach((item: any) => {
              if (!item.created_by) item.created_by = userId;
            });
          } else if (context.data && !context.data.created_by) {
            // biome-ignore lint/suspicious/noExplicitAny: Hook data type
            (context.data as any).created_by = userId;
          }
          return context;
        },
      ],
    },
  });

  app.service('boards').hooks({
    before: {
      create: [
        async context => {
          // Inject user_id if authenticated, otherwise use 'anonymous'
          // biome-ignore lint/suspicious/noExplicitAny: Context params extended with user field
          const userId = (context.params as any).user?.user_id || 'anonymous';

          if (Array.isArray(context.data)) {
            // biome-ignore lint/suspicious/noExplicitAny: Hook data type
            context.data.forEach((item: any) => {
              if (!item.created_by) item.created_by = userId;
            });
          } else if (context.data && !context.data.created_by) {
            // biome-ignore lint/suspicious/noExplicitAny: Hook data type
            (context.data as any).created_by = userId;
          }
          return context;
        },
      ],
      patch: [
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
            const result = await boardsService.upsertBoardObject(context.id, objectId, objectData);
            context.result = result;
            // Manually emit 'patched' event for WebSocket broadcasting (ONCE)
            app.service('boards').emit('patched', result);
            // Skip normal patch flow to prevent double emit
            context.dispatch = result;
            return context;
          }

          if (_action === 'removeObject' && objectId) {
            const result = await boardsService.removeBoardObject(context.id, objectId);
            context.result = result;
            // Manually emit 'patched' event for WebSocket broadcasting (ONCE)
            app.service('boards').emit('patched', result);
            // Skip normal patch flow to prevent double emit
            context.dispatch = result;
            return context;
          }

          if (_action === 'batchUpsertObjects' && objects) {
            const result = await boardsService.batchUpsertBoardObjects(context.id, objects);
            context.result = result;
            // Manually emit 'patched' event for WebSocket broadcasting (ONCE)
            app.service('boards').emit('patched', result);
            // Skip normal patch flow to prevent double emit
            context.dispatch = result;
            return context;
          }

          if (_action === 'deleteZone' && objectId) {
            const result = await boardsService.deleteZone(
              context.id,
              objectId,
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
    },
  });

  // Generate or load JWT secret
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

  // Configure authentication options BEFORE creating service
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

  app.use('/authentication', authentication);

  // Hook: Add refresh token to authentication response
  app.service('authentication').hooks({
    after: {
      create: [
        async context => {
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
    async create(data: { refreshToken: string }) {
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

  // Initialize repositories for ClaudeTool
  const messagesRepo = new MessagesRepository(db);
  const sessionsRepo = new SessionRepository(db);
  const sessionMCPRepo = new SessionMCPServerRepository(db);
  const mcpServerRepo = new MCPServerRepository(db);
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
    app.service('sessions') // Sessions service for permission persistence (WebSocket broadcast)
  );

  // Initialize CodexTool (uses OPENAI_API_KEY from environment)
  const openaiApiKey = config.credentials?.OPENAI_API_KEY || process.env.OPENAI_API_KEY;
  const codexTool = new CodexTool(
    messagesRepo,
    sessionsRepo,
    openaiApiKey,
    app.service('messages'),
    app.service('tasks')
  );

  if (!openaiApiKey) {
    console.warn('⚠️  No OPENAI_API_KEY found - Codex sessions will fail');
    console.warn('   Run: agor config set credentials.OPENAI_API_KEY <your-key>');
    console.warn('   Or set OPENAI_API_KEY environment variable');
  }

  // Initialize GeminiTool (uses GEMINI_API_KEY from environment)
  const geminiApiKey = config.credentials?.GEMINI_API_KEY || process.env.GEMINI_API_KEY;
  const geminiTool = new GeminiTool(
    messagesRepo,
    sessionsRepo,
    geminiApiKey,
    app.service('messages'),
    app.service('tasks')
  );

  if (!geminiApiKey) {
    console.warn('⚠️  No GEMINI_API_KEY found - Gemini sessions will fail');
    console.warn('   Run: agor config set credentials.GEMINI_API_KEY <your-key>');
    console.warn('   Or set GEMINI_API_KEY environment variable');
  } else {
    // CRITICAL: Set environment variable for Gemini SDK
    // Unlike Claude Code, Gemini SDK reads GEMINI_API_KEY from process.env
    process.env.GEMINI_API_KEY = geminiApiKey;
  }
  // NOTE: Do NOT set process.env.OPENAI_API_KEY here for the same reason as ANTHROPIC_API_KEY
  // Let the Codex CLI use its own auth system

  // Configure custom route for bulk message creation
  app.use('/messages/bulk', {
    async create(data: unknown[]) {
      // biome-ignore lint/suspicious/noExplicitAny: Messages data validated by repository
      return messagesService.createMany(data as any);
    },
  });

  // Configure custom methods for sessions service
  // biome-ignore lint/suspicious/noExplicitAny: Service type is correct but TS doesn't infer custom methods
  const sessionsService = app.service('sessions') as any;
  app.use('/sessions/:id/fork', {
    async create(data: { prompt: string; task_id?: string }, params: RouteParams) {
      const id = params.route?.id;
      if (!id) throw new Error('Session ID required');
      return sessionsService.fork(id, data, params);
    },
  });

  app.use('/sessions/:id/spawn', {
    async create(data: { prompt: string; agent?: string; task_id?: string }, params: RouteParams) {
      const id = params.route?.id;
      if (!id) throw new Error('Session ID required');
      return sessionsService.spawn(id, data, params);
    },
  });

  // Feathers custom route handler with find method
  app.use('/sessions/:id/genealogy', {
    // biome-ignore lint/suspicious/noExplicitAny: Route handler parameter type
    async find(_data: any, params: RouteParams) {
      const id = params.route?.id;
      if (!id) throw new Error('Session ID required');
      return sessionsService.getGenealogy(id, params);
    },
    // biome-ignore lint/suspicious/noExplicitAny: Service type not compatible with Express
  } as any);

  app.use('/sessions/:id/prompt', {
    async create(
      data: { prompt: string; permissionMode?: PermissionMode; stream?: boolean },
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
      console.log(`   Session agent: ${session.agent}`);
      console.log(
        `   Session permission_config.mode: ${session.permission_config?.mode || 'not set'}`
      );
      const messageStartIndex = session.message_count;
      const startTimestamp = new Date().toISOString();

      // Get current git state from session's working directory
      const { getGitState } = await import('@agor/core/git');
      const gitStateAtStart = session.repo?.cwd ? await getGitState(session.repo.cwd) : 'unknown';

      // PHASE 1: Create task immediately with 'running' status (UI shows task instantly)
      const task = await tasksService.create(
        {
          session_id: id,
          status: 'running', // Start as running, will be updated to completed
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
            sha_at_start: gitStateAtStart,
          },
        },
        params
      );

      // Update session with new task immediately and set status to running
      await sessionsService.patch(id, {
        tasks: [...session.tasks, task.task_id],
        status: 'running',
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
        } else {
          // Use ClaudeTool for Claude Code sessions (default)
          executeMethod = useStreaming
            ? claudeTool.executePromptWithStreaming(
                id as SessionID,
                data.prompt,
                task.task_id,
                data.permissionMode,
                streamingCallbacks
              )
            : claudeTool.executePrompt(
                id as SessionID,
                data.prompt,
                task.task_id,
                data.permissionMode
              );
        }

        executeMethod
          .then(async result => {
            try {
              // PHASE 3: Mark task as completed and update message count
              // (Messages already created with task_id, no need to patch)
              const endTimestamp = new Date().toISOString();
              const totalMessages = 1 + result.assistantMessageIds.length; // user + assistants

              // Check current task status - don't overwrite terminal states
              // (e.g., 'failed' from denied permission, 'awaiting_permission' still pending, 'stopping'/'stopped' from user cancel)
              const currentTask = await tasksService.get(task.task_id);
              if (
                currentTask.status === 'failed' ||
                currentTask.status === 'awaiting_permission' ||
                currentTask.status === 'stopping' ||
                currentTask.status === 'stopped'
              ) {
                console.log(
                  `⚠️  Task ${task.task_id} already in terminal state: ${currentTask.status} - not marking as completed`
                );

                // Still update message range for completeness
                await tasksService.patch(task.task_id, {
                  message_range: {
                    start_index: messageStartIndex,
                    end_index: messageStartIndex + totalMessages - 1,
                    start_timestamp: startTimestamp,
                    end_timestamp: endTimestamp,
                  },
                });
              } else {
                // Safe to mark as completed
                await tasksService.patch(task.task_id, {
                  status: 'completed',
                  message_range: {
                    start_index: messageStartIndex,
                    end_index: messageStartIndex + totalMessages - 1,
                    start_timestamp: startTimestamp,
                    end_timestamp: endTimestamp,
                  },
                  tool_use_count: result.assistantMessageIds.reduce((count, _id, _index) => {
                    // First assistant message likely has tools
                    return count; // TODO: Count actual tools from messages
                  }, 0),
                });

                console.log(`✅ Task ${task.task_id} completed successfully`);
              }

              await sessionsService.patch(id, {
                message_count: session.message_count + totalMessages,
                status: 'idle',
              });
            } catch (error) {
              console.error(`❌ Error completing task ${task.task_id}:`, error);
              // Mark task as failed
              await tasksService.patch(task.task_id, {
                status: 'failed',
              });
            }
          })
          .catch(async error => {
            console.error(`❌ Error executing prompt for task ${task.task_id}:`, error);

            // Check if error is due to stale Agent SDK session
            if (
              error.message?.includes('Claude Code process exited with code 1') &&
              session.agent_session_id
            ) {
              console.warn(`⚠️  Detected stale Agent SDK session ${session.agent_session_id}`);
              console.warn(`   Clearing agent_session_id to allow fresh session on retry`);

              // Clear the stale agent_session_id so next prompt starts fresh
              await sessionsService.patch(id, {
                agent_session_id: null,
              });
            }

            // Mark task as failed and set session back to idle
            await tasksService.patch(task.task_id, {
              status: 'failed',
            });
            await sessionsService.patch(id, {
              status: 'idle',
            });
          });
      });

      // Return immediately with task ID - don't wait for Claude to finish!
      return {
        success: true,
        taskId: task.task_id,
        status: 'running',
        streaming: useStreaming, // Inform client whether streaming is enabled
      };
    },
  });

  // Stop execution endpoint
  app.use('/sessions/:id/stop', {
    async create(_data: unknown, params: RouteParams) {
      const id = params.route?.id;
      if (!id) throw new Error('Session ID required');

      console.log(`🛑 [Daemon] Stop request for session ${id.substring(0, 8)}`);

      // Get session to find which tool to use
      const session = await sessionsService.get(id, params);

      // Check if session is actually running
      if (session.status !== 'running') {
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
          status: { $in: ['running', 'awaiting_permission'] },
          $limit: 10,
        },
      });

      // Extract data array if paginated
      const runningTasksArray = Array.isArray(runningTasks)
        ? runningTasks
        : runningTasks.data || [];

      // PHASE 1: Immediately update status to 'stopping' (UI feedback before SDK call)
      if (runningTasksArray.length > 0) {
        const latestTask = runningTasksArray[runningTasksArray.length - 1];

        try {
          await Promise.race([
            tasksService.patch(latestTask.task_id, {
              status: 'stopping' satisfies TaskStatus as TaskStatus,
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
          status: 'idle',
        });

        // Update task status to 'stopped'
        if (runningTasksArray.length > 0) {
          const latestTask = runningTasksArray[runningTasksArray.length - 1];
          await tasksService.patch(latestTask.task_id, {
            status: 'stopped',
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
            status: 'running', // Revert to running
          });
        }
      }

      return result;
    },
  });

  // Permission decision endpoint
  app.use('/sessions/:id/permission-decision', {
    async create(data: PermissionDecision, params: RouteParams) {
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
  // biome-ignore lint/suspicious/noExplicitAny: Service type is correct but TS doesn't infer custom methods
  const tasksService = app.service('tasks') as any;

  // Configure custom route for bulk task creation
  app.use('/tasks/bulk', {
    async create(data: unknown[]) {
      return tasksService.createMany(data);
    },
  });

  app.use('/tasks/:id/complete', {
    async create(
      data: { git_state?: { sha_at_end?: string; commit_message?: string } },
      params: RouteParams
    ) {
      const id = params.route?.id;
      if (!id) throw new Error('Task ID required');
      return tasksService.complete(id, data, params);
    },
  });

  app.use('/tasks/:id/fail', {
    async create(data: { error?: string }, params: RouteParams) {
      const id = params.route?.id;
      if (!id) throw new Error('Task ID required');
      return tasksService.fail(id, data, params);
    },
  });

  // Configure custom methods for repos service
  // biome-ignore lint/suspicious/noExplicitAny: Service type is correct but TS doesn't infer custom methods
  const reposService = app.service('repos') as any;
  app.use('/repos/clone', {
    async create(data: { url: string; name?: string; destination?: string }, params: RouteParams) {
      return reposService.cloneRepository(data, params);
    },
  });

  app.use('/repos/:id/worktrees', {
    async create(data: { name: string; ref: string; createBranch?: boolean }, params: RouteParams) {
      const id = params.route?.id;
      if (!id) throw new Error('Repo ID required');
      return reposService.createWorktree(id, data, params);
    },
  });

  app.use('/repos/:id/worktrees/:name', {
    async remove(_id: unknown, params: RouteParams & { route?: { name?: string } }) {
      const id = params.route?.id;
      const name = params.route?.name;
      if (!id) throw new Error('Repo ID required');
      if (!name) throw new Error('Worktree name required');
      return reposService.removeWorktree(id, name, params);
    },
  });

  // Configure custom methods for boards service
  // biome-ignore lint/suspicious/noExplicitAny: Service type is correct but TS doesn't infer custom methods
  const boardsService = app.service('boards') as any;
  app.use('/boards/:id/sessions', {
    async create(data: { sessionId: string }, params: RouteParams) {
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
  } as any);

  // DELETE /sessions/:id/mcp-servers/:mcpId - Remove MCP server from session
  app.use('/sessions/:id/mcp-servers/:mcpId', {
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
  } as any);

  // Hook: Remove session from all boards when session is deleted
  sessionsService.on('removed', async (session: import('@agor/core/types').Session) => {
    try {
      // Find all boards
      const boardsResult = await boardsService.find();
      const boards = Array.isArray(boardsResult) ? boardsResult : boardsResult.data;

      // Remove session from any boards that contain it
      for (const board of boards) {
        if (board.sessions?.includes(session.session_id)) {
          await boardsService.removeSession(board.board_id, session.session_id);
          console.log(`Removed session ${session.session_id} from board ${board.name}`);
        }
      }
    } catch (error) {
      console.error('Failed to remove session from boards:', error);
    }
  });

  // Health check endpoint
  app.use('/health', {
    async find() {
      return {
        status: 'ok',
        timestamp: Date.now(),
        version: '0.1.0',
        database: DB_PATH,
        auth: {
          requireAuth: config.daemon?.requireAuth === true,
          allowAnonymous: config.daemon?.allowAnonymous !== false,
        },
      };
    },
  });

  // Error handling
  app.use(errorHandler());

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
  console.log(`     - /context`);
  console.log(`     - /users`);

  // Graceful shutdown handler
  const shutdown = async (signal: string) => {
    console.log(`\n⏳ Received ${signal}, shutting down gracefully...`);

    try {
      // Close Socket.io connections (this also closes the HTTP server)
      if (socketServer) {
        console.log('🔌 Closing Socket.io and HTTP server...');
        await new Promise<void>(resolve => {
          socketServer?.close(() => {
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
