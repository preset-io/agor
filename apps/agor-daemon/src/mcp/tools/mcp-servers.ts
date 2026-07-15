import {
  isReservedMCPCustomHeaderName,
  isValidMCPHeaderName,
} from '@agor/core/tools/mcp/http-headers';
import type {
  CreateMCPServerInput,
  MCPAuth,
  MCPServer,
  UpdateMCPServerInput,
} from '@agor/core/types';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { resolveMcpServerId, resolveSessionId } from '../resolve-ids.js';
import {
  mcpOptionalId,
  mcpOptionalNonEmptyString,
  mcpOptionalString,
  mcpRequiredId,
} from '../schema.js';
import type { McpContext } from '../server.js';
import { textResult } from '../server.js';
import { runWithMcpTenantDatabaseScope } from '../tenant-scope.js';

/**
 * Standard MCP-server payload returned by the MCP tools. Shared by the catalog
 * lister (`agor_mcp_servers_list`) and the per-session attachment view that
 * `agor_sessions_get_current` / `agor_sessions_get` embeds as
 * `attached_mcp_servers` — keeping one shape so agents can treat them
 * identically.
 */
export interface McpServerSummary {
  mcp_server_id: string;
  name: string;
  display_name?: string;
  transport: string;
  auth_type: string;
  oauth_mode?: string;
  oauth_authenticated: boolean;
  has_custom_headers: boolean;
  enabled: boolean;
}

/** Resolve OAuth authentication status for an MCP server. */
async function getOAuthStatus(
  ctx: McpContext,
  mcpServer: MCPServer
): Promise<{ authenticated: boolean; tokenExpiresAt?: number }> {
  const authType = mcpServer.auth?.type || 'none';
  const oauthMode = mcpServer.auth?.oauth_mode || 'per_user';

  if (authType !== 'oauth') {
    return { authenticated: true };
  }

  // Both shared and per_user live in `user_mcp_oauth_tokens` — shared rows use
  // `user_id = NULL`. See migration 0038 (sqlite) / 0027 (postgres).
  const { UserMCPOAuthTokenRepository } = await import('@agor/core/db');
  const lookupUserId = oauthMode === 'shared' ? null : ctx.userId;
  const tokenData = await runWithMcpTenantDatabaseScope(ctx, (db) =>
    new UserMCPOAuthTokenRepository(db).getToken(lookupUserId, mcpServer.mcp_server_id)
  );
  if (tokenData) {
    if (!tokenData.oauth_token_expires_at || tokenData.oauth_token_expires_at > new Date()) {
      return {
        authenticated: true,
        tokenExpiresAt: tokenData.oauth_token_expires_at?.getTime(),
      };
    }
  }
  return { authenticated: false };
}

/** Build the standard MCP-server summary, resolving OAuth status inline. */
export async function summarizeMcpServer(
  ctx: McpContext,
  mcpServer: MCPServer
): Promise<McpServerSummary> {
  const authType = mcpServer.auth?.type || 'none';
  const oauthMode = mcpServer.auth?.oauth_mode || 'per_user';
  const { authenticated } = await getOAuthStatus(ctx, mcpServer);
  return {
    mcp_server_id: mcpServer.mcp_server_id,
    name: mcpServer.name,
    display_name: mcpServer.display_name,
    transport: mcpServer.transport,
    auth_type: authType,
    oauth_mode: oauthMode,
    oauth_authenticated: authenticated,
    has_custom_headers: !!mcpServer.headers && Object.keys(mcpServer.headers).length > 0,
    enabled: mcpServer.enabled,
  };
}

/**
 * List MCP servers attached to a session (via the `session-mcp-servers`
 * junction), enriched with OAuth status. Used by `agor_sessions_get_current`
 * and `agor_sessions_get` to expose `attached_mcp_servers` in their payload.
 */
export async function listAttachedMcpServers(
  ctx: McpContext,
  sessionId: string,
  opts: { includeDisabled?: boolean } = {}
): Promise<McpServerSummary[]> {
  const sessionMCPServers = await ctx.app.service('session-mcp-servers').find({
    ...ctx.baseServiceParams,
    query: {
      session_id: sessionId,
      ...(opts.includeDisabled ? {} : { enabled: true }),
      $limit: 100,
    },
  });
  const data = Array.isArray(sessionMCPServers) ? sessionMCPServers : sessionMCPServers.data;
  const summaries: McpServerSummary[] = [];
  for (const sms of data as Array<{ mcp_server_id: string }>) {
    try {
      const mcpServer = await ctx.app
        .service('mcp-servers')
        .get(sms.mcp_server_id, ctx.baseServiceParams);
      summaries.push(await summarizeMcpServer(ctx, mcpServer));
    } catch (error) {
      console.warn(`Failed to fetch MCP server ${sms.mcp_server_id}:`, error);
    }
  }
  return summaries;
}

