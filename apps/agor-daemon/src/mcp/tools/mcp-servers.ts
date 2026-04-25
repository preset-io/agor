import type { MCPServer } from '@agor/core/types';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { McpContext } from '../server.js';
import { textResult } from '../server.js';

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
  const userTokenRepo = new UserMCPOAuthTokenRepository(ctx.db);
  const lookupUserId = oauthMode === 'shared' ? null : ctx.userId;
  const tokenData = await userTokenRepo.getToken(lookupUserId, mcpServer.mcp_server_id);
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

export function registerMcpServerTools(server: McpServer, ctx: McpContext): void {
  // Tool 1: agor_mcp_servers_list
  server.registerTool(
    'agor_mcp_servers_list',
    {
      description:
        'List the MCP-server catalog the current user can access (i.e. servers eligible to attach to a session). Each entry includes name, transport, auth type, and OAuth status. Use this to discover IDs to pass to `agor_sessions_create({ mcpServerIds })`. To see which servers are currently ATTACHED to a session, read `attached_mcp_servers` from `agor_sessions_get_current` or `agor_sessions_get`.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
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
      inputSchema: z.object({
        mcpServerId: z.string().describe('MCP server ID to check (UUIDv7 or short ID)'),
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
}
