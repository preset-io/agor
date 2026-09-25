import { and, eq, sql } from 'drizzle-orm';
import type { StoredTenantPublicRouting, TenantPublicRouting } from '../../types/tenant';
import { normalizeHttpBaseUrl } from '../../utils/url';
import type { Database, SystemDatabase, TenantScopedDatabase } from '../client';
import { isPostgresDatabase, lockRowForUpdate, select } from '../database-wrapper';
import { appVariables } from '../schema';
import {
  getCurrentTenantDatabase,
  getCurrentTenantDatabaseScope,
  getCurrentTenantId,
  runWithTenantDatabaseScope,
} from '../tenant-scope';
import { AppVariableRepository } from './app-variables';

// Reserved server-owned metadata. Never expose this through preference APIs.
export const TENANT_PUBLIC_ROUTING_NAMESPACE = 'tenant.routing';
export const TENANT_PUBLIC_ROUTING_KEY = 'public_url';

/** Validate without reflecting assertion values (which may contain secrets). */
export function validateTenantPublicRouting(url: unknown, issuedAt: unknown): TenantPublicRouting {
  try {
    if (
      typeof url !== 'string' ||
      url.length > 2048 ||
      !/^https?:\/\/[^/?#@\\\s]+\/?$/i.test(url) ||
      [...url].some((char) => char.charCodeAt(0) <= 0x1f || char.charCodeAt(0) === 0x7f) ||
      typeof issuedAt !== 'number' ||
      !Number.isSafeInteger(issuedAt) ||
      issuedAt < 0
    )
      throw new Error();
    if (new URL(url).pathname !== '/') throw new Error();
    return {
      public_base_url: normalizeHttpBaseUrl(url),
      assertion_issued_at: issuedAt,
    };
  } catch {
    throw new Error('Invalid tenant public routing metadata');
  }
}

/**
 * Parse one trusted request Host value as a bare authority for `protocol`.
 * Returns null for anything that is not exactly `hostname[:port]`.
 */
function parseRequestAuthority(requestHost: string, protocol: string): URL | null {
  if (!requestHost || requestHost.length > 255 || /[\s,/\\?#@]/.test(requestHost)) return null;
  try {
    const parsed = new URL(`${protocol}//${requestHost}`);
    if (parsed.username || parsed.password || parsed.pathname !== '/') return null;
    if (parsed.search || parsed.hash) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * True only when the trusted request Host names exactly the authority of a
 * tenant's launch-observed public base URL. Default ports are normalized under
 * the public URL's own scheme (`host:443` matches `https://host`); hostnames
 * compare case-insensitively through WHATWG URL parsing. Nothing else is
 * fuzzy: subdomains, ports, and look-alike hosts never match.
 */
export function publicBaseUrlMatchesRequestHost(
  publicBaseUrl: string,
  requestHost: string
): boolean {
  let expected: URL;
  try {
    expected = new URL(publicBaseUrl);
  } catch {
    return false;
  }
  if (expected.pathname !== '/' || expected.username || expected.password) return false;
  const presented = parseRequestAuthority(requestHost, expected.protocol);
  return presented !== null && presented.host === expected.host;
}

/**
 * Pre-authentication Host -> tenant discovery for personal API keys.
 *
 * Runs only under the `api_key_host_tenant_discovery` system capability, whose
 * RLS policy exposes nothing but `tenant.routing/public_url` rows. It returns
 * tenant routing IDs, never values, and every candidate must carry the same
 * tenant binding `TenantPublicRoutingRepository.find()` requires. The caller
 * must treat no tenant as a failed login and must verify the credential under
 * the returned tenant's ordinary RLS scope.
 */
export class TenantPublicRoutingDiscoveryRepository {
  constructor(private readonly db: SystemDatabase) {
    if (!isPostgresDatabase(db)) {
      throw new Error('Tenant public routing discovery requires PostgreSQL');
    }
  }

  /**
   * The tenant whose launch-observed public URL is this request host, or null.
   *
   * Routing rows are written only from Cloud-signed launch assertions, so when
   * a hostname moved between workspaces and an old row still names it, the
   * claim with the newest signed `assertion_issued_at` is the current one.
   * Several tenants tied at the newest assertion fail closed (null).
   */
  async findTenantIdByRequestHost(requestHost: string): Promise<string | null> {
    const probe = parseRequestAuthority(requestHost, 'https:');
    if (!probe) return null;
    const tenantColumn = (appVariables as unknown as { tenant_id?: typeof appVariables.key })
      .tenant_id;
    if (!tenantColumn) {
      throw new Error('Tenant public routing discovery requires tenant metadata');
    }
    const rows = await select(this.db, {
      tenant_id: tenantColumn,
      value_text: appVariables.value_text,
      is_encrypted: appVariables.is_encrypted,
    })
      .from(appVariables)
      .where(
        and(
          eq(appVariables.namespace, TENANT_PUBLIC_ROUTING_NAMESPACE),
          eq(appVariables.key, TENANT_PUBLIC_ROUTING_KEY),
          // Cheap literal prefilter; the exact authority comparison below is
          // the only match decision.
          sql`strpos(${appVariables.value_text}, ${probe.hostname}) > 0`
        )
      )
      .all();

    const newestByTenant = new Map<string, number>();
    for (const row of rows as Array<{
      tenant_id: unknown;
      value_text: unknown;
      is_encrypted: unknown;
    }>) {
      if (typeof row.tenant_id !== 'string' || !row.tenant_id) continue;
      if (row.is_encrypted || typeof row.value_text !== 'string') continue;
      let routing: TenantPublicRouting;
      try {
        const parsed = JSON.parse(row.value_text) as StoredTenantPublicRouting;
        // Same import guard as find(): the assertion's tenant binding wins.
        if (parsed.tenant_id !== row.tenant_id) continue;
        routing = validateTenantPublicRouting(parsed.public_base_url, parsed.assertion_issued_at);
      } catch {
        continue;
      }
      if (publicBaseUrlMatchesRequestHost(routing.public_base_url, requestHost)) {
        const seen = newestByTenant.get(row.tenant_id);
        if (seen === undefined || routing.assertion_issued_at > seen) {
          newestByTenant.set(row.tenant_id, routing.assertion_issued_at);
        }
      }
    }
    let winner: string | null = null;
    let newest = Number.NEGATIVE_INFINITY;
    let tied = false;
    for (const [tenantId, issuedAt] of newestByTenant) {
      if (issuedAt > newest) {
        winner = tenantId;
        newest = issuedAt;
        tied = false;
      } else if (issuedAt === newest) {
        tied = true;
      }
    }
    return tied ? null : winner;
  }
}

export class TenantPublicRoutingRepository {
  constructor(private db: TenantScopedDatabase) {}

  async find(): Promise<TenantPublicRouting | null> {
    const value = await new AppVariableRepository(this.db).getPlain(
      TENANT_PUBLIC_ROUTING_NAMESPACE,
      TENANT_PUBLIC_ROUTING_KEY
    );
    if (value === null) return null;
    try {
      const parsed = JSON.parse(value) as StoredTenantPublicRouting;
      // Archive imports can rewrite the row's tenant_id, not the original
      // assertion binding. Another tenant must reinitialize through launch.
      if (parsed.tenant_id !== getCurrentTenantId()) return null;
      return validateTenantPublicRouting(parsed.public_base_url, parsed.assertion_issued_at);
    } catch {
      throw new Error('Invalid stored tenant public routing metadata');
    }
  }

  /**
   * Called only after verified launch, inside the same tenant transaction and
   * authorization fence as user projection. That fence serializes all users
   * across replicas, including the initial insert. Older assertions cannot
   * undo a newer observation; equal-iat conflicts retain the first observation.
   */
  async observeVerifiedLaunch(routing: TenantPublicRouting): Promise<void> {
    const next = validateTenantPublicRouting(routing.public_base_url, routing.assertion_issued_at);
    const scope = getCurrentTenantDatabaseScope();
    if (
      scope?.kind !== 'tenant' ||
      !scope.transactionActive ||
      !scope.tenantId ||
      scope.tenantId !== getCurrentTenantId() ||
      scope.db !== this.db
    ) {
      throw new Error('Tenant routing updates require the active tenant transaction');
    }
    const variables = new AppVariableRepository(this.db);
    const data = {
      namespace: TENANT_PUBLIC_ROUTING_NAMESPACE,
      key: TENANT_PUBLIC_ROUTING_KEY,
      value: JSON.stringify({
        ...next,
        tenant_id: scope.tenantId,
      } satisfies StoredTenantPublicRouting),
      content_type: 'application/json',
    };
    await variables.setIfAbsent(data);
    await lockRowForUpdate(
      this.db,
      this.db,
      appVariables,
      and(
        eq(appVariables.namespace, TENANT_PUBLIC_ROUTING_NAMESPACE),
        eq(appVariables.key, TENANT_PUBLIC_ROUTING_KEY)
      )!
    );
    const current = await this.find();
    if (current && current.assertion_issued_at >= next.assertion_issued_at) return;
    await variables.set(data);
  }
}

/**
 * Why a tenant public link could not be resolved, as a stable code.
 *
 * Mirrors `PublicBaseUrlNotConfiguredError.code` (`config/config-manager.ts`),
 * and for the same
 * reason: these two were bare `new Error(...)`s, so the only thing that
 * distinguished them was their message — which
 * `context/guidelines/logging.md` forbids logging, and which a classifier
 * therefore must not read. The live incident of 2026-09-16 was the second of
 * them, and the lane reported it as `unexpected`.
 */
export class TenantPublicBaseUrlError extends Error {
  constructor(
    readonly code:
      | 'TENANT_PUBLIC_BASE_URL_IDENTITY_REQUIRED'
      | 'TENANT_PUBLIC_BASE_URL_DATABASE_REQUIRED',
    message: string
  ) {
    super(message);
    this.name = 'TenantPublicBaseUrlError';
  }
}

/** No process cache: background work and every replica observe durable routing. */
export async function getTenantPublicBaseUrl(db?: Database): Promise<string> {
  const tenantId = getCurrentTenantId();
  if (!tenantId) {
    throw new TenantPublicBaseUrlError(
      'TENANT_PUBLIC_BASE_URL_IDENTITY_REQUIRED',
      'Tenant public links require trusted tenant identity'
    );
  }
  const database = db ?? getCurrentTenantDatabase();
  if (!database) {
    throw new TenantPublicBaseUrlError(
      'TENANT_PUBLIC_BASE_URL_DATABASE_REQUIRED',
      'Tenant public links require a tenant database'
    );
  }
  return runWithTenantDatabaseScope(database, tenantId, async (scoped) => {
    const routing = await new TenantPublicRoutingRepository(scoped).find();
    // Existing entity projections represent unavailable links as null/empty.
    // Never substitute a cell-wide origin for an uninitialized hosted tenant.
    return routing?.public_base_url ?? '';
  });
}
