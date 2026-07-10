/**
 * Pure shaping of the `/health` payload's DB-derived fields. Extracted from the
 * `/health` route handler so the contract can be unit-tested without standing
 * up the full daemon: public payloads must never leak the raw DB error, and the
 * top-level `status` must flip to `degraded` when connectivity fails.
 */

import type { DbProbeResult, MigrationsProbeResult } from './db-probe.js';

export type HealthStatus = 'ok' | 'degraded';

/** Top-level `/health` status: `degraded` iff the DB probe failed. */
export function healthStatus(dbProbe: DbProbeResult): HealthStatus {
  return dbProbe.ok ? 'ok' : 'degraded';
}

/**
 * Public DB section — connectivity + latency only. Deliberately omits the raw
 * probe error, which can carry connection details, from unauthenticated callers.
 */
export function publicHealthDb(dbProbe: DbProbeResult): { ok: boolean; latencyMs: number } {
  return { ok: dbProbe.ok, latencyMs: dbProbe.latencyMs };
}

/** Authenticated DB section — adds the raw error when the probe failed. */
export function authenticatedHealthDb(dbProbe: DbProbeResult): {
  ok: boolean;
  latencyMs: number;
  error?: string;
} {
  return { ...publicHealthDb(dbProbe), ...(dbProbe.error ? { error: dbProbe.error } : {}) };
}

/** Authenticated migrations diagnostic — pending count, plus error if the check failed. */
export function healthMigrations(migrations: MigrationsProbeResult): {
  pending: number;
  error?: string;
} {
  return { pending: migrations.pending, ...(migrations.error ? { error: migrations.error } : {}) };
}
