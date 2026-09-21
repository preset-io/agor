import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../client';
import { initializeDatabase } from '../migrate';
import { runWithTenantContext, runWithTenantDatabaseTransaction } from '../tenant-scope';
import { getTenantPublicBaseUrl, TenantPublicRoutingRepository } from './tenant-public-routing';

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
  }
);
