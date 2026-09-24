/**
 * Tenant routing for personal API keys in hosted (`required_from_auth`)
 * deployments.
 *
 * An `agor_sk_` key is opaque: it carries no signed tenant claim, so on a
 * multi-tenant Cell the daemon cannot know which tenant's `user_api_keys` rows
 * to verify it against. The workspace URL can: the edge routes by `Host`, the
 * operator declares that header trusted for launch
 * (`external_launch.forward_request_host`), and each tenant's launch-observed
 * public URL is stored in `tenant.routing/public_url`.
 *
 * Contract:
 * - The Host is a routing hint only. It selects exactly one tenant scope; the
 *   key must then verify under that tenant's ordinary RLS. A key presented to
 *   another workspace's URL finds no row and fails.
 * - Zero or several matching tenants, an untrusted/absent Host, or a tenant
 *   with no recorded public URL all fail closed with the same message used for
 *   any missing tenant context, so this path is not a tenant oracle.
 * - Discovery runs under the narrow `api_key_host_tenant_discovery` system
 *   capability (RLS exposes only routing rows) and returns tenant IDs only.
 */

import {
  type AgorConfig,
  type ResolvedExternalLaunchProvider,
  resolveMultiTenancyConfig,
  resolveValidExternalLaunchProvider,
  TenantResolutionError,
} from '@agor/core/config';
import {
  publicBaseUrlMatchesRequestHost,
  runWithoutTenantContext,
  runWithoutTenantDatabaseScope,
  runWithSystemDatabaseScope,
  runWithTenantContext,
  runWithTenantDatabaseScope,
  TenantPublicRoutingDiscoveryRepository,
  TenantPublicRoutingRepository,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import { PERSONAL_API_KEY_PREFIX, type TenantContext, type TenantID } from '@agor/core/types';
import { resolveRequestHost } from './launch-auth.js';

/** Deliberately identical to the resolver's generic missing-tenant failure. */
const MISSING_TENANT_MESSAGE = 'Missing tenant context for multi_tenancy.required_from_auth';

function headerValues(headers: Record<string, unknown> | undefined, name: string): string[] {
  if (!headers) return [];
  const values: string[] = [];
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      if (typeof item === 'string') values.push(item.trim());
    }
  }
  return values;
}

/** True when the request presents a personal API key in a supported header. */
export function hasPersonalApiKeyHeader(headers: Record<string, unknown> | undefined): boolean {
  if (headerValues(headers, 'x-api-key').some((v) => v.startsWith(PERSONAL_API_KEY_PREFIX))) {
    return true;
  }
  return headerValues(headers, 'authorization').some((value) => {
    const match = value.match(/^Bearer\s+(\S+)$/i);
    return Boolean(match?.[1]?.startsWith(PERSONAL_API_KEY_PREFIX));
  });
}

export type ApiKeyHostTenantResolver = (
  headers: Record<string, unknown> | undefined
) => Promise<TenantContext>;

export interface ApiKeyHostTenantResolverOptions {
  db: TenantScopeAwareDatabase;
  config: Pick<AgorConfig, 'multi_tenancy' | 'external_launch'>;
  /** Retained startup model; resolved from `config` when omitted. */
  provider?: ResolvedExternalLaunchProvider;
}

/**
 * Returns null when this deployment cannot route personal keys by Host (static
 * tenancy needs no routing; hosted tenancy without a trusted Host header must
 * keep failing closed).
 */
export function createApiKeyHostTenantResolver(
  options: ApiKeyHostTenantResolverOptions
): ApiKeyHostTenantResolver | null {
  if (resolveMultiTenancyConfig(options.config).mode !== 'required_from_auth') return null;

  let provider: ResolvedExternalLaunchProvider;
  try {
    provider = options.provider ?? resolveValidExternalLaunchProvider(options.config as AgorConfig);
  } catch {
    // Startup already rejects invalid launch config; never widen access here.
    return null;
  }
  if (!provider.enabled || !provider.forwardRequestHost) return null;

  const { db } = options;

  return async (headers) => {
    let requestHost: string | undefined;
    try {
      requestHost = resolveRequestHost(provider, headers);
    } catch {
      throw new TenantResolutionError(MISSING_TENANT_MESSAGE);
    }
    if (!requestHost) throw new TenantResolutionError(MISSING_TENANT_MESSAGE);
    const host = requestHost;

    const tenantIds = await runWithoutTenantContext(() =>
      runWithoutTenantDatabaseScope(() =>
        runWithSystemDatabaseScope(
          db,
          'Personal API key host tenant discovery',
          (systemDb) =>
            new TenantPublicRoutingDiscoveryRepository(systemDb).findTenantIdsByRequestHost(host),
          { capability: 'api_key_host_tenant_discovery' }
        )
      )
    );
    if (tenantIds.length !== 1) throw new TenantResolutionError(MISSING_TENANT_MESSAGE);
    const tenantId = tenantIds[0] as TenantID;

    // Re-read the binding under the discovered tenant's ordinary RLS so a
    // misconfigured discovery policy can never be the only check.
    const confirmed = await runWithoutTenantContext(() =>
      runWithoutTenantDatabaseScope(() =>
        runWithTenantContext(tenantId, () =>
          runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
            const routing = await new TenantPublicRoutingRepository(scoped).find();
            return (
              routing !== null && publicBaseUrlMatchesRequestHost(routing.public_base_url, host)
            );
          })
        )
      )
    );
    if (!confirmed) throw new TenantResolutionError(MISSING_TENANT_MESSAGE);

    return { tenant_id: tenantId, source: 'trusted_host' };
  };
}
