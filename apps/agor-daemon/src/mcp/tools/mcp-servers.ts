import type { MCPServer } from '@agor/core/types';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { McpContext } from '../server.js';
import { textResult } from '../server.js';

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

          let oauthAuthenticated = false;
          if (authType === 'oauth' && oauthMode === 'per_user') {
            const { UserMCPOAuthTokenRepository } = await import('@agor/core/db');
            const userTokenRepo = new UserMCPOAuthTokenRepository(ctx.db);
            const token = await userTokenRepo.getValidToken(ctx.userId, serverId);
            oauthAuthenticated = !!token;
          } else if (authType === 'oauth' && oauthMode === 'shared') {
            oauthAuthenticated = !!mcpServer.auth?.oauth_access_token;
          } else if (authType !== 'oauth') {
            oauthAuthenticated = true;
          }

          servers.push({
            mcp_server_id: mcpServer.mcp_server_id,
            name: mcpServer.name,
            display_name: mcpServer.display_name,
            transport: mcpServer.transport,
            auth_type: authType,
            oauth_mode: oauthMode,
            oauth_authenticated: oauthAuthenticated,
            enabled: mcpServer.enabled,
          });
        } catch (error) {
          console.warn(`Failed to fetch MCP server ${serverId}:`, error);
        }
      }

      // Also include global MCP servers not explicitly attached
      const globalServers = await ctx.app.service('mcp-servers').find({
        ...ctx.baseServiceParams,
        query: { scope: 'global', enabled: true, $limit: 100 },
      });

      for (const mcpServer of Array.isArray(globalServers) ? globalServers : globalServers.data) {
        if (!mcpServerIds.includes(mcpServer.mcp_server_id)) {
          const authType = mcpServer.auth?.type || 'none';
          const oauthMode = mcpServer.auth?.oauth_mode || 'per_user';

          let oauthAuthenticated = false;
          if (authType === 'oauth' && oauthMode === 'per_user') {
            const { UserMCPOAuthTokenRepository } = await import('@agor/core/db');
            const userTokenRepo = new UserMCPOAuthTokenRepository(ctx.db);
            const token = await userTokenRepo.getValidToken(ctx.userId, mcpServer.mcp_server_id);
            oauthAuthenticated = !!token;
          } else if (authType === 'oauth' && oauthMode === 'shared') {
            oauthAuthenticated = !!mcpServer.auth?.oauth_access_token;
          } else if (authType !== 'oauth') {
            oauthAuthenticated = true;
          }

          servers.push({
            mcp_server_id: mcpServer.mcp_server_id,
            name: mcpServer.name,
            display_name: mcpServer.display_name,
            transport: mcpServer.transport,
            auth_type: authType,
            oauth_mode: oauthMode,
            oauth_authenticated: oauthAuthenticated,
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
        'Check the OAuth authentication status for an MCP server. Returns whether the current user is authenticated. If NOT authenticated, you MUST immediately call agor_mcp_servers_request_oauth to trigger the OAuth popup in the UI. Do not just tell the user to authenticate manually.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        mcpServerId: z.string().optional().describe('MCP server ID to check (UUIDv7 or short ID)'),
        mcpServerName: z
          .string()
          .optional()
          .describe('MCP server name to check (alternative to mcpServerId)'),
      }),
    },
    async (args) => {
      let mcpServer: MCPServer;

      if (args.mcpServerId) {
        mcpServer = await ctx.app
          .service('mcp-servers')
          .get(args.mcpServerId, ctx.baseServiceParams);
      } else if (args.mcpServerName) {
        const servers = await ctx.app.service('mcp-servers').find({
          ...ctx.baseServiceParams,
          query: { name: args.mcpServerName, $limit: 1 },
        });
        const serverList = Array.isArray(servers) ? servers : servers.data;
        if (serverList.length === 0)
          throw new Error(`MCP server not found with name: ${args.mcpServerName}`);
        mcpServer = serverList[0];
      } else {
        throw new Error('mcpServerId or mcpServerName is required');
      }

      const authType = mcpServer.auth?.type || 'none';
      const oauthMode = mcpServer.auth?.oauth_mode || 'per_user';

      let oauthAuthenticated = false;
      let tokenExpiry: number | undefined;

      if (authType === 'oauth' && oauthMode === 'per_user') {
        const { UserMCPOAuthTokenRepository } = await import('@agor/core/db');
        const userTokenRepo = new UserMCPOAuthTokenRepository(ctx.db);
        const tokenData = await userTokenRepo.getToken(ctx.userId, mcpServer.mcp_server_id);
        if (tokenData) {
          if (!tokenData.oauth_token_expires_at || tokenData.oauth_token_expires_at > new Date()) {
            oauthAuthenticated = true;
            tokenExpiry = tokenData.oauth_token_expires_at?.getTime();
          }
        }
      } else if (authType === 'oauth' && oauthMode === 'shared') {
        oauthAuthenticated = !!mcpServer.auth?.oauth_access_token;
      } else if (authType !== 'oauth') {
        oauthAuthenticated = true;
      }

      return textResult({
        mcp_server_id: mcpServer.mcp_server_id,
        name: mcpServer.name,
        display_name: mcpServer.display_name,
        auth_type: authType,
        oauth_mode: oauthMode,
        oauth_authenticated: oauthAuthenticated,
        token_expires_at: tokenExpiry ? new Date(tokenExpiry).toISOString() : undefined,
        instructions:
          !oauthAuthenticated && authType === 'oauth'
            ? `To authenticate with "${mcpServer.display_name || mcpServer.name}", go to Settings > MCP Servers > ${mcpServer.display_name || mcpServer.name} > Click "Test Authentication" then "Start OAuth Flow". After completing the OAuth flow in your browser, the MCP tools will become available.`
            : undefined,
      });
    }
  );

  // Tool 3: agor_mcp_servers_request_oauth
  server.registerTool(
    'agor_mcp_servers_request_oauth',
    {
      description:
        'TRIGGER OAuth authentication popup in the Agor UI. Call this immediately when you detect an MCP server needs OAuth (e.g., when agor_mcp_servers_auth_status shows oauth_authenticated=false, or when MCP tools fail). This displays a modal/notification in the UI prompting the user to authenticate. The user will complete OAuth in their browser, and once done the MCP tools will become available.',
      inputSchema: z.object({
        mcpServerId: z
          .string()
          .optional()
          .describe('MCP server ID to authenticate (UUIDv7 or short ID)'),
        mcpServerName: z
          .string()
          .optional()
          .describe('MCP server name to authenticate (alternative to mcpServerId)'),
      }),
    },
    async (args) => {
      let mcpServer: MCPServer;

      if (args.mcpServerId) {
        mcpServer = await ctx.app
          .service('mcp-servers')
          .get(args.mcpServerId, ctx.baseServiceParams);
      } else if (args.mcpServerName) {
        const servers = await ctx.app.service('mcp-servers').find({
          ...ctx.baseServiceParams,
          query: { name: args.mcpServerName, $limit: 1 },
        });
        const serverList = Array.isArray(servers) ? servers : servers.data;
        if (serverList.length === 0)
          throw new Error(`MCP server not found with name: ${args.mcpServerName}`);
        mcpServer = serverList[0];
      } else {
        throw new Error('mcpServerId or mcpServerName is required');
      }

      const authType = mcpServer.auth?.type || 'none';

      if (authType !== 'oauth') {
        return textResult({
          success: false,
          error: `MCP server "${mcpServer.display_name || mcpServer.name}" does not use OAuth authentication (auth_type: ${authType})`,
        });
      }

      try {
        await ctx.app.service('mcp-servers/oauth-notify').create(
          {
            session_id: ctx.sessionId,
            user_id: ctx.userId,
            servers: [
              {
                name: mcpServer.display_name || mcpServer.name,
                serverId: mcpServer.mcp_server_id,
                url: mcpServer.url || '',
              },
            ],
          },
          ctx.baseServiceParams
        );

        return textResult({
          success: true,
          message: `OAuth authentication request sent to the Agor UI. The user has been notified to authenticate with "${mcpServer.display_name || mcpServer.name}". They should go to Settings > MCP Servers > ${mcpServer.display_name || mcpServer.name} > Start OAuth Flow.`,
          mcp_server_id: mcpServer.mcp_server_id,
          mcp_server_name: mcpServer.name,
        });
      } catch (error) {
        return textResult({
          success: false,
          error: `Failed to send OAuth notification: ${error instanceof Error ? error.message : String(error)}`,
          instructions: `Please ask the user to manually go to Settings > MCP Servers > ${mcpServer.display_name || mcpServer.name} > Start OAuth Flow`,
        });
      }
    }
  );
}
