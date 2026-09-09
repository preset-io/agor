/**
 * Start an idle session with a previously added MCP Catalog server.
 *
 * Installation/authentication and session creation are intentionally separate
 * commands. This boundary accepts only an install returned by Catalog and an
 * active teammate returned by the caller-scoped teammate API. It then delegates
 * both writes to their owning services so session permissions, creator
 * stamping, execution identity, and private MCP ownership stay authoritative.
 */

import { BadRequest, Forbidden, NotAuthenticated, NotFound } from '@agor/core/feathers';
import type {
  AuthenticatedParams,
  Branch,
  MCPCatalogEntry,
  MCPCatalogStartSessionData,
  MCPCatalogStartSessionResult,
  MCPServer,
  Session,
} from '@agor/core/types';
import { catalogDisplayName } from '@agor/core/types';
import { catalogServerTransport, sameCatalogEndpoint } from './mcp-catalog-install-policy.js';

export interface MCPCatalogStartSessionService {
  create(
    data: MCPCatalogStartSessionData,
    params: AuthenticatedParams
  ): Promise<MCPCatalogStartSessionResult>;
}

export function createMCPCatalogStartSessionService(
  // biome-ignore lint/suspicious/noExplicitAny: Feathers app type is complex and varies
  app: any
): MCPCatalogStartSessionService {
  const service = (path: string) => app.service(path);

  return {
    async create(data, params) {
      const userId = params.user?.user_id;
      if (!userId) throw new NotAuthenticated('Authentication required');
      if (!data?.catalog_key) throw new BadRequest('catalog_key is required');
      if (!data.mcp_server_id) throw new BadRequest('mcp_server_id is required');
      if (!data.teammate_branch_id) throw new BadRequest('teammate_branch_id is required');
      if (!data.agentic_tool) throw new BadRequest('agentic_tool is required');

      let entry: MCPCatalogEntry;
      try {
        entry = (await service('mcp-catalog').get(data.catalog_key, {
          ...params,
          query: {},
        })) as MCPCatalogEntry;
      } catch {
        throw new NotFound(`MCP catalog entry not found: ${data.catalog_key}`);
      }

      const server = (await service('mcp-servers').get(data.mcp_server_id, params)) as MCPServer;
      const matchesEntry =
        (server.owner_user_id == null || server.owner_user_id === userId) &&
        !!entry.remote_url &&
        sameCatalogEndpoint(server.url, entry.remote_url) &&
        server.transport === catalogServerTransport(entry) &&
        (server.source !== 'catalog' || server.catalog_entry_name === entry.name);
      if (!matchesEntry) {
        throw new Forbidden('That MCP server is not the selected MCP Catalog connection');
      }

      // This is the same caller-scoped source used by the settings primary
      // teammate picker. It already enforces tenant scope, active teammate
      // status, and session-level branch permission. Session creation repeats
      // the branch authorization at the write boundary below.
      const teammates = (await service('users').getPrimaryTeammateCandidates(
        undefined,
        params
      )) as Branch[];
      const teammate = teammates.find(
        (candidate) => candidate.branch_id === data.teammate_branch_id
      );
      if (!teammate) {
        throw new Forbidden('Choose an active teammate you can create sessions with');
      }

      // Use the newer atomic create/attach boundary: failure rolls back the
      // session as well as its MCP selection, rather than compensating a row
      // that has already been published to other clients.
      const session = (await service('sessions').create(
        {
          branch_id: teammate.branch_id,
          agentic_tool: data.agentic_tool,
          status: 'idle',
          title: catalogDisplayName(entry),
          mcpServerIds: [server.mcp_server_id],
        },
        params
      )) as Session;
      return { session, starter_prompt: entry.starter_prompt };
    },
  };
}
