import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../client';
import { initializeDatabase } from '../migrate';
import { runWithTenantDatabaseScope, runWithTenantDatabaseTransaction } from '../tenant-scope';
import { AppVariableRepository } from './app-variables';
import {
  TENANT_DISPLAY_LABEL_KEY,
  TENANT_DISPLAY_NAMESPACE,
  TenantDisplayRepository,
} from './tenant-display';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
describe.skipIf(!postgresUrl || process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'tenant display label PostgreSQL isolation',
  () => {
    let db: Database;
    let replica: Database;
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    beforeAll(async () => {
      db = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      await initializeDatabase(db);
      replica = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
    });
    afterAll(async () => {
      await (db as Database & { $client: { end(): Promise<void> } }).$client.end();
      await (replica as Database & { $client: { end(): Promise<void> } }).$client.end();
    });
    const observe = (tenant: string, label: string, iat: number, connection = db) =>
      runWithTenantDatabaseTransaction(connection, tenant, (scoped) =>
        new TenantDisplayRepository(scoped).observeVerifiedLaunch({
          label,
          assertion_issued_at: iat,
        })
      );
    const read = (tenant: string, connection = db) =>
      runWithTenantDatabaseScope(connection, tenant, async (scoped) => {
        const display = await new TenantDisplayRepository(scoped).find();
        return display?.label ?? null;
      });
    const writeRaw = (tenant: string, value: string) =>
      runWithTenantDatabaseTransaction(db, tenant, (scoped) =>
        new AppVariableRepository(scoped).set({
          namespace: TENANT_DISPLAY_NAMESPACE,
          key: TENANT_DISPLAY_LABEL_KEY,
          value,
        })
      );

    it('keeps each tenant label under the same variable key isolated', async () => {
      const tenantA = `display-a-${suffix}`;
      const tenantB = `display-b-${suffix}`;
      await observe(tenantA, 'Acme', 100);
      await expect(read(tenantB)).resolves.toBeNull();
      await observe(tenantB, 'Data team sandbox', 500);
      expect(await Promise.all([read(tenantA), read(tenantB)])).toEqual([
        'Acme',
        'Data team sandbox',
      ]);
      await observe(tenantB, 'Renamed', 501);
      await expect(read(tenantA)).resolves.toBe('Acme');
      await expect(read(tenantB, replica)).resolves.toBe('Renamed');
    });

    it('orders concurrent observations by signed iat, keeping the first at equal iat', async () => {
      const tenant = `display-race-${suffix}`;
      await Promise.all([observe(tenant, 'Newer', 200), observe(tenant, 'Older', 100, replica)]);
      await expect(read(tenant)).resolves.toBe('Newer');
      await observe(tenant, 'Same second', 200);
      await expect(read(tenant)).resolves.toBe('Newer');
      await Promise.all([observe(tenant, 'Stale', 150), observe(tenant, 'Newest', 300)]);
      await expect(read(tenant, replica)).resolves.toBe('Newest');
    });

    it('reads a corrupt row as absent and lets a verified launch repair it', async () => {
      const tenant = `display-corrupt-${suffix}`;
      await writeRaw(tenant, '{invalid');
      await expect(read(tenant)).resolves.toBeNull();
      await observe(tenant, 'Repaired', 100);
      await expect(read(tenant)).resolves.toBe('Repaired');
    });

    it('rejects a row whose assertion binding names another tenant', async () => {
      const tenant = `display-import-${suffix}`;
      await writeRaw(
        tenant,
        JSON.stringify({
          tenant_id: `source-${suffix}`,
          label: 'Source',
          assertion_issued_at: 999,
        })
      );
      await expect(read(tenant)).resolves.toBeNull();
      await observe(tenant, 'Destination', 100);
      await expect(read(tenant)).resolves.toBe('Destination');
    });
  }
);