const mcpNameSchema = z
  .string({
    error: 'name is required and must be a string. Example: { "name": "context7" }',
  })
  .regex(
    /^[a-z][a-z0-9_-]{0,63}$/,
    'name must start with a lowercase letter and contain only lowercase letters, digits, "_" or "-" (max 64 chars).'
  )
  .describe('Stable internal ID, e.g. "context7", "github", "datadog". Cannot be changed later.');

const stringMapSchema = z
  .record(z.string(), z.string())
  .describe(
    'JSON object of string keys/values. Values may use templates like {{ user.env.API_TOKEN }}.'
  );

const mcpAuthInputSchema = z
  .strictObject({
    type: z
      .enum(['none', 'bearer', 'jwt', 'oauth'])
      .describe(
        "Authentication mode. OAuth tip: start with { type: 'oauth' } plus the MCP server URL; only add endpoint/client fields if discovery/DCR fails."
      ),
    token: mcpOptionalString(
      'auth.token',
      'Bearer token. Prefer {{ user.env.MCP_TOKEN }} templates; raw secrets will be stored redacted but are still visible in this MCP call transcript.'
    ),
    api_url: mcpOptionalString('auth.api_url', 'JWT auth API URL.'),
    api_token: mcpOptionalString(
      'auth.api_token',
      'JWT API token. Prefer {{ user.env.JWT_TOKEN }} templates.'
    ),
    api_secret: mcpOptionalString(
      'auth.api_secret',
      'JWT API secret. Prefer {{ user.env.JWT_SECRET }} templates.'
    ),
    oauth_authorization_url: mcpOptionalString(
      'auth.oauth_authorization_url',
      'Optional OAuth authorization endpoint override. Leave blank for discovery.'
    ),
    oauth_token_url: mcpOptionalString(
      'auth.oauth_token_url',
      'Optional OAuth token endpoint override. Leave blank for discovery.'
    ),
    oauth_client_id: mcpOptionalString(
      'auth.oauth_client_id',
      'Optional OAuth client ID for providers that require a pre-registered app. Leave blank for Dynamic Client Registration where supported.'
    ),
    oauth_client_secret: mcpOptionalString(
      'auth.oauth_client_secret',
      'Optional OAuth client secret. Prefer {{ user.env.OAUTH_CLIENT_SECRET }} templates; raw secrets are not returned by this tool.'
    ),
    oauth_scope: mcpOptionalString('auth.oauth_scope', 'Optional OAuth scopes, space-separated.'),
    oauth_grant_type: z
      .enum(['client_credentials', 'authorization_code'])
      .optional()
      .describe(
        "OAuth grant type hint. Defaults to 'client_credentials' for legacy token testing; browser OAuth uses authorization code with PKCE."
      ),
    oauth_mode: z
      .enum(['per_user', 'shared'])
      .optional()
      .describe("OAuth token ownership. Defaults to 'per_user' (recommended)."),
    insecure: z.boolean().optional().describe('Allow insecure auth behavior if supported.'),
  })
  .superRefine((auth, issue) => {
    if (auth.type === 'bearer' && !auth.token) {
      issue.addIssue({
        code: 'custom',
        path: ['token'],
        message: "auth.token is required when auth.type is 'bearer'.",
      });
    }
    const fieldsByType = {
      none: [] as const,
      bearer: ['token'] as const,
      jwt: ['api_url', 'api_token', 'api_secret'] as const,
      oauth: [
        'oauth_authorization_url',
        'oauth_token_url',
        'oauth_client_id',
        'oauth_client_secret',
        'oauth_scope',
        'oauth_grant_type',
        'oauth_mode',
        'insecure',
      ] as const,
    };
    const allowed = new Set<string>(['type', ...fieldsByType[auth.type]]);
    for (const key of Object.keys(auth)) {
      if (!allowed.has(key)) {
        issue.addIssue({
          code: 'custom',
          path: [key],
          message: `auth.${key} does not apply when auth.type is '${auth.type}'.`,
        });
      }
    }
    if (auth.type === 'jwt') {
      for (const field of ['api_url', 'api_token', 'api_secret'] as const) {
        if (!auth[field]) {
          issue.addIssue({
            code: 'custom',
            path: [field],
            message: `auth.${field} is required when auth.type is 'jwt'.`,
          });
        }
      }
    }
  })
  .describe(
    "Auth config. Common OAuth path: { type: 'oauth' } plus url; leave OAuth URLs/client fields blank first so metadata discovery/DCR can do the work."
  );

