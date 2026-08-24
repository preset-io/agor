import {
  createDatabase,
  enqueueTenantDatabasePostCommitCallback,
  getCurrentTenantDatabaseScope,
  getCurrentTenantId,
  runWithoutTenantDatabaseScope,
  runWithTenantDatabaseScope,
  TenantWriteGateActiveError,
} from '@agor/core/db';
import { NotAuthenticated } from '@agor/core/feathers';
import jwt from 'jsonwebtoken';
import { describe, expect, it, vi } from 'vitest';
import { RUNTIME_JWT_AUDIENCE, RUNTIME_JWT_ISSUER } from '../auth/runtime-tokens.js';
import {
  createTenantDatabaseScopeAroundHook,
  createTenantWriteAdmissionAroundHook,
  deferWithTenantContext,
  withFreshTenantWrite,
} from './tenant-db-scope.js';

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

describe('withFreshTenantWrite', () => {
  it('remains a no-op write gate on the single-tenant SQLite path', async () => {
    const db = createDatabase({ url: ':memory:' });
    const work = vi.fn(async () => {
      expect(getCurrentTenantId()).toBe('default');
      return 'written';
    });

    await expect(withFreshTenantWrite(db, 'default', work)).resolves.toBe('written');
    expect(work).toHaveBeenCalledOnce();
  });

  it('leaves an inherited DB scope and opens a new short tenant transaction', async () => {
    let transactionNumber = 0;
    const db = {
      transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
        transactionNumber += 1;
        return callback({
          execute: vi.fn(async () => []),
          marker: `tx-${transactionNumber}`,
        });
      }),
    };
    await runWithTenantDatabaseScope(db as never, 'tenant-a', async () => {
      expect(getCurrentTenantDatabaseScope()?.db).toMatchObject({ marker: 'tx-1' });
      await withFreshTenantWrite(db as never, 'tenant-a', async () => {
        expect(getCurrentTenantId()).toBe('tenant-a');
        expect(getCurrentTenantDatabaseScope()?.db).toMatchObject({ marker: 'tx-2' });
      });
      expect(getCurrentTenantDatabaseScope()?.db).toMatchObject({ marker: 'tx-1' });
    });

    expect(db.transaction).toHaveBeenCalledTimes(2);
  });

  it('checks the tenant write gate inside the fresh transaction before mutation work', async () => {
    const work = vi.fn(async () => undefined);
    const tx = {
      execute: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            value_text: JSON.stringify({
              generation: 'gate-generation',
              acquiredAt: '2026-08-18T00:00:00.000Z',
            }),
          },
        ]),
    };
    const db = {
      transaction: vi.fn(async (callback: (scoped: unknown) => Promise<unknown>) => callback(tx)),
    };
    await expect(withFreshTenantWrite(db as never, 'tenant-frozen', work)).rejects.toBeInstanceOf(
      TenantWriteGateActiveError
    );
    expect(work).not.toHaveBeenCalled();
  });

  it('fails closed when no trusted tenant identity is available', () => {
    expect(() => withFreshTenantWrite({} as never, undefined, async () => undefined)).toThrow(
      'Missing tenant context'
    );
  });
});

