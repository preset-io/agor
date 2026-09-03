import type { MCPCatalogEntry, MCPCatalogProbedAuthType } from '@agor/core/types';
import { MCPExternalError } from '../tools/mcp/external-error';
import {
  OAuthConfigurationError,
  resolveMCPOAuthDiscovery,
  validateMCPOAuthMetadata,
} from '../tools/mcp/oauth-mcp-transport';
import { assertSafeOutboundUrl, UnsafeOutboundUrlError } from '../utils/safe-outbound-fetch';
import { probeRemoteAuth, type RemoteAuthProbeResult } from './auth-probe';

export type CatalogHealthStatus =
  | 'ready'
  | 'credential-required'
  | 'oauth-now-available'
  | 'unreachable'
  | 'indeterminate'
  | 'auth-drift'
  | 'oauth-metadata-not-ready';

export type CatalogHealthReason =
  | 'probe_failed'
  | 'auth_mismatch'
  | 'credential_not_verified'
  | 'metadata_unavailable'
  | 'metadata_incompatible'
  | 'endpoint_override_mismatch'
  | 'issuer_mismatch'
  | 'pkce_required'
  | 'client_registration_required'
  | 'external_provider_unavailable'
  | 'external_provider_rejected'
  | 'external_invalid_response'
  | 'external_configuration_required'
  | 'external_unknown'
  | 'unexpected_error';

export interface CatalogHealthResult {
  name: string;
  status: CatalogHealthStatus;
  expectedAuth: MCPCatalogEntry['auth_type'];
  observedAuth: MCPCatalogProbedAuthType;
  reason?: CatalogHealthReason;
  /** Safe production error text or a bounded unexpected-error classification. */
  error?: string;
}

export interface CatalogHealthAuditDependencies {
  probe?: (url: string) => Promise<RemoteAuthProbeResult>;
  oauthMetadataReady?: (entry: MCPCatalogEntry, challenge: string | undefined) => Promise<void>;
}

/**
 * Read-only OAuth readiness check. Production discovery and its exact
 * resource/issuer/endpoint/PKCE validators are reused, but this deliberately
 * stops before DCR or user authorization so an audit cannot create a vendor
 * client.
 */
async function assertOAuthMetadataReady(
  entry: MCPCatalogEntry,
  challenge: string | undefined
): Promise<void> {
  if (!entry.remote_url) {
    throw new OAuthConfigurationError('metadata_unavailable', 'Catalog entry has no remote URL');
  }
  const compatibilityMode = entry.oauth?.compatibility_mode ?? 'marketplace';
  const discovery = await resolveMCPOAuthDiscovery(challenge ?? null, entry.remote_url, {
    compatibilityMode,
  });
  if (!discovery) {
    throw new OAuthConfigurationError(
      'metadata_unavailable',
      'OAuth metadata discovery did not find a protected-resource or authorization-server document'
    );
  }

  const validated = await validateMCPOAuthMetadata(discovery, entry.remote_url, {
    compatibilityMode,
  });
  if (entry.oauth?.client_id) return;
  if (entry.oauth?.dcr_mode === 'disabled' || !validated.registrationEndpoint) {
    throw new OAuthConfigurationError(
      'client_registration_required',
      'OAuth metadata does not advertise Dynamic Client Registration and the catalog has no public client ID'
    );
  }
  try {
    await assertSafeOutboundUrl(validated.registrationEndpoint);
  } catch (error) {
    if (error instanceof UnsafeOutboundUrlError || error instanceof TypeError) {
      throw new OAuthConfigurationError(
        'metadata_incompatible',
        'OAuth metadata advertises an unsafe Dynamic Client Registration endpoint'
      );
    }
    throw error;
  }
}

function boundedUnexpectedError(error: unknown): string {
  if (!(error instanceof Error)) return 'Unexpected non-Error rejection';
  const name = error.name || 'Error';
  const message = error.message
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, 300);
  return message ? `${name}: ${message}` : name;
}

function describeOAuthError(error: unknown): {
  reason: CatalogHealthReason;
  error: string;
  transient: boolean;
} {
  if (error instanceof OAuthConfigurationError) {
    return {
      reason: error.failureCode,
      error: error.message,
      // Discovery and metadata fetch failures can be vendor weather. Contract
      // contradictions have their own stable codes and remain actionable.
      transient: error.failureCode === 'metadata_unavailable',
    };
  }
  if (error instanceof MCPExternalError) {
    return {
      reason: `external_${error.category}`,
      error: `${error.message} (${error.diagnostic.stage}${error.diagnostic.code ? `/${error.diagnostic.code}` : ''})`,
      transient: error.category === 'provider_unavailable',
    };
  }
  return { reason: 'unexpected_error', error: boundedUnexpectedError(error), transient: true };
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

    if (entry.auth_type === 'oauth' || reviewedBearerOAuth) {
      try {
        await oauthMetadataReady(entry, observed.wwwAuthenticate);
      } catch (error) {
        const detail = describeOAuthError(error);
        if (reviewedBearerOAuth) {
          return {
            ...base,
            status: 'credential-required',
            reason: detail.reason,
            error: detail.error,
          };
        }
        return {
          ...base,
          status: detail.transient ? 'indeterminate' : 'oauth-metadata-not-ready',
          reason: detail.reason,
          error: detail.error,
        };
      }
      if (reviewedBearerOAuth) return { ...base, status: 'oauth-now-available' };
    }

    // The public challenge was checked, but only an authenticated initialize
    // can establish that a PAT/credential really works. Scheduled audits have
    // no user secret and must not call that state fully verified.
    if (entry.auth_type === 'credentials') {
      return {
        ...base,
        status: 'credential-required',
        reason: 'credential_not_verified',
      };
    }
    return { ...base, status: 'ready' };
  };

  // Keep scheduled checks useful without turning a catalog expansion into an
  // outbound connection burst. Ordering remains catalog ordering for stable
  // logs and summaries. Every entry is contained so one unexpected rejection
  // cannot discard the other results.
  const workers = Array.from({ length: Math.min(6, entries.length) }, async () => {
    while (nextIndex < entries.length) {
      const index = nextIndex++;
      const entry = entries[index];
      try {
        results[index] = await auditOne(entry);
      } catch (error) {
        const detail = describeOAuthError(error);
        results[index] = {
          name: entry.name,
          status: 'indeterminate',
          expectedAuth: entry.auth_type,
          observedAuth: 'unknown',
          reason: detail.reason,
          error: detail.error,
        };
      }
    }
  });
  await Promise.all(workers);
  return results;
}
