import { runWithTenantDatabaseScope, type TenantScopeAwareDatabase } from '@agor/core/db';
import type { AuthenticatedParams } from '@agor/core/types';
import jwt from 'jsonwebtoken';
import { afterEach, describe, expect, it } from 'vitest';
import {
  configureExecutorTokenTenantScoping,
  createServiceToken,
  EXECUTOR_TOKEN_GLOBAL_SCOPE_CLAIM,
  generateScopedServiceToken,
  globalExecutorTokenScope,
  serviceTokenScopeForParams,
} from './spawn-executor';

const scopeOnlyDb = { run: () => undefined } as unknown as TenantScopeAwareDatabase;

describe('executor service token scoping', () => {
  afterEach(() => {
    configureExecutorTokenTenantScoping(null);
  });

  it('copies tenant context into service token claims', () => {
    const scope = serviceTokenScopeForParams({
      tenant: { tenant_id: 'tenant-a' as never, source: 'auth_claim' },
    } satisfies Partial<AuthenticatedParams>);

    const token = createServiceToken('test-secret', '5m', scope);
    const decoded = jwt.decode(token) as { tenant_id?: string; type?: string };

    expect(decoded.type).toBe('service');
    expect(decoded.tenant_id).toBe('tenant-a');
  });

  it('falls back to user tenant metadata when explicit params are absent', () => {
    expect(
      serviceTokenScopeForParams({
        user: {
          user_id: 'u1',
          email: 'u1@example.test',
          role: 'member',
          tenant_id: 'tenant-from-user' as never,
        },
      })
    ).toEqual({ tenant_id: 'tenant-from-user' });
  });

  it('omits tenant claim for single-tenant/internal calls without tenant context', () => {
    expect(serviceTokenScopeForParams({})).toEqual({});
  });

  it('copies ambient tenant database scope into service token claims', async () => {
    configureExecutorTokenTenantScoping({
      mode: 'required_from_auth',
      static_tenant_id: 'default' as never,
      auth_claim: 'tenant_id',
    });

    const scope = await runWithTenantDatabaseScope(scopeOnlyDb, 'tenant-ambient', () =>
      Promise.resolve(serviceTokenScopeForParams({}))
    );
    const token = createServiceToken('test-secret', '5m', scope);
    const decoded = jwt.decode(token) as { tenant_id?: string; type?: string };

    expect(decoded.type).toBe('service');
    expect(decoded.tenant_id).toBe('tenant-ambient');
  });

  it('fails closed for required_from_auth service token issuance without tenant context', () => {
    configureExecutorTokenTenantScoping({
      mode: 'required_from_auth',
      static_tenant_id: 'default' as never,
      auth_claim: 'tenant_id',
    });

    expect(() => serviceTokenScopeForParams({})).toThrow(/Missing tenant context/);
    expect(() => createServiceToken('test-secret', '5m')).toThrow(/Missing tenant context/);
  });

  it('keeps explicit global executor token escape searchable', () => {
    configureExecutorTokenTenantScoping({
      mode: 'required_from_auth',
      static_tenant_id: 'default' as never,
      auth_claim: 'tenant_id',
    });

    const token = createServiceToken('test-secret', '5m', {
      ...globalExecutorTokenScope('test-only non-tenant-owned executor check'),
    });
    const decoded = jwt.decode(token) as Record<string, unknown>;

    expect(decoded.type).toBe('service');
    expect(decoded.tenant_id).toBeUndefined();
    expect(decoded[EXECUTOR_TOKEN_GLOBAL_SCOPE_CLAIM]).toBe(
      'test-only non-tenant-owned executor check'
    );
  });

  it('generates tenant-scoped service tokens directly from params', () => {
    const token = generateScopedServiceToken(
      { settings: { authentication: { secret: 'test-secret' } } },
      { tenant: { tenant_id: 'tenant-b' as never, source: 'auth_claim' } }
    );
    const decoded = jwt.decode(token) as { tenant_id?: string; type?: string };

    expect(decoded.type).toBe('service');
    expect(decoded.tenant_id).toBe('tenant-b');
  });
});
