import { getCurrentTenantId } from '@agor/core/db';
import { describe, expect, it, vi } from 'vitest';
import type { McpContext } from './server';
import { runWithMcpTenantDatabaseUnit, tenantScopedToolProxy } from './tenant-scope';

describe('tenantScopedToolProxy', () => {
  it('refuses to open a typed tenant database unit without trusted tenant identity', async () => {
    const work = vi.fn();
    await expect(
      runWithMcpTenantDatabaseUnit({ db: {}, baseServiceParams: {} } as unknown as McpContext, work)
    ).rejects.toThrow('requires tenant identity');
    expect(work).not.toHaveBeenCalled();
  });

  it('runs the complete tool handler with tenant identity but no DB transaction', async () => {
    let registeredHandler: ((args: unknown, extra?: unknown) => unknown) | undefined;
    const server = {
      registerTool: vi.fn((_name, _config, handler) => {
        registeredHandler = handler;
      }),
    } as never;
    const db = {
      transaction: vi.fn(async (work: (tx: unknown) => unknown) => work(db)),
      execute: async () => undefined,
    };
    const ctx = {
      db,
      baseServiceParams: {
        tenant: { tenant_id: 'tenant-a', source: 'auth_claim' },
      },
    } as McpContext;

    const proxy = tenantScopedToolProxy(server, ctx);
    proxy.registerTool('test', {} as never, async () => getCurrentTenantId());

    expect(await registeredHandler?.({}, {})).toBe('tenant-a');
    expect(db.transaction).not.toHaveBeenCalled();
    expect(getCurrentTenantId()).toBeUndefined();
  });

  it('reads mutable MCP context at invocation time', async () => {
    let registeredHandler: ((args: unknown, extra?: unknown) => unknown) | undefined;
    const server = {
      registerTool: vi.fn((_name, _config, handler) => {
        registeredHandler = handler;
      }),
    } as never;
    const db = {
      transaction: vi.fn(async (work: (tx: unknown) => unknown) => work(db)),
      execute: async () => undefined,
    };
    const ctx = {
      db,
      baseServiceParams: {
        tenant: { tenant_id: 'tenant-a', source: 'auth_claim' },
      },
    } as McpContext;

    tenantScopedToolProxy(server, ctx).registerTool('test', {} as never, async () =>
      getCurrentTenantId()
    );
    ctx.baseServiceParams.tenant = { tenant_id: 'tenant-b' as never, source: 'auth_claim' };

    expect(await registeredHandler?.({}, {})).toBe('tenant-b');
  });
});
