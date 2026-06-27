import { describe, expect, it } from 'vitest';
import {
  assertValidMultiTenancyConfig,
  DEFAULT_STATIC_TENANT_ID,
  resolveMultiTenancyConfig,
  resolveTenantContext,
  TenantResolutionError,
} from './multitenancy';

describe('multi-tenancy config and tenant resolution', () => {
  it('defaults to static/default tenant for single-tenant installs', () => {
    const config = resolveMultiTenancyConfig({});
    expect(config).toEqual({ mode: 'static', static_tenant_id: DEFAULT_STATIC_TENANT_ID });
    expect(resolveTenantContext(config)).toEqual({ tenant_id: 'default', source: 'static' });
  });

  it('preserves existing behavior with a configured static tenant', () => {
    expect(
      resolveTenantContext({ multi_tenancy: { mode: 'static', static_tenant_id: 'acme' } })
    ).toEqual({ tenant_id: 'acme', source: 'static' });
  });

  it('requires an explicit resolver in required_from_auth mode', () => {
    expect(() =>
      assertValidMultiTenancyConfig({ multi_tenancy: { mode: 'required_from_auth' } })
    ).toThrow(/auth_claim, multi_tenancy\.trusted_header, or multi_tenancy\.host_base_domain/);
  });

  it('resolves required tenant from configured JWT/auth claim', () => {
    const ctx = resolveTenantContext(
      { multi_tenancy: { mode: 'required_from_auth', auth_claim: 'tenant_id' } },
      { authPayload: { tenant_id: 'tenant-a' } }
    );
    expect(ctx).toEqual({ tenant_id: 'tenant-a', source: 'auth_claim' });
  });

  it('resolves required tenant from trusted header when configured', () => {
    const ctx = resolveTenantContext(
      { multi_tenancy: { mode: 'required_from_auth', trusted_header: 'x-agor-tenant-id' } },
      { headers: { 'X-Agor-Tenant-Id': 'tenant-b' } }
    );
    expect(ctx).toEqual({ tenant_id: 'tenant-b', source: 'trusted_header' });
  });

  it('resolves required tenant from a configured subdomain host', () => {
    const ctx = resolveTenantContext(
      { multi_tenancy: { mode: 'required_from_auth', host_base_domain: 'agor.cloud' } },
      { headers: { Host: 'netflix.agor.cloud' } }
    );
    expect(ctx).toEqual({ tenant_id: 'netflix', source: 'trusted_host' });
  });

  it('uses auth JWT claim ahead of host after login', () => {
    const ctx = resolveTenantContext(
      {
        multi_tenancy: {
          mode: 'required_from_auth',
          auth_claim: 'tenant_id',
          host_base_domain: 'agor.cloud',
        },
      },
      { authPayload: { tenant_id: 'netflix' }, headers: { Host: 'hulu.agor.cloud' } }
    );
    expect(ctx).toEqual({ tenant_id: 'netflix', source: 'auth_claim' });
  });

  it('uses subdomain host ahead of legacy user tenant during login', () => {
    const ctx = resolveTenantContext(
      {
        multi_tenancy: {
          mode: 'required_from_auth',
          auth_claim: 'tenant_id',
          host_base_domain: 'agor.cloud',
        },
      },
      {
        params: { user: { tenant_id: 'legacy-single-team' } },
        headers: { Host: 'netflix.agor.cloud:443' },
      }
    );
    expect(ctx).toEqual({ tenant_id: 'netflix', source: 'trusted_host' });
  });

  it('fails closed in required_from_auth mode when tenant context is missing', () => {
    expect(() =>
      resolveTenantContext({
        multi_tenancy: { mode: 'required_from_auth', auth_claim: 'tenant_id' },
      })
    ).toThrow(TenantResolutionError);
  });

  it('allows trusted internal jobs to pass explicit tenant context', () => {
    const ctx = resolveTenantContext(
      { multi_tenancy: { mode: 'required_from_auth', auth_claim: 'tenant_id' } },
      { params: { tenant_id: 'tenant-job' } }
    );
    expect(ctx).toEqual({ tenant_id: 'tenant-job', source: 'explicit' });
  });
});
