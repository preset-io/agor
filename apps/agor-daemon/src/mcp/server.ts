/**
 * MCP Server — Official SDK integration
 *
 * Creates a lightweight McpServer adapter per request using the v2 MCP SDK
 * and mounts one authenticated endpoint that serves both the modern
 * 2026-07-28 protocol and the stateless initialization-era protocol family.
 *
 * When tool search is enabled (mcpToolSearch config flag), only essential
 * tools appear in tools/list. Agents discover others via agor_search_tools.
 * Hidden domain tools remain callable both directly by name for compatibility
 * and through the explicit execute facade.
 *
 * DETERMINISM: The tools/list response and registry are built once on first
 * request and cached as module-level singletons. This ensures byte-identical
 * JSON across requests, which is critical for client-side KV prefix caching.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { AgorConfig } from '@agor/core/config';
import {
  resolveMultiTenancyConfig,
  resolveTenantContext,
  TenantResolutionError,
} from '@agor/core/config';
import type { TenantScopeAwareDatabase } from '@agor/core/db';
import {
  runWithTenantContext,
  runWithTenantDatabaseScope,
  shortId,
  UserApiKeysRepository,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { Session, SessionID, TenantContext, UserID } from '@agor/core/types';
import { isNotFoundError } from '@agor/core/utils/errors';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, type ListToolsResult, McpServer } from '@modelcontextprotocol/server';
import type { Request, Response } from 'express';
import { toJSONSchema } from 'zod/v4-mini';
import type { AuthenticatedParams, AuthenticatedUser } from '../declarations.js';
import { ToolDispatcher, toolDispatcherProxy } from './register-tool-proxy.js';
import { tenantScopedToolProxy } from './tenant-scope.js';
import { validateVerifiedSessionToken, verifySessionToken } from './tokens.js';
import { formatDomainDescriptionsForInstructions, ToolRegistry } from './tool-registry.js';
import { registerAnalyticsTools } from './tools/analytics.js';
import { registerArtifactTools } from './tools/artifacts.js';
import { registerBoardTools } from './tools/boards.js';
import { registerBranchTools } from './tools/branches.js';
import { registerCardTypeTools } from './tools/card-types.js';
import { registerCardTools } from './tools/cards.js';
import { registerEnvironmentTools } from './tools/environment.js';
import { registerGatewayChannelTools } from './tools/gateway-channels.js';
import { registerKnowledgeTools } from './tools/knowledge.js';
import { registerMcpServerTools } from './tools/mcp-servers.js';
import { registerMessageTools } from './tools/messages.js';
import { registerRepoTools } from './tools/repos.js';
import { registerScheduleTools } from './tools/schedules.js';
import { registerSearchTools } from './tools/search.js';
import { registerSessionTools } from './tools/sessions.js';
import { registerTaskTools } from './tools/tasks.js';
import { registerUserTools } from './tools/users.js';
import { registerWidgetTools } from './tools/widgets.js';

const DEBUG_MCP_REQUESTS =
  process.env.AGOR_DEBUG_MCP_REQUESTS === '1' || process.env.DEBUG?.includes('mcp-requests');

function mcpRequestDebug(...args: unknown[]): void {
  if (DEBUG_MCP_REQUESTS) {
    console.debug(...args);
  }
}

function authenticatedUserTenantMatches(user: AuthenticatedUser, tenant: TenantContext): boolean {
  const tenantId = typeof user.tenant_id === 'string' ? user.tenant_id.trim() : '';
  return !tenantId || tenantId === tenant.tenant_id;
}

/**
 * Shared context passed to every tool handler.
 */
export interface McpContext {
  app: Application;
  db: TenantScopeAwareDatabase;
  userId: UserID;
  /** Current Agor session context, when the caller supplied or authenticated with one. */
  sessionId?: SessionID;
  /** Freshly authorized Session identity available to session-aware tool boundaries. */
  authenticatedSession?: Pick<Session, 'session_id' | 'agentic_tool' | 'branch_id'>;
  authenticatedUser: AuthenticatedUser;
  baseServiceParams: Pick<AuthenticatedParams, 'user' | 'authenticated' | 'provider' | 'tenant'>;
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
3. agor_branches_create(repoId, boardId, branchName, waitForReady:true) → continue only when _readiness.outcome is "ready"
4. After a timeout, agor_branches_wait_for_ready(branchId) → safely call again as needed
5. agor_sessions_create(branchId, agenticTool, initialPrompt)

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
let cachedToolsList: ListToolsResult | null = null;

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
  { domain: 'users', register: registerUserTools },
  { domain: 'analytics', register: registerAnalyticsTools },
  { domain: 'mcp-servers', register: registerMcpServerTools },
  { domain: 'gateway', register: registerGatewayChannelTools },
  { domain: 'knowledge', register: registerKnowledgeTools },
  { domain: 'schedules', register: registerScheduleTools },
];

