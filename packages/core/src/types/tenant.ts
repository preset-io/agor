/**
 * Tenant identity primitives for app-level multi-tenancy.
 *
 * The default self-hosted/open-source mode uses a single static tenant
 * (`default`). Cloud mode must resolve this from trusted auth/request context
 * and should fail closed when missing.
 */
export type TenantID = string & { readonly __brand: 'TenantID' };

export interface TenantContext {
  tenant_id: TenantID;
  source: 'static' | 'auth_claim' | 'trusted_header' | 'explicit';
}
