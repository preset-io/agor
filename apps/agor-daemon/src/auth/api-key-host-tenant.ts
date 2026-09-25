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
 * - When a hostname moved between workspaces and an old routing row still
 *   names it, the newest Cloud-signed launch assertion wins; a tie fails closed.
 * - No matching tenant, an untrusted/absent Host, or a tenant with no recorded
 *   public URL all fail with the generic missing-tenant message. That hides
 *   why routing failed, but it does not hide whether a Host routes at all: a
 *   routable Host with a bad key reaches key verification (`Invalid API key`).
 *   Workspace hosts are public, so this reveals nothing new.
 * - Discovery runs under the narrow `api_key_host_tenant_discovery` system
 *   capability (RLS exposes only routing rows) and returns a tenant ID only.
 * - Results are cached per Host for a short time, so a stream of garbage
 *   `agor_sk_` keys at a real workspace host costs no discovery queries per
 *   request. Revocation is unaffected: the key itself is verified every time.
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

/** How long a Host → tenant answer is reused (a miss is retried sooner). */
const HOST_TENANT_CACHE_TTL_MS = 30_000;
const HOST_TENANT_MISS_TTL_MS = 5_000;
/** Bounds memory against arbitrary Host headers; oldest entries go first. */
const HOST_TENANT_CACHE_MAX_ENTRIES = 1_024;

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
  /** Test seam for the Host → tenant cache clock. */
  now?: () => number;
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
  const now = options.now ?? Date.now;
  const cache = new Map<string, { tenantId: TenantID | null; expiresAt: number }>();

  const lookup = async (host: string): Promise<TenantID | null> => {
    const tenantId = await runWithoutTenantContext(() =>
      runWithoutTenantDatabaseScope(() =>
        runWithSystemDatabaseScope(
          db,
          'Personal API key host tenant discovery',
          (systemDb) =>
            new TenantPublicRoutingDiscoveryRepository(systemDb).findTenantIdByRequestHost(host),
          { capability: 'api_key_host_tenant_discovery' }
        )
      )
    );
    if (!tenantId) return null;
    const discovered = tenantId as TenantID;

    // Re-read the binding under the discovered tenant's ordinary RLS so a
    // misconfigured discovery policy can never be the only check.
    const confirmed = await runWithoutTenantContext(() =>
      runWithoutTenantDatabaseScope(() =>
        runWithTenantContext(discovered, () =>
          runWithTenantDatabaseScope(db, discovered, async (scoped) => {
            const routing = await new TenantPublicRoutingRepository(scoped).find();
            return (
              routing !== null && publicBaseUrlMatchesRequestHost(routing.public_base_url, host)
            );
          })
        )
      )
    );
    return confirmed ? discovered : null;
  };

  const cachedLookup = async (host: string): Promise<TenantID | null> => {
    const key = host.toLowerCase();
    const hit = cache.get(key);
    if (hit && hit.expiresAt > now()) return hit.tenantId;
    cache.delete(key);
    const tenantId = await lookup(host);
    if (cache.size >= HOST_TENANT_CACHE_MAX_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, {
      tenantId,
      expiresAt: now() + (tenantId ? HOST_TENANT_CACHE_TTL_MS : HOST_TENANT_MISS_TTL_MS),
    });
    return tenantId;
  };

  return async (headers) => {
    let requestHost: string | undefined;
    try {
      requestHost = resolveRequestHost(provider, headers);
    } catch {
      throw new TenantResolutionError(MISSING_TENANT_MESSAGE);
    }
    if (!requestHost) throw new TenantResolutionError(MISSING_TENANT_MESSAGE);

    const tenantId = await cachedLookup(requestHost);
    if (!tenantId) throw new TenantResolutionError(MISSING_TENANT_MESSAGE);

    return { tenant_id: tenantId, source: 'trusted_host' };
  };
}
