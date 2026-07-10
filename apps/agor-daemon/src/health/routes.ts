/**
 * Kubernetes-style liveness (/livez) and readiness (/readyz) probes (#1726).
 *
 * Raw Express routes, not Feathers services, so we control the status code
 * (Feathers `find` is always 200; readiness needs 503). Both are unauthenticated
 * like `/health` and expose only { ok, latencyMs } — safe for public k8s probes
 * and the #1735 watchdog.
 *
 * The split is load-bearing: point a `livenessProbe` at a DB check and a DB
 * outage restarts every pod (fleet-wide crash loop). Liveness MUST stay
 * dependency-free; readiness is where the DB probe belongs, and a 503 there just
 * pulls the pod from rotation without killing it.
 */

import type { Database } from '@agor/core/db';
import type { Application } from 'express';
import { probeDatabase } from './db-probe.js';

/**
 * The slice of Express we use. Structural (just `get`) so this registers
 * against both the Feathers app (production) and a bare Express app (tests),
 * while keeping Express' typed `Request`/`Response` in the handlers.
 */
export type ProbeRouteApp = Pick<Application, 'get'>;

export function registerHealthProbeRoutes(app: ProbeRouteApp, db: Database): void {
  // Liveness: trivial in-process 200, no DB. If this can't answer, the event
  // loop is wedged and a restart is the right remedy.
  app.get('/livez', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  // Readiness: run the DB probe; 503 on failure. The raw error is logged, not
  // returned, so nothing leaks to unauthenticated callers.
  app.get('/readyz', async (_req, res) => {
    const dbProbe = await probeDatabase(db);
    if (!dbProbe.ok) {
      console.warn(`[health] /readyz DB probe failed after ${dbProbe.latencyMs}ms:`, dbProbe.error);
      res.status(503).json({
        status: 'error',
        db: { ok: false, latencyMs: dbProbe.latencyMs },
      });
      return;
    }
    res.status(200).json({
      status: 'ok',
      db: { ok: true, latencyMs: dbProbe.latencyMs },
    });
  });
}
