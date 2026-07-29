import { runWithTenantContext } from '@agor/core/db';
import jwt from 'jsonwebtoken';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  configureExecutor,
  createServiceToken,
  generateScopedServiceToken,
  serviceTokenScopeForCurrentTenant,
} from './spawn-executor';

describe('executor service token scoping', () => {
  beforeEach(() => configureExecutor(null));

  it('copies ambient tenant context into service token claims', () => {
    const token = runWithTenantContext('tenant-a', () =>
      createServiceToken('test-secret', '5m', serviceTokenScopeForCurrentTenant())
    );
    const decoded = jwt.decode(token) as { tenant_id?: string; type?: string };

    expect(decoded.type).toBe('service');
    expect(decoded.tenant_id).toBe('tenant-a');
  });

  it('omits the tenant claim outside tenant context when it is not required', () => {
    expect(serviceTokenScopeForCurrentTenant()).toEqual({});
  });

  it('preserves ambient tenant identity across asynchronous orchestration', async () => {
    const token = await runWithTenantContext('tenant-async', async () => {
      await Promise.resolve();
      return generateScopedServiceToken({
        settings: { authentication: { secret: 'test-secret' } },
      });
    });
    const decoded = jwt.decode(token) as { tenant_id?: string };

    expect(decoded.tenant_id).toBe('tenant-async');
  });

  it('stamps role: service for a plain service token', () => {
    const decoded = jwt.decode(createServiceToken('test-secret', '5m', {})) as { role?: string };
    expect(decoded.role).toBe('service');
  });

  it('stamps role: terminal-executor for a terminal-scoped token (no full service role)', () => {
    // Both resolvers override role before use, but a token that leaks its raw
    // role must not read as a full service account to any future consumer.
    const decoded = jwt.decode(
      createServiceToken('test-secret', '30d', { terminal_user_id: 'u1' })
    ) as { role?: string; terminal_user_id?: string };
    expect(decoded.role).toBe('terminal-executor');
    expect(decoded.role).not.toBe('service');
    expect(decoded.terminal_user_id).toBe('u1');
  });

  it('keeps ambient tenant identity authoritative over extra token claims', () => {
    const token = runWithTenantContext('tenant-b', () =>
      generateScopedServiceToken(
        { settings: { authentication: { secret: 'test-secret' } } },
        { tenant_id: 'spoofed-tenant' }
      )
    );
    const decoded = jwt.decode(token) as { tenant_id?: string; type?: string };

    expect(decoded.type).toBe('service');
    expect(decoded.tenant_id).toBe('tenant-b');
  });

  it('fails closed without ambient tenant context when required', () => {
    configureExecutor(null, { requireTenantContext: true });

    expect(() => serviceTokenScopeForCurrentTenant()).toThrow(
      'Missing active tenant context for executor launch'
    );
    expect(() =>
      generateScopedServiceToken({
        settings: { authentication: { secret: 'test-secret' } },
      })
    ).toThrow('Missing active tenant context for executor launch');
  });
});
