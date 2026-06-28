/**
 * Event emission contract for the Drizzle → Feathers adapter.
 *
 * Each FeathersJS service method has a canonical event:
 *   create → 'created'
 *   update → 'updated'
 *   patch  → 'patched'
 *   remove → 'removed'
 *
 * The adapter used to emit BOTH `'updated'` and `'patched'` from `update()`
 * "for consistency", which doubled live-event delivery for any subscriber
 * listening to both. These tests pin the corrected behavior so the
 * convention doesn't drift again — the chime hook (and any future event
 * subscriber) can rely on one event per write.
 */
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

  it('emits only `created` on create()', async () => {
    const repo = makeRepo();
    const { service, events } = makeService(repo);

    await service.create({ id: 'w1', name: 'hello' });

    expect(events.map((e) => e.event)).toEqual(['created']);
  });

  it('emits only `patched` on patch()', async () => {
    const repo = makeRepo([{ id: 'w1', name: 'hello' }]);
    const { service, events } = makeService(repo);

    await service.patch('w1', { name: 'updated' });

    expect(events.map((e) => e.event)).toEqual(['patched']);
  });

  it('emits only `updated` on update() — NOT `patched`', async () => {
    // Regression: the adapter used to emit both for "consistency". That
    // doubled delivery for any subscriber listening to both events, which
    // is the entire UI chime hook + anyone else doing "react to any
    // mutation". Per Feathers convention, update() owns 'updated' and
    // patch() owns 'patched'. Don't conflate.
    const repo = makeRepo([{ id: 'w1', name: 'hello' }]);
    const { service, events } = makeService(repo);

    await service.update('w1', { id: 'w1', name: 'replaced' });

    expect(events.map((e) => e.event)).toEqual(['updated']);
  });

  it('emits only `removed` on remove()', async () => {
    const repo = makeRepo([{ id: 'w1', name: 'hello' }]);
    const { service, events } = makeService(repo);

    await service.remove('w1');

    expect(events.map((e) => e.event)).toEqual(['removed']);
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
