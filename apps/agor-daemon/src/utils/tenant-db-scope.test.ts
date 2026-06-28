import { getCurrentTenantId } from '@agor/core/db';
import { NotAuthenticated } from '@agor/core/feathers';
import jwt from 'jsonwebtoken';
import { describe, expect, it, vi } from 'vitest';
import { RUNTIME_JWT_AUDIENCE, RUNTIME_JWT_ISSUER } from '../auth/runtime-tokens.js';
import { createTenantDatabaseScopeAroundHook } from './tenant-db-scope.js';

function makePgDb() {
  const tx = {
    execute: vi.fn(async () => []),
    marker: vi.fn(() => 'tx'),
  };
  const db = {
    transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(tx)),
    marker: vi.fn(() => 'base'),
  };
  return { db, tx };
}

function signRuntimeJwt(secret: string, payload: Record<string, unknown>) {
  return jwt.sign({ sub: 'user-1', type: 'access', ...payload }, secret, {
    issuer: RUNTIME_JWT_ISSUER,
    audience: RUNTIME_JWT_AUDIENCE,
    expiresIn: '5m',
  });
}

describe('createTenantDatabaseScopeAroundHook', () => {
  it('uses the configured static tenant for the hook and database scope', async () => {
    const { db, tx } = makePgDb();
    const hook = createTenantDatabaseScopeAroundHook({
      db: db as never,
      jwtSecret: 'secret',
      config: { multi_tenancy: { mode: 'static', static_tenant_id: 'tenant-static' } },
    });
    const context = { params: {} } as never;
    const next = vi.fn(async () => {
      expect(getCurrentTenantId()).toBe('tenant-static');
    });

    await hook(context, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect((context as { params: { tenant?: unknown } }).params.tenant).toEqual({
      tenant_id: 'tenant-static',
      source: 'static',
    });
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(tx.execute).toHaveBeenCalledTimes(1);
  });

  it('resolves required tenant context from a signed bearer JWT', async () => {
    const { db } = makePgDb();
    const secret = 'secret';
    const token = signRuntimeJwt(secret, { tenant_id: 'tenant-from-jwt' });
    const hook = createTenantDatabaseScopeAroundHook({
      db: db as never,
      jwtSecret: secret,
      config: {
        database: { dialect: 'postgresql' },
        multi_tenancy: { mode: 'required_from_auth', auth_claim: 'tenant_id' },
      },
    });
    const context = { params: { headers: { authorization: `Bearer ${token}` } } } as never;
    const next = vi.fn(async () => {
      expect(getCurrentTenantId()).toBe('tenant-from-jwt');
    });

    await hook(context, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect((context as { params: { tenant?: unknown } }).params.tenant).toEqual({
      tenant_id: 'tenant-from-jwt',
      source: 'auth_claim',
    });
  });

  it('fails closed when required tenant context is missing', async () => {
    const { db } = makePgDb();
    const hook = createTenantDatabaseScopeAroundHook({
      db: db as never,
      jwtSecret: 'secret',
      config: {
        database: { dialect: 'postgresql' },
        multi_tenancy: { mode: 'required_from_auth', auth_claim: 'tenant_id' },
      },
    });
    const next = vi.fn(async () => undefined);

    await expect(hook({ params: {} } as never, next)).rejects.toBeInstanceOf(NotAuthenticated);
    expect(next).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('reuses tenant context already attached to a socket connection', async () => {
    const { db } = makePgDb();
    const hook = createTenantDatabaseScopeAroundHook({
      db: db as never,
      jwtSecret: 'secret',
      config: {
        database: { dialect: 'postgresql' },
        multi_tenancy: { mode: 'required_from_auth', auth_claim: 'tenant_id' },
      },
    });
    const context = {
      params: {
        connection: { tenant: { tenant_id: 'tenant-from-socket', source: 'auth_claim' } },
      },
    } as never;

    await hook(context, async () => {
      expect(getCurrentTenantId()).toBe('tenant-from-socket');
    });

    expect((context as { params: { tenant?: unknown } }).params.tenant).toEqual({
      tenant_id: 'tenant-from-socket',
      source: 'auth_claim',
    });
  });
});
