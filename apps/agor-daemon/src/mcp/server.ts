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

import { randomUUID } from 'node:crypto';
import type { Database } from '@agor/core/db';
import { shortId, UserApiKeysRepository } from '@agor/core/db';
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
import { wrapRegisterTool } from './register-tool-proxy.js';
import { validateSessionToken } from './tokens.js';
import { formatDomainDescriptionsForInstructions, ToolRegistry } from './tool-registry.js';
import { registerAnalyticsTools } from './tools/analytics.js';
import { registerArtifactTools } from './tools/artifacts.js';
import { registerBoardTools } from './tools/boards.js';
import { registerBranchTools } from './tools/branches.js';
import { registerCardTypeTools } from './tools/card-types.js';
import { registerCardTools } from './tools/cards.js';
import { registerEnvironmentTools } from './tools/environment.js';
import { registerKnowledgeTools } from './tools/knowledge.js';
import { registerMcpServerTools } from './tools/mcp-servers.js';
import { registerMessageTools } from './tools/messages.js';
import { registerProxyTools } from './tools/proxies.js';
import { registerRepoTools } from './tools/repos.js';
import { registerScheduleTools } from './tools/schedules.js';
import { registerSearchTools } from './tools/search.js';
import { registerSessionTools } from './tools/sessions.js';
import { registerTaskTools } from './tools/tasks.js';
import { registerUserTools } from './tools/users.js';
import { registerWidgetTools } from './tools/widgets.js';

/**
 * Shared context passed to every tool handler.
 */
