import { and, eq } from 'drizzle-orm';
import type { StoredTenantPublicRouting, TenantPublicRouting } from '../../types/tenant';
import { normalizeHttpBaseUrl } from '../../utils/url';
import type { Database, TenantScopedDatabase } from '../client';
import { lockRowForUpdate } from '../database-wrapper';
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

/** No process cache: background work and every replica observe durable routing. */
export async function getTenantPublicBaseUrl(db?: Database): Promise<string> {
  const tenantId = getCurrentTenantId();
  if (!tenantId) throw new Error('Tenant public links require trusted tenant identity');
  const database = db ?? getCurrentTenantDatabase();
  if (!database) throw new Error('Tenant public links require a tenant database');
  return runWithTenantDatabaseScope(database, tenantId, async (scoped) => {
    const routing = await new TenantPublicRoutingRepository(scoped).find();
    // Existing entity projections represent unavailable links as null/empty.
    // Never substitute a cell-wide origin for an uninitialized hosted tenant.
    return routing?.public_base_url ?? '';
  });
}
