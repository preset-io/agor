/**
 * Drive executor MCP setup through the REAL scoping, template resolution, and
 * auth-header path, for test files that otherwise mock `@agor/core/mcp` and
 * `@agor/core/tools/mcp/jwt-auth`. Template resolution normalizes stored auth
 * (for example defaulting `oauth_grant_type`), and mocks hide that.
 */

import type { MCPServer, MCPServerID } from '@agor/core/types';
import { vi } from 'vitest';

/** The shipped `com.asana/mcp` recipe, installed with a customer-owned app and no grant. */
export async function shippedAsanaInstall(oauthMode: 'per_user' | 'shared'): Promise<MCPServer> {
  const { findCatalogEntry, loadCatalog } =
    await vi.importActual<typeof import('@agor/core/mcp-catalog')>('@agor/core/mcp-catalog');
  const entry = findCatalogEntry(await loadCatalog(), 'com.asana/mcp');
  if (!entry?.remote_url || !entry.oauth?.configured_client) {
    throw new Error('shipped Asana recipe is no longer a configured_client remote entry');
  }
  return {
    mcp_server_id: 'asana-id' as MCPServerID,
    name: 'asana',
    display_name: 'Asana',
    scope: 'global',
    source: 'catalog',
    catalog_entry_name: entry.name,
    enabled: true,
    transport: 'http',
    url: entry.remote_url,
    // What a Connect install stores: the catalog's prescribed OAuth config
    // plus the customer's own app. No grant type is ever set.
    auth: {
      type: 'oauth',
      oauth_mode: oauthMode,
      ...(entry.oauth.scope ? { oauth_scope: entry.oauth.scope } : {}),
      ...(entry.oauth.dcr_mode ? { oauth_dcr_mode: entry.oauth.dcr_mode } : {}),
      ...(entry.oauth.compatibility_mode
        ? { oauth_compatibility_mode: entry.oauth.compatibility_mode }
        : {}),
      oauth_client_id: 'customer-app',
      oauth_client_secret: 'customer-secret',
    },
  } as MCPServer;
}

/**
 * Real implementations to install into a test file's mocks. Scoping sees only
 * `servers`, and the executor auth-header authority returns no grant for any.
 */
export async function realMcpScoping(servers: MCPServer[]) {
  const mcp = await vi.importActual<typeof import('@agor/core/mcp')>('@agor/core/mcp');
  const jwt = await vi.importActual<typeof import('@agor/core/tools/mcp/jwt-auth')>(
    '@agor/core/tools/mcp/jwt-auth'
  );
  const getMcpServersForSession: typeof mcp.getMcpServersForSession = (sessionId, deps, caps) =>
    mcp.getMcpServersForSession(
      sessionId,
      {
        forUserId: deps.forUserId,
        sessionMCPRepo: {
          listServers: async () => [],
          listEffectiveServers: async () => servers,
        },
        mcpServerRepo: { findAll: async () => [] },
        mcpOAuthAuthHeadersRepo: { getAuthHeaders: async () => ({}) },
      } as Parameters<typeof mcp.getMcpServersForSession>[1],
      caps
    );
  return {
    getMcpServersForSession,
    resolveScopedMCPAuthHeaders: mcp.resolveScopedMCPAuthHeaders,
    resolveMCPAuthHeaders: jwt.resolveMCPAuthHeaders,
  };
}
