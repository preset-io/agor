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
import type { DaemonServicesConfig, ServiceGroupName, SessionID, UserID } from '@agor/core/types';
import { getServiceTier, SERVICE_GROUP_TO_MCP_DOMAINS, SERVICE_TIER_RANK } from '@agor/core/types';
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
import { registerArtifactTools } from './tools/artifacts.js';
import { registerBoardTools } from './tools/boards.js';
import { registerCardTypeTools } from './tools/card-types.js';
import { registerCardTools } from './tools/cards.js';
import { registerEnvironmentTools } from './tools/environment.js';
import { registerMcpServerTools } from './tools/mcp-servers.js';
import { registerMessageTools } from './tools/messages.js';
import { registerProxyTools } from './tools/proxies.js';
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
 * Helper: coerce a possibly-stringified JSON value to a Record, or return as-is.
 *
 * Some MCP clients double-serialize nested objects as JSON strings (especially
 * with large or complex content). This helper transparently parses those back.
 * Returns the original value unchanged if it's not a string or not valid JSON.
 */
export function coerceJsonRecord(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
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
- worktrees: Git worktrees with isolated branches, board placement, zone pinning, and assistant discovery
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
 * One-time-per-caller deprecation warning for clients that still send the
 * MCP session token in the query string. Keyed by remote IP so noisy callers
 * don't drown out other logs. The token value is never logged.
 */
const deprecationWarningsEmitted = new Set<string>();

function logQueryParamDeprecation(req: Request): void {
  const ip = (req.ip || req.socket.remoteAddress || 'unknown').toString();
  if (deprecationWarningsEmitted.has(ip)) return;
  deprecationWarningsEmitted.add(ip);
  // Cap the set so a rotating IP attacker can't grow memory unbounded.
  if (deprecationWarningsEmitted.size > 1024) {
    const oldest = deprecationWarningsEmitted.values().next().value;
    if (oldest) deprecationWarningsEmitted.delete(oldest);
  }
  console.warn(
    `⚠️  MCP request from ${ip} used deprecated ?sessionToken= query param — rejecting. Migrate callers to Authorization: Bearer header.`
  );
}

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
function buildRegistry(servicesConfig?: DaemonServicesConfig): ToolRegistry {
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
  // Only register tools for enabled service domains.
  const dummyCtx = {} as McpContext;

  if (isDomainEnabled('sessions', servicesConfig)) {
    registry.setCurrentDomain('sessions');
    registerSessionTools(tempServer, dummyCtx);
    registerTaskTools(tempServer, dummyCtx);
    registerMessageTools(tempServer, dummyCtx);
  }

  if (isDomainEnabled('repos', servicesConfig)) {
    registry.setCurrentDomain('repos');
    registerRepoTools(tempServer, dummyCtx);
  }

  if (isDomainEnabled('worktrees', servicesConfig)) {
    registry.setCurrentDomain('worktrees');
    registerWorktreeTools(tempServer, dummyCtx);
    registry.setCurrentDomain('environment');
    registerEnvironmentTools(tempServer, dummyCtx);
  }

  if (isDomainEnabled('boards', servicesConfig)) {
    registry.setCurrentDomain('boards');
    registerBoardTools(tempServer, dummyCtx);
  }

  if (isDomainEnabled('cards', servicesConfig)) {
    registry.setCurrentDomain('cards');
    registerCardTools(tempServer, dummyCtx);
    registerCardTypeTools(tempServer, dummyCtx);
  }

  if (isDomainEnabled('artifacts', servicesConfig)) {
    registry.setCurrentDomain('artifacts');
    registerArtifactTools(tempServer, dummyCtx);
  }

  // 'proxies' is always registered when 'artifacts' domain is on — the two
  // are tightly coupled (proxies exist to serve artifacts). Read-only by
  // construction, so registering them here is safe regardless of tier.
  if (isDomainEnabled('artifacts', servicesConfig)) {
    registry.setCurrentDomain('proxies');
    registerProxyTools(tempServer, dummyCtx);
  }

  if (isDomainEnabled('users', servicesConfig)) {
    registry.setCurrentDomain('users');
    registerUserTools(tempServer, dummyCtx);
  }

  if (isDomainEnabled('analytics', servicesConfig)) {
    registry.setCurrentDomain('analytics');
    registerAnalyticsTools(tempServer, dummyCtx);
  }

  if (isDomainEnabled('mcp-servers', servicesConfig)) {
    registry.setCurrentDomain('mcp-servers');
    registerMcpServerTools(tempServer, dummyCtx);
  }

  // Search/execute tools always registered (meta-tools)
  registry.setCurrentDomain('discovery');
  registerSearchTools(tempServer, registry);

  return registry;
}

/**
 * Get or build the cached registry and tools/list response.
 */
function getRegistry(servicesConfig?: DaemonServicesConfig): {
  registry: ToolRegistry;
  toolsList: { tools: Array<Record<string, unknown>> };
} {
  if (!cachedRegistry) {
    cachedRegistry = buildRegistry(servicesConfig);
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
/**
 * Check if a MCP domain should have tools registered based on service config.
 * Returns false for 'off' or 'internal' tiers, 'readonly' or 'full' otherwise.
 */
function getDomainAccess(
  domain: string,
  servicesConfig?: DaemonServicesConfig
): false | 'readonly' | 'full' {
  if (!servicesConfig) return 'full'; // default: all enabled

  // Find which service group owns this domain
  for (const [group, domains] of Object.entries(SERVICE_GROUP_TO_MCP_DOMAINS)) {
    if (domains?.includes(domain)) {
      const tier = getServiceTier(servicesConfig, group as ServiceGroupName);
      if (SERVICE_TIER_RANK[tier] < SERVICE_TIER_RANK.readonly) return false;
      return tier === 'on' ? 'full' : 'readonly';
    }
  }
  return 'full'; // unknown domain = full access
}

/** Backwards-compatible wrapper */
function isDomainEnabled(domain: string, servicesConfig?: DaemonServicesConfig): boolean {
  return getDomainAccess(domain, servicesConfig) !== false;
}

/**
 * Create a proxy McpServer that silently skips tools without
 * readOnlyHint: true. Uses Object.create so the original server is unmodified.
 */
function readOnlyProxy(server: McpServer): McpServer {
  const proxy = Object.create(server) as McpServer;
  const original = server.registerTool.bind(server);
  // Cast required: registerTool is an overloaded generic — TS can't represent the replacement.
  (proxy as unknown as Record<string, unknown>).registerTool = (
    name: string,
    config: Record<string, unknown>,
    cb: unknown
  ) => {
    const annotations = config.annotations as { readOnlyHint?: boolean } | undefined;
    if (annotations?.readOnlyHint === true) {
      return (original as (...args: unknown[]) => unknown)(name, config, cb);
    }
    // Skip mutating tools silently
  };
  return proxy;
}

function createMcpServer(
  ctx: McpContext,
  toolSearchEnabled: boolean,
  servicesConfig?: DaemonServicesConfig
): McpServer {
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

  // Register domain tools conditionally based on service tier.
  // 'off' / 'internal': no MCP tools
  // 'readonly': only tools with readOnlyHint: true
  // 'on': all tools
  const domainRegister = (domain: string, fn: (s: McpServer, c: McpContext) => void) => {
    const access = getDomainAccess(domain, servicesConfig);
    if (!access) return;
    fn(access === 'readonly' ? readOnlyProxy(server) : server, ctx);
  };

  domainRegister('sessions', (s, c) => {
    registerSessionTools(s, c);
    registerTaskTools(s, c);
    registerMessageTools(s, c);
  });
  domainRegister('repos', registerRepoTools);
  domainRegister('worktrees', (s, c) => {
    registerWorktreeTools(s, c);
    registerEnvironmentTools(s, c);
  });
  domainRegister('boards', registerBoardTools);
  domainRegister('cards', (s, c) => {
    registerCardTools(s, c);
    registerCardTypeTools(s, c);
  });
  domainRegister('artifacts', (s, c) => {
    registerArtifactTools(s, c);
    registerProxyTools(s, c);
  });
  domainRegister('users', registerUserTools);
  domainRegister('analytics', registerAnalyticsTools);
  domainRegister('mcp-servers', registerMcpServerTools);

  if (toolSearchEnabled) {
    const { registry, toolsList } = getRegistry(servicesConfig);

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
export function setupMCPRoutes(
  app: Application,
  db: Database,
  toolSearchEnabled = true,
  servicesConfig?: DaemonServicesConfig
): void {
  // Eagerly build the registry at startup so first request isn't slower
  if (toolSearchEnabled) {
    getRegistry(servicesConfig);
    console.log(`✅ MCP tool registry built (${cachedRegistry!.size} tools cached)`);
  }

  const handler = async (req: Request, res: Response) => {
    try {
      console.log(`🔌 Incoming MCP request: ${req.method} /mcp`);

      // Reject session tokens in query strings — they leak via Referer, browser
      // history, reverse-proxy access logs, and any verbose request logger that
      // captures req.url. The canonical carrier for MCP streamable HTTP auth is
      // `Authorization: Bearer <token>`.
      //
      // We check for the presence of the query parameter (not its value) so we
      // don't echo or log the token itself.
      if ('sessionToken' in req.query) {
        logQueryParamDeprecation(req);
        return res.status(400).json({
          jsonrpc: '2.0',
          id: (req.body as { id?: unknown })?.id,
          error: {
            code: -32600,
            message:
              'Session token in query string is no longer accepted. Send it as an Authorization: Bearer <token> header instead.',
          },
        });
      }

      // Extract session token from Authorization header only
      let sessionToken: string | undefined;
      const authHeader = req.headers.authorization;
      if (authHeader?.startsWith('Bearer ')) {
        sessionToken = authHeader.slice(7);
      }

      if (!sessionToken) {
        console.warn('⚠️  MCP request missing Authorization header');
        return res.status(401).json({
          jsonrpc: '2.0',
          id: (req.body as { id?: unknown })?.id,
          error: {
            code: -32001,
            message:
              'Authentication required: session token must be provided via Authorization: Bearer header',
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

      // Create a per-request McpServer with tools registered per service tier
      const mcpServer = createMcpServer(
        {
          app,
          db,
          userId: context.userId,
          sessionId: context.sessionId,
          authenticatedUser,
          baseServiceParams,
        },
        toolSearchEnabled,
        servicesConfig
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
