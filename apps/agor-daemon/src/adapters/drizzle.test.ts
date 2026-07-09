/**
 * Event emission contract for the Drizzle → Feathers adapter.
 *
 * The adapter itself emits NO realtime events. Feathers' own `eventHook`
 * (`@feathersjs/feathers`) emits the canonical `created`/`updated`/`patched`/
 * `removed` events with a full HookContext for every method called through the
 * `app.service(path)` proxy — that is the event browsers receive.
 *
 * The adapter used to ALSO emit `this.emit(event, result, params)`. Because
 * Feathers' transport-commons passes the third `emit` arg through UNCHANGED as
 * the publish hook, a bare `params` object (no `path`, no `result`) produced a
 * duplicate wire event with an EMPTY name (bare `'created'`/`'patched'`) and a
 * NULL payload — noise no client could consume. These tests pin that the
 * adapter no longer emits, and that a real Feathers registration yields exactly
 * one correctly-shaped event per write (no bare/null twin).
 */
import { feathers } from '@agor/core/feathers';
import { describe, expect, it, vi } from 'vitest';
import { DrizzleService, type Repository } from './drizzle.js';

interface Widget {
  id: string;
  name: string;
  tenant_id?: string;
}

function makeRepo(seed: Widget[] = []): Repository<Widget> {
  const rows = new Map(seed.map((w) => [w.id, w]));
  return {
    create: vi.fn(async (data) => {
      const row = { id: 'auto', name: '', ...data } as Widget;
      rows.set(row.id, row);
      return row;
    }),
    findById: vi.fn(async (id) => rows.get(id) ?? null),
    findAll: vi.fn(async () => Array.from(rows.values())),
    update: vi.fn(async (id, data) => {
      const existing = rows.get(id);
      if (!existing) throw new Error(`not found: ${id}`);
      const next = { ...existing, ...data } as Widget;
      rows.set(id, next);
      return next;
    }),
    delete: vi.fn(async (id) => {
      rows.delete(id);
    }),
  };
}

function makeService(repo: Repository<Widget>): {
  service: DrizzleService<Widget>;
  events: Array<{ event: string; payload: Widget }>;
} {
  const service = new DrizzleService<Widget>(repo, { id: 'id', resourceType: 'Widget' });
  const events: Array<{ event: string; payload: Widget }> = [];
  service.emit = (event: string, payload: Widget) => {
    events.push({ event, payload });
    return true;
  };
  return { service, events };
}

describe('DrizzleService event emission', () => {
  it('reuses a hook-prefetched record on get()', async () => {
    const prefetched = { id: 'w1', name: 'from hook' };
    const repo = makeRepo([{ id: 'w1', name: 'from repo' }]);
    const { service } = makeService(repo);

    const result = await service.get('w1', {
      _agorPrefetchedRecord: { id: 'w1', idField: 'id', record: prefetched },
    } as never);

    expect(result).toBe(prefetched);
    expect(repo.findById).not.toHaveBeenCalled();
  });

  it('ignores a hook-prefetched record for a different id field', async () => {
    const prefetched = { id: 'w1', name: 'from hook' };
    const repo = makeRepo([{ id: 'w1', name: 'from repo' }]);
    const { service } = makeService(repo);

    const result = await service.get('w1', {
      _agorPrefetchedRecord: { id: 'w1', idField: 'session_id', record: prefetched },
    } as never);

    expect(result).toEqual({ id: 'w1', name: 'from repo' });
    expect(repo.findById).toHaveBeenCalledTimes(1);
  });

  it('does not emit any event itself on create/patch/update/remove', async () => {
    // The adapter must not emit — Feathers' eventHook owns delivery. A direct
    // adapter emit (with `params` as the third arg) becomes a bare, null-payload
    // wire event. Feed every mutation through the raw adapter and assert silence.
    const repo = makeRepo([{ id: 'w1', name: 'hello' }]);
    const { service, events } = makeService(repo);

    await service.create({ id: 'w2', name: 'created' });
    await service.patch('w1', { name: 'patched' });
    await service.update('w1', { id: 'w1', name: 'replaced' });
    await service.remove('w1');

    expect(events).toEqual([]);
  });

  it('registered in a real Feathers app, one write yields one path-scoped event (no bare/null twin)', async () => {
    // End-to-end guard for the bare `created`/`patched` null-payload regression.
    // Feathers' eventHook emits with a full HookContext (path + result); the
    // removed adapter emit passed raw `params`, adding a second emission whose
    // hook had no `path` (→ bare event name) and no `result` (→ null payload).
    const app = feathers();
    app.use('widgets', new DrizzleService<Widget>(makeRepo(), { id: 'id' }) as never);

    const emissions: Array<{ path: unknown; hasResult: boolean }> = [];
    (
      app.service('widgets') as unknown as {
        on: (e: string, cb: (d: unknown, h: unknown) => void) => void;
      }
    ).on('created', (_data, hook) => {
      const h = hook as { path?: unknown; result?: unknown } | undefined;
      emissions.push({ path: h?.path, hasResult: h?.result !== undefined });
    });

    await app.service('widgets').create({ id: 'w1', name: 'hello' } as never);

    expect(emissions).toEqual([{ path: 'widgets', hasResult: true }]);
  });
});

