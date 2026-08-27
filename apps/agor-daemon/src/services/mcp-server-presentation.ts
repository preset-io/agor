import { loadCatalog } from '@agor/core/mcp-catalog';
import type { MCPServer } from '@agor/core/types';
import {
  presentMCPOAuthCompatibilityPolicy,
  resolveMCPOAuthCompatibilityPolicy,
} from './mcp-oauth-compatibility.js';

/** Secret-free compatibility projection used by ordinary reads. */
export async function presentMCPServerOAuthPolicies(
  servers: readonly MCPServer[]
): Promise<MCPServer[]> {
  if (!servers.some((server) => server.auth?.type === 'oauth')) return [...servers];
  const catalog = await loadCatalog();
  return Promise.all(
    servers.map(async (server) => {
      if (server.auth?.type !== 'oauth') return server;
      const policy = await resolveMCPOAuthCompatibilityPolicy(server, catalog);
      return {
        ...server,
        oauth_compatibility_policy: presentMCPOAuthCompatibilityPolicy(policy),
      };
    })
  );
}
