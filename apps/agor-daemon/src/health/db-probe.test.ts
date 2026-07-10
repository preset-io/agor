/**
 * Unit tests for the daemon self-health probes.
 *
 * Covers the three outcomes that matter for the readiness contract:
 *   - success  -> { ok: true, latencyMs }
 *   - failure  -> { ok: false, error }
 *   - timeout  -> { ok: false, error: '…timeout' } (never hangs)
 * plus dialect branching (SQLite `.run` vs Postgres `.execute`).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createDatabase,
  createTenantScopedDatabaseProxy,
  type Database,
  initializeDatabase,
  MissingTenantDatabaseScopeError,
  sql,
} from '@agor/core/db';
import { afterEach, describe, expect, it } from 'vitest';
import { DB_PROBE_TIMEOUT_MS, probeDatabase, probePendingMigrations } from './db-probe';

/** A SQLite-shaped fake: has `.run`, so `isSQLiteDatabase` returns true. */
function sqliteFake(run: () => Promise<unknown>): Database {
  return { run } as unknown as Database;
}

/** A Postgres-shaped fake: no `.run`, only `.execute`. */
function postgresFake(execute: () => Promise<unknown>): Database {
  return { execute } as unknown as Database;
}

describe('probeDatabase', () => {
  it('returns ok with a latency reading when the SQLite query succeeds', async () => {
    const db = sqliteFake(() => Promise.resolve({ rows: [{ 1: 1 }] }));
    const result = await probeDatabase(db);
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('uses .execute() for the Postgres dialect', async () => {
    let called = false;
    const db = postgresFake(() => {
      called = true;
      return Promise.resolve([{ 1: 1 }]);
    });
    const result = await probeDatabase(db);
    expect(called).toBe(true);
    expect(result.ok).toBe(true);
  });

  it('returns ok:false with the error message when the query rejects', async () => {
    const db = sqliteFake(() => Promise.reject(new Error('connection refused')));
    const result = await probeDatabase(db);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('connection refused');
  });

  it('never hangs: a stalled query times out and reports failure', async () => {
    // A query that never resolves — the probe must still return via timeout.
    const db = sqliteFake(() => new Promise<never>(() => {}));
    const start = Date.now();
    const result = await probeDatabase(db, 50);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/timeout/i);
    // Comfortably below the default; proves we didn't wait on the query.
    expect(Date.now() - start).toBeLessThan(DB_PROBE_TIMEOUT_MS);
  });
});

describe('probePendingMigrations', () => {
  it('reports failure (never throws) when the underlying check rejects', async () => {
    const db = sqliteFake(() => Promise.reject(new Error('no such table')));
    const result = await probePendingMigrations(db, 200);
    expect(result.ok).toBe(false);
    expect(result.pending).toBe(0);
    expect(result.error).toBeTruthy();
  });

  it('times out instead of hanging on a stalled check', async () => {
    const db = sqliteFake(() => new Promise<never>(() => {}));
    const result = await probePendingMigrations(db, 50);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/timeout/i);
  });
});

// Regression: in `required_from_auth` multi-tenancy mode the daemon's DB handle
// is a scope-guarded proxy (requireScope:true) that throws unless a tenant OR
// system scope is active. The probes must enter a system scope themselves —
// otherwise they'd throw, get swallowed as a DB failure, and report a healthy
// DB as down (false 503 / degraded). These tests use a real guarded proxy so a
// regression here fails loudly.
describe('probes against a scope-guarded proxy (required_from_auth mode)', () => {
  let dir: string;
  let scoped: Database;

  const setup = async () => {
    dir = mkdtempSync(join(tmpdir(), 'agor-health-probe-'));
    const base = createDatabase({ url: `file:${join(dir, 'test.db')}` });
    await initializeDatabase(base);
    scoped = createTenantScopedDatabaseProxy(base, { requireScope: true, label: 'agor.db' });
  };

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('guard is active: touching the raw proxy without a scope throws (sanity)', async () => {
    await setup();
    // Proves the proxy really is guarded — otherwise the tests below would pass
    // even if the probes forgot to enter a scope.
    expect(() => scoped.run(sql`SELECT 1`)).toThrow(MissingTenantDatabaseScopeError);
  });

  it('probeDatabase reports ok through the guarded proxy', async () => {
    await setup();
    const result = await probeDatabase(scoped);
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('probePendingMigrations reports ok (0 pending) through the guarded proxy', async () => {
    await setup();
    const result = await probePendingMigrations(scoped);
    expect(result.ok).toBe(true);
    expect(result.pending).toBe(0);
  });
});
