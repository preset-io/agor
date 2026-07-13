import { readFileSync } from 'node:fs';
import { tenantDatabaseScope } from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import { describe, expect, it, vi } from 'vitest';
import { emitServiceEvent } from './emit-service-event';

function makeApp(emit: (name: string, data: unknown, hook: unknown) => void) {
  const service = { emit };
  return {
    app: {
      service: vi.fn(() => service),
    } as unknown as Application,
    service,
  };
}

describe('emitServiceEvent', () => {
  it('emits a HookContext-shaped third arg so the publish handler can scope the event', () => {
    const emit = vi.fn();
    const { app } = makeApp(emit);
    const params = { tenant: { tenant_id: 'tenant-a', source: 'auth_claim' } };
    const data = { branch_id: 'b1', environment_instance: { status: 'running' } };

    emitServiceEvent(app, {
      path: 'branches',
      event: 'patched',
      data,
      params: params as never,
      id: 'b1',
    });

    expect(emit).toHaveBeenCalledTimes(1);
    const [event, payload, hook] = emit.mock.calls[0];
    expect(event).toBe('patched');
    expect(payload).toBe(data);
    // The third arg is passed UNCHANGED by Feathers as the publish `hook`, so
    // it must carry path (RBAC scoping) and params (tenant resolution).
    expect(hook).toMatchObject({
      path: 'branches',
      event: 'patched',
      method: 'patch',
      id: 'b1',
      params,
      result: data,
    });
    expect((hook as { app: unknown }).app).toBe(app);
  });

  it('infers the CRUD method from the event name and defaults params to an object', () => {
    const emit = vi.fn();
    const { app } = makeApp(emit);

    emitServiceEvent(app, { path: 'boards', event: 'created', data: { id: 'x' } });

    const hook = emit.mock.calls[0][2];
    expect(hook).toMatchObject({ path: 'boards', method: 'create', params: {} });
  });

  it('honors an explicit method override', () => {
    const emit = vi.fn();
    const { app } = makeApp(emit);

    emitServiceEvent(app, { path: 'branches', event: 'custom', data: {}, method: 'get' });

    expect(emit.mock.calls[0][2]).toMatchObject({ method: 'get' });
  });

  it('snapshots the ambient tenant for asynchronous publication', async () => {
    const emit = vi.fn();
    const { app } = makeApp(emit);
    const db = {} as never;

    await tenantDatabaseScope.run({ db, kind: 'tenant', tenantId: 'tenant-a' }, async () => {
      emitServiceEvent(app, { path: 'branches', event: 'patched', data: { id: 'b1' } });
    });

    expect(emit.mock.calls[0][2]).toMatchObject({
      params: { tenant: { tenant_id: 'tenant-a', source: 'explicit' } },
    });
  });

  it('rejects an explicit tenant that conflicts with the ambient scope', async () => {
    const { app } = makeApp(vi.fn());
    const db = {} as never;

    await tenantDatabaseScope.run({ db, kind: 'tenant', tenantId: 'tenant-a' }, async () => {
      expect(() =>
        emitServiceEvent(app, {
          path: 'branches',
          event: 'patched',
          data: {},
          params: { tenant: { tenant_id: 'tenant-b', source: 'auth_claim' } } as never,
        })
      ).toThrow('explicit tenant does not match ambient tenant scope');
    });
  });
});

describe('board patch custom actions', () => {
  it('preserves the original hook params for every manually emitted patched event', () => {
    const source = readFileSync(new URL('../register-hooks.ts', import.meta.url), 'utf8');
    const patchHook = source.slice(
      source.indexOf("if (_action === 'upsertObject')"),
      source.indexOf('return context;', source.indexOf("if (_action === 'deleteZone'"))
    );

    expect(patchHook.match(/params: context\.params/g)).toHaveLength(5);
    expect(patchHook.match(/emitServiceEvent\(app/g)).toHaveLength(5);
  });
});
