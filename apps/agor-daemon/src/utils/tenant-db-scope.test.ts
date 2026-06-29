import {
  enqueueTenantDatabasePostCommitCallback,
  getCurrentTenantId,
  runWithTenantDatabaseScope,
} from '@agor/core/db';
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

  it('runs registered post-commit callbacks after the scoped transaction resolves', async () => {
    const events: string[] = [];
    const tx = {
      execute: vi.fn(async () => []),
    };
    const db = {
      transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
        events.push('tx:start');
        const result = await callback(tx);
        events.push('tx:committed');
        return result;
      }),
    };

    await runWithTenantDatabaseScope(db as never, 'tenant-static', async () => {
      expect(
        enqueueTenantDatabasePostCommitCallback(async () => {
          expect(getCurrentTenantId()).toBe('tenant-static');
          events.push('post-commit');
        })
      ).toBe(true);
      events.push('work:done');
    });

    expect(events).toEqual([
      'tx:start',
      'work:done',
      'tx:committed',
      'tx:start',
      'post-commit',
      'tx:committed',
    ]);
    expect(db.transaction).toHaveBeenCalledTimes(2);
    expect(tx.execute).toHaveBeenCalledTimes(2);
  });

  it('does not run post-commit callbacks when the scoped transaction rolls back', async () => {
    const callback = vi.fn(async () => undefined);
    const tx = {
      execute: vi.fn(async () => []),
    };
    const db = {
      transaction: vi.fn(async (transactionCallback: (tx: unknown) => Promise<unknown>) => {
        await transactionCallback(tx);
        throw new Error('rollback');
      }),
    };

    await expect(
      runWithTenantDatabaseScope(db as never, 'tenant-static', async () => {
        expect(enqueueTenantDatabasePostCommitCallback(callback)).toBe(true);
      })
    ).rejects.toThrow('rollback');

    expect(callback).not.toHaveBeenCalled();
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

  it('inherits an active tenant database scope for nested internal service calls', async () => {
    const { db } = makePgDb();
    const hook = createTenantDatabaseScopeAroundHook({
      db: db as never,
      jwtSecret: 'secret',
      config: {
        database: { dialect: 'postgresql' },
        multi_tenancy: { mode: 'required_from_auth', auth_claim: 'tenant_id' },
      },
    });
    const context = { params: {} } as never;

    await runWithTenantDatabaseScope(db as never, 'tenant-inherited', async () => {
      await hook(context, async () => {
        expect(getCurrentTenantId()).toBe('tenant-inherited');
      });
    });

    expect((context as { params: { tenant?: unknown } }).params.tenant).toEqual({
      tenant_id: 'tenant-inherited',
      source: 'explicit',
    });
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
