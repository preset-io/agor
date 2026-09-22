import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const home = await mkdtemp(path.join(os.tmpdir(), 'agor-refresh-runtime-'));
const envKeys = ['HOME', 'USERPROFILE', 'AGOR_DATA_HOME', 'AGOR_DB_DIALECT', 'DATABASE_URL'];
const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
process.env.HOME = home;
process.env.USERPROFILE = home;
for (const key of envKeys.slice(2)) delete process.env[key];
after(async () => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(home, { recursive: true, force: true });
});

// Plain Node deliberately loads separate published bundles, not Vitest's
// shared source graph. No live database, grant or provider is used.
for (const format of ['esm', 'cjs']) {
  test(`packaged ${format} OAuth refresh shares the daemon's tenant authority`, async (t) => {
    const load = format === 'cjs' ? createRequire(import.meta.url) : (id) => import(id);
    const db = await load('@agor/core/db');
    const oauth = await load('@agor/core/tools/mcp/oauth-refresh');
    const forbiddenNetwork = () => assert.fail('Refresh must not dispatch without a grant');
    t.mock.method(globalThis, 'fetch', forbiddenNetwork);
    t.mock.method(http, 'request', forbiddenNetwork);
    t.mock.method(https, 'request', forbiddenNetwork);

    let reads = 0;
    const query = {
      from() {
        return this;
      },
      where() {
        return this;
      },
      async get() {
        reads++;
        assert.equal(db.getCurrentTenantId(), 'tenant-a');
        assert.equal(db.getCurrentTenantDatabaseScope()?.kind, 'tenant');
        return undefined;
      },
    };
    const sqlite = db.createTenantScopedDatabaseProxy({
      run() {
        assert.fail('Unexpected write');
      },
      select() {
        return query;
      },
    });
    const postgres = db.createTenantScopedDatabaseProxy({
      transaction() {
        assert.fail('Conflicting tenant reached the database');
      },
    });
    const options = {
      tenantId: 'tenant-a',
      userId: 'synthetic-user',
      mcpServerId: 'synthetic-server',
      observedRefreshVersion: {
        grantGeneration: 0,
        refreshGeneration: 0,
        grantBindingFingerprint: 'synthetic-binding',
      },
      validateGrant() {
        assert.fail('No grant exists');
      },
    };

    // Both dialects must see the originating operation identity across the
    // bundle boundary and refuse a conflicting caller before touching data.
    for (const guarded of [sqlite, postgres]) {
      await db.runWithTenantContext('tenant-b', () =>
        assert.rejects(
          oauth.refreshAndPersistToken({ ...options, db: guarded }),
          /active tenant context tenant-b/
        )
      );
    }
    assert.equal(reads, 0);
    await db.runWithTenantContext('tenant-a', () =>
      assert.rejects(
        oauth.refreshAndPersistToken({ ...options, db: sqlite }),
        (error) => error instanceof oauth.MissingRefreshTokenError
      )
    );
    assert.equal(reads, 1); // Reached the scoped grant lookup, not a proxy guard failure.
    await assert.rejects(
      oauth.refreshAndPersistToken({ ...options, tenantId: undefined, db: sqlite }),
      /Missing tenant database scope/
    );
    assert.equal(reads, 1);
    assert.equal(db.getCurrentTenantId(), undefined);
    assert.equal(db.getCurrentTenantDatabaseScope(), undefined);
    assert.throws(() => 'run' in sqlite, /Missing tenant database scope/);
  });

  test(`packaged ${format} scopes reject a different database, including mixed ESM/CJS`, async (t) => {
    const esmDb = await import('@agor/core/db');
    const cjsDb = createRequire(import.meta.url)('@agor/core/db');
    const db = format === 'esm' ? esmDb : cjsDb;
    const other = format === 'esm' ? cjsDb : esmDb;
    const refreshers = [
      await import('@agor/core/tools/mcp/oauth-refresh'),
      createRequire(import.meta.url)('@agor/core/tools/mcp/oauth-refresh'),
    ];
    const forbiddenNetwork = () => assert.fail('No provider I/O is permitted');
    t.mock.method(globalThis, 'fetch', forbiddenNetwork);
    t.mock.method(http, 'request', forbiddenNetwork);
    t.mock.method(https, 'request', forbiddenNetwork);

    const reads = [];
    function database(name) {
      const query = {
        from() {
          return this;
        },
        where() {
          return this;
        },
        async get() {
          reads.push(name);
          return undefined;
        },
      };
      return db.createTenantScopedDatabaseProxy({
        run() {
          assert.fail('Unexpected write');
        },
        select() {
          return query;
        },
      });
    }
    const a = database('A');
    const b = database('B');
    const mismatch = /different database/;
    const options = {
      db: b,
      tenantId: 'tenant-a',
      userId: 'synthetic-user',
      mcpServerId: 'synthetic-server',
      observedRefreshVersion: {
        grantGeneration: 0,
        refreshGeneration: 0,
        grantBindingFingerprint: 'synthetic-binding',
      },
      validateGrant() {
        assert.fail('No grant exists');
      },
    };
    await db.runWithTenantContext('tenant-a', () =>
      db.runWithTenantDatabaseScope(a, 'tenant-a', async (scoped) => {
        for (const oauth of refreshers) {
          await assert.rejects(oauth.refreshAndPersistToken(options), mismatch);
        }
        await assert.rejects(
          other.runWithTenantDatabaseScope(b, 'tenant-a', async () => assert.fail('Entered B')),
          mismatch
        );
        assert.throws(() => b.select(), mismatch);
        assert.deepEqual(reads, []); // Neither A nor B may be queried on a mismatch.
        await other.runWithTenantDatabaseScope(a, 'tenant-a', async (nested) => {
          assert.equal(nested, scoped);
          await a.select().from().where().get();
        });
      })
    );
    assert.deepEqual(reads, ['A']);

    // The base, its proxies, and the current transaction all belong to A.
    // Mixing module formats must not turn legitimate nesting into a rejection.
    let transactions = 0;
    let settings = 0;
    const tx = {
      async execute() {
        settings++;
      },
      marker() {
        return 'transaction';
      },
    };
    const base = {
      async transaction(work) {
        transactions++;
        return work(tx);
      },
      marker() {
        assert.fail('Proxy bypassed the transaction');
      },
    };
    const guarded = db.createTenantScopedDatabaseProxy(base);
    await db.runWithTenantDatabaseScope(guarded, 'tenant-a', async (scoped) => {
      for (const handle of [
        base,
        guarded,
        scoped,
        other.createTenantScopedDatabaseProxy(scoped),
        other.createTenantScopedDatabaseProxy(guarded),
      ]) {
        await other.runWithTenantDatabaseScope(handle, 'tenant-a', async (nested) => {
          assert.equal(nested, scoped);
          assert.equal(guarded.marker(), 'transaction');
        });
        await other.runWithTenantDatabaseTransaction(handle, 'tenant-a', async (nested) => {
          assert.equal(nested, scoped);
        });
      }
      await assert.rejects(
        other.runWithTenantDatabaseTransaction(b, 'tenant-a', async () => assert.fail('Entered B')),
        mismatch
      );
    });
    assert.equal(transactions, 1);
    assert.equal(settings, 1);

    // Independent async chains still own their database and tenant identity.
    await Promise.all(
      [
        [a, 'tenant-a'],
        [b, 'tenant-b'],
      ].map(([handle, tenantId]) =>
        db.runWithTenantContext(tenantId, () =>
          other.runWithTenantDatabaseScope(handle, tenantId, async () => {
            await new Promise((resolve) => setImmediate(resolve));
            assert.equal(db.getCurrentTenantId(), tenantId);
            await handle.select().from().where().get();
          })
        )
      )
    );
    assert.deepEqual(reads, ['A', 'A', 'B']);
    assert.equal(db.getCurrentTenantDatabaseScope(), undefined);
    assert.equal(other.getCurrentTenantId(), undefined);
  });
}
