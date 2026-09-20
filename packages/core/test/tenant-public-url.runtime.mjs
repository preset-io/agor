import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// Run with plain Node, not Vitest's source aliases: this specifically tests the
// separate package entrypoints consumed by the packaged ESM daemon.
for (const format of ['esm', 'cjs']) {
  test(`packaged ${format} config and DB share trusted tenant routing context`, async () => {
    const load =
      format === 'cjs' ? createRequire(import.meta.url) : (specifier) => import(specifier);
    const home = await mkdtemp(path.join(os.tmpdir(), 'agor-routing-artifacts-'));
    const keys = [
      'HOME',
      'USERPROFILE',
      'AGOR_DATA_HOME',
      'AGOR_DB_DIALECT',
      'DATABASE_URL',
      'AGOR_BASE_URL',
    ];
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    for (const key of keys.slice(2)) delete process.env[key];
    const databases = new Map();
    try {
      const {
        createDatabase,
        initializeDatabase,
        runWithTenantContext,
        runWithTenantDatabaseTransaction,
        TenantPublicRoutingRepository,
      } = await load('@agor/core/db');
      const { getBaseUrl, __resetConfigCacheForTests } = await load('@agor/core/config');
      // SQLite has no RLS; use separate fixtures to test concurrent ALS plumbing.
      // Shared-database isolation remains covered by the PostgreSQL suite.
      for (const tenant of ['tenant-a', 'tenant-b', 'uninitialized']) {
        const db = createDatabase({
          dialect: 'sqlite',
          url: `file:${path.join(home, `${tenant}.db`)}`,
        });
        databases.set(tenant, db);
        await initializeDatabase(db);
      }
      await mkdir(path.join(home, '.agor'), { recursive: true });
      const configPath = path.join(home, '.agor/config.yaml');
      await writeFile(
        configPath,
        `database:
  dialect: postgresql
multi_tenancy:
  mode: required_from_auth
  auth_claim: tenant_id
  filesystem_isolation_enabled: true
execution:
  branch_storage:
    default_mode: clone
    allowed_modes: [clone]
`
      );
      process.env.AGOR_BASE_URL = 'https://cell.example.test';
      __resetConfigCacheForTests();
      for (const tenant of ['tenant-a', 'tenant-b']) {
        await runWithTenantDatabaseTransaction(databases.get(tenant), tenant, (scoped) =>
          new TenantPublicRoutingRepository(scoped).observeVerifiedLaunch({
            public_base_url: `https://${tenant}.example.test`,
            assertion_issued_at: 100,
          })
        );
      }
      assert.deepEqual(
        await Promise.all(
          ['tenant-a', 'tenant-b', 'uninitialized'].map((tenant) =>
            runWithTenantContext(tenant, () => getBaseUrl(databases.get(tenant)))
          )
        ),
        ['https://tenant-a.example.test', 'https://tenant-b.example.test', '']
      );
      await runWithTenantDatabaseTransaction(databases.get('tenant-a'), 'tenant-a', async () => {
        assert.equal(await getBaseUrl(), 'https://tenant-a.example.test');
      });
      await assert.rejects(getBaseUrl(databases.get('tenant-a')), /trusted tenant identity/);
      await writeFile(configPath, '{}\n');
      __resetConfigCacheForTests();
      const forbiddenDatabase = new Proxy(
        {},
        {
          get() {
            throw new Error('Static fallback touched DB');
          },
        }
      );
      assert.equal(await getBaseUrl(forbiddenDatabase), 'https://cell.example.test');
    } finally {
      for (const db of databases.values()) db.$client.close();
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(home, { recursive: true, force: true });
    }
  });
}
