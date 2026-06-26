/**
 * EXPLORATORY POC: multi-tenant request context plumbing.
 *
 * This file is intentionally not wired into daemon startup. It demonstrates the
 * low-level mechanics recommended in the KB research doc: resolve a trusted
 * tenant before service code runs, attach it to Feathers params/connection, and
 * make downstream database/channel code consume that explicit params value.
 */

import type { HookContext, Params } from '@agor/core/types';

export type TenantID = string & { readonly __brand: 'TenantID' };

export interface TenantContext {
  tenantId: TenantID;
}

export type TenantParams<P extends Params = Params> = P & {
  tenant?: TenantContext;
  adapter?: P extends { adapter?: infer A } ? A & { tenantId?: TenantID } : { tenantId?: TenantID };
};

type TenantConnection = {
  tenant?: TenantContext;
  authentication?: { payload?: Record<string, unknown> };
  user?: Record<string, unknown>;
};

type TenantResolverOptions = {
  /** JWT/session payload claim to trust after authentication, e.g. `tenant_id`. */
  claim?: string;
  /** Optional allowlist/normalizer. Throw to reject unknown tenants. */
  normalize?: (tenantId: string) => TenantID | null | undefined;
};

const DEFAULT_TENANT_CLAIM = 'tenant_id';

export function asTenantId(value: string): TenantID {
  const trimmed = value.trim();
  if (!trimmed) throw new Error('Tenant id is required');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(trimmed)) {
    throw new Error('Tenant id contains unsupported characters');
  }
  return trimmed as TenantID;
}

function readString(obj: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = obj?.[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export function tenantFromParams(params: Params | undefined): TenantContext | undefined {
  return (params as TenantParams | undefined)?.tenant;
}

export function requireTenant(params: Params | undefined): TenantContext {
  const tenant = tenantFromParams(params);
  if (!tenant?.tenantId) throw new Error('Tenant context is required');
  return tenant;
}

/**
 * Feathers before/around hook that stamps `params.tenant` from authenticated
 * server-side data. Do not read a tenant id directly from client query/body here.
 */
export function resolveTenantContext(options: TenantResolverOptions = {}) {
  const claim = options.claim ?? DEFAULT_TENANT_CLAIM;
  return async (context: HookContext): Promise<HookContext> => {
    const params = context.params as TenantParams | undefined;
    const connection = params?.connection as TenantConnection | undefined;
    const payload = params?.authentication?.payload as Record<string, unknown> | undefined;
    const user = params?.user as Record<string, unknown> | undefined;

    const rawTenantId =
      readString(payload, claim) ??
      readString(user, claim) ??
      readString(connection?.authentication?.payload, claim) ??
      readString(connection?.user, claim) ??
      connection?.tenant?.tenantId;

    if (!rawTenantId) throw new Error(`Authenticated request is missing ${claim}`);

    const tenantId = options.normalize ? options.normalize(rawTenantId) : asTenantId(rawTenantId);
    if (!tenantId) throw new Error(`Unknown tenant: ${rawTenantId}`);

    context.params = {
      ...(params ?? {}),
      tenant: { tenantId },
      // Mirrors the Feathers documented per-request adapter override pattern.
      adapter: { ...(params?.adapter ?? {}), tenantId },
    } as typeof context.params;

    if (connection) connection.tenant = { tenantId };
    return context;
  };
}
