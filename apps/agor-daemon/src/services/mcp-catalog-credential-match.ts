import type { MCPAuth, MCPCatalogEntry, MCPCatalogServerCandidate } from '@agor/core/types';
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

export interface CatalogCredentialMatcherDeps {
  /** Authoritative binding/mode check; returns only a decision, never material. */
  isGrantAuthorized(candidate: MCPCatalogServerCandidate): Promise<boolean>;
}

export async function hasLiveCallerOAuthGrant(
  candidate: MCPCatalogServerCandidate,
  now: number,
  deps: CatalogCredentialMatcherDeps
): Promise<boolean> {
  const grant = candidate.grant;
  if (!grant?.has_access_token || grant.refresh_status !== 'idle') return false;
  if (grant.expires_at && grant.expires_at <= now) return false;
  return deps.isGrantAuthorized(candidate);
}

export function isCatalogCredentialPeer(
  candidate: MCPCatalogServerCandidate,
  entry: MCPCatalogEntry & { remote_url: string },
  prescribed: MCPAuth
): boolean {
  const server = candidate.server;
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

export function hasCatalogCredentialPolicy(
  candidate: MCPCatalogServerCandidate,
  entry: MCPCatalogEntry & { remote_url: string },
  prescribed: MCPAuth
): boolean {
  const server = candidate.server;
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

export async function compatibleCatalogOAuthPeers(
  entry: MCPCatalogEntry & { remote_url: string },
  candidates: MCPCatalogServerCandidate[]
): Promise<MCPCatalogServerCandidate[]> {
  const prescribed = catalogOAuthConfig(entry);
  return candidates
    .filter(
      (candidate) =>
        isCatalogCredentialPeer(candidate, entry, prescribed) &&
        hasCatalogCredentialPolicy(candidate, entry, prescribed) &&
        sameCatalogEndpoint(candidate.grant?.resource_uri, entry.remote_url)
    )
    .sort((a, b) => (a.server.mcp_server_id < b.server.mcp_server_id ? -1 : 1));
}

export interface CatalogCandidateSelection {
  /** Current canonical catalog row, whether or not its grant is live. */
  currentCatalog?: MCPCatalogServerCandidate;
  /** Owned row occupying this catalog identity and eligible for reconciliation. */
  ownedCatalog?: MCPCatalogServerCandidate;
  /** Live authority in actual Connect priority order. */
  live?: MCPCatalogServerCandidate;
  liveKind?: 'catalog_install' | 'credential_peer';
  compatibleOAuth: MCPCatalogServerCandidate[];
}

/** One selector shared by advisory readiness and authoritative Connect. */
export async function selectCatalogCandidate(
  entry: MCPCatalogEntry & { remote_url: string },
  prescribed: MCPAuth,
  candidates: MCPCatalogServerCandidate[],
  userId: string,
  now: number,
  deps: CatalogCredentialMatcherDeps
): Promise<CatalogCandidateSelection> {
  const catalogRows = candidates.filter(
    ({ server }) => server.source === 'catalog' && server.catalog_entry_name === entry.name
  );
  const currentCatalog = catalogRows.find(
    ({ server, has_row_secret }) =>
      server.enabled &&
      isCurrentCatalogInstall(server, entry, prescribed, {
        reconcileMissingCompatibilityMode: true,
      }) &&
      (!has_row_secret || server.owner_user_id === userId)
  );
  const ownedCatalog =
    currentCatalog ?? catalogRows.find(({ server }) => server.owner_user_id === userId);
  if (prescribed.type !== 'oauth') {
    return {
      currentCatalog,
      ownedCatalog,
      ...(currentCatalog ? { live: currentCatalog, liveKind: 'catalog_install' as const } : {}),
      compatibleOAuth: [],
    };
  }

  const compatibleOAuth = await compatibleCatalogOAuthPeers(entry, candidates);
  // A live current install wins. Crucially, a stale catalog row does not block
  // a live manual peer; this order is also what readiness reports.
  if (currentCatalog && (await hasLiveCallerOAuthGrant(currentCatalog, now, deps))) {
    return {
      currentCatalog,
      ownedCatalog,
      live: currentCatalog,
      liveKind: 'catalog_install',
      compatibleOAuth,
    };
  }
  for (const candidate of compatibleOAuth) {
    if (candidate === currentCatalog) continue;
    if (await hasLiveCallerOAuthGrant(candidate, now, deps)) {
      return {
        currentCatalog,
        ownedCatalog,
        live: candidate,
        liveKind: 'credential_peer',
        compatibleOAuth,
      };
    }
  }
  return { currentCatalog, ownedCatalog, compatibleOAuth };
}
