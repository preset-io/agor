import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  expiredByTenant: new Map<string, any[]>(),
  discovered: [] as string[],
  deletes: [] as any[],
  configured: 0,
  systemOptions: undefined as unknown,
}));

vi.mock('@agor/core/config', () => ({
  resolveMultiTenancyConfig: (config: any) => ({
    mode: config.multi_tenancy?.mode ?? 'static',
    static_tenant_id: config.multi_tenancy?.static_tenant_id ?? 'default',
  }),
}));
vi.mock('@agor/core/db', () => ({
  assertValidTenantId: (value: string) => {
    if (!value || value.includes('/')) throw new Error('Invalid tenant id');
  },
  isPostgresDatabase: (db: any) => db.postgres === true,
  isPostgresDatabaseHandle: (db: any) => db.postgres === true,
  runWithSystemDatabaseScope: async (
    _db: unknown,
    _reason: string,
    work: (db: unknown) => unknown,
    options: unknown
  ) => {
    state.systemOptions = options;
    return work({});
  },
  runWithTenantDatabaseScope: async (_db: unknown, tenantId: string, work: () => unknown) => work(),
  UploadMaintenanceDiscoveryRepository: class {
    async findExpiredTenantIds() {
      return state.discovered;
    }
  },
  UploadRepository: class {
    async findExpired(tenantId: string, _now: Date, limit: number) {
      return (state.expiredByTenant.get(tenantId) ?? []).slice(0, limit);
    }
  },
}));
vi.mock('./utils/upload-staging.js', () => ({
  configureUploadStagingStoreFromConfig: () => {
    state.configured++;
  },
  getUploadStagingStore: () => ({
    delete: async (input: unknown) => {
      state.deletes.push(input);
    },
  }),
}));

import { cleanupExpiredUploads } from './uploads-maintenance.js';

const row = (tenantId: string, suffix: string) => ({
  tenantId,
  sessionId: `session-${suffix}`,
  branchId: `branch-${suffix}`,
  ref: `upl_${suffix}`,
});

describe('deployment-local upload maintenance', () => {
  beforeEach(() => {
    state.expiredByTenant.clear();
    state.discovered = [];
    state.deletes = [];
    state.configured = 0;
    state.systemOptions = undefined;
  });

  it('defaults static deployments to their configured tenant', async () => {
    state.expiredByTenant.set('self-hosted', [row('self-hosted', 'one')]);
    const result = await cleanupExpiredUploads({
      db: {} as never,
      config: { multi_tenancy: { mode: 'static', static_tenant_id: 'self-hosted' } },
    });

    expect(result).toMatchObject({ tenantsExamined: 1, expired: 1, deleted: 1, failed: 0 });
    expect(state.deletes).toHaveLength(1);
    await expect(
      cleanupExpiredUploads({
        db: {} as never,
        config: { multi_tenancy: { mode: 'static', static_tenant_id: 'self-hosted' } },
        tenantId: 'another-tenant',
      })
    ).rejects.toThrow(/refusing another-tenant/);
  });

  it('uses narrow system discovery then tenant-scoped bounded deletion', async () => {
    state.discovered = ['tenant-a', 'tenant-b'];
    state.expiredByTenant.set('tenant-a', [row('tenant-a', 'one'), row('tenant-a', 'two')]);
    state.expiredByTenant.set('tenant-b', [row('tenant-b', 'three')]);
    const result = await cleanupExpiredUploads({
      db: { postgres: true } as never,
      config: { multi_tenancy: { mode: 'required_from_auth' } },
      allTenants: true,
      limit: 2,
    });

    expect(state.systemOptions).toEqual({ capability: 'upload_maintenance' });
    expect(result).toMatchObject({ expired: 2, deleted: 2, hasMore: true });
    expect(state.deletes).toHaveLength(2);
  });

  it('requires explicit scope in multi-tenant mode and keeps dry runs byte-free', async () => {
    await expect(
      cleanupExpiredUploads({
        db: { postgres: true } as never,
        config: { multi_tenancy: { mode: 'required_from_auth' } },
      })
    ).rejects.toThrow(/--tenant-id or --all-tenants/);

    state.expiredByTenant.set('tenant-a', [row('tenant-a', 'one')]);
    const result = await cleanupExpiredUploads({
      db: {} as never,
      config: { multi_tenancy: { mode: 'required_from_auth' } },
      tenantId: 'tenant-a',
      dryRun: true,
    });
    expect(result).toMatchObject({ dryRun: true, expired: 1, deleted: 0 });
    expect(state.configured).toBe(0);
    expect(state.deletes).toHaveLength(0);
  });
});