function registerDomainTools(
  server: McpServer,
  ctx: McpContext,
  beforeRegister?: (domain: string) => void
): void {
  for (const { domain, register } of DOMAIN_TOOL_REGISTRARS) {
    beforeRegister?.(domain);
    register(server, ctx);
  }
}

/**
 * Build the tool registry by registering tools against a temporary server.
 * Captures metadata (name, description, JSON Schema, annotations, domain)
 * without creating real handlers. Called once, cached forever.
 */
export function buildRegistry(): ToolRegistry {
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
    let jsonSchema: import('@modelcontextprotocol/server').Tool['inputSchema'] = {
      type: 'object',
    };
    if (config.inputSchema) {
      try {
        jsonSchema = toJSONSchema(
          config.inputSchema as Parameters<typeof toJSONSchema>[0]
        ) as unknown as import('@modelcontextprotocol/server').Tool['inputSchema'];
      } catch {
        // Fallback: empty object schema if conversion fails
        jsonSchema = { type: 'object' };
      }
    }

    registry.register({
      name,
      description: (config.description as string) ?? '',
      inputSchema: jsonSchema,
      annotations: config.annotations as import('@modelcontextprotocol/server').ToolAnnotations,
    });

    // Still register with the temp server so Zod schemas are valid
    return originalRegisterTool(name, config, cb);
  };

  // Register all domain tools with domain tracking.
  // Handlers receive a dummy context — they won't be called.
  const dummyCtx = {} as McpContext;
  registerDomainTools(tempServer, dummyCtx, (domain) => registry.setCurrentDomain(domain));

  // Search/execute tools always registered (meta-tools)
  registry.setCurrentDomain('discovery');
  registerSearchTools(tempServer, registry);

  return registry;
}

/**
 * Get or build the cached registry and tools/list response.
 */
