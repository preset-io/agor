import { readFileSync } from 'node:fs';
import { runWithTenantDatabaseScope } from '@agor/core/db';
import { type Application, feathers } from '@agor/core/feathers';
import type { HookContext } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { emitServiceEvent, publishCommittedServiceEvent } from './emit-service-event';

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
    const db = { run: vi.fn() } as never;

    await runWithTenantDatabaseScope(db, 'tenant-a', async () => {
      emitServiceEvent(app, { path: 'branches', event: 'patched', data: { id: 'b1' } });
    });

    expect(emit.mock.calls[0][2]).toMatchObject({
      params: { tenant: { tenant_id: 'tenant-a', source: 'explicit' } },
    });
  });

  it('rejects an explicit tenant that conflicts with the ambient scope', async () => {
    const { app } = makeApp(vi.fn());
    const db = { run: vi.fn() } as never;

    await runWithTenantDatabaseScope(db, 'tenant-a', async () => {
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

describe('publishCommittedServiceEvent', () => {
  it('keeps bulk dispatch redaction, one event per row, and the original CRUD response', async () => {
    const app = feathers();
    const rows = [
      { branch_id: 'a', private: true },
      { branch_id: 'b', private: true },
    ];
    app.use('branches', {
      async create() {
        return rows;
      },
    });
    app.service('branches').hooks({
      after: {
        create: [
          (context: HookContext) => {
            context.dispatch = rows.map(({ branch_id }) => ({ branch_id }));
            return context;
          },
          publishCommittedServiceEvent,
        ],
      },
    });
    const received = vi.fn();
    app.service('branches').on('created', received);
    await runWithTenantDatabaseScope({ run() {} } as never, 'tenant-a', async () => {
      expect(await app.service('branches').create({})).toBe(rows);
      expect(received).not.toHaveBeenCalled();
    });
    expect(received).toHaveBeenCalledTimes(2);
    expect(received.mock.calls.map(([row]) => row)).toEqual([
      { branch_id: 'a' },
      { branch_id: 'b' },
    ]);
    for (const [, hook] of received.mock.calls) {
      expect(hook).toMatchObject({
        path: 'branches',
        event: 'created',
        method: 'create',
        params: { tenant: { tenant_id: 'tenant-a' } },
      });
    }
  });

  it('preserves explicit null dispatch without publishing the private result', async () => {
    const app = feathers();
    const row = { branch_id: 'a', private: true };
    app.use('branches', {
      async create() {
        return row;
      },
    });
    app.service('branches').hooks({
      after: {
        create: [
          (context: HookContext) => {
            context.dispatch = null;
            return context;
          },
          publishCommittedServiceEvent,
        ],
      },
    });
    const received = vi.fn();
    app.service('branches').on('created', received);
    await runWithTenantDatabaseScope({ run() {} } as never, 'tenant-a', async () => {
      expect(await app.service('branches').create({})).toBe(row);
      expect(received).not.toHaveBeenCalled();
    });
    expect(received).toHaveBeenCalledOnce();
    const [payload, hook] = received.mock.calls[0];
    expect(payload).toBeNull();
    expect(hook).toMatchObject({
      result: null,
      params: { tenant: { tenant_id: 'tenant-a' } },
    });
  });

  it('does not re-enable a suppressed event', () => {
    const context = { event: null, result: { branch_id: 'a' } } as HookContext;
    expect(publishCommittedServiceEvent(context)).toBe(context);
    expect(context.event).toBeNull();
  });

  it('emits once without an outer tenant transaction too', async () => {
    const app = feathers();
    app.use('board-objects', {
      async create() {
        return { object_id: 'placement' };
      },
    });
    app.service('board-objects').hooks({ after: { create: [publishCommittedServiceEvent] } });
    const received = vi.fn();
    app.service('board-objects').on('created', received);
    await app.service('board-objects').create({});
    expect(received).toHaveBeenCalledOnce();
  });
});

describe('board patch custom actions', () => {
  it('preserves the original hook params for every manually emitted patched event', () => {
    const source = readFileSync(new URL('../register-hooks.ts', import.meta.url), 'utf8');
    const patchHook = source.slice(
      source.indexOf("if (_action === 'upsertObject')"),
      source.indexOf('return context;', source.indexOf("if (_action === 'deleteZone'"))
    );

    // applyLayout adds one complete layout event plus the board/object
    // compatibility events; each must retain the authorized request params.
    expect(patchHook.match(/params: context\.params/g)).toHaveLength(9);
    expect(patchHook.match(/emitServiceEvent\(app/g)).toHaveLength(9);
    const noOpGuard = patchHook.indexOf('if (result.changed === false)');
    const firstLayoutEvent = patchHook.indexOf('event: BOARD_LAYOUT_APPLIED_EVENT');
    expect(patchHook).toContain('context.event = null');
    expect(patchHook).toContain("if (_action === 'setZoneLayoutDefaults' && defaults)");
    expect(patchHook).toContain('if (!result.changed) return context');
    expect(noOpGuard).toBeGreaterThan(-1);
    expect(noOpGuard).toBeLessThan(firstLayoutEvent);
  });

  it('authorizes every layout placement before the atomic write', () => {
    const source = readFileSync(new URL('../register-hooks.ts', import.meta.url), 'utf8');
    const layoutAction = source.slice(
      source.indexOf("if (_action === 'applyLayout'"),
      source.indexOf("if (_action === 'setZoneLayoutDefaults'")
    );
    const authorization = layoutAction.indexOf('await authorizeBoardLayoutPlacements(');
    expect(authorization).toBeGreaterThan(-1);
    expect(authorization).toBeLessThan(layoutAction.indexOf('applyBoardLayout('));
    expect(layoutAction).toContain('boardLayoutPlacementIds({ placements, expected }');
  });
});
