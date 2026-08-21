import type { MCPAuth, MCPCatalogEntry, MCPServer, MCPServerID } from '@agor/core/types';
import {
  catalogOAuthConfig,
  catalogServerTransport,
  isCurrentCatalogInstall,
  sameCatalogEndpoint,
} from './mcp-catalog-install-policy.js';

const CREDENTIAL_ROUTING_OVERRIDES = [
  'oauth_authorization_url',
  'oauth_token_url',
  'oauth_client_secret',
] as const satisfies readonly (keyof MCPAuth)[];

export function hasLiveCallerOAuthGrant(server: MCPServer, now: number): boolean {
  const auth = server.auth;
  if (!auth?.oauth_access_token) return false;
  const expiresAt = auth.oauth_token_expires_at;
  return !(expiresAt && expiresAt <= now);
}

export function isCatalogCredentialPeer(
  server: MCPServer,
  entry: MCPCatalogEntry & { remote_url: string },
  prescribed: MCPAuth
): boolean {
  const auth = server.auth;
  if (auth?.type !== 'oauth' || prescribed.type !== 'oauth') return false;
  if ((auth.oauth_mode ?? 'per_user') !== 'per_user') return false;
  if (CREDENTIAL_ROUTING_OVERRIDES.some((field) => auth[field])) return false;
  if ((auth.oauth_scope ?? undefined) !== (prescribed.oauth_scope ?? undefined)) return false;
  return (
    server.enabled &&
    server.transport === catalogServerTransport(entry) &&
    sameCatalogEndpoint(server.url, entry.remote_url) &&
    Object.keys(server.headers ?? {}).length === 0
  );
}

export async function hasCatalogCredentialPolicy(
  server: MCPServer,
  entry: MCPCatalogEntry & { remote_url: string },
  prescribed: MCPAuth
): Promise<boolean> {
  if (server.auth?.oauth_client_id !== prescribed.oauth_client_id) return false;
  if (
    (server.auth?.oauth_dcr_mode ?? 'advertised') !== (prescribed.oauth_dcr_mode ?? 'advertised')
  ) {
    return false;
  }
  const actual =
    server.auth?.oauth_compatibility_mode ??
    (isCurrentCatalogInstall(server, entry, prescribed, {
      reconcileMissingCompatibilityMode: true,
    })
      ? (entry.oauth?.compatibility_mode ?? 'marketplace')
      : 'strict');
  return actual === (entry.oauth?.compatibility_mode ?? 'marketplace');
}

export interface CatalogCredentialMatcherDeps {
  readGrantResourceUri(serverId: MCPServerID): Promise<string | undefined>;
}

/**
 * Return compatible rows in stable order. This is deliberately shared by the
 * advisory readiness read and authoritative Connect path so they cannot drift
 * on endpoint, policy, scope, routing overrides, or protected-resource bounds.
 */
export async function compatibleCatalogOAuthPeers(
  entry: MCPCatalogEntry & { remote_url: string },
  servers: MCPServer[],
  deps: CatalogCredentialMatcherDeps
): Promise<MCPServer[]> {
  const prescribed = catalogOAuthConfig(entry);
  const candidates: MCPServer[] = [];
  for (const server of servers) {
    if (!isCatalogCredentialPeer(server, entry, prescribed)) continue;
    if (!(await hasCatalogCredentialPolicy(server, entry, prescribed))) continue;
    const resourceUri = await deps.readGrantResourceUri(server.mcp_server_id);
    if (!sameCatalogEndpoint(resourceUri, entry.remote_url)) continue;
    candidates.push(server);
  }
  return candidates.sort((a, b) => (a.mcp_server_id < b.mcp_server_id ? -1 : 1));
}

export async function findLiveReusableCatalogOAuthCredential(
  entry: MCPCatalogEntry & { remote_url: string },
  servers: MCPServer[],
  now: number,
  deps: CatalogCredentialMatcherDeps
): Promise<MCPServer | undefined> {
  const peers = await compatibleCatalogOAuthPeers(entry, servers, deps);
  return peers.find((server) => hasLiveCallerOAuthGrant(server, now));
}
