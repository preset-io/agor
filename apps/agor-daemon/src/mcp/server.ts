/**
 * MCP Server — Official SDK integration
 *
 * Creates an McpServer using @modelcontextprotocol/sdk and mounts it
 * at POST /mcp with JWT session-token auth.
 *
 * When tool search is enabled (mcpToolSearch config flag), only essential
 * tools appear in tools/list. Agents discover others via agor_search_tools.
 * All tools remain registered and callable regardless.
 *
 * DETERMINISM: The tools/list response and registry are built once on first
 * request and cached as module-level singletons. This ensures byte-identical
 * JSON across requests, which is critical for client-side KV prefix caching.
 */

import type { Database } from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { SessionID, UserID } from '@agor/core/types';
import { NotFoundError } from '@agor/core/utils/errors';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Request, Response } from 'express';
import { toJSONSchema } from 'zod/v4-mini';
import type { AuthenticatedParams, AuthenticatedUser } from '../declarations.js';
import { validateSessionToken } from './tokens.js';
import { ToolRegistry } from './tool-registry.js';
import { registerAnalyticsTools } from './tools/analytics.js';
import { registerBoardTools } from './tools/boards.js';
import { registerCardTypeTools } from './tools/card-types.js';
import { registerCardTools } from './tools/cards.js';
import { registerEnvironmentTools } from './tools/environment.js';
import { registerMcpServerTools } from './tools/mcp-servers.js';
import { registerMessageTools } from './tools/messages.js';
import { registerRepoTools } from './tools/repos.js';
import { registerSearchTools } from './tools/search.js';
import { registerSessionTools } from './tools/sessions.js';
import { registerTaskTools } from './tools/tasks.js';
import { registerUserTools } from './tools/users.js';
import { registerWorktreeTools } from './tools/worktrees.js';

/**
 * Shared context passed to every tool handler.
 */
export interface McpContext {
  app: Application;
  db: Database;
  userId: UserID;
  sessionId: SessionID;
  authenticatedUser: AuthenticatedUser;
  baseServiceParams: Pick<AuthenticatedParams, 'user' | 'authenticated' | 'provider'>;
}

/**
 * Helper: coerce unknown value to trimmed non-empty string or undefined.
 */
export function coerceString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Helper: format a value as MCP text content response.
 */
export function textResult(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  };
}

/** Server instructions shown to agents when tool search is enabled. */
const SERVER_INSTRUCTIONS = `Agor is a multiplayer canvas for orchestrating AI coding agents. It manages git worktrees, tracks AI conversations, visualizes work on spatial boards, and enables real-time collaboration.

This server uses progressive tool discovery. Only 2 tools are listed directly — use them to discover and call all available tools:

- agor_search_tools: Browse/search tools by keyword, domain, or annotation. Call with no args for a domains overview.
- agor_execute_tool: Call any discovered tool by name with arguments.

Domains:
- sessions: Agent conversations with genealogy (fork/spawn), task tracking, and message history
- repos: Repository registration and management
- worktrees: Git worktrees with isolated branches, board placement, and zone pinning
- environment: Start/stop/health/logs for worktree dev environments
- boards: Spatial canvases with zones for organizing worktrees and cards
- cards: Kanban-style cards and card type definitions on boards
- users: User accounts, profiles, preferences, and administration
- analytics: Usage and cost tracking leaderboard
- mcp-servers: External MCP server configuration and OAuth management

Common workflows:

Create a worktree and start a session:
1. agor_repos_list → get repoId
2. agor_boards_list → get boardId
3. agor_worktrees_create(repoId, boardId, worktreeName) → get worktreeId
4. agor_sessions_create(worktreeId, agenticTool, initialPrompt)

Delegate a subtask to a child agent:
1. agor_sessions_spawn(prompt) — inherits current worktree, tracks parent-child genealogy

Continue or fork an existing session:
1. agor_sessions_prompt(sessionId, prompt, mode:"continue"|"fork"|"subsession")

Discover tools: search (list detail) → search (full detail for schemas) → execute`;

/**
 * Module-level cached registry and tools/list response.
 *
 * Built once on first request, reused for all subsequent requests.
 * The registry content is independent of user/session — only tool handlers
 * differ per request. This ensures deterministic, byte-identical tools/list
 * responses critical for client-side KV prefix caching.
 */
let cachedRegistry: ToolRegistry | null = null;
let cachedToolsList: { tools: Array<Record<string, unknown>> } | null = null;

