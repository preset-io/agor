/**
 * Agor Daemon
 *
 * FeathersJS backend providing REST + WebSocket API for session management.
 * Auto-started by CLI, provides unified interface for GUI and CLI clients.
 */

import 'dotenv/config';
import { loadConfig } from '@agor/core/config';
import {
  createDatabase,
  MessagesRepository,
  SessionMCPServerRepository,
  SessionRepository,
  sessionMcpServers,
} from '@agor/core/db';
import { ClaudeTool } from '@agor/core/tools';
import type { SessionID } from '@agor/core/types';
import { AuthenticationService, JWTStrategy } from '@feathersjs/authentication';
import { LocalStrategy } from '@feathersjs/authentication-local';
import feathersExpress, { errorHandler, rest } from '@feathersjs/express';
import type { Params } from '@feathersjs/feathers';
import { feathers } from '@feathersjs/feathers';
import socketio from '@feathersjs/socketio';
import cors from 'cors';
import express from 'express';
import { createBoardsService } from './services/boards';
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

const PORT = process.env.PORT || 3030;
const DB_PATH = process.env.AGOR_DB_PATH || 'file:~/.agor/agor.db';

// Main async function
async function main() {
  // Load config to get API key
  const config = await loadConfig();
  const apiKey = config.credentials?.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    console.warn('⚠️  No ANTHROPIC_API_KEY found in config or environment');
    console.warn('   Run: agor config set credentials.ANTHROPIC_API_KEY <your-key>');
    console.warn('   Or set ANTHROPIC_API_KEY environment variable');
  }

  // Create Feathers app
  const app = feathersExpress(feathers());

  // Enable CORS for all REST API requests
  app.use(
    cors({
      origin: [
        'http://localhost:5173',
        'http://localhost:5174',
        'http://localhost:5175',
        'http://localhost:5176',
      ],
      credentials: true,
    })
  );

  // Parse JSON
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Configure REST and Socket.io with CORS
  app.configure(rest());
  app.configure(
    socketio({
      cors: {
        origin: 'http://localhost:5173',
        methods: ['GET', 'POST', 'PATCH', 'DELETE'],
        credentials: true,
      },
    })
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
  app.use('/messages', messagesService);
  app.use('/boards', createBoardsService(db));
  app.use('/repos', createReposService(db));
  app.use('/mcp-servers', createMCPServersService(db));

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
      expiresIn: '7d',
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

  // Initialize repositories for ClaudeTool
  const messagesRepo = new MessagesRepository(db);
  const sessionsRepo = new SessionRepository(db);
  const sessionMCPRepo = new SessionMCPServerRepository(db);

  // Initialize ClaudeTool with repositories, API key, AND app-level messagesService
  // CRITICAL: Must use app.service('messages') to ensure WebSocket events are emitted
  // Using the raw service instance bypasses Feathers event publishing
  const claudeTool = new ClaudeTool(
    messagesRepo,
    sessionsRepo,
    apiKey,
    app.service('messages'),
    sessionMCPRepo
  );

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
    async create(data: { prompt: string }, params: RouteParams) {
      const id = params.route?.id;
      if (!id) throw new Error('Session ID required');
      if (!data.prompt) throw new Error('Prompt required');

      // Get session to find current message count
      const session = await sessionsService.get(id, params);
      const messageStartIndex = session.message_count;
      const startTimestamp = new Date().toISOString();

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
            sha_at_start: session.git_state?.current_sha || 'unknown',
          },
        },
        params
      );

      // Update session with new task immediately
      await sessionsService.patch(id, {
        tasks: [...session.tasks, task.task_id],
      });

      // PHASE 2: Execute prompt in background (COMPLETELY DETACHED from HTTP request context)
      // Use setImmediate to break out of FeathersJS request scope
      // This ensures WebSocket events flush immediately, not batched with request
      setImmediate(() => {
        claudeTool
          .executePrompt(id as SessionID, data.prompt, task.task_id)
          .then(async result => {
            try {
              // PHASE 3: Mark task as completed and update message count
              // (Messages already created with task_id, no need to patch)
              const endTimestamp = new Date().toISOString();
              const totalMessages = 1 + result.assistantMessageIds.length; // user + assistants

              await tasksService.patch(task.task_id, {
                status: 'completed',
                message_range: {
                  start_index: messageStartIndex,
                  end_index: messageStartIndex + totalMessages - 1,
                  start_timestamp: startTimestamp,
                  end_timestamp: endTimestamp,
                },
                tool_use_count: result.assistantMessageIds.reduce((count, _id, index) => {
                  // First assistant message likely has tools
                  return count; // TODO: Count actual tools from messages
                }, 0),
              });

              await sessionsService.patch(id, {
                message_count: session.message_count + totalMessages,
              });

              console.log(`✅ Task ${task.task_id} completed successfully`);
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
            // Mark task as failed
            await tasksService.patch(task.task_id, {
              status: 'failed',
            });
          });
      });

      // Return immediately with task ID - don't wait for Claude to finish!
      return {
        success: true,
        taskId: task.task_id,
        status: 'running',
      };
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

  // Start server
  app.listen(PORT).then(() => {
    console.log(`🚀 Agor daemon running at http://localhost:${PORT}`);
    console.log(`   Health: http://localhost:${PORT}/health`);
    console.log(
      `   Authentication: ${config.daemon?.allowAnonymous !== false ? '🔓 Anonymous (default)' : '🔐 Required'}`
    );
    console.log(`   Login: POST http://localhost:${PORT}/authentication`);
    console.log(`   Services:`);
    console.log(`     - /sessions`);
    console.log(`     - /tasks`);
    console.log(`     - /messages`);
    console.log(`     - /boards`);
    console.log(`     - /repos`);
    console.log(`     - /mcp-servers`);
    console.log(`     - /users`);
  });

  // Graceful shutdown
  process.on('SIGTERM', () => {
    console.log('\n⏳ Shutting down gracefully...');
    process.exit(0);
  });

  process.on('SIGINT', () => {
    console.log('\n⏳ Shutting down gracefully...');
    process.exit(0);
  });
}

// Start the daemon
main().catch(error => {
  console.error('Failed to start daemon:', error);
  process.exit(1);
});