const toolPermissionsSchema = z
  .record(z.string(), z.enum(['ask', 'allow', 'deny']))
  .describe("Optional per-tool permissions, e.g. { 'list_files': 'allow', 'write_file': 'ask' }.");

const mcpServerCreateSchema = z
  .strictObject({
    name: mcpNameSchema,
    displayName: mcpOptionalNonEmptyString(
      'displayName',
      'Human-friendly display name, e.g. "Context7 MCP".'
    ),
    description: mcpOptionalString('description', 'Optional description.'),
    transport: z
      .enum(['stdio', 'http', 'sse'])
      .optional()
      .describe(
        "Transport. Defaults to 'http' when url is provided, otherwise 'stdio'. Most remote OAuth MCP servers use 'http'."
      ),
    url: mcpOptionalString(
      'url',
      'Remote MCP server URL for http/sse transports. Supports templates like {{ user.env.MCP_URL }}.'
    ),
    command: mcpOptionalString('command', 'Local command for stdio transport, e.g. "npx".'),
    args: z
      .array(z.string())
      .optional()
      .describe(
        'Arguments for stdio command, e.g. ["-y", "@modelcontextprotocol/server-filesystem"].'
      ),
    headers: stringMapSchema
      .optional()
      .describe(
        'Custom HTTP headers for http/sse transports. Do not include Authorization; use auth instead. Prefer templates for secret values.'
      ),
    env: stringMapSchema
      .optional()
      .describe(
        'Environment variables for the MCP process/config. Prefer {{ user.env.VAR }} templates for secrets.'
      ),
    auth: mcpAuthInputSchema.optional(),
    scope: z
      .enum(['global', 'session'])
      .optional()
      .describe(
        "Scope. Defaults to 'global' so it appears in agor_mcp_servers_list. 'session' is only for explicit session attachment workflows."
      ),
    enabled: z.boolean().optional().describe('Whether the server is enabled. Defaults to true.'),
    attachToCurrentSession: z
      .boolean()
      .optional()
      .describe(
        'If true, also add a session-specific link after creating. Mostly useful for scope:"session" servers; global enabled servers are already in each session\'s effective MCP set.'
      ),
    attachToSessionId: mcpOptionalId(
      'attachToSessionId',
      'Session',
      'Optional session ID (UUIDv7 or short ID) to attach after creating. Overrides attachToCurrentSession.'
    ),
  })
  .superRefine((value, issue) => validateMcpServerConfig(value, issue, false));

const mcpServerUpdateSchema = z
  .strictObject({
    mcpServerId: mcpRequiredId(
      'mcpServerId',
      'MCP server',
      'MCP server ID to update (UUIDv7 or short ID)'
    ),
    displayName: mcpOptionalNonEmptyString('displayName', 'New human-friendly display name.'),
    description: mcpOptionalString(
      'description',
      'New description. Pass an empty string to clear.'
    ),
    transport: z.enum(['stdio', 'http', 'sse']).optional().describe('Transport to set.'),
    url: mcpOptionalString('url', 'Remote MCP URL for http/sse transports.'),
    command: mcpOptionalString('command', 'Local command for stdio transport.'),
    args: z.array(z.string()).optional().describe('Arguments for stdio command.'),
    headers: stringMapSchema
      .optional()
      .describe(
        'Replace custom HTTP headers. Redacted existing header values may be passed back unchanged by the UI; this tool should normally pass real template values or omit headers.'
      ),
    env: stringMapSchema.optional().describe('Replace environment variables.'),
    auth: mcpAuthInputSchema
      .optional()
      .describe(
        "Replace auth config. Existing redacted secrets are preserved if their redacted placeholders are passed back; prefer omitting auth unless changing it. Use { type: 'none' } to clear auth."
      ),
    scope: z.enum(['global', 'session']).optional().describe('Scope to set.'),
    enabled: z.boolean().optional().describe('Enabled flag.'),
    toolPermissions: toolPermissionsSchema.optional(),
  })
  .superRefine((value, issue) => validateMcpServerConfig(value, issue, true));

