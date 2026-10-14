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

/** A DCR OAuth server and an explicit client-credentials one, neither with a grant. */
export function dcrAndMachineInstalls(): MCPServer[] {
  const base = { scope: 'global', enabled: true, transport: 'http' } as const;
  return [
    {
      ...base,
      mcp_server_id: 'dcr-id' as MCPServerID,
      name: 'dcr',
      url: 'https://mcp.dcr.test/mcp',
      auth: { type: 'oauth' },
    },
    {
      ...base,
      mcp_server_id: 'm2m-id' as MCPServerID,
      name: 'm2m',
      url: 'https://mcp.m2m.test/mcp',
      auth: { type: 'oauth', oauth_grant_type: 'client_credentials', oauth_client_id: 'svc' },
    },
  ] as MCPServer[];
}

/** A PAT server whose bearer token comes from the acting user's `LINEAR_API_KEY`. */
export function userEnvBearerInstall(): MCPServer {
  return {
    mcp_server_id: 'linear-id' as MCPServerID,
    name: 'linear',
    display_name: 'Linear',
    scope: 'global',
    enabled: true,
    transport: 'http',
    url: 'https://mcp.linear.test/mcp',
    auth: { type: 'bearer', token: '{{ user.env.LINEAR_API_KEY }}' },
  } as MCPServer;
}

/**
 * Real implementations to install into a test file's mocks. Scoping sees only
 * `servers`. The executor auth-header authority returns the grants listed for
 * the acting user (`forUserId`) in `grantsByUser`, and none otherwise; with
 * `lookupFails` it throws, as when the credential repository is unreachable.
 */
export async function realMcpScoping(
  servers: MCPServer[],
  options: { grantsByUser?: Record<string, Record<string, string>>; lookupFails?: boolean } = {}
) {
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
        mcpOAuthAuthHeadersRepo: {
          getAuthHeaders: async (ids: string[]) => {
            if (options.lookupFails) throw new Error('credential repository unavailable');
            const grants = options.grantsByUser?.[deps.forUserId ?? ''] ?? {};
            return Object.fromEntries(
              ids.filter((id) => grants[id]).map((id) => [id, { authorization: grants[id] }])
            );
          },
        },
      } as Parameters<typeof mcp.getMcpServersForSession>[1],
      caps
    );
  return {
    getMcpServersForSession,
    resolveScopedMCPAuthHeaders: mcp.resolveScopedMCPAuthHeaders,
    resolveMCPAuthHeaders: jwt.resolveMCPAuthHeaders,
  };
}
