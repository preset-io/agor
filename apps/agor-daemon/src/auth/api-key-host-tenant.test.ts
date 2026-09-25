import type { AgorConfig, ResolvedExternalLaunchProvider } from '@agor/core/config';
import type { TenantScopeAwareDatabase } from '@agor/core/db';
import { describe, expect, it } from 'vitest';
import { createApiKeyHostTenantResolver, hasPersonalApiKeyHeader } from './api-key-host-tenant.js';

const db = {} as TenantScopeAwareDatabase;
const hosted: Pick<AgorConfig, 'multi_tenancy' | 'external_launch'> = {
  multi_tenancy: { mode: 'required_from_auth', auth_claim: 'tenant_id' },
};
const provider = (overrides: Partial<ResolvedExternalLaunchProvider> = {}) =>
  ({
    enabled: true,
    forwardRequestHost: true,
    trustedHostHeader: 'host',
    allowAdminRoles: false,
    trustVerifiedEmailForLinking: false,
    requestTimeoutMs: 1_000,
    ...overrides,
  }) as ResolvedExternalLaunchProvider;

describe('hasPersonalApiKeyHeader', () => {
  it.each([
    [{ authorization: 'Bearer agor_sk_abc' }],
    [{ Authorization: 'bearer agor_sk_abc' }],
    [{ 'x-api-key': 'agor_sk_abc' }],
    [{ 'X-API-Key': ['agor_sk_abc'] }],
  ])('detects %j', (headers) => {
    expect(hasPersonalApiKeyHeader(headers)).toBe(true);
  });

  it.each([
    [undefined],
    [{}],
    [{ authorization: 'Bearer eyJhbGciOi.jwt.token' }],
    [{ authorization: 'Basic agor_sk_abc' }],
    [{ 'x-api-key': 'not-a-personal-key' }],
    [{ cookie: 'agor_sk_abc' }],
  ])('ignores %j', (headers) => {
    expect(hasPersonalApiKeyHeader(headers)).toBe(false);
  });
});

describe('createApiKeyHostTenantResolver', () => {
  it('is disabled in static tenancy, where the tenant already comes from config', () => {
    expect(createApiKeyHostTenantResolver({ db, config: {}, provider: provider() })).toBeNull();
  });

  it('is disabled unless the operator declared a trusted launch Host header', () => {
    expect(
      createApiKeyHostTenantResolver({
        db,
        config: hosted,
        provider: provider({ forwardRequestHost: false }),
      })
    ).toBeNull();
    expect(
      createApiKeyHostTenantResolver({ db, config: hosted, provider: provider({ enabled: false }) })
    ).toBeNull();
    // No external_launch block at all: resolved from config, disabled.
    expect(createApiKeyHostTenantResolver({ db, config: hosted })).toBeNull();
  });

  it.each([
    [{}],
    [{ host: ['a.test', 'b.test'] }],
    [{ host: 'a.test,b.test' }],
    [{ host: 'a.test b.test' }],
  ])('fails closed before any database access for Host headers %j', async (headers) => {
    const resolve = createApiKeyHostTenantResolver({ db, config: hosted, provider: provider() });
    expect(resolve).not.toBeNull();
    await expect(resolve!(headers)).rejects.toMatchObject({
      name: 'TenantResolutionError',
      message: 'Missing tenant context for multi_tenancy.required_from_auth',
    });
  });
});