function validateHeaders(headers: Record<string, string> | undefined, issue: z.RefinementCtx) {
  if (!headers) return;
  for (const [key, value] of Object.entries(headers)) {
    const name = key.trim();
    if (!name) {
      issue.addIssue({
        code: 'custom',
        path: ['headers', key],
        message: 'Header names cannot be empty.',
      });
    } else if (!isValidMCPHeaderName(name)) {
      issue.addIssue({
        code: 'custom',
        path: ['headers', key],
        message: `Invalid HTTP header name: ${key}`,
      });
    } else if (isReservedMCPCustomHeaderName(name)) {
      issue.addIssue({
        code: 'custom',
        path: ['headers', key],
        message: `Header ${name} is reserved; configure Authorization through auth instead.`,
      });
    }
    if (typeof value !== 'string') {
      issue.addIssue({
        code: 'custom',
        path: ['headers', key],
        message: 'Header values must be strings.',
      });
    }
  }
}

function validateMcpServerConfig(
  value: {
    transport?: 'stdio' | 'http' | 'sse';
    url?: string;
    command?: string;
    args?: string[];
    headers?: Record<string, string>;
    auth?: z.infer<typeof mcpAuthInputSchema>;
  },
  issue: z.RefinementCtx,
  partial: boolean
) {
  const transport = value.transport ?? (value.url ? 'http' : 'stdio');
  validateHeaders(value.headers, issue);

  if (
    !partial ||
    value.transport !== undefined ||
    value.url !== undefined ||
    value.command !== undefined
  ) {
    if (transport === 'stdio') {
      if (!partial && !value.command) {
        issue.addIssue({
          code: 'custom',
          path: ['command'],
          message: 'command is required for stdio transport.',
        });
      }
      if (value.url) {
        issue.addIssue({
          code: 'custom',
          path: ['url'],
          message: 'url only applies to http/sse transports, not stdio.',
        });
      }
      if (value.headers) {
        issue.addIssue({
          code: 'custom',
          path: ['headers'],
          message: 'headers only apply to http/sse transports, not stdio.',
        });
      }
      if (value.auth && value.auth.type !== 'none') {
        issue.addIssue({
          code: 'custom',
          path: ['auth', 'type'],
          message: 'Authentication config only applies to http/sse transports.',
        });
      }
    } else if (!partial && !value.url) {
      issue.addIssue({
        code: 'custom',
        path: ['url'],
        message: `url is required for ${transport} transport.`,
      });
    } else {
      if (value.command) {
        issue.addIssue({
          code: 'custom',
          path: ['command'],
          message: 'command only applies to stdio transport, not http/sse.',
        });
      }
      if (value.args && value.args.length > 0) {
        issue.addIssue({
          code: 'custom',
          path: ['args'],
          message: 'args only apply to stdio transport, not http/sse.',
        });
      }
    }
  }
}

function assertUpdateCompatibleWithCurrent(
  current: MCPServer,
  args: z.infer<typeof mcpServerUpdateSchema>
) {
  const transport = args.transport ?? current.transport;
  const url = args.url ?? current.url;
  const command = args.command ?? current.command;
  const errors: string[] = [];

  if (transport === 'stdio') {
    if (!command) errors.push('command is required for stdio transport.');
    if (args.url) errors.push('url only applies to http/sse transports, not stdio.');
    if (args.headers && Object.keys(args.headers).length > 0) {
      errors.push('headers only apply to http/sse transports, not stdio.');
    }
    if (args.auth && args.auth.type !== 'none') {
      errors.push('auth only applies to http/sse transports, not stdio.');
    }
  } else {
    if (!url) errors.push(`url is required for ${transport} transport.`);
    if (args.command) errors.push('command only applies to stdio transport, not http/sse.');
    if (args.args && args.args.length > 0) {
      errors.push('args only apply to stdio transport, not http/sse.');
    }
  }

  if (errors.length > 0) {
    throw new Error(`Invalid MCP server update: ${errors.join(' ')}`);
  }
}

