import {
  getCurrentTenantDatabaseScope,
  getCurrentTenantId,
  runWithTenantDatabaseScope,
} from '@agor/core/db';
import type { SessionID } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import {
  deferWithSessionQueueTenantScope,
  runWithSessionQueueTenantScope,
} from './session-queue-tenant-scope.js';

function makePgDb() {
  const tx = { execute: vi.fn(async () => []) };
  const db = {
    transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(tx)),
  };
  return { db, tx };
}

describe('session queue tenant scope', () => {
  it('does not carry task-scoped transport authentication into a queue drain', async () => {
    const { db } = makePgDb();
    const user = { user_id: 'user-1' };

    await runWithSessionQueueTenantScope(
      {
        db: db as never,
        config: {
          database: { dialect: 'postgresql' },
          multi_tenancy: { mode: 'required_from_auth', auth_claim: 'tenant_id' },
        },
        sessionId: 'session-1' as SessionID,
        params: {
          provider: 'socketio',
          authentication: {
            strategy: 'jwt',
            accessToken: 'completed-task-executor-token',
          },
          connection: { id: 'executor-socket' },
          headers: { authorization: 'Bearer completed-task-executor-token' },
          user,
          tenant: { tenant_id: 'tenant-a', source: 'auth_claim' },
        } as never,
        label: 'test authenticated drain',
      },
      async (params) => {
        expect(params).not.toHaveProperty('provider');
        expect(params).not.toHaveProperty('authentication');
        expect(params).not.toHaveProperty('connection');
        expect(params).not.toHaveProperty('headers');
        expect(params.user).toBe(user);
        expect(params.tenant?.tenant_id).toBe('tenant-a');
      }
    );
  });

  it('uses params tenant before running queue work', async () => {
    const { db } = makePgDb();
    const seen: string[] = [];

    await runWithSessionQueueTenantScope(
      {
        db: db as never,
        config: {
          database: { dialect: 'postgresql' },
          multi_tenancy: { mode: 'required_from_auth', auth_claim: 'tenant_id' },
        },
        sessionId: 'session-1' as SessionID,
        params: { tenant: { tenant_id: 'tenant-a', source: 'explicit' } },
        label: 'test drain',
      },
      async (params) => {
        expect(getCurrentTenantDatabaseScope()).toBeUndefined();
        seen.push(`tenant:${getCurrentTenantId()}`);
        seen.push(`params:${params.tenant?.tenant_id}`);
      }
    );

    expect(seen).toEqual(['tenant:tenant-a', 'params:tenant-a']);
  });

  it('uses the active tenant scope when params are minimal', async () => {
    const { db } = makePgDb();
    const seen: string[] = [];

    await runWithTenantDatabaseScope(db as never, 'tenant-active', async () => {
      await runWithSessionQueueTenantScope(
        {
          db: db as never,
          config: {
            database: { dialect: 'postgresql' },
            multi_tenancy: { mode: 'required_from_auth', auth_claim: 'tenant_id' },
          },
          sessionId: 'session-1' as SessionID,
          params: {},
          label: 'test drain',
        },
        async (params) => {
          seen.push(`tenant:${getCurrentTenantId()}`);
          seen.push(`params:${params.tenant?.tenant_id}`);
        }
      );
    });

    expect(seen).toEqual(['tenant:tenant-active', 'params:tenant-active']);
  });

  it('uses a trusted tenant hint when params and active scope are absent', async () => {
    const { db } = makePgDb();
    const seen: string[] = [];

    await runWithSessionQueueTenantScope(
      {
        db: db as never,
        config: {
          database: { dialect: 'postgresql' },
          multi_tenancy: { mode: 'required_from_auth', auth_claim: 'tenant_id' },
        },
        sessionId: 'session-1' as SessionID,
        params: {},
        tenantIdHint: 'tenant-from-row',
        label: 'test hinted drain',
      },
      async (params) => {
        seen.push(`tenant:${getCurrentTenantId()}`);
        seen.push(`params:${params.tenant?.tenant_id}`);
        seen.push(`source:${params.tenant?.source}`);
      }
    );

    expect(seen).toEqual(['tenant:tenant-from-row', 'params:tenant-from-row', 'source:explicit']);
  });

  it('prefers params tenant over trusted tenant hint', async () => {
    const { db } = makePgDb();
    const seen: string[] = [];

    await runWithSessionQueueTenantScope(
      {
        db: db as never,
        config: {
          database: { dialect: 'postgresql' },
          multi_tenancy: { mode: 'required_from_auth', auth_claim: 'tenant_id' },
        },
        sessionId: 'session-1' as SessionID,
        params: { tenant: { tenant_id: 'tenant-from-params', source: 'auth_claim' } },
        tenantIdHint: 'tenant-from-row',
        label: 'test hinted drain',
      },
      async (params) => {
        seen.push(`tenant:${getCurrentTenantId()}`);
        seen.push(`params:${params.tenant?.tenant_id}`);
        seen.push(`source:${params.tenant?.source}`);
      }
    );

    expect(seen).toEqual([
      'tenant:tenant-from-params',
      'params:tenant-from-params',
      'source:auth_claim',
    ]);
  });

  it('uses configured static tenant mode when params and active scope are absent', async () => {
    const { db } = makePgDb();
    const seen: string[] = [];

    await runWithSessionQueueTenantScope(
      {
        db: db as never,
        config: {
          database: { dialect: 'postgresql' },
          multi_tenancy: { mode: 'static', static_tenant_id: 'tenant-static' },
        },
        sessionId: 'session-1' as SessionID,
        params: {},
        label: 'test static drain',
      },
      async (params) => {
        seen.push(`tenant:${getCurrentTenantId()}`);
        seen.push(`params:${params.tenant?.tenant_id}`);
        seen.push(`source:${params.tenant?.source}`);
      }
    );

    expect(seen).toEqual(['tenant:tenant-static', 'params:tenant-static', 'source:static']);
  });

  it('fails closed in required tenant mode when params and active scope are absent', async () => {
    const { db } = makePgDb();
    const work = vi.fn(async () => undefined);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await runWithSessionQueueTenantScope(
      {
        db: db as never,
        config: {
          database: { dialect: 'postgresql' },
          multi_tenancy: { mode: 'required_from_auth', auth_claim: 'tenant_id' },
        },
        sessionId: 'session-1' as SessionID,
        params: {},
        label: 'test drain',
      },
      work
    );

    expect(work).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('missing tenant context'));
    consoleError.mockRestore();
  });

  it('defers promptable-session queue drains with active tenant params', async () => {
    const { db } = makePgDb();
    const seen: string[] = [];

    const drained = new Promise<void>((resolve, reject) => {
      void runWithTenantDatabaseScope(db as never, 'tenant-active', async () => {
        deferWithSessionQueueTenantScope(
          {
            db: db as never,
            config: {
              database: { dialect: 'postgresql' },
              multi_tenancy: { mode: 'required_from_auth', auth_claim: 'tenant_id' },
            },
            sessionId: 'session-1' as SessionID,
            params: {},
            label: 'session after.patch drain',
          },
          async (params) => {
            expect(getCurrentTenantDatabaseScope()).toBeUndefined();
            seen.push(`tenant:${getCurrentTenantId()}`);
            seen.push(`params:${params.tenant?.tenant_id}`);
            resolve();
          },
          reject
        );
      }).catch(reject);
    });
    await drained;

    expect(seen).toEqual(['tenant:tenant-active', 'params:tenant-active']);
  });

  it('does not defer request-less queue drains in required tenant mode without params or ALS', async () => {
    const { db } = makePgDb();
    const work = vi.fn(async () => undefined);
    const onError = vi.fn();

    deferWithSessionQueueTenantScope(
      {
        db: db as never,
        config: {
          database: { dialect: 'postgresql' },
          multi_tenancy: { mode: 'required_from_auth', auth_claim: 'tenant_id' },
        },
        sessionId: 'session-1' as SessionID,
        params: {},
        label: 'session after.patch drain',
      },
      work,
      onError
    );

    expect(work).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.any(String) }));
  });

  it('defers request-less queue drains with a trusted tenant hint', async () => {
    const { db } = makePgDb();
    const seen: string[] = [];

    const drained = new Promise<void>((resolve, reject) => {
      deferWithSessionQueueTenantScope(
        {
          db: db as never,
          config: {
            database: { dialect: 'postgresql' },
            multi_tenancy: { mode: 'required_from_auth', auth_claim: 'tenant_id' },
          },
          sessionId: 'session-1' as SessionID,
          params: {},
          tenantIdHint: 'tenant-from-row',
          label: 'session after.patch drain',
        },
        async (params) => {
          seen.push(`tenant:${getCurrentTenantId()}`);
          seen.push(`params:${params.tenant?.tenant_id}`);
          resolve();
        },
        reject
      );
    });
    await drained;

    expect(seen).toEqual(['tenant:tenant-from-row', 'params:tenant-from-row']);
  });
});