export interface McpContext {
  app: Application;
  db: Database;
  userId: UserID;
  /** Current Agor session context, when the caller supplied or authenticated with one. */
  sessionId?: SessionID;
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

export const SESSION_CONTEXT_REQUIRED_MESSAGE =
  'This MCP tool requires current Agor session context. Reconnect or call /mcp with X-Agor-Session-Id: <session-id> (or ?sessionId=<session-id>) when using a personal API key.';

export function sessionContextRequiredResult() {
  return {
    ...textResult({
      error: SESSION_CONTEXT_REQUIRED_MESSAGE,
      how_to_fix:
        'Set the X-Agor-Session-Id header or ?sessionId= query parameter to an accessible session ID, or use a session-scoped MCP token.',
    }),
    isError: true,
  };
}

/** Server instructions shown to agents when tool search is enabled. */
const SERVER_INSTRUCTIONS = `Agor is a multiplayer canvas for orchestrating AI coding agents. It manages branches (isolated workspaces backed by git branches), tracks AI conversations, visualizes work on spatial boards, and enables real-time collaboration.

This server uses progressive tool discovery. Only 3 tools are listed directly — use them to discover and call all available tools:

- agor_search_tools: Browse domains and search concise tool summaries. Call with no args for a domain overview.
- agor_get_tool_details: Get the exact input schema for one selected tool.
- agor_execute_tool: Call one discovered tool by name with arguments matching its schema.

Domains:
${formatDomainDescriptionsForInstructions()}

Common workflows:

Create a branch and start a session:
1. agor_repos_list → get repoId
2. agor_boards_list → get boardId
3. agor_branches_create(repoId, boardId, branchName) → get branchId
4. agor_sessions_create(branchId, agenticTool, initialPrompt)

Delegate a subtask to a child agent:
1. agor_sessions_spawn(prompt) — inherits current branch, tracks parent-child genealogy

Continue or fork an existing session:
1. agor_sessions_prompt(sessionId, prompt, mode:"continue"|"fork"|"subsession")

Discover tools: search domains/summaries → get details for one tool → execute`;

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

type DomainToolRegistrar = {
  domain: string;
  register: (server: McpServer, ctx: McpContext) => void;
};

const DOMAIN_TOOL_REGISTRARS: DomainToolRegistrar[] = [
  {
    domain: 'sessions',
    register: (server, ctx) => {
      registerSessionTools(server, ctx);
      registerTaskTools(server, ctx);
      registerMessageTools(server, ctx);
    },
  },
  { domain: 'widgets', register: registerWidgetTools },
  { domain: 'repos', register: registerRepoTools },
  { domain: 'branches', register: registerBranchTools },
  { domain: 'environment', register: registerEnvironmentTools },
  { domain: 'boards', register: registerBoardTools },
  {
    domain: 'cards',
    register: (server, ctx) => {
      registerCardTools(server, ctx);
      registerCardTypeTools(server, ctx);
    },
  },
  { domain: 'artifacts', register: registerArtifactTools },
  { domain: 'proxies', register: registerProxyTools },
  { domain: 'users', register: registerUserTools },
  { domain: 'analytics', register: registerAnalyticsTools },
  { domain: 'mcp-servers', register: registerMcpServerTools },
  { domain: 'knowledge', register: registerKnowledgeTools },
  { domain: 'schedules', register: registerScheduleTools },
];

function registerDomainTools(
  server: McpServer,
  ctx: McpContext,
  servicesConfig?: DaemonServicesConfig,
  beforeRegister?: (domain: string) => void
): void {
  for (const { domain, register } of DOMAIN_TOOL_REGISTRARS) {
    const access = getDomainAccess(domain, servicesConfig);
    if (!access) continue;
    beforeRegister?.(domain);
    register(access === 'readonly' ? readOnlyProxy(server) : server, ctx);
  }
}

/**
 * Build the tool registry by registering tools against a temporary server.
 * Captures metadata (name, description, JSON Schema, annotations, domain)
 * without creating real handlers. Called once, cached forever.
 */
export function buildRegistry(servicesConfig?: DaemonServicesConfig): ToolRegistry {
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
  // The registry uses the same service-tier filtering as runtime registration,
  // including read-only proxying, so search/details never advertise tools that
  // agor_execute_tool cannot actually call in this server configuration.
  const dummyCtx = {} as McpContext;
  registerDomainTools(tempServer, dummyCtx, servicesConfig, (domain) =>
    registry.setCurrentDomain(domain)
  );

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

/**
 * Create a proxy McpServer that silently skips tools without
 * `readOnlyHint: true`. Backs the read-only service tier where mutating
 * tools should not even appear in `tools/list`.
 */
function readOnlyProxy(server: McpServer): McpServer {
  return wrapRegisterTool(server, (register, name, config, handler) => {
    const annotations = config.annotations as { readOnlyHint?: boolean } | undefined;
    if (annotations?.readOnlyHint === true) {
      return register(name, config, handler);
    }
    // Mutating tools: silently skipped in read-only mode.
  });
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
  registerDomainTools(server, ctx, servicesConfig);

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

  const personalApiKeys = new UserApiKeysRepository(db);

  type StatefulTransportEntry = {
    transport: StreamableHTTPServerTransport;
    server: McpServer;
    /** Mutable context object captured by registered tool handlers. */
    context: McpContext;
    userId: UserID;
    /** Immutable Agor session binding established at MCP initialize time, if any. */
    sessionId?: SessionID;
    lastUsedAt: number;
    ttlTimer: NodeJS.Timeout;
  };

  // Streamable HTTP sessions are intentionally in-memory and modestly bounded:
  // external orchestrators can hold an SSE session, but abandoned clients must
  // not grow this map forever if they never send DELETE /mcp.
  const STATEFUL_TRANSPORT_TTL_MS = 30 * 60 * 1000;
  const STATEFUL_TRANSPORT_MAX = 100;
  const statefulTransports = new Map<string, StatefulTransportEntry>();

  const closeStatefulTransport = (mcpSessionId: string): void => {
    const entry = statefulTransports.get(mcpSessionId);
    if (!entry) return;
    statefulTransports.delete(mcpSessionId);
    clearTimeout(entry.ttlTimer);
    // McpServer owns the connected transport; closing the server closes the
    // transport. Calling both can recurse through transport.onclose.
    entry.server.close().catch(() => {});
  };

  const armStatefulTransportTtl = (mcpSessionId: string, entry: StatefulTransportEntry): void => {
    clearTimeout(entry.ttlTimer);
    entry.lastUsedAt = Date.now();
    entry.ttlTimer = setTimeout(() => {
      console.warn(`⚠️  MCP streamable HTTP session expired: ${mcpSessionId}`);
      closeStatefulTransport(mcpSessionId);
    }, STATEFUL_TRANSPORT_TTL_MS);
    entry.ttlTimer.unref?.();
  };

  const evictOldestStatefulTransportIfNeeded = (): void => {
    if (statefulTransports.size < STATEFUL_TRANSPORT_MAX) return;
    let oldestId: string | undefined;
    let oldestLastUsed = Number.POSITIVE_INFINITY;
    for (const [id, entry] of statefulTransports) {
      if (entry.lastUsedAt < oldestLastUsed) {
        oldestLastUsed = entry.lastUsedAt;
        oldestId = id;
      }
    }
    if (oldestId) {
      console.warn(`⚠️  MCP streamable HTTP session limit reached; evicting ${oldestId}`);
      closeStatefulTransport(oldestId);
    }
  };

  const isInitializeRequest = (body: unknown): boolean => {
    if (!body || typeof body !== 'object') return false;
    const maybeRequest = body as { method?: unknown };
    return maybeRequest.method === 'initialize';
  };

  const getBodyId = (req: Request): unknown => (req.body as { id?: unknown } | undefined)?.id;

  const jsonRpcError = (req: Request, code: number, message: string) => ({
    jsonrpc: '2.0',
    id: getBodyId(req),
    error: { code, message },
  });

  const getCredential = (req: Request): string | undefined => {
    const authHeader = req.headers.authorization;
    if (authHeader) {
      const [scheme, ...rest] = authHeader.split(' ');
      const token = rest.join(' ').trim();
      if (scheme?.toLowerCase() === 'bearer' && token) return token;
    }

    const xApiKey = req.headers['x-api-key'];
    return coerceString(Array.isArray(xApiKey) ? xApiKey[0] : xApiKey);
  };

  const getRequestedSessionId = (req: Request): string | undefined => {
    const fromQuery = coerceString(req.query.sessionId);
    if (fromQuery) return fromQuery;

    const fromHeader = req.headers['x-agor-session-id'];
    return coerceString(Array.isArray(fromHeader) ? fromHeader[0] : fromHeader);
  };

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
          ...jsonRpcError(
            req,
            -32600,
            'Session token in query string is no longer accepted. Send it as an Authorization: Bearer <token> header instead.'
          ),
        });
      }

      const credential = getCredential(req);
      if (!credential) {
        console.warn('⚠️  MCP request missing credentials');
        return res.status(401).json({
          ...jsonRpcError(
            req,
            -32001,
            'Authentication required: provide a session MCP token or personal API key via Authorization: Bearer <token> (or X-API-Key for personal API keys).'
          ),
        });
      }

      let authenticatedUser: AuthenticatedUser;
      let userId: UserID;
      let sessionId: SessionID | undefined;
      const isPersonalApiKey = credential.startsWith('agor_sk_');

      if (isPersonalApiKey) {
        const keyRow = await personalApiKeys.verifyKey(credential);
        if (!keyRow) {
          console.warn('⚠️  Invalid MCP personal API key');
          return res.status(401).json({
            ...jsonRpcError(req, -32001, 'Invalid personal API key'),
          });
        }

        personalApiKeys.updateLastUsed(keyRow.id).catch((err: unknown) => {
          console.warn('Failed to update MCP personal API key last_used_at:', err);
        });

        userId = keyRow.user_id as UserID;
        try {
          authenticatedUser = await app.service('users').get(userId);
        } catch (error) {
          if (error instanceof NotFoundError) {
            return res.status(401).json({
              ...jsonRpcError(req, -32001, 'Invalid personal API key'),
            });
          }
          throw error;
        }
        sessionId = getRequestedSessionId(req) as SessionID | undefined;
      } else {
        const context = await validateSessionToken(app, credential);
        if (!context) {
          console.warn('⚠️  Invalid MCP session token');
          return res.status(401).json({
            ...jsonRpcError(req, -32001, 'Invalid or expired session token'),
          });
        }

        userId = context.userId;
        sessionId = context.sessionId;

        try {
          authenticatedUser = await app.service('users').get(userId);
        } catch (error) {
          if (error instanceof NotFoundError) {
            return res.status(401).json({
              ...jsonRpcError(req, -32001, 'Invalid or expired session token'),
            });
          }
          throw error;
        }
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

      // Personal API key callers may optionally bind a current-session context
      // using a header/query param. Validate through the normal sessions
      // service so branch RBAC and short-ID resolution stay identical to REST.
      if (isPersonalApiKey && sessionId) {
        try {
          const session = await app.service('sessions').get(sessionId, baseServiceParams);
          sessionId = session.session_id;
        } catch {
          return res.status(403).json({
            ...jsonRpcError(
              req,
              -32003,
              'Forbidden: X-Agor-Session-Id / ?sessionId is invalid or not accessible to this API key user.'
            ),
          });
        }
      }

      console.log(
        `🔌 MCP request authenticated (user: ${shortId(userId)}, session: ${sessionId ? shortId(sessionId) : 'none'})`
      );

      const mcpContext: McpContext = {
        app,
        db,
        userId,
        sessionId,
        authenticatedUser,
        baseServiceParams,
      };

      const mcpSessionHeader = req.headers['mcp-session-id'];
      const mcpSessionId = coerceString(
        Array.isArray(mcpSessionHeader) ? mcpSessionHeader[0] : mcpSessionHeader
      );

      if (req.method === 'GET' || req.method === 'DELETE' || mcpSessionId) {
        if (!mcpSessionId) {
          return res.status(400).json({
            ...jsonRpcError(req, -32000, 'Bad Request: Mcp-Session-Id header is required'),
          });
        }
        const entry = statefulTransports.get(mcpSessionId);
        if (!entry) {
          return res.status(404).json({
            ...jsonRpcError(req, -32001, 'Session not found for Mcp-Session-Id'),
          });
        }
        if (entry.userId !== userId) {
          return res.status(403).json({
            ...jsonRpcError(req, -32003, 'Forbidden: MCP session belongs to a different user'),
          });
        }

        // A stateful MCP transport's Agor session binding is immutable. Tool
        // handlers close over `entry.context`, so allowing callers to add or
        // change X-Agor-Session-Id on later requests would be confusing at
        // best and a stale-context authorization footgun at worst.
        if (!entry.sessionId && sessionId) {
          return res.status(403).json({
            ...jsonRpcError(
              req,
              -32003,
              'Forbidden: MCP session was initialized without X-Agor-Session-Id / ?sessionId context; start a new MCP session with session context instead.'
            ),
          });
        }
        if (entry.sessionId && sessionId && entry.sessionId !== sessionId) {
          return res.status(403).json({
            ...jsonRpcError(
              req,
              -32003,
              'Forbidden: MCP session is already bound to a different X-Agor-Session-Id / ?sessionId context'
            ),
          });
        }

        armStatefulTransportTtl(mcpSessionId, entry);

        // Rebuild the mutable context captured by registered handlers on each
        // stateful request. Credentials have just been re-authenticated and
        // the user was reloaded, so this keeps role/user data fresh for
        // long-lived streamable HTTP sessions. If the immutable Agor session
        // binding is no longer accessible to this user, evict the MCP session.
        if (entry.sessionId) {
          try {
            const session = await app.service('sessions').get(entry.sessionId, baseServiceParams);
            entry.sessionId = session.session_id;
          } catch {
            closeStatefulTransport(mcpSessionId);
            return res.status(403).json({
              ...jsonRpcError(
                req,
                -32003,
                'Forbidden: the X-Agor-Session-Id / ?sessionId context bound to this MCP session is no longer accessible.'
              ),
            });
          }
        }
        entry.context.userId = userId;
        entry.context.sessionId = entry.sessionId;
        entry.context.authenticatedUser = authenticatedUser;
        entry.context.baseServiceParams = baseServiceParams;

        await entry.transport.handleRequest(req, res, req.body);
        return;
      }

      if (req.method === 'POST' && isInitializeRequest(req.body)) {
        evictOldestStatefulTransportIfNeeded();

        const mcpServer = createMcpServer(mcpContext, toolSearchEnabled, servicesConfig);
        let transport: StreamableHTTPServerTransport;
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            const ttlTimer = setTimeout(
              () => closeStatefulTransport(newSessionId),
              STATEFUL_TRANSPORT_TTL_MS
            );
            ttlTimer.unref?.();
            const entry: StatefulTransportEntry = {
              transport,
              server: mcpServer,
              context: mcpContext,
              userId,
              sessionId,
              lastUsedAt: Date.now(),
              ttlTimer,
            };
            statefulTransports.set(newSessionId, entry);
          },
          onsessionclosed: (closedSessionId) => {
            if (closedSessionId) closeStatefulTransport(closedSessionId);
          },
        });

        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid) {
            const entry = statefulTransports.get(sid);
            statefulTransports.delete(sid);
            if (entry) clearTimeout(entry.ttlTimer);
          }
        };

        await mcpServer.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      }

      if (req.method !== 'POST') {
        return res.status(405).json({
          ...jsonRpcError(req, -32005, `Method ${req.method} not allowed on /mcp`),
        });
      }

      const mcpServer = createMcpServer(mcpContext, toolSearchEnabled, servicesConfig);

      // Create stateless transport (one per request, no session tracking)
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });

      // Connect and handle the request
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, req.body);

      // Clean up after response is done
      res.on('close', () => {
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
  // @ts-expect-error - FeathersJS app extends Express
  app.get('/mcp', handler);
  // @ts-expect-error - FeathersJS app extends Express
  app.delete('/mcp', handler);

  console.log('✅ MCP routes registered at /mcp (POST + GET + DELETE)');
}
