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
  /**
   * `trusted_host` is a routing hint only: the tenant whose launch-observed
   * public URL owns the trusted request Host. It admits a personal API key for
   * verification inside that tenant and never authenticates on its own.
   */
  source: 'static' | 'auth_claim' | 'trusted_header' | 'trusted_host' | 'explicit';
}

/** Cloud-owned routing observation, persisted per tenant after verified launch. */
export interface TenantPublicRouting {
  public_base_url: string;
  /** Signed assertion iat; not a routing revision or a runtime token timestamp. */
  assertion_issued_at: number;
}

/** Preserve the assertion's tenant binding even if app_variables is imported. */
export interface StoredTenantPublicRouting extends TenantPublicRouting {
  tenant_id: TenantID | string;
}
