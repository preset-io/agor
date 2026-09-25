import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database, type SystemDatabase } from '../client';
import { select } from '../database-wrapper';
import { initializeDatabase } from '../migrate';
import { appVariables } from '../schema';
import {
  runWithSystemDatabaseScope,
  runWithTenantContext,
  runWithTenantDatabaseTransaction,
} from '../tenant-scope';
import { AppVariableRepository } from './app-variables';
import {
  getTenantPublicBaseUrl,
  TENANT_PUBLIC_ROUTING_KEY,
  TENANT_PUBLIC_ROUTING_NAMESPACE,
  TenantPublicRoutingDiscoveryRepository,
  TenantPublicRoutingRepository,
} from './tenant-public-routing';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
describe.skipIf(!postgresUrl || process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'tenant public routing PostgreSQL isolation',
  () => {
    let db: Database;
    let replica: Database;
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const tenantA = `public-url-a-${suffix}`;
    const tenantB = `public-url-b-${suffix}`;
    beforeAll(async () => {
      db = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      await initializeDatabase(db);
      replica = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
    });
    afterAll(async () => {
      await (db as Database & { $client: { end(): Promise<void> } }).$client.end();
      await (replica as Database & { $client: { end(): Promise<void> } }).$client.end();
    });
    const observe = (tenant: string, url: string, iat: number, connection = db) =>
      runWithTenantDatabaseTransaction(connection, tenant, (scoped) =>
        new TenantPublicRoutingRepository(scoped).observeVerifiedLaunch({
          public_base_url: url,
          assertion_issued_at: iat,
        })
      );
    const read = (tenant: string) => runWithTenantContext(tenant, () => getTenantPublicBaseUrl(db));

    it('cannot read or overwrite another tenant routing entry under the same variable key', async () => {
      await observe(tenantA, 'https://a.test', 100);
      await expect(read(tenantB)).resolves.toBe('');
      await observe(tenantB, 'https://b.test', 500);
      expect(await Promise.all([read(tenantA), read(tenantB)])).toEqual([
        'https://a.test',
        'https://b.test',
      ]);
      await observe(tenantB, 'https://changed-b.test', 501);
      await expect(read(tenantA)).resolves.toBe('https://a.test');
    });
    it('serializes concurrent first launches/updates without process locks or cache leakage', async () => {
      const tenant = `public-url-race-${suffix}`;
      await Promise.all([
        observe(tenant, 'https://new.test', 200),
        observe(tenant, 'https://old.test', 100, replica),
      ]);
      await expect(read(tenant)).resolves.toBe('https://new.test');
      await Promise.all([
        observe(tenant, 'https://old.test', 150),
        observe(tenant, 'https://newest.test', 300),
      ]);
      await expect(read(tenant)).resolves.toBe('https://newest.test');
      await runWithTenantContext(tenant, () =>
        expect(getTenantPublicBaseUrl(replica)).resolves.toBe('https://newest.test')
      );
    });

    const discover = (host: string, capability?: 'api_key_host_tenant_discovery') =>
      runWithSystemDatabaseScope(
        db,
        'test host discovery',
        (systemDb) =>
          new TenantPublicRoutingDiscoveryRepository(systemDb).findTenantIdByRequestHost(host),
        capability ? { capability } : {}
      );

    it('maps a trusted Host to exactly its tenant only under the discovery capability', async () => {
      const tenant = `host-discovery-${suffix}`;
      const host = `ws-${suffix}.cloud.test`;
      await observe(tenant, `https://${host}`, 100);

      await expect(discover(host, 'api_key_host_tenant_discovery')).resolves.toBe(tenant);
      await expect(
        discover(`${host.toUpperCase()}:443`, 'api_key_host_tenant_discovery')
      ).resolves.toBe(tenant);
      // Plain system scope has no row visibility for tenant-owned routing rows.
      await expect(discover(host)).resolves.toBeNull();
      await expect(
        discover(`other-${suffix}.cloud.test`, 'api_key_host_tenant_discovery')
      ).resolves.toBeNull();
      await expect(discover(`evil.${host}`, 'api_key_host_tenant_discovery')).resolves.toBeNull();
    });

    it('fails closed when tenants claim one host with equally new assertions', async () => {
      const host = `shared-${suffix}.cloud.test`;
      await observe(`host-dup-a-${suffix}`, `https://${host}`, 100);
      await observe(`host-dup-b-${suffix}`, `https://${host}`, 100);
      await expect(discover(host, 'api_key_host_tenant_discovery')).resolves.toBeNull();
    });

    it('picks the newest signed claim when a host moved between tenants', async () => {
      const host = `moved-${suffix}.cloud.test`;
      const previous = `host-prev-${suffix}`;
      const current = `host-curr-${suffix}`;
      await observe(current, `https://${host}`, 200);
      await observe(previous, `https://${host}`, 100);
      await expect(discover(host, 'api_key_host_tenant_discovery')).resolves.toBe(current);
    });

    it('ignores imported routing rows whose assertion binding names another tenant', async () => {
      const tenant = `host-import-${suffix}`;
      const host = `imported-${suffix}.cloud.test`;
      await runWithTenantDatabaseTransaction(db, tenant, (scoped) =>
        new AppVariableRepository(scoped).set({
          namespace: TENANT_PUBLIC_ROUTING_NAMESPACE,
          key: TENANT_PUBLIC_ROUTING_KEY,
          value: JSON.stringify({
            tenant_id: `source-${suffix}`,
            public_base_url: `https://${host}`,
            assertion_issued_at: 100,
          }),
          content_type: 'application/json',
        })
      );
      await expect(discover(host, 'api_key_host_tenant_discovery')).resolves.toBeNull();
    });

    it('exposes no other app variable to the discovery capability', async () => {
      const tenant = `host-secret-${suffix}`;
      const marker = `marker-${suffix}`;
      await observe(tenant, `https://secret-${suffix}.cloud.test`, 100);
      await runWithTenantDatabaseTransaction(db, tenant, (scoped) =>
        new AppVariableRepository(scoped).set({
          namespace: 'tenant.secrets',
          key: 'public_url',
          value: marker,
        })
      );
      const visible = (await runWithSystemDatabaseScope(
        db,
        'test capability visibility',
        (systemDb: SystemDatabase) =>
          select(systemDb, {
            namespace: appVariables.namespace,
            key: appVariables.key,
            value_text: appVariables.value_text,
          })
            .from(appVariables)
            .where(and(eq(appVariables.key, 'public_url')))
            .all(),
        { capability: 'api_key_host_tenant_discovery' }
      )) as Array<{ namespace: string; value_text: string | null }>;
      expect(visible.length).toBeGreaterThan(0);
      for (const row of visible) {
        expect(row.namespace).toBe(TENANT_PUBLIC_ROUTING_NAMESPACE);
        expect(row.value_text).not.toBe(marker);
      }
    });
  }
);