function createOrUpdateNextSteps(
  server: MCPServer,
  attach?: { sessionId: string; ok: boolean; error?: string }
) {
  const authType = server.auth?.type || 'none';
  const steps: string[] = [];
  if (authType === 'oauth') {
    steps.push(
      `OAuth configured. If oauth_authenticated is false, authenticate in Settings > MCP Servers > ${server.display_name || server.name} > Test Authentication > Start OAuth Flow.`
    );
  }
  if (attach?.ok) {
    steps.push(
      `Attached to session ${attach.sessionId}. Restart or re-prompt the agent if its MCP client does not hot-reload tools.`
    );
  } else if (attach?.error) {
    steps.push(`Attach to session ${attach.sessionId} failed: ${attach.error}`);
  } else if (server.scope === 'global') {
    steps.push(
      'This enabled global MCP server is in every session’s effective MCP set. Restart or re-prompt an existing agent if its MCP client does not hot-reload tools.'
    );
  } else {
    steps.push(
      'This session-scoped MCP server must be linked to a session with agor_sessions_add_mcp_server (or set on session creation) before that session can use it.'
    );
  }
  return steps;
}

async function attachMcpServerToSession(ctx: McpContext, sessionId: string, mcpServerId: string) {
  return ctx.app.service('/sessions/:id/mcp-servers').create(
    { mcpServerId },
    {
      ...ctx.baseServiceParams,
      route: { id: sessionId },
    }
  );
}

async function removeMcpServerFromSession(ctx: McpContext, sessionId: string, mcpServerId: string) {
  return ctx.app.service('/sessions/:id/mcp-servers').remove(mcpServerId, {
    ...ctx.baseServiceParams,
    route: { id: sessionId },
  });
}

async function resolveTargetSessionId(ctx: McpContext, sessionId?: string) {
  const targetSessionId = sessionId ? await resolveSessionId(ctx, sessionId) : ctx.sessionId;
  if (!targetSessionId) {
    return {
      error:
        'No current session context. Pass sessionId explicitly, or reconnect with X-Agor-Session-Id / a session-scoped MCP token.',
    };
  }
  return { sessionId: targetSessionId };
}

