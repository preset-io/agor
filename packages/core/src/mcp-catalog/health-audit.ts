import type { MCPCatalogEntry, MCPCatalogProbedAuthType } from '@agor/core/types';
import {
  type AuthorizationServerMetadata,
  fetchAuthorizationServerMetadata,
  fetchResourceMetadata,
  resolveMCPOAuthDiscovery,
} from '../tools/mcp/oauth-mcp-transport';
import { probeRemoteAuth, type RemoteAuthProbeResult } from './auth-probe';

export type CatalogHealthStatus =
  | 'ready'
  | 'unreachable'
  | 'indeterminate'
  | 'auth-drift'
  | 'oauth-metadata-not-ready';

export interface CatalogHealthResult {
  name: string;
  status: CatalogHealthStatus;
  expectedAuth: MCPCatalogEntry['auth_type'];
  observedAuth: MCPCatalogProbedAuthType;
  reason?: 'probe_failed' | 'auth_mismatch' | 'metadata_missing' | 'dcr_missing' | 'pkce_missing';
}

export interface CatalogHealthAuditDependencies {
  probe?: (url: string) => Promise<RemoteAuthProbeResult>;
  oauthMetadataReady?: (entry: MCPCatalogEntry, challenge: string | undefined) => Promise<void>;
}

/**
 * Read-only OAuth readiness check. It follows the same SSRF-hardened discovery
 * implementation as the real flow but deliberately stops before DCR or user
 * authorization, so a scheduled audit cannot create vendor-side clients.
 */
async function assertOAuthMetadataReady(
  entry: MCPCatalogEntry,
  challenge: string | undefined
): Promise<void> {
  if (!entry.remote_url) throw new Error('metadata_missing');
  const compatibilityMode = entry.oauth?.compatibility_mode ?? 'marketplace';
  const discovery = await resolveMCPOAuthDiscovery(challenge ?? null, entry.remote_url, {
    compatibilityMode,
  });
  if (!discovery) throw new Error('metadata_missing');

  let metadata: AuthorizationServerMetadata;
  if (discovery.kind === 'authorization-server') {
    metadata = discovery.authServerMetadata;
  } else {
    const resource = await fetchResourceMetadata(discovery.metadataUrl);
    const advertisedResource = Array.isArray(resource.resource)
      ? resource.resource[0]
      : resource.resource;
    if (!advertisedResource && compatibilityMode === 'strict') throw new Error('metadata_missing');
    if (advertisedResource) {
      const expected = new URL(entry.remote_url);
      const actual = new URL(advertisedResource);
      const exact = actual.href.replace(/\/$/, '') === expected.href.replace(/\/$/, '');
      const boundedParent =
        compatibilityMode !== 'strict' &&
        actual.origin === expected.origin &&
        (expected.pathname === actual.pathname ||
          expected.pathname.startsWith(`${actual.pathname.replace(/\/$/, '')}/`));
      if (!exact && !boundedParent) throw new Error('metadata_missing');
    }
    const issuer = resource.authorization_servers?.[0];
    if (!issuer) throw new Error('metadata_missing');
    metadata = await fetchAuthorizationServerMetadata(issuer, { compatibilityMode });
  }

  if (!metadata.code_challenge_methods_supported?.includes('S256')) throw new Error('pkce_missing');
  if (
    compatibilityMode === 'strict' &&
    metadata.authorization_response_iss_parameter_supported !== true
  )
    throw new Error('metadata_missing');
  if (
    !entry.oauth?.client_id &&
    entry.oauth?.dcr_mode !== 'disabled' &&
    !metadata.registration_endpoint
  )
    throw new Error('dcr_missing');
}

export async function auditCatalogHealth(
  entries: readonly MCPCatalogEntry[],
  dependencies: CatalogHealthAuditDependencies = {}
): Promise<CatalogHealthResult[]> {
  const probe = dependencies.probe ?? probeRemoteAuth;
  const oauthMetadataReady = dependencies.oauthMetadataReady ?? assertOAuthMetadataReady;

  const results = new Array<CatalogHealthResult>(entries.length);
  let nextIndex = 0;
  const auditOne = async (entry: MCPCatalogEntry): Promise<CatalogHealthResult> => {
    const observed = entry.remote_url
      ? await probe(entry.remote_url)
      : ({ authType: 'unknown' } satisfies RemoteAuthProbeResult);
    const base = {
      name: entry.name,
      expectedAuth: entry.auth_type,
      observedAuth: observed.authType,
    };
    if (observed.authType === 'unreachable')
      return { ...base, status: 'unreachable', reason: 'probe_failed' };
    if (observed.authType === 'unknown')
      return { ...base, status: 'indeterminate', reason: 'probe_failed' };

    const reviewedBearerOAuth =
      entry.auth_type === 'credentials' &&
      observed.authType === 'oauth' &&
      entry.credentials?.oauth_challenge_compatible;
    if (entry.auth_type !== observed.authType && !reviewedBearerOAuth)
      return { ...base, status: 'auth-drift', reason: 'auth_mismatch' };

    if (entry.auth_type === 'oauth') {
      try {
        await oauthMetadataReady(entry, observed.wwwAuthenticate);
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        const reason =
          message === 'dcr_missing'
            ? 'dcr_missing'
            : message === 'pkce_missing'
              ? 'pkce_missing'
              : 'metadata_missing';
        return { ...base, status: 'oauth-metadata-not-ready', reason };
      }
    }
    return { ...base, status: 'ready' };
  };

  // Keep scheduled checks useful without turning a catalog expansion into an
  // outbound connection burst. Ordering remains catalog ordering for stable
  // logs and summaries.
  const workers = Array.from({ length: Math.min(6, entries.length) }, async () => {
    while (nextIndex < entries.length) {
      const index = nextIndex++;
      results[index] = await auditOne(entries[index]);
    }
  });
  await Promise.all(workers);
  return results;
}