/**
 * Build the tool registry by registering tools against a temporary server.
 * Captures metadata (name, description, JSON Schema, annotations, domain)
 * without creating real handlers. Called once, cached forever.
 */
function buildRegistry(): ToolRegistry {
  const registry = new ToolRegistry();

  // Create a throwaway server just to run the registration code.
  // We intercept registerTool to capture metadata only.
  const tempServer = new McpServer({ name: 'agor-registry-builder', version: '0.0.0' });
  const originalRegisterTool = tempServer.registerTool.bind(tempServer) as (
    ...args: unknown[]
  ) => ReturnType<typeof tempServer.registerTool>;

  // Override the registerTool method to intercept metadata.
  // Cast required because registerTool is an overloaded generic method — TypeScript
  // cannot represent the replacement function with the exact overload signature.
  (
    tempServer as unknown as {
      registerTool: (name: string, config: Record<string, unknown>, cb: unknown) => void;
    }
  ).registerTool = (name: string, config: Record<string, unknown>, cb: unknown) => {
    // Convert Zod schema to JSON Schema using Zod v4's built-in converter
    let jsonSchema: Record<string, unknown> = { type: 'object' };
    if (config.inputSchema) {
      try {
        jsonSchema = toJSONSchema(
          config.inputSchema as Parameters<typeof toJSONSchema>[0]
        ) as Record<string, unknown>;
      } catch {
        // Fallback: empty object schema if conversion fails
        jsonSchema = { type: 'object' };
      }
    }

    registry.register({
      name,
      description: (config.description as string) ?? '',
      inputSchema: jsonSchema,
      annotations:
        config.annotations as import('@modelcontextprotocol/sdk/types.js').ToolAnnotations,
    });

    // Still register with the temp server so Zod schemas are valid
    return originalRegisterTool(name, config, cb);
  };

  // Register all domain tools with domain tracking.
  // Handlers receive a dummy context — they won't be called.
  const dummyCtx = {} as McpContext;

  registry.setCurrentDomain('sessions');
  registerSessionTools(tempServer, dummyCtx);

  registry.setCurrentDomain('repos');
  registerRepoTools(tempServer, dummyCtx);

  registry.setCurrentDomain('worktrees');
  registerWorktreeTools(tempServer, dummyCtx);

  registry.setCurrentDomain('environment');
  registerEnvironmentTools(tempServer, dummyCtx);

  registry.setCurrentDomain('boards');
  registerBoardTools(tempServer, dummyCtx);

  registry.setCurrentDomain('cards');
  registerCardTools(tempServer, dummyCtx);
  registerCardTypeTools(tempServer, dummyCtx);

  registry.setCurrentDomain('sessions');
  registerTaskTools(tempServer, dummyCtx);
  registerMessageTools(tempServer, dummyCtx);

  registry.setCurrentDomain('users');
  registerUserTools(tempServer, dummyCtx);

  registry.setCurrentDomain('analytics');
  registerAnalyticsTools(tempServer, dummyCtx);

  registry.setCurrentDomain('mcp-servers');
  registerMcpServerTools(tempServer, dummyCtx);

  // Search/execute tools registered separately on the real server
  // but we capture their metadata here too
  registry.setCurrentDomain('discovery');
  registerSearchTools(tempServer, registry);

  return registry;
}

/**
 * Get or build the cached registry and tools/list response.
 */
function getRegistry(): {
  registry: ToolRegistry;
  toolsList: { tools: Array<Record<string, unknown>> };
} {
  if (!cachedRegistry) {
    cachedRegistry = buildRegistry();
    // Pre-compute the tools/list response — frozen, deterministic
    cachedToolsList = {
      tools: cachedRegistry.getAlwaysVisible().map((entry) => ({
        name: entry.name,
        description: entry.description,
        inputSchema: entry.inputSchema,
        annotations: entry.annotations,
      })),
    };
  }
  return { registry: cachedRegistry, toolsList: cachedToolsList! };
}

/**
 * Create an McpServer with all tools registered for the given context.
 *
 * Tool handlers close over `ctx` for per-request user/session scope.
 * The registry and tools/list response are shared across all requests.
 */
