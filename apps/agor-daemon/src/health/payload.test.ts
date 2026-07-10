/**
 * Contract tests for the `/health` payload shaping. These lock the guarantees
 * the route handler relies on: `status` reflects DB health, the public DB
 * section never leaks the raw error, and the authenticated section does.
 */

import { describe, expect, it } from 'vitest';
import type { DbProbeResult, MigrationsProbeResult } from './db-probe';
import { authenticatedHealthDb, healthMigrations, healthStatus, publicHealthDb } from './payload';

const okProbe: DbProbeResult = { ok: true, latencyMs: 3 };
const failedProbe: DbProbeResult = { ok: false, latencyMs: 1500, error: 'ECONNREFUSED host:5432' };

describe('healthStatus', () => {
  it('is ok when the DB probe succeeds', () => {
    expect(healthStatus(okProbe)).toBe('ok');
  });
  it('is degraded when the DB probe fails', () => {
    expect(healthStatus(failedProbe)).toBe('degraded');
  });
});

describe('publicHealthDb', () => {
  it('exposes only ok + latencyMs, never the raw error', () => {
    expect(publicHealthDb(okProbe)).toEqual({ ok: true, latencyMs: 3 });
    const shaped = publicHealthDb(failedProbe);
    expect(shaped).toEqual({ ok: false, latencyMs: 1500 });
    expect('error' in shaped).toBe(false);
    expect(JSON.stringify(shaped)).not.toContain('ECONNREFUSED');
  });
});

describe('authenticatedHealthDb', () => {
  it('includes the raw error when the probe failed', () => {
    expect(authenticatedHealthDb(failedProbe)).toEqual({
      ok: false,
      latencyMs: 1500,
      error: 'ECONNREFUSED host:5432',
    });
  });
  it('omits error when the probe succeeded', () => {
    const shaped = authenticatedHealthDb(okProbe);
    expect(shaped).toEqual({ ok: true, latencyMs: 3 });
    expect('error' in shaped).toBe(false);
  });
});

describe('healthMigrations', () => {
  it('reports the pending count and omits error on success', () => {
    const shaped = healthMigrations({ ok: true, pending: 0 } satisfies MigrationsProbeResult);
    expect(shaped).toEqual({ pending: 0 });
    expect('error' in shaped).toBe(false);
  });
  it('includes error when the check failed', () => {
    expect(healthMigrations({ ok: false, pending: 0, error: 'no such table' })).toEqual({
      pending: 0,
      error: 'no such table',
    });
  });
});
