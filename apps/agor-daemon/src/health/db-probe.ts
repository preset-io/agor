/**
 * Cheap, hard-time-bounded probes of the daemon's own database, backing the
 * health endpoints in `routes.ts`. Time-bounding matters because these run on
 * every k8s poll — a hung DB must never stall the endpoint. The 1.5s ceiling
 * only bounds how long the *endpoint* waits; the underlying query is itself
 * capped server-side (Postgres `statement_timeout` 60s, SQLite `busy_timeout`
 * 5s), so a stalled connection is reclaimed rather than leaked indefinitely.
 *
 * All DB work runs inside an explicit system scope: the daemon's DB handle is
 * a tenant-scope-aware proxy, and in `required_from_auth` multi-tenancy mode it
 * throws unless a tenant *or* system scope is active. A connectivity check is
 * tenant-agnostic global work, so `runWithSystemDatabaseScope` is the correct
 * (and only supported) no-tenant entry — without it these probes would throw
 * and report the DB as down when it is perfectly healthy.
 *
 * Unrelated to the `HealthMonitor` service, which polls branch environments.
 */

import {
  checkMigrationStatus,
  type Database,
  isSQLiteDatabase,
  runWithSystemDatabaseScope,
  sql,
} from '@agor/core/db';

/** ~1.5s: above a healthy round-trip, short enough that a hung DB fails fast. */
export const DB_PROBE_TIMEOUT_MS = 1500;

export interface DbProbeResult {
  ok: boolean;
  latencyMs: number;
  /** Present only when `ok` is false. */
  error?: string;
}

/**
 * Race a promise against a timeout. The work isn't cancellable (a hung query
 * keeps running), but the caller stops waiting on it — enough to stay responsive.
 */
function withTimeout<T>(work: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} exceeded ${timeoutMs}ms timeout`)),
      timeoutMs
    );
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Probe database connectivity with a cheap, dialect-aware `SELECT 1` and a
 * hard timeout. Never throws — a failure or timeout is returned as
 * `{ ok: false, error }` so callers can map it onto a status code without a
 * try/catch of their own. Safe to call with the daemon's tenant-scope-aware
 * `Database`: it enters a system scope internally (see file header).
 */
export async function probeDatabase(
  db: Database,
  timeoutMs: number = DB_PROBE_TIMEOUT_MS
): Promise<DbProbeResult> {
  const start = Date.now();
  try {
    await runWithSystemDatabaseScope(db, 'health db probe', (systemDb) => {
      // SQLite (libSQL) exposes `.run()`; Postgres exposes `.execute()`. Both
      // return a thenable, so racing them against the timeout is uniform.
      const query = isSQLiteDatabase(systemDb)
        ? systemDb.run(sql`SELECT 1`)
        : systemDb.execute(sql`SELECT 1`);
      return withTimeout(Promise.resolve(query), timeoutMs, 'database probe');
    });
    return { ok: true, latencyMs: Date.now() - start };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface MigrationsProbeResult {
  /** True when the check completed (regardless of pending count). */
  ok: boolean;
  /** Migrations on disk not yet applied (0 when up to date). */
  pending: number;
  error?: string;
}

/**
 * Count un-applied migrations. Diagnostic only — surfaced on authenticated
 * `/health`, never gates readiness (a migration shouldn't flap pods out of
 * rotation; that's a startupProbe concern). Never throws; time-bounded. Like
 * `probeDatabase`, safe to call with the tenant-scope-aware `Database` — it
 * enters a system scope internally.
 */
export async function probePendingMigrations(
  db: Database,
  timeoutMs: number = DB_PROBE_TIMEOUT_MS
): Promise<MigrationsProbeResult> {
  try {
    const status = await runWithSystemDatabaseScope(db, 'health migrations probe', (systemDb) =>
      withTimeout(checkMigrationStatus(systemDb), timeoutMs, 'pending-migrations probe')
    );
    return { ok: true, pending: status.pending.length };
  } catch (error) {
    return {
      ok: false,
      pending: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
