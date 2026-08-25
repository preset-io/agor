/**
 * Tenant identity primitives for app-level multi-tenancy.
 *
 * The default self-hosted mode uses a single static tenant
 * (`default`). Cloud mode must resolve this from trusted auth/request context
 * and should fail closed when missing.
 */
export type TenantID = string & { readonly __brand: 'TenantID' };

/** Shared upper bound for trusted tenant authority and every transport carrying it. */
export const MAX_TENANT_ID_LENGTH = 128;

export interface TenantContext {
  tenant_id: TenantID;
  source: 'static' | 'auth_claim' | 'trusted_header' | 'explicit';
}