describe('DrizzleService tenant isolation', () => {
  const tenantParams = { tenant: { tenant_id: 'tenant-a', source: 'static' } } as never;

  it('stamps created rows with the resolved tenant_id', async () => {
    const repo = makeRepo();
    const { service } = makeService(repo);

    const result = await service.create(
      { id: 'w1', name: 'hello', tenant_id: 'client-supplied' },
      tenantParams
    );

    expect(result).toMatchObject({ id: 'w1', tenant_id: 'tenant-a' });
  });

  it('filters find() results to the current tenant', async () => {
    const repo = makeRepo([
      { id: 'a', name: 'A', tenant_id: 'tenant-a' },
      { id: 'b', name: 'B', tenant_id: 'tenant-b' },
    ]);
    const { service } = makeService(repo);

    await expect(service.find(tenantParams)).resolves.toEqual([
      { id: 'a', name: 'A', tenant_id: 'tenant-a' },
    ]);
  });

  it('hides get() rows from other tenants as not found', async () => {
    const repo = makeRepo([{ id: 'b', name: 'B', tenant_id: 'tenant-b' }]);
    const { service } = makeService(repo);

    await expect(service.get('b', tenantParams)).rejects.toThrow(/Widget.*b/);
  });

  it('does not allow patch() to move a row to another tenant', async () => {
    const repo = makeRepo([{ id: 'a', name: 'A', tenant_id: 'tenant-a' }]);
    const { service } = makeService(repo);

    const result = await service.patch(
      'a',
      { tenant_id: 'tenant-b', name: 'updated' },
      tenantParams
    );

    expect(result).toEqual({ id: 'a', name: 'updated', tenant_id: 'tenant-a' });
  });

  it('keeps rows isolated when the active tenant changes between calls', async () => {
    const repo = makeRepo();
    const { service } = makeService(repo);
    const tenantA = { tenant: { tenant_id: 'tenant-a', source: 'static' } } as never;
    const tenantB = { tenant: { tenant_id: 'tenant-b', source: 'static' } } as never;

    await service.create({ id: 'a', name: 'A' }, tenantA);
    await service.create({ id: 'b', name: 'B' }, tenantB);

    await expect(service.find(tenantA)).resolves.toEqual([
      { id: 'a', name: 'A', tenant_id: 'tenant-a' },
    ]);
    await expect(service.find(tenantB)).resolves.toEqual([
      { id: 'b', name: 'B', tenant_id: 'tenant-b' },
    ]);
    await expect(service.get('b', tenantA)).rejects.toThrow(/Widget.*b/);
    await expect(service.get('a', tenantB)).rejects.toThrow(/Widget.*a/);
  });
});