export function registerMcpServerTools(server: McpServer, ctx: McpContext): void {
  // Tool 1: agor_mcp_servers_list
  server.registerTool(
    'agor_mcp_servers_list',
    {
      description:
        'List the MCP-server catalog the current user can access (i.e. servers eligible to attach to a session). Each entry includes name, transport, auth type, custom-header presence, and OAuth status. Use this to discover IDs to pass to `agor_sessions_create({ mcpServerIds })`. To see which servers are currently ATTACHED to a session, read `attached_mcp_servers` from `agor_sessions_get_current` or `agor_sessions_get`.',
      annotations: { readOnlyHint: true },
      inputSchema: z.strictObject({
        includeDisabled: z
          .boolean()
          .optional()
          .describe('Include disabled MCP servers (default: false)'),
      }),
    },
    async (args) => {
      const includeDisabled = args.includeDisabled === true;

      const result = await ctx.app.service('mcp-servers').find({
        ...ctx.baseServiceParams,
        query: {
          scope: 'global',
          ...(includeDisabled ? {} : { enabled: true }),
          $limit: 100,
        },
      });
      const data = (Array.isArray(result) ? result : result.data) as MCPServer[];

      const servers: McpServerSummary[] = [];
      for (const mcpServer of data) {
        servers.push(await summarizeMcpServer(ctx, mcpServer));
      }

      return textResult({
        mcp_servers: servers,
        summary: {
          total: servers.length,
          oauth_servers: servers.filter((s) => s.auth_type === 'oauth').length,
          authenticated: servers.filter((s) => s.oauth_authenticated).length,
          needs_auth: servers.filter((s) => s.auth_type === 'oauth' && !s.oauth_authenticated)
            .length,
        },
      });
    }
  );

  // Tool 2: agor_mcp_servers_auth_status
  server.registerTool(
    'agor_mcp_servers_auth_status',
    {
      description:
        'Check the OAuth authentication status for an MCP server. Returns whether the current user is authenticated. If NOT authenticated, returns instructions for the user to complete OAuth via Settings → MCP Servers. Use agor_mcp_servers_list to get server IDs.',
      annotations: { readOnlyHint: true },
      inputSchema: z.strictObject({
        mcpServerId: mcpRequiredId(
          'mcpServerId',
          'MCP server',
          'MCP server ID to check (UUIDv7 or short ID)'
        ),
      }),
    },
    async (args) => {
      const mcpServer: MCPServer = await ctx.app
        .service('mcp-servers')
        .get(args.mcpServerId, ctx.baseServiceParams);

      const authType = mcpServer.auth?.type || 'none';
      const oauthMode = mcpServer.auth?.oauth_mode || 'per_user';
      const { authenticated, tokenExpiresAt } = await getOAuthStatus(ctx, mcpServer);

      return textResult({
        mcp_server_id: mcpServer.mcp_server_id,
        name: mcpServer.name,
        display_name: mcpServer.display_name,
        auth_type: authType,
        oauth_mode: oauthMode,
        oauth_authenticated: authenticated,
        token_expires_at: tokenExpiresAt ? new Date(tokenExpiresAt).toISOString() : undefined,
        instructions:
          !authenticated && authType === 'oauth'
            ? `To authenticate with "${mcpServer.display_name || mcpServer.name}", go to Settings > MCP Servers > ${mcpServer.display_name || mcpServer.name} > Click "Test Authentication" then "Start OAuth Flow". After completing the OAuth flow in your browser, the MCP tools will become available.`
            : undefined,
      });
    }
  );

  // Tool 3: agor_mcp_servers_create
  server.registerTool(
    'agor_mcp_servers_create',
    {
      description:
        'Register a new MCP server definition. Permissions are service-enforced: only admins can create MCP configs. Scope matters: enabled `global` servers are automatically in each session\'s effective MCP set; `session` scoped servers must be linked with `agor_sessions_add_mcp_server` (or `attachToCurrentSession` / `attachToSessionId`). Start simple for remote OAuth: `name` + `url` + `auth:{type:"oauth"}`; add endpoint/client fields only if discovery/DCR fails. For stdio use `transport:"stdio"` + `command` (+ `args`). Use `auth`, not Authorization headers. Prefer `{{ user.env.SECRET_NAME }}` templates; raw secrets are visible in the MCP transcript though never returned.',
      annotations: { destructiveHint: false, idempotentHint: false },
      inputSchema: mcpServerCreateSchema,
    },
    async (args) => {
      const transport = args.transport ?? (args.url ? 'http' : 'stdio');

      const wantsAttach = args.attachToSessionId !== undefined || args.attachToCurrentSession;
      const attachTargetResult = wantsAttach
        ? await resolveTargetSessionId(ctx, args.attachToSessionId)
        : undefined;
      if (attachTargetResult && 'error' in attachTargetResult) {
        return { ...textResult({ error: attachTargetResult.error }), isError: true };
      }
      const attachTarget = attachTargetResult?.sessionId;

      const createData: CreateMCPServerInput = {
        name: args.name,
        display_name: args.displayName,
        description: args.description,
        transport,
        command: transport === 'stdio' ? args.command : undefined,
        args: transport === 'stdio' ? args.args : undefined,
        url: transport === 'stdio' ? undefined : args.url,
        headers: transport === 'stdio' ? undefined : args.headers,
        env: args.env,
        auth:
          transport === 'stdio' || !args.auth || args.auth.type === 'none'
            ? undefined
            : (args.auth as MCPAuth),
        scope: args.scope ?? 'global',
        source: 'user',
        enabled: args.enabled ?? true,
      };

      const created: MCPServer = await ctx.app
        .service('mcp-servers')
        .create(createData, ctx.baseServiceParams);

      let attachResult: { sessionId: string; ok: boolean; error?: string } | undefined;
      if (attachTarget) {
        try {
          await attachMcpServerToSession(ctx, attachTarget, created.mcp_server_id);
          attachResult = { sessionId: attachTarget, ok: true };
        } catch (error) {
          attachResult = {
            sessionId: attachTarget,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }

      const summary = await summarizeMcpServer(ctx, created);
      return textResult({
        mcp_server: summary,
        attached: attachResult?.ok
          ? { session_id: attachResult.sessionId, mcp_server_id: created.mcp_server_id }
          : undefined,
        attach_error: attachResult && !attachResult.ok ? attachResult.error : undefined,
        next_steps: createOrUpdateNextSteps(created, attachResult),
      });
    }
  );

  // Tool 4: agor_mcp_servers_update
  server.registerTool(
    'agor_mcp_servers_update',
    {
      description:
        'Update an existing MCP server definition. Permissions are service-enforced: only admins can update MCP configs. Updating config does not create a session-specific link: enabled `global` servers are already effective for all sessions, while `session` scoped servers need `agor_sessions_add_mcp_server`. Provide only fields to change. Validation rejects incompatible combinations (e.g. stdio+url/auth/headers, remote+command/args, wrong auth fields). OAuth tip: keep only `auth:{type:"oauth"}` unless discovery fails or a provider requires endpoint/client overrides. Use `auth:{type:"none"}` to clear auth.',
      annotations: { destructiveHint: false, idempotentHint: false },
      inputSchema: mcpServerUpdateSchema,
    },
    async (args) => {
      const mcpServerId = await resolveMcpServerId(ctx, args.mcpServerId);
      const current: MCPServer = await ctx.app
        .service('mcp-servers')
        .get(mcpServerId, ctx.baseServiceParams);
      assertUpdateCompatibleWithCurrent(current, args);

      const updates: UpdateMCPServerInput = {};
      if (args.displayName !== undefined) updates.display_name = args.displayName;
      if (args.description !== undefined) updates.description = args.description;
      if (args.transport !== undefined) updates.transport = args.transport;
      if (args.command !== undefined) updates.command = args.command;
      if (args.args !== undefined) updates.args = args.args;
      if (args.url !== undefined) updates.url = args.url;
      if (args.headers !== undefined) updates.headers = args.headers;
      if (args.env !== undefined) updates.env = args.env;
      if (args.auth !== undefined) {
        updates.auth =
          args.auth.type === 'none' ? ({ type: 'none' } as MCPAuth) : (args.auth as MCPAuth);
      }
      if (args.scope !== undefined) updates.scope = args.scope;
      if (args.enabled !== undefined) updates.enabled = args.enabled;
      if (args.toolPermissions !== undefined) updates.tool_permissions = args.toolPermissions;

      // Avoid leaving stale transport-specific config behind when switching
      // transports via the MCP tool. Existing UI/service behavior merges
      // partial updates, so explicitly clear fields that no longer apply.
      if (args.transport === 'stdio') {
        updates.url = undefined;
        updates.headers = undefined;
        updates.auth = undefined;
      } else if (args.transport === 'http' || args.transport === 'sse') {
        updates.command = undefined;
        updates.args = undefined;
      }

      const updated: MCPServer = await ctx.app
        .service('mcp-servers')
        .patch(mcpServerId, updates, ctx.baseServiceParams);

      return textResult({
        mcp_server: await summarizeMcpServer(ctx, updated),
        next_steps: createOrUpdateNextSteps(updated),
      });
    }
  );

  // Tool 5: agor_sessions_add_mcp_server
  server.registerTool(
    'agor_sessions_add_mcp_server',
    {
      description:
        'Attach a registered MCP server to a session. Defaults to current session when `sessionId` is omitted. Permissions are service-enforced via the same session-scoped route as the UI: caller must be allowed to edit that session config. Verify with `agor_sessions_get_current`/`agor_sessions_get`; the agent may need a restart/re-prompt before its MCP client sees new tools.',
      annotations: { destructiveHint: false, idempotentHint: true },
      inputSchema: z.strictObject({
        mcpServerId: mcpRequiredId(
          'mcpServerId',
          'MCP server',
          'MCP server ID to attach (UUIDv7 or short ID)'
        ),
        sessionId: mcpOptionalId(
          'sessionId',
          'Session',
          'Target session ID (UUIDv7 or short ID). Omit to attach to the current session.'
        ),
      }),
    },
    async (args) => {
      const target = await resolveTargetSessionId(ctx, args.sessionId);
      if ('error' in target) {
        return {
          ...textResult({
            error: target.error,
          }),
          isError: true,
        };
      }
      const sessionId = target.sessionId;
      const mcpServerId = await resolveMcpServerId(ctx, args.mcpServerId);
      const relationship = await attachMcpServerToSession(ctx, sessionId, mcpServerId);
      const mcpServer: MCPServer = await ctx.app
        .service('mcp-servers')
        .get(mcpServerId, ctx.baseServiceParams);
      return textResult({
        relationship,
        mcp_server: await summarizeMcpServer(ctx, mcpServer),
        next_steps: createOrUpdateNextSteps(mcpServer, { sessionId, ok: true }),
      });
    }
  );

  // Tool 6: agor_sessions_remove_mcp_server
  server.registerTool(
    'agor_sessions_remove_mcp_server',
    {
      description:
        'Remove a session-specific MCP server link from a session. Defaults to current session when `sessionId` is omitted. Permissions are service-enforced by the same session-scoped route as the UI. This only removes the session link; it does not delete the registered MCP server. Note: enabled global MCP servers remain effective for all sessions and cannot be removed from just one session with this link-removal tool.',
      annotations: { destructiveHint: true, idempotentHint: true },
      inputSchema: z.strictObject({
        mcpServerId: mcpRequiredId(
          'mcpServerId',
          'MCP server',
          'MCP server ID to remove from the session (UUIDv7 or short ID)'
        ),
        sessionId: mcpOptionalId(
          'sessionId',
          'Session',
          'Target session ID (UUIDv7 or short ID). Omit to use the current session.'
        ),
      }),
    },
    async (args) => {
      const target = await resolveTargetSessionId(ctx, args.sessionId);
      if ('error' in target) {
        return { ...textResult({ error: target.error }), isError: true };
      }
      const mcpServerId = await resolveMcpServerId(ctx, args.mcpServerId);
      const relationship = await removeMcpServerFromSession(ctx, target.sessionId, mcpServerId);
      return textResult({
        relationship,
        removed: { session_id: target.sessionId, mcp_server_id: mcpServerId },
        next_steps: [
          'Verify with agor_sessions_get_current/agor_sessions_get. Restart or re-prompt an existing agent if its MCP client does not hot-reload tool removals.',
        ],
      });
    }
  );

  // Tool 7: agor_sessions_set_mcp_servers
  server.registerTool(
    'agor_sessions_set_mcp_servers',
    {
      description:
        'Replace the session-specific MCP links for a session by diffing through the same add/remove route the UI uses. Defaults to current session when `sessionId` is omitted. Permissions are service-enforced per add/remove. This manages session links only; enabled global MCP servers are still effective for every session even if omitted here.',
      annotations: { destructiveHint: true, idempotentHint: true },
      inputSchema: z.strictObject({
        mcpServerIds: z
          .array(mcpRequiredId('mcpServerIds[]', 'MCP server', 'MCP server ID'))
          .describe(
            'Exact desired set of session-specific MCP server IDs. Pass [] to remove all session-specific links.'
          ),
        sessionId: mcpOptionalId(
          'sessionId',
          'Session',
          'Target session ID (UUIDv7 or short ID). Omit to use the current session.'
        ),
      }),
    },
    async (args) => {
      const target = await resolveTargetSessionId(ctx, args.sessionId);
      if ('error' in target) {
        return { ...textResult({ error: target.error }), isError: true };
      }

      const desired = [
        ...new Set(await Promise.all(args.mcpServerIds.map((id) => resolveMcpServerId(ctx, id)))),
      ];
      const currentResult = await ctx.app.service('/sessions/:id/mcp-servers').find({
        ...ctx.baseServiceParams,
        route: { id: target.sessionId },
      });
      const currentServers = (
        Array.isArray(currentResult) ? currentResult : currentResult.data
      ) as Array<{ mcp_server_id: string }>;
      const current = currentServers.map((s) => s.mcp_server_id);
      const currentSet = new Set(current);
      const desiredSet = new Set(desired);
      const toAdd = desired.filter((id) => !currentSet.has(id));
      const toRemove = current.filter((id) => !desiredSet.has(id));

      const failures: Array<{ mcp_server_id: string; action: 'add' | 'remove'; reason: string }> =
        [];
      for (const mcpServerId of toRemove) {
        try {
          await removeMcpServerFromSession(ctx, target.sessionId, mcpServerId);
        } catch (error) {
          failures.push({
            mcp_server_id: mcpServerId,
            action: 'remove',
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
      for (const mcpServerId of toAdd) {
        try {
          await attachMcpServerToSession(ctx, target.sessionId, mcpServerId);
        } catch (error) {
          failures.push({
            mcp_server_id: mcpServerId,
            action: 'add',
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const payload = {
        session_id: target.sessionId,
        desired_mcp_server_ids: desired,
        added_mcp_server_ids: toAdd.filter(
          (id) => !failures.some((f) => f.action === 'add' && f.mcp_server_id === id)
        ),
        removed_mcp_server_ids: toRemove.filter(
          (id) => !failures.some((f) => f.action === 'remove' && f.mcp_server_id === id)
        ),
        unchanged_mcp_server_ids: desired.filter((id) => currentSet.has(id)),
        failures: failures.length > 0 ? failures : undefined,
        next_steps: [
          'Verify with agor_sessions_get_current/agor_sessions_get. Enabled global MCP servers remain effective even if not listed here.',
          'Restart or re-prompt an existing agent if its MCP client does not hot-reload MCP link changes.',
        ],
      };
      return failures.length > 0 ? { ...textResult(payload), isError: true } : textResult(payload);
    }
  );
}
