import { describe, expect, it, vi } from 'vitest';
import type { Repository } from '../adapters/drizzle';
import { filterChannelToTenant } from './tenant-channel-scope';
import { asTenantId, resolveTenantContext, type TenantParams } from './tenant-context';
import { TenantDatabaseRegistry, TenantRepositoryProvider } from './tenant-db-registry';
import { TenantRoutedRepositoryAdapter } from './tenant-routed-adapter-poc';

class FakeChannel {
  constructor(public connections: unknown[]) {}
  filter(fn: (connection: unknown) => boolean) {
    return new FakeChannel(this.connections.filter(fn));
  }
}

type Row = { id: string; value: string };

function repo(label: string): Repository<Row> {
  const rows = new Map<string, Row>();
  return {
    async create(data) {
      const row = { id: data.id ?? `${label}-id`, value: data.value ?? label };
      rows.set(row.id, row);
      return row;
    },
    async findById(id) {
      return rows.get(id) ?? null;
    },
    async findAll() {
      return [...rows.values()];
    },
    async update(id, updates) {
      const next = { ...(rows.get(id) ?? { id, value: label }), ...updates };
      rows.set(id, next);
      return next;
    },
    async delete(id) {
      rows.delete(id);
    },
  };
}

describe('tenant routing POC', () => {
  it('stamps tenant context from trusted auth payload and socket connection', async () => {
    const hook = resolveTenantContext({ claim: 'tenant_id' });
    const connection = {};
    const context = await hook({
      params: { authentication: { payload: { tenant_id: 'tenant-a' } }, connection },
    } as any);

    expect((context.params as TenantParams).tenant?.tenantId).toBe('tenant-a');
    expect((context.params as TenantParams).adapter?.tenantId).toBe('tenant-a');
    expect((connection as any).tenant.tenantId).toBe('tenant-a');
  });

  it('routes repository operations to the database selected by params.tenant', async () => {
    const dbs = new Map<string, unknown>();
    const registry = new TenantDatabaseRegistry({
      createDatabase: vi.fn(async (tenantId) => {
        const db = { tenantId } as any;
        dbs.set(tenantId, db);
        return db;
      }),
    });
    const provider = new TenantRepositoryProvider(registry, (db: any) => repo(db.tenantId));
    const service = new TenantRoutedRepositoryAdapter<Row>(provider, 'id');

    const tenantA = { tenant: { tenantId: asTenantId('tenant-a') } } as TenantParams;
    const tenantB = { tenant: { tenantId: asTenantId('tenant-b') } } as TenantParams;

    await service.create({ id: 'same-id', value: 'A' }, tenantA);
    await service.create({ id: 'same-id', value: 'B' }, tenantB);

    await expect(service.get('same-id', tenantA)).resolves.toMatchObject({ value: 'A' });
    await expect(service.get('same-id', tenantB)).resolves.toMatchObject({ value: 'B' });
    expect(dbs.size).toBe(2);
  });

  it('filters websocket event channels by tenant and fails closed without tenant context', () => {
    const tenantA = asTenantId('tenant-a');
    const tenantB = asTenantId('tenant-b');
    const service = { user: { role: 'service', _isServiceAccount: true } };
    const channel = new FakeChannel([
      { tenant: { tenantId: tenantA }, user: { user_id: 'a' } },
      { tenant: { tenantId: tenantB }, user: { user_id: 'b' } },
      service,
      { user: { user_id: 'missing-tenant' } },
    ]) as any;

    expect(filterChannelToTenant(channel, tenantA).connections).toEqual([
      { tenant: { tenantId: tenantA }, user: { user_id: 'a' } },
      service,
    ]);
    expect(filterChannelToTenant(channel, undefined).connections).toEqual([service]);
  });
});
