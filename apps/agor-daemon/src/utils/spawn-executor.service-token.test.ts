import type { AuthenticatedParams } from '@agor/core/types';
import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';
import {
  createServiceToken,
  generateScopedServiceToken,
  serviceTokenScopeForParams,
} from './spawn-executor';

describe('executor service token scoping', () => {
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