function getRegistry(): {
  registry: ToolRegistry;
  toolsList: ListToolsResult;
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
function createMcpServer(
  ctx: McpContext,
  toolSearchEnabled: boolean,
  serverVersion: string
): McpServer {
  const server = new McpServer(
    {
      name: 'agor',
      version: serverVersion,
      ...(toolSearchEnabled && {
        description: 'Multiplayer canvas for orchestrating AI coding agents',
      }),
    },
    {
      capabilities: { tools: { listChanged: false } },
      cacheHints: {
        'server/discover': { ttlMs: 60_000, cacheScope: 'private' },
        'tools/list': { ttlMs: 60_000, cacheScope: 'private' },
      },
      ...(toolSearchEnabled && { instructions: SERVER_INSTRUCTIONS }),
    }
  );

  // MCP custom methods bypass Feathers around hooks. Scope every tool at this
  // execution boundary so tenant-aware repositories and manual events share one
  // consistent ambient context.
  if (toolSearchEnabled) {
    const { registry, toolsList } = getRegistry();
    const dispatcher = new ToolDispatcher();

    // Capture domain operations for agor_execute_tool while also registering
    // them normally. Existing clients may call a known tool directly even
    // though progressive discovery intentionally omits it from tools/list.
    // Both paths retain the same authenticated tenant wrapper and SDK input /
    // output validation.
    registerDomainTools(tenantScopedToolProxy(toolDispatcherProxy(server, dispatcher), ctx), ctx);

    // Register search/detail/execute as the complete visible MCP catalog.
    registerSearchTools(server, registry, dispatcher);

    // Keep the advertised catalog to the three progressive-discovery facade
    // tools without removing direct tools/call compatibility. This uses the
    // SDK's public low-level handler seam; domain tools remain registered with
    // McpServer for native annotations, validation, and direct dispatch.
    server.server.setRequestHandler('tools/list', async () => toolsList);

    // Guard the invariant that the SDK-generated catalog is the same stable
    // three-tool surface captured in the shared registry.
    if (toolsList.tools.length !== 3) {
      throw new Error(`Expected 3 progressive-discovery MCP tools, got ${toolsList.tools.length}`);
    }
  } else {
    registerDomainTools(tenantScopedToolProxy(server, ctx), ctx);
  }

  // McpServer.registerTool() conservatively advertises listChanged=true.
  // Agor's registry is immutable after startup, so correct the generated
  // capability after every tool has been registered. Agor intentionally
  // advertises no logging capability because it sends no MCP logging events.
  server.server.registerCapabilities({ tools: { listChanged: false } });

  return server;
}

/**
 * Setup MCP routes on FeathersJS app using the official SDK.
 *
 * @param toolSearchEnabled - When true, tools/list returns only essential tools
 *   and agents discover others via agor_search_tools. Default: true.
 * @param options.serverVersion - User-facing Agor release version advertised
 *   during MCP initialization.
 */
export function setupMCPRoutes(
  app: Application,
  db: TenantScopeAwareDatabase,
  toolSearchEnabled = true,
  config: Pick<AgorConfig, 'multi_tenancy'> = { multi_tenancy: undefined },
  options: { serverVersion?: string } = {}
): void {
  const serverVersion = options.serverVersion ?? '0.0.0';
  // Eagerly build the registry at startup so first request isn't slower
  if (toolSearchEnabled) {
    getRegistry();
    console.log(`✅ MCP tool registry built (${cachedRegistry!.size} tools cached)`);
  }

  const personalApiKeys = new UserApiKeysRepository(db);
  const multiTenancy = resolveMultiTenancyConfig(config);
  const requestContext = new AsyncLocalStorage<McpContext>();

  const protocolHandler = createMcpHandler(
    ({ era }) => {
      const ctx = requestContext.getStore();
      if (!ctx) {
        throw new Error('Authenticated MCP request context is unavailable');
      }
      mcpRequestDebug(`🔌 Serving MCP ${era} protocol request`);
      return createMcpServer(ctx, toolSearchEnabled, serverVersion);
    },
    {
      // One endpoint serves the 2026-07-28 per-request protocol and every
      // initialization-era client through the SDK's stateless compatibility
      // path. Agor intentionally exposes no transport subscriptions or
      // mid-call messages. Modern calls therefore resolve to bounded JSON;
      // the SDK may use one request-scoped SSE response for legacy clients.
      legacy: 'stateless',
      responseMode: 'auto',
      maxSubscriptions: 0,
      onerror: (error) => mcpRequestDebug('❌ MCP protocol request failed:', error.message),
    }
  );
  const nodeProtocolHandler = toNodeHandler(protocolHandler, {
    onerror: (error) => console.error('❌ MCP Node adapter failed:', error.message),
  });

  const getBodyId = (req: Request): unknown => (req.body as { id?: unknown } | undefined)?.id;

  const jsonRpcError = (req: Request, code: number, message: string) => ({
    jsonrpc: '2.0',
    id: getBodyId(req),
    error: { code, message },
  });

  class MalformedHeaderError extends Error {}

  /**
   * Read a security-sensitive header without accepting Node's duplicate-header
   * coalescing. Credentials and context bindings must have exactly one on-wire
   * value so intermediaries cannot interpret the request differently.
   */
  const getSingleHeader = (req: Request, name: string): string | undefined => {
    const lowerName = name.toLowerCase();
    const distinct = (req as Request & { headersDistinct?: Record<string, string[] | undefined> })
      .headersDistinct;
    const values = distinct?.[lowerName];
    if (values && values.length !== 1) {
      throw new MalformedHeaderError(`${name} must be sent at most once`);
    }

    const normalized = values?.[0] ?? req.headers[lowerName];
    if (Array.isArray(normalized)) {
      if (normalized.length !== 1) {
        throw new MalformedHeaderError(`${name} must be sent at most once`);
      }
      const value = coerceString(normalized[0]);
      if (!value) throw new MalformedHeaderError(`${name} must be a non-empty string`);
      return value;
    }
    if (normalized !== undefined && typeof normalized !== 'string') {
      throw new MalformedHeaderError(`${name} must be a string`);
    }
    if (normalized === undefined) return undefined;
    const value = coerceString(normalized);
    if (!value) throw new MalformedHeaderError(`${name} must be a non-empty string`);
    return value;
  };

  const getCredential = (
    authorization: string | undefined,
    xApiKey: string | undefined
  ): string | undefined => {
    if (authorization && xApiKey) {
      throw new MalformedHeaderError(
        'Send exactly one credential: Authorization or X-API-Key, not both'
      );
    }

    if (authorization) {
      const [scheme, ...rest] = authorization.split(' ');
      const token = rest.join(' ').trim();
      if (scheme?.toLowerCase() === 'bearer' && token) return token;
      throw new MalformedHeaderError('Authorization must use Bearer <token>');
    }
    return xApiKey;
  };

  /**
   * Preserve duplicate on-wire header fields for tenant resolution. Node's
   * normalized `headers` map comma-coalesces most duplicate names;
   * `headersDistinct` lets the resolver compare every trusted tenant value.
   * Non-Node test adapters may not expose it, so retain the normalized map as
   * a fail-closed fallback (the resolver rejects comma/list values).
   */
  const getTenantResolutionHeaders = (req: Request): Record<string, unknown> => {
    const distinct = (req as Request & { headersDistinct?: Record<string, string[] | undefined> })
      .headersDistinct;
    return distinct ?? (req.headers as Record<string, unknown>);
  };

  const getRequestedSessionId = (
    req: Request,
    fromHeader: string | undefined
  ): string | undefined => {
    const rawQuery = req.query.sessionId;
    const fromQuery = coerceString(rawQuery);
    if (rawQuery !== undefined && !fromQuery) {
      throw new MalformedHeaderError('sessionId query parameter must be a single non-empty string');
    }
    if (fromHeader && fromQuery && fromHeader !== fromQuery) {
      throw new MalformedHeaderError(
        'X-Agor-Session-Id and sessionId query parameter must match when both are sent'
      );
    }
    return fromHeader ?? fromQuery;
  };

  const handler = async (req: Request, res: Response) => {
    try {
      mcpRequestDebug(`🔌 Incoming MCP request: ${req.method} /mcp`);

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

      let requestedSessionId: string | undefined;
      let credential: string | undefined;
      try {
        const authorization = getSingleHeader(req, 'Authorization');
        const xApiKey = getSingleHeader(req, 'X-API-Key');
        requestedSessionId = getRequestedSessionId(req, getSingleHeader(req, 'X-Agor-Session-Id'));
        const mcpSessionId = getSingleHeader(req, 'Mcp-Session-Id');
        if (mcpSessionId && !/^[\x21-\x7e]+$/.test(mcpSessionId)) {
          throw new MalformedHeaderError('Mcp-Session-Id must contain only visible ASCII');
        }
        credential = getCredential(authorization, xApiKey);
      } catch (error) {
        if (error instanceof MalformedHeaderError) {
          return res.status(400).json({
            ...jsonRpcError(req, -32600, `Bad Request: ${error.message}`),
          });
        }
        throw error;
      }

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
      let tenant: TenantContext;
      const isPersonalApiKey = credential.startsWith('agor_sk_');

      if (isPersonalApiKey) {
        try {
          // Opaque personal keys do not contain a signed tenant claim. Resolve
          // static mode or the configured trusted edge header before touching
          // the tenant-owned key table. Auth-claim-only hosted deployments must
          // use an internal tenant-bound MCP token instead.
          tenant = resolveTenantContext(multiTenancy, {
            headers: getTenantResolutionHeaders(req),
          });
        } catch (error) {
          if (error instanceof TenantResolutionError) {
            return res.status(401).json({
              ...jsonRpcError(req, -32001, error.message),
            });
          }
          throw error;
        }

        const keyRow = await runWithTenantContext(tenant.tenant_id, () =>
          runWithTenantDatabaseScope(db, tenant.tenant_id, () =>
            personalApiKeys.verifyKey(credential)
          )
        );
        if (!keyRow) {
          console.warn('⚠️  Invalid MCP personal API key');
          return res.status(401).json({
            ...jsonRpcError(req, -32001, 'Invalid personal API key'),
          });
        }

        void runWithTenantContext(tenant.tenant_id, () =>
          runWithTenantDatabaseScope(db, tenant.tenant_id, () =>
            personalApiKeys.updateLastUsed(keyRow.id)
          )
        ).catch((err: unknown) => {
          console.warn('Failed to update MCP personal API key last_used_at:', err);
        });

        userId = keyRow.user_id as UserID;
        try {
          authenticatedUser = await runWithTenantContext(tenant.tenant_id, () =>
            app.service('users').get(userId, { tenant } as AuthenticatedParams)
          );
        } catch (error) {
          if (isNotFoundError(error)) {
            return res.status(401).json({
              ...jsonRpcError(req, -32001, 'Invalid personal API key'),
            });
          }
          throw error;
        }
        sessionId = requestedSessionId as SessionID | undefined;
      } else {
        const verifiedToken = verifySessionToken(app, credential);
        if (!verifiedToken) {
          console.warn('⚠️  Invalid MCP session token');
          return res.status(401).json({
            ...jsonRpcError(req, -32001, 'Invalid or expired session token'),
          });
        }

        try {
          // The signed token binding is an authenticated tenant signal. Static
          // configuration and a configured trusted header, when present, must
          // agree with it before the token's session is looked up.
          tenant = resolveTenantContext(multiTenancy, {
            params: { tenant_id: verifiedToken.tenantId },
            headers: getTenantResolutionHeaders(req),
          });
        } catch (error) {
          if (error instanceof TenantResolutionError) {
            return res.status(403).json({
              ...jsonRpcError(req, -32003, 'Forbidden: tenant identity mismatch'),
            });
          }
          throw error;
        }

        const context = await validateVerifiedSessionToken(verifiedToken);
        if (!context) {
          console.warn('⚠️  Invalid MCP session token');
          return res.status(401).json({
            ...jsonRpcError(req, -32001, 'Invalid or expired session token'),
          });
        }

        userId = context.userId;
        sessionId = context.sessionId;

        try {
          authenticatedUser = await runWithTenantContext(tenant.tenant_id, () =>
            app.service('users').get(userId, { tenant } as AuthenticatedParams)
          );
        } catch (error) {
          if (isNotFoundError(error)) {
            return res.status(401).json({
              ...jsonRpcError(req, -32001, 'Invalid or expired session token'),
            });
          }
          throw error;
        }
      }

      if (!authenticatedUserTenantMatches(authenticatedUser, tenant)) {
        console.warn('⚠️  MCP authenticated user tenant does not match request tenant');
        return res.status(401).json({
          ...jsonRpcError(req, -32001, 'Authenticated identity is not valid for this tenant'),
        });
      }

      // Keep tenant identity ambient for the complete MCP request without
      // holding a database transaction. Tool/repository operations open their
      // own short tenant units of work.
      return runWithTenantContext(tenant.tenant_id, async () => {
        const baseServiceParams: Pick<
          AuthenticatedParams,
          'user' | 'authenticated' | 'provider' | 'tenant'
        > = {
          user: {
            user_id: authenticatedUser.user_id,
            email: authenticatedUser.email,
            role: authenticatedUser.role,
          },
          authenticated: true,
          provider: 'mcp',
          tenant,
        };

        // Re-authorize every optional current-Session context through the
        // normal service on every request. Personal keys may supply a short ID;
        // internal tokens carry a signed full ID, but still need fresh branch
        // RBAC after a permission change. This also canonicalizes short IDs.
        let authenticatedSession: McpContext['authenticatedSession'];
        if (sessionId) {
          try {
            const session = await app.service('sessions').get(sessionId, baseServiceParams);
            sessionId = session.session_id;
            authenticatedSession = {
              session_id: session.session_id,
              agentic_tool: session.agentic_tool,
              branch_id: session.branch_id,
            };
          } catch {
            return res.status(403).json({
              ...jsonRpcError(
                req,
                -32003,
                isPersonalApiKey
                  ? 'Forbidden: X-Agor-Session-Id / ?sessionId is invalid or not accessible to this API key user.'
                  : 'Forbidden: the Agor Session context authenticated by this MCP token is no longer accessible.'
              ),
            });
          }
        }

        mcpRequestDebug(
          `🔌 MCP request authenticated (user: ${shortId(userId)}, session: ${sessionId ? shortId(sessionId) : 'none'})`
        );

        const mcpContext: McpContext = {
          app,
          db,
          userId,
          sessionId,
          authenticatedSession,
          authenticatedUser,
          baseServiceParams,
        };

        // A valid legacy Mcp-Session-Id is deliberately discarded before the
        // protocol adapter sees the request. It selects no server/context,
        // conveys no trust, and changes neither routing nor logging during a
        // rolling upgrade from the former stateful implementation.
        delete req.headers['mcp-session-id'];

        // createMcpHandler performs era classification, modern discovery,
        // legacy initialization compatibility, per-request server/transport
        // construction, response projection, and cleanup. Authentication and
        // tenant identity remain authoritative in this outer request scope.
        if (req.method === 'GET' || req.method === 'DELETE') {
          // HTTP 405 responses should enumerate the supported method. Let the
          // SDK own the status/body while completing the HTTP contract here.
          res.setHeader('Allow', 'POST');
        }
        return requestContext.run(mcpContext, () => nodeProtocolHandler(req, res, req.body));
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

  // GET and DELETE remain registered only to return an explicit, authenticated
  // 405 response to Streamable HTTP clients that optimistically probe them.
  // @ts-expect-error - FeathersJS app extends Express
  app.post('/mcp', handler);
  // @ts-expect-error - FeathersJS app extends Express
  app.get('/mcp', handler);
  // @ts-expect-error - FeathersJS app extends Express
  app.delete('/mcp', handler);

  console.log(
    '✅ MCP route registered at /mcp (2026-07-28 + stateless legacy; POST request/response, GET + DELETE 405)'
  );
}
