/**
 * HTTP-level tests for the liveness/readiness probe routes.
 *
 * These stand up a bare Express app, register the *production* route handlers
 * via `registerHealthProbeRoutes`, and hit them over a real socket — so we're
 * verifying the actual status-code contract (200 vs 503), not a reimplementation.
 */

import type { Server } from 'node:http';
import type { Database } from '@agor/core/db';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { registerHealthProbeRoutes } from './routes';

/** SQLite-shaped fake whose probe query resolves (DB reachable). */
const healthyDb = { run: () => Promise.resolve({ rows: [] }) } as unknown as Database;
/** SQLite-shaped fake whose probe query rejects (DB unreachable). */
const brokenDb = {
  run: () => Promise.reject(new Error('ECONNREFUSED')),
} as unknown as Database;

let server: Server | undefined;

async function startWith(db: Database): Promise<string> {
  const app = express();
  registerHealthProbeRoutes(app, db);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  const addr = server?.address();
  if (!addr || typeof addr === 'string') throw new Error('failed to bind test server');
  return `http://127.0.0.1:${addr.port}`;
}

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  }
});

describe('GET /livez', () => {
  it('returns 200 without touching the DB (even when the DB is down)', async () => {
    // Pass the broken DB to prove liveness never consults it.
    const base = await startWith(brokenDb);
    const res = await fetch(`${base}/livez`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });
});

describe('GET /readyz', () => {
  it('returns 200 with db latency when the DB is reachable', async () => {
    const base = await startWith(healthyDb);
    const res = await fetch(`${base}/readyz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; db: { ok: boolean; latencyMs: number } };
    expect(body.status).toBe('ok');
    expect(body.db.ok).toBe(true);
    expect(body.db.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('returns 503 with a degraded body when the DB is unreachable', async () => {
    const base = await startWith(brokenDb);
    const res = await fetch(`${base}/readyz`);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { status: string; db: { ok: boolean } };
    expect(body.status).toBe('error');
    expect(body.db.ok).toBe(false);
  });

  it('does not leak the raw DB error to unauthenticated callers', async () => {
    const base = await startWith(brokenDb);
    const res = await fetch(`${base}/readyz`);
    expect(JSON.stringify(await res.json())).not.toContain('ECONNREFUSED');
  });
});
