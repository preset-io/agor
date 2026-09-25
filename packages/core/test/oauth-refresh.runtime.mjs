/**
 * MCP OAuth refresh, driven through the BUILT `@agor/core` bundles.
 *
 * `@agor/core/db` and `@agor/core/tools/mcp/oauth-refresh` are separate tsup
 * entries built with `splitting: false`, so each inlines its own copy of the
 * tenant scope runtime. The daemon builds its guarded handle with one and
 * refreshes with the other. When those copies kept private scope stores and
 * proxy-target maps, a refresh failed in Agor's own scope guard before any
 * provider request, and users saw `token_refresh_failed`.
 *
 * `scripts/packaged-tenant-scope-smoke.mjs` pins the scope primitives across
 * the `@agor/core` and `@agor/core/db` entries. This file adds what that does
 * not load: the refresh entry itself, the CommonJS bundles, ESM/CJS mixing,
 * joining an existing scope or transaction from another copy, and concurrent
 * tenant chains. Probes the smoke already makes (a guarded proxy refusing
 * outside every scope; a foreign database's proxy refusing inside a scope) are
 * deliberately not repeated here.
 */

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

const observedRefreshVersion = {
  grantGeneration: 0,
  refreshGeneration: 0,
  grantBindingFingerprint: 'synthetic-binding',
};

function forbidNetwork(t, message) {
  const forbidden = () => assert.fail(message);
  t.mock.method(globalThis, 'fetch', forbidden);
  t.mock.method(http, 'request', forbidden);
  t.mock.method(https, 'request', forbidden);
}

// Plain Node deliberately loads separate published bundles, not Vitest's
// shared source graph. No live database, grant or provider is used.
for (const format of ['esm', 'cjs']) {
  test(`packaged ${format} OAuth refresh shares the daemon's tenant authority`, async (t) => {
    const load = format === 'cjs' ? createRequire(import.meta.url) : (id) => import(id);
    const db = await load('@agor/core/db');
    const oauth = await load('@agor/core/tools/mcp/oauth-refresh');
    forbidNetwork(t, 'Refresh must not dispatch without a grant');

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
        assert.fail('The PostgreSQL handle must not be entered');
      },
    });
    const options = {
      tenantId: 'tenant-a',
      userId: 'synthetic-user',
      mcpServerId: 'synthetic-server',
      observedRefreshVersion,
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

    // PostgreSQL refresh requires trusted tenant identity. The refresh bundle
    // has to unwrap the daemon bundle's proxy to know it is PostgreSQL at all;
    // otherwise the dialect check itself trips the guard. The standalone path
    // intentionally does not require a tenant, so it is not probed this way.
    await assert.rejects(
      oauth.refreshAndPersistToken({ ...options, tenantId: undefined, db: postgres }),
      /requires trusted tenant identity/
    );
    assert.equal(db.getCurrentTenantId(), undefined);
    assert.equal(db.getCurrentTenantDatabaseScope(), undefined);
  });

  test(`packaged ${format} scopes keep each database to its origin, including mixed ESM/CJS`, async (t) => {
    const esmDb = await import('@agor/core/db');
    const cjsDb = createRequire(import.meta.url)('@agor/core/db');
    const db = format === 'esm' ? esmDb : cjsDb;
    const other = format === 'esm' ? cjsDb : esmDb;
    const refreshers = [
      await import('@agor/core/tools/mcp/oauth-refresh'),
      createRequire(import.meta.url)('@agor/core/tools/mcp/oauth-refresh'),
    ];
    forbidNetwork(t, 'No provider I/O is permitted');

    const reads = [];
    const transactionsOpened = [];
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
      const tx = { name: `${name}:tx` };
      return db.createTenantScopedDatabaseProxy({
        run() {
          assert.fail('Unexpected write');
        },
        select() {
          return query;
        },
        async transaction(work) {
          transactionsOpened.push(name);
          return work(tx);
        },
      });
    }
    const a = database('A');
    const b = database('B');
    const options = {
      db: b,
      tenantId: 'tenant-a',
      userId: 'synthetic-user',
      mcpServerId: 'synthetic-server',
      observedRefreshVersion,
      validateGrant() {
        assert.fail('No grant exists');
      },
    };

    // A refresh on B, started inside a scope on A, must read B. Joining A's
    // scope because it is the ambient one would route B's lookups to A's rows.
    await db.runWithTenantContext('tenant-a', () =>
      db.runWithTenantDatabaseScope(a, 'tenant-a', async (scoped) => {
        for (const oauth of refreshers) {
          await assert.rejects(
            oauth.refreshAndPersistToken(options),
            (error) => error instanceof oauth.MissingRefreshTokenError
          );
        }
        assert.deepEqual(reads, ['B', 'B']);
        await other.runWithTenantDatabaseScope(a, 'tenant-a', async (nested) => {
          assert.equal(nested, scoped);
          await a.select().from().where().get();
        });
      })
    );
    assert.deepEqual(reads, ['B', 'B', 'A']);

    // The base, its proxies, and the current transaction all belong to A.
    // Mixing module formats must not turn legitimate nesting into a new unit.
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
      // ...but a transaction on B, from inside A's, is B's own.
      await other.runWithTenantDatabaseTransaction(b, 'tenant-a', async (nested) => {
        assert.notEqual(nested, scoped);
        assert.equal(nested.name, 'B:tx');
      });
    });
    assert.equal(transactions, 1);
    assert.equal(settings, 1);
    assert.deepEqual(transactionsOpened, ['B']);

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
    assert.deepEqual(reads, ['B', 'B', 'A', 'A', 'B']);
    assert.equal(db.getCurrentTenantDatabaseScope(), undefined);
    assert.equal(other.getCurrentTenantId(), undefined);
  });
}
