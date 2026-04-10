import type { MCPServer } from '@agor/core/types';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { McpContext } from '../server.js';
import { textResult } from '../server.js';

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

  if (oauthMode === 'shared') {
    return { authenticated: !!mcpServer.auth?.oauth_access_token };
  }

  // per_user OAuth — check user-specific token
  const { UserMCPOAuthTokenRepository } = await import('@agor/core/db');
  const userTokenRepo = new UserMCPOAuthTokenRepository(ctx.db);
  const tokenData = await userTokenRepo.getToken(ctx.userId, mcpServer.mcp_server_id);
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

export function registerMcpServerTools(server: McpServer, ctx: McpContext): void {
  // Tool 1: agor_mcp_servers_list
  server.registerTool(
    'agor_mcp_servers_list',
    {
      description:
        "List MCP servers available to the current session. Shows each server's name, transport type, authentication type, and OAuth connection status. Use this to see which external tools/services are configured and whether they need authentication.",
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

      const sessionMCPServers = await ctx.app.service('session-mcp-servers').find({
        ...ctx.baseServiceParams,
        query: {
          session_id: ctx.sessionId,
          ...(includeDisabled ? {} : { enabled: true }),
          $limit: 100,
        },
      });

      const servers: Array<{
        mcp_server_id: string;
        name: string;
        display_name?: string;
        transport: string;
        auth_type: string;
        oauth_mode?: string;
        oauth_authenticated: boolean;
        enabled: boolean;
      }> = [];

      const sessionMCPData = Array.isArray(sessionMCPServers)
        ? sessionMCPServers
        : sessionMCPServers.data;
      const mcpServerIds = sessionMCPData.map(
        (sms: { mcp_server_id: string }) => sms.mcp_server_id
      );

      for (const serverId of mcpServerIds) {
        try {
          const mcpServer = await ctx.app
            .service('mcp-servers')
            .get(serverId, ctx.baseServiceParams);
          const authType = mcpServer.auth?.type || 'none';
          const oauthMode = mcpServer.auth?.oauth_mode || 'per_user';
          const { authenticated } = await getOAuthStatus(ctx, mcpServer);

          servers.push({
            mcp_server_id: mcpServer.mcp_server_id,
            name: mcpServer.name,
            display_name: mcpServer.display_name,
            transport: mcpServer.transport,
            auth_type: authType,
            oauth_mode: oauthMode,
            oauth_authenticated: authenticated,
            enabled: mcpServer.enabled,
          });
        } catch (error) {
          console.warn(`Failed to fetch MCP server ${serverId}:`, error);
        }
      }

      // Also include global MCP servers not explicitly attached
      const globalServers = await ctx.app.service('mcp-servers').find({
        ...ctx.baseServiceParams,
        query: { scope: 'global', ...(includeDisabled ? {} : { enabled: true }), $limit: 100 },
      });

      for (const mcpServer of Array.isArray(globalServers) ? globalServers : globalServers.data) {
        if (!mcpServerIds.includes(mcpServer.mcp_server_id)) {
          const authType = mcpServer.auth?.type || 'none';
          const oauthMode = mcpServer.auth?.oauth_mode || 'per_user';
          const { authenticated } = await getOAuthStatus(ctx, mcpServer);

          servers.push({
            mcp_server_id: mcpServer.mcp_server_id,
            name: mcpServer.name,
            display_name: mcpServer.display_name,
            transport: mcpServer.transport,
            auth_type: authType,
            oauth_mode: oauthMode,
            oauth_authenticated: authenticated,
            enabled: mcpServer.enabled,
          });
        }
      }

      return textResult({
        session_id: ctx.sessionId,
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
