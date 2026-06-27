import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertValidMultiTenancyConfig,
  DEFAULT_STATIC_TENANT_ID,
  resolveMultiTenancyConfig,
  resolveTenantContext,
  TenantResolutionError,
} from './multitenancy';

describe('multi-tenancy config and tenant resolution', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });
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

  it('rejects required_from_auth on SQLite because SQLite has no tenant columns/RLS', () => {
    vi.stubEnv('AGOR_DB_DIALECT', '');
    vi.stubEnv('DATABASE_URL', '');

    expect(() =>
      assertValidMultiTenancyConfig({
        database: { dialect: 'sqlite' },
        multi_tenancy: { mode: 'required_from_auth', auth_claim: 'tenant_id' },
      })
    ).toThrow(/requires database\.dialect: postgresql/);
  });

  it('requires an explicit resolver in required_from_auth mode', () => {
    vi.stubEnv('AGOR_DB_DIALECT', '');
    vi.stubEnv('DATABASE_URL', '');

    expect(() =>
      assertValidMultiTenancyConfig({
        database: { dialect: 'postgresql' },
        multi_tenancy: { mode: 'required_from_auth' },
      })
    ).toThrow(/auth_claim or multi_tenancy\.trusted_header/);
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