function createMcpServer(ctx: McpContext, toolSearchEnabled: boolean): McpServer {
  const server = new McpServer(
    {
      name: 'agor',
      version: '0.14.3',
      ...(toolSearchEnabled && {
        description: 'Multiplayer canvas for orchestrating AI coding agents',
      }),
    },
    {
      capabilities: { tools: { listChanged: true }, logging: {} },
      ...(toolSearchEnabled && { instructions: SERVER_INSTRUCTIONS }),
    }
  );

  // Register all domain tools — handlers close over ctx for this request
  registerSessionTools(server, ctx);
  registerRepoTools(server, ctx);
  registerWorktreeTools(server, ctx);
  registerEnvironmentTools(server, ctx);
  registerBoardTools(server, ctx);
  registerCardTools(server, ctx);
  registerCardTypeTools(server, ctx);
  registerTaskTools(server, ctx);
  registerMessageTools(server, ctx);
  registerUserTools(server, ctx);
  registerAnalyticsTools(server, ctx);
  registerMcpServerTools(server, ctx);

  if (toolSearchEnabled) {
    const { registry, toolsList } = getRegistry();

    // Register search/execute tools with the shared cached registry
    registerSearchTools(server, registry);

    // Override tools/list with the pre-computed, deterministic response.
    // All tools remain registered and callable via tools/call.
    server.server.setRequestHandler(ListToolsRequestSchema, async () => toolsList);
  }

  return server;
}

/**
 * Setup MCP routes on FeathersJS app using the official SDK.
 *
 * @param toolSearchEnabled - When true, tools/list returns only essential tools
 *   and agents discover others via agor_search_tools. Default: true.
 */
export function setupMCPRoutes(app: Application, db: Database, toolSearchEnabled = true): void {
  // Eagerly build the registry at startup so first request isn't slower
  if (toolSearchEnabled) {
    getRegistry();
    console.log(`✅ MCP tool registry built (${cachedRegistry!.size} tools cached)`);
  }

  const handler = async (req: Request, res: Response) => {
    try {
      console.log(`🔌 Incoming MCP request: ${req.method} /mcp`);

      // Extract session token from query params or Authorization header
      let sessionToken = req.query.sessionToken as string | undefined;
      if (!sessionToken) {
        const authHeader = req.headers.authorization;
        if (authHeader?.startsWith('Bearer ')) {
          sessionToken = authHeader.slice(7);
        }
      }

      if (!sessionToken) {
        console.warn('⚠️  MCP request missing sessionToken');
        return res.status(401).json({
          jsonrpc: '2.0',
          id: (req.body as { id?: unknown })?.id,
          error: {
            code: -32001,
            message:
              'Authentication required: session token must be provided in query params or Authorization header',
          },
        });
      }

      // Validate token and extract context
      const context = await validateSessionToken(app, sessionToken);
      if (!context) {
        console.warn('⚠️  Invalid MCP session token');
        return res.status(401).json({
          jsonrpc: '2.0',
          id: (req.body as { id?: unknown })?.id,
          error: {
            code: -32001,
            message: 'Invalid or expired session token',
          },
        });
      }

      console.log(
        `🔌 MCP request authenticated (user: ${context.userId.substring(0, 8)}, session: ${context.sessionId.substring(0, 8)})`
      );

      // Fetch the authenticated user
      let authenticatedUser: AuthenticatedUser;
      try {
        authenticatedUser = await app.service('users').get(context.userId);
      } catch (error) {
        if (error instanceof NotFoundError) {
          return res.status(401).json({
            jsonrpc: '2.0',
            id: (req.body as { id?: unknown })?.id,
            error: {
              code: -32001,
              message: 'Invalid or expired session token',
            },
          });
        }
        throw error;
      }

      const baseServiceParams: Pick<AuthenticatedParams, 'user' | 'authenticated' | 'provider'> = {
        user: {
          user_id: authenticatedUser.user_id,
          email: authenticatedUser.email,
          role: authenticatedUser.role,
        },
        authenticated: true,
        provider: 'mcp',
      };

      // Create a per-request McpServer with all tools registered
      const mcpServer = createMcpServer(
        {
          app,
          db,
          userId: context.userId,
          sessionId: context.sessionId,
          authenticatedUser,
          baseServiceParams,
        },
        toolSearchEnabled
      );

      // Create stateless transport (one per request, no session tracking)
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });

      // Connect and handle the request
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, req.body);

      // Clean up after response is done
      res.on('close', () => {
        transport.close().catch(() => {});
        mcpServer.close().catch(() => {});
      });
    } catch (error) {
      console.error('❌ MCP request failed:', error);
      if (!res.headersSent) {
        return res.status(500).json({
          error: 'Internal error',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  // Register as Express POST route
  // @ts-expect-error - FeathersJS app extends Express
  app.post('/mcp', handler);

  console.log('✅ MCP routes registered at POST /mcp');
}
