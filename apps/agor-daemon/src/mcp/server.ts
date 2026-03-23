/**
 * MCP Server — Official SDK integration
 *
 * Creates an McpServer using @modelcontextprotocol/sdk and mounts it
 * at POST /mcp with JWT session-token auth.
 *
 * When tool search is enabled (mcpToolSearch config flag), only essential
 * tools appear in tools/list. Agents discover others via agor_search_tools.
 * All tools remain registered and callable regardless.
 */

import type { Database } from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { SessionID, UserID } from '@agor/core/types';
import { NotFoundError } from '@agor/core/utils/errors';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Request, Response } from 'express';
import type { AuthenticatedParams, AuthenticatedUser } from '../declarations.js';
import { validateSessionToken } from './tokens.js';
import { type ToolEntry, ToolRegistry } from './tool-registry.js';
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
  baseServiceParams: Pick<AuthenticatedParams, 'user' | 'authenticated'>;
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

/**
 * Create an McpServer with all tools registered for the given context.
 *
 * When toolSearchEnabled is true, intercepts tool registrations to build
 * a searchable registry, then overrides tools/list to return only essential
 * tools. All tools remain callable via tools/call.
 */
function createMcpServer(ctx: McpContext, toolSearchEnabled: boolean): McpServer {
  const server = new McpServer(
    { name: 'agor', version: '0.14.3' },
    { capabilities: { tools: { listChanged: true }, logging: {} } }
  );

  const registry = new ToolRegistry();

  // When tool search is enabled, intercept registerTool to capture metadata
  if (toolSearchEnabled) {
    const originalRegisterTool = server.registerTool.bind(server) as (
      ...args: unknown[]
    ) => ReturnType<typeof server.registerTool>;
    // biome-ignore lint/suspicious/noExplicitAny: intercepting overloaded method
    (server as any).registerTool = (name: string, config: Record<string, unknown>, cb: unknown) => {
      // Capture metadata in registry
      registry.register({
        name,
        description: (config.description as string) ?? '',
        inputSchema: config.inputSchema
          ? JSON.parse(JSON.stringify(config.inputSchema))
          : { type: 'object' },
        annotations: config.annotations as ToolEntry['annotations'],
      });
      // Call original
      return originalRegisterTool(name, config, cb);
    };
  }

  // Register all domain tools
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

  // Register the search tool (always, but only useful when filtering is on)
  if (toolSearchEnabled) {
    registerSearchTools(server, registry);

    // Override tools/list to return only essential tools.
    // All tools remain registered and callable via tools/call.
    server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: registry.getAlwaysVisible().map((entry) => ({
        name: entry.name,
        description: entry.description,
        inputSchema: entry.inputSchema,
        annotations: entry.annotations,
      })),
    }));
  }

  return server;
}

/**
 * Setup MCP routes on FeathersJS app using the official SDK.
 *
 * @param toolSearchEnabled - When true, tools/list returns only essential tools
 *   and agents discover others via agor_search_tools. Default: false.
 */
export function setupMCPRoutes(app: Application, db: Database, toolSearchEnabled = false): void {
  const handler = async (req: Request, res: Response) => {
    try {
      console.log(`🔌 Incoming MCP request: ${req.method} /mcp`);

      // Extract session token from query params
      const sessionToken = req.query.sessionToken as string | undefined;

      if (!sessionToken) {
        console.warn('⚠️  MCP request missing sessionToken');
        return res.status(401).json({
          jsonrpc: '2.0',
          id: (req.body as { id?: unknown })?.id,
          error: {
            code: -32001,
            message: 'Authentication required: session token must be provided in query params',
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

      const baseServiceParams: Pick<AuthenticatedParams, 'user' | 'authenticated'> = {
        user: {
          user_id: authenticatedUser.user_id,
          email: authenticatedUser.email,
          role: authenticatedUser.role,
        },
        authenticated: true,
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