describe('createTenantWriteAdmissionAroundHook', () => {
  it('fails closed before a recognized write when tenant identity is missing', async () => {
    const { db } = makePgDb();
    const hook = createTenantWriteAdmissionAroundHook(db as never);
    const next = vi.fn(async () => undefined);

    await expect(hook({ method: 'create', params: {} } as never, next)).rejects.toBeInstanceOf(
      NotAuthenticated
    );

    expect(next).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('composes with the installed identity-only scope without retaining its admission transaction', async () => {
    const { db, tx } = makePgDb();
    const identity = createTenantDatabaseScopeAroundHook({
      db: db as never,
      jwtSecret: 'secret',
      config: { multi_tenancy: { mode: 'static', static_tenant_id: 'tenant-long' } },
      transaction: false,
    });
    const admission = createTenantWriteAdmissionAroundHook(db as never);
    const context = { method: 'create', params: {} } as never;
    const next = vi.fn(async () => {
      expect(getCurrentTenantId()).toBe('tenant-long');
      expect(getCurrentTenantDatabaseScope()).toBeUndefined();
    });

    await identity(context, () => admission(context, next));

    expect(next).toHaveBeenCalledOnce();
    expect(db.transaction).toHaveBeenCalledOnce();
    expect(tx.execute).toHaveBeenCalledTimes(2);
  });

  it('checks a mutation in one short unit without holding it across long work', async () => {
    const { db, tx } = makePgDb();
    const hook = createTenantWriteAdmissionAroundHook(db as never);
    const next = vi.fn(async () => {
      expect(getCurrentTenantId()).toBeUndefined();
      expect(getCurrentTenantDatabaseScope()).toBeUndefined();
    });

    await hook(
      {
        method: 'create',
        params: { tenant: { tenant_id: 'tenant-long', source: 'explicit' } },
      } as never,
      next
    );

    expect(next).toHaveBeenCalledOnce();
    expect(db.transaction).toHaveBeenCalledOnce();
    expect(tx.execute).toHaveBeenCalledTimes(2);
  });

  it('rejects a long mutation before its handler when the tenant is frozen', async () => {
    const tx = {
      execute: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            value_text: JSON.stringify({
              generation: 'gate-generation',
              acquiredAt: '2026-08-24T00:00:00.000Z',
            }),
          },
        ]),
    };
    const db = {
      transaction: vi.fn(async (work: (transaction: unknown) => Promise<unknown>) => work(tx)),
    };
    const hook = createTenantWriteAdmissionAroundHook(db as never);
    const next = vi.fn(async () => undefined);

    await expect(
      hook(
        {
          method: 'create',
          params: { tenant: { tenant_id: 'tenant-frozen', source: 'explicit' } },
        } as never,
        next
      )
    ).rejects.toMatchObject({ code: 503 });
    expect(next).not.toHaveBeenCalled();
  });

  it('does not query the write gate for a recognized custom read', async () => {
    const { db } = makePgDb();
    const hook = createTenantWriteAdmissionAroundHook(db as never);
    const next = vi.fn(async () => undefined);

    await hook(
      {
        method: 'getPrimaryTeammate',
        params: { tenant: { tenant_id: 'tenant-read', source: 'explicit' } },
      } as never,
      next
    );

    expect(next).toHaveBeenCalledOnce();
    expect(db.transaction).not.toHaveBeenCalled();
  });
});

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

  it('does not let a nested explicit tenant switch silently', async () => {
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
      params: { tenant: { tenant_id: 'tenant-b', source: 'auth_claim' } },
    } as never;

    await expect(
      runWithTenantDatabaseScope(db as never, 'tenant-a', async () => {
        await hook(context, async () => undefined);
      })
    ).rejects.toThrow(/Cannot enter tenant scope tenant-b from active tenant scope tenant-a/);
  });

  it('treats provider-less nested calls as tenant-scoped rather than global', async () => {
    const { db } = makePgDb();
    const hook = createTenantDatabaseScopeAroundHook({
      db: db as never,
      jwtSecret: 'secret',
      config: {
        database: { dialect: 'postgresql' },
        multi_tenancy: { mode: 'required_from_auth', auth_claim: 'tenant_id' },
      },
    });
    const outer = {
      params: { provider: 'rest', authentication: { payload: { tenant_id: 'tenant-a' } } },
    } as never;
    const innerTasksPatch = { params: {} } as never;
    const innerSessionLookup = { params: { provider: undefined } } as never;
    const events: string[] = [];

    await hook(outer, async () => {
      events.push(`outer:${getCurrentTenantId()}`);
      await hook(innerTasksPatch, async () => {
        events.push(`tasks.patch:${getCurrentTenantId()}`);
      });
      await hook(innerSessionLookup, async () => {
        events.push(`sessions.get:${getCurrentTenantId()}`);
      });
    });

    expect(events).toEqual(['outer:tenant-a', 'tasks.patch:tenant-a', 'sessions.get:tenant-a']);
    expect((innerTasksPatch as { params: { tenant?: unknown } }).params.tenant).toEqual({
      tenant_id: 'tenant-a',
      source: 'explicit',
    });
  });

  it('documents the failed startup mode when deferred work only exits ALS', async () => {
    const { db } = makePgDb();
    const missing = await runWithTenantDatabaseScope(db as never, 'tenant-a', async () => {
      return runWithoutTenantDatabaseScope(() => getCurrentTenantId());
    });

    expect(missing).toBeUndefined();
  });

  it('keeps board owner lookups tenant-scoped under required_from_auth', async () => {
    const { db } = makePgDb();
    const hook = createTenantDatabaseScopeAroundHook({
      db: db as never,
      jwtSecret: 'secret',
      config: {
        database: { dialect: 'postgresql' },
        multi_tenancy: { mode: 'required_from_auth', auth_claim: 'tenant_id' },
      },
    });
    const boardOwnersFind = {
      params: { provider: 'rest', authentication: { payload: { tenant_id: 'tenant-board' } } },
    } as never;
    const nestedUsersGet = { params: {} } as never;
    const events: string[] = [];

    await hook(boardOwnersFind, async () => {
      events.push(`boards/:id/owners.find:${getCurrentTenantId()}`);
      await hook(nestedUsersGet, async () => {
        events.push(`users.get:${getCurrentTenantId()}`);
      });
    });

    expect(events).toEqual(['boards/:id/owners.find:tenant-board', 'users.get:tenant-board']);
  });

  it('allows an explicit global/system escape hatch outside the active scope', async () => {
    const { db } = makePgDb();
    const seen: Array<string | undefined> = [];

    await runWithTenantDatabaseScope(db as never, 'tenant-a', async () => {
      seen.push(getCurrentTenantId());
      runWithoutTenantDatabaseScope(() => {
        seen.push(getCurrentTenantId());
      });
      seen.push(getCurrentTenantId());
    });

    expect(seen).toEqual(['tenant-a', undefined, 'tenant-a']);
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

describe('deferWithTenantContext', () => {
  it('runs orchestration after commit with identity but no inherited database scope', async () => {
    const events: string[] = [];
    const completed = Promise.withResolvers<void>();
    const db = {
      transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
        events.push('transaction:start');
        const result = await callback({ execute: vi.fn(async () => []) });
        events.push('transaction:committed');
        return result;
      }),
    };

    await runWithTenantDatabaseScope(db as never, 'tenant-deferred', async () => {
      deferWithTenantContext({}, async () => {
        expect(getCurrentTenantId()).toBe('tenant-deferred');
        expect(getCurrentTenantDatabaseScope()).toBeUndefined();
        events.push('deferred:work');
        completed.resolve();
      });
      events.push('hook:return');
    });
    await completed.promise;

    expect(events).toEqual([
      'transaction:start',
      'hook:return',
      'transaction:committed',
      'deferred:work',
    ]);
  });
});
