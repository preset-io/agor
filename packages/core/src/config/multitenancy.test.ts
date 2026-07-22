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

  it('rejects an explicit tenant that conflicts with static mode', () => {
    expect(() =>
      resolveTenantContext(
        { multi_tenancy: { mode: 'static', static_tenant_id: 'tenant-a' } },
        { params: { tenant_id: 'tenant-b' } }
      )
    ).toThrow(/Conflicting tenant identities/);
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

  it('rejects reserved JWT claims as the tenant auth claim', () => {
    vi.stubEnv('AGOR_DB_DIALECT', '');
    vi.stubEnv('DATABASE_URL', '');

    expect(() =>
      assertValidMultiTenancyConfig({
        database: { dialect: 'postgresql' },
        multi_tenancy: { mode: 'static', auth_claim: 'sub' },
      })
    ).toThrow(/auth_claim cannot be reserved JWT claim 'sub'/);

    expect(() =>
      assertValidMultiTenancyConfig({
        database: { dialect: 'postgresql' },
        multi_tenancy: { mode: 'required_from_auth', auth_claim: 'sub' },
      })
    ).toThrow(/auth_claim cannot be reserved JWT claim 'sub'/);
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

  it('rejects conflicting authenticated and trusted-header tenant identities', () => {
    expect(() =>
      resolveTenantContext(
        {
          multi_tenancy: {
            mode: 'required_from_auth',
            auth_claim: 'tenant_id',
            trusted_header: 'x-agor-tenant-id',
          },
        },
        {
          authPayload: { tenant_id: 'tenant-a' },
          headers: { 'x-agor-tenant-id': 'tenant-b' },
        }
      )
    ).toThrow(/Conflicting tenant identities/);
  });

  it.each([
    {
      label: 'decoded and Feathers authentication payloads',
      input: {
        authPayload: { tenant_id: 'tenant-a' },
        params: { authentication: { payload: { tenant_id: 'tenant-b' } } },
      },
    },
    {
      label: 'decoded payload and authenticated user',
      input: {
        authPayload: { tenant_id: 'tenant-a' },
        params: { user: { tenant_id: 'tenant-b' } },
      },
    },
    {
      label: 'Feathers authentication payload and authenticated user',
      input: {
        params: {
          authentication: { payload: { tenant_id: 'tenant-a' } },
          user: { tenant_id: 'tenant-b' },
        },
      },
    },
  ])('rejects conflicting auth claims from $label', ({ input }) => {
    expect(() =>
      resolveTenantContext(
        { multi_tenancy: { mode: 'required_from_auth', auth_claim: 'tenant_id' } },
        input
      )
    ).toThrow(/Conflicting tenant identities/);
  });

  it('rejects conflicting trusted headers from request and Feathers params', () => {
    expect(() =>
      resolveTenantContext(
        {
          multi_tenancy: {
            mode: 'required_from_auth',
            trusted_header: 'x-agor-tenant-id',
          },
        },
        {
          headers: { 'x-agor-tenant-id': 'tenant-a' },
          params: { headers: { 'X-Agor-Tenant-Id': 'tenant-b' } },
        }
      )
    ).toThrow(/Conflicting tenant identities/);
  });

  it.each([
    {
      label: 'a multi-valued header',
      headers: { 'x-agor-tenant-id': ['tenant-a', 'tenant-b'] },
    },
    {
      label: 'case-insensitive duplicate keys',
      headers: {
        'x-agor-tenant-id': 'tenant-a',
        'X-Agor-Tenant-Id': 'tenant-b',
      },
    },
  ])('rejects conflicting tenant identities within $label', ({ headers }) => {
    expect(() =>
      resolveTenantContext(
        {
          multi_tenancy: {
            mode: 'required_from_auth',
            trusted_header: 'x-agor-tenant-id',
          },
        },
        { headers }
      )
    ).toThrow(/Conflicting tenant identities/);
  });

  it('rejects a malformed duplicate trusted-header value instead of ignoring it', () => {
    expect(() =>
      resolveTenantContext(
        {
          multi_tenancy: {
            mode: 'required_from_auth',
            trusted_header: 'x-agor-tenant-id',
          },
        },
        { headers: { 'x-agor-tenant-id': ['tenant-a', ''] } }
      )
    ).toThrow(/Invalid trusted tenant header/);
  });

  it.each([
    {
      label: 'identical multi-valued header',
      headers: { 'x-agor-tenant-id': ['tenant-a', 'tenant-a'] },
    },
    {
      label: 'identical case-insensitive duplicate keys',
      headers: {
        'x-agor-tenant-id': 'tenant-a',
        'X-Agor-Tenant-Id': 'tenant-a',
      },
    },
  ])('rejects $label because the trusted header is a singleton', ({ headers }) => {
    expect(() =>
      resolveTenantContext(
        {
          multi_tenancy: {
            mode: 'required_from_auth',
            trusted_header: 'x-agor-tenant-id',
          },
        },
        { headers }
      )
    ).toThrow(/Invalid trusted tenant header/);
  });

  it('rejects a comma-coalesced trusted header as an ambiguous HTTP list', () => {
    expect(() =>
      resolveTenantContext(
        {
          multi_tenancy: {
            mode: 'required_from_auth',
            trusted_header: 'x-agor-tenant-id',
          },
        },
        { headers: { 'x-agor-tenant-id': 'tenant-a, tenant-b' } }
      )
    ).toThrow(/Invalid trusted tenant header/);
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
