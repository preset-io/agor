import { describe, expect, it } from 'vitest';
import { resolveSignedRuntimeTenant } from './runtime-tokens.js';

const REQUIRED_TENANCY = {
  mode: 'required_from_auth',
  static_tenant_id: 'unused' as never,
  auth_claim: 'org_id',
  trusted_header: 'x-agor-tenant-id',
} as const;

describe('resolveSignedRuntimeTenant', () => {
  it('rejects contradictory canonical and configured signed claims', () => {
    expect(() =>
      resolveSignedRuntimeTenant(REQUIRED_TENANCY, {
        tenant_id: 'tenant-a',
        org_id: 'tenant-b',
      })
    ).toThrow(/Conflicting signed tenant claims/);
  });

  it('derives socket tenant authority only from the signed payload', () => {
    expect(resolveSignedRuntimeTenant(REQUIRED_TENANCY, { org_id: 'tenant-a' })).toEqual({
      tenant_id: 'tenant-a',
      source: 'auth_claim',
    });
    expect(() => resolveSignedRuntimeTenant(REQUIRED_TENANCY, {})).toThrow(
      /Missing tenant context/
    );
  });
});
