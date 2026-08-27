import { createRequire } from 'node:module';

/**
 * Datadog APM spans for PostgreSQL queries.
 *
 * dd-trace auto-instruments `pg` (node-postgres) but not `postgres.js`, which is
 * the driver Agor's Drizzle client uses — so DB queries are otherwise invisible
 * to APM. Rather than instrument postgres.js's lazy-thenable internals (which
 * also miss transaction-scoped clients), we patch the ONE Drizzle chokepoint
 * every query flows through: `PgSession.prepareQuery(...)` →
 * `PgPreparedQuery.{execute,all,values}()`. This is the same driver-agnostic,
 * transaction/RLS-aware technique the community `@kubiks/otel-drizzle` /
 * `autotel-drizzle` packages use — but emitted via dd-trace's NATIVE tracer
 * (not OpenTelemetry, which dd-trace mis-handles at @opentelemetry/api > 1.4.1,
 * dd-trace-js#6882).
 *
 * Safety contract: this is best-effort and additive. Any failure to resolve the
 * tracer or reach the Drizzle internals leaves the database completely
 * untouched — it can never break, slow, or change a query. Worst case is "no DB
 * spans".
 */

/** Minimal surface of the dd-trace singleton we depend on. */
export interface DatadogTracer {
  trace<T>(
    name: string,
    options: { resource?: string; type?: string; tags?: Record<string, unknown> },
    fn: () => T
  ): T;
}

/** The methods on a Drizzle prepared query that actually run the SQL. */
const PREPARED_EXECUTE_METHODS = ['execute', 'all', 'values'] as const;

const TRACED_MARK = Symbol.for('agor.db.postgres-tracing.patched');

const requireFromCore = createRequire(import.meta.url);

/**
 * Resolve the process-wide APM tracer without initializing it. Optional runtime
 * dependency (never declared/bundled): present → used, absent → no-op. Tries
 * `dd-trace-api` (Datadog's single-step bridge) then `dd-trace`.
 */
export function resolvePostgresTracer(
  requireFn: (id: string) => unknown = requireFromCore
): DatadogTracer | null {
  for (const moduleName of ['dd-trace-api', 'dd-trace']) {
    try {
      const mod = requireFn(moduleName) as { default?: DatadogTracer } & DatadogTracer;
      const tracer = mod?.default ?? mod;
      if (tracer && typeof tracer.trace === 'function') return tracer;
    } catch {
      // Not installed under this name; try the next.
    }
  }
  return null;
}

/**
 * Collapse a Drizzle SQL string to a bounded span resource. Drizzle always
 * parameterizes ($1, $2, …), so the text carries no literals — but cap length
 * to keep resource cardinality/pipeline size sane.
 */
function toResource(sqlText: unknown): string {
  if (typeof sqlText !== 'string' || sqlText.length === 0) return 'postgres.query';
  const collapsed = sqlText.replace(/\s+/g, ' ').trim();
  return collapsed.length > 4096 ? `${collapsed.slice(0, 4096)}…` : collapsed;
}

function wrapPreparedQuery(prepared: unknown, sqlText: unknown, tracer: DatadogTracer): unknown {
  if (!prepared || typeof prepared !== 'object') return prepared;
  const resource = toResource(sqlText);
  for (const method of PREPARED_EXECUTE_METHODS) {
    const original = (prepared as Record<string, unknown>)[method];
    if (typeof original !== 'function') continue;
    (prepared as Record<string, unknown>)[method] = function tracedExecute(
      this: unknown,
      ...args: unknown[]
    ) {
      // dd-trace finishes the span when the returned promise settles and tags
      // any rejection automatically.
      return tracer.trace(
        'postgres.query',
        {
          resource,
          type: 'sql',
          tags: { 'db.system': 'postgresql', 'span.kind': 'client', component: 'postgres.js' },
        },
        () => (original as (...a: unknown[]) => unknown).apply(this, args)
      );
    };
  }
  return prepared;
}

interface DrizzleSessionLike {
  prepareQuery: (...args: unknown[]) => unknown;
}

/**
 * Patch a Drizzle postgres.js database so every query emits a `postgres.query`
 * span. Idempotent and best-effort — safe to call unconditionally.
 *
 * @param db      the Drizzle database returned by `drizzle-orm/postgres-js`
 * @param options.tracer  inject a tracer (or `null`) instead of resolving the
 *   dd-trace singleton — for tests and for callers that resolve it themselves.
 * @returns `true` if instrumentation was installed, `false` otherwise.
 */
export function instrumentDrizzlePostgresForTracing(
  db: unknown,
  options: { tracer?: DatadogTracer | null } = {}
): boolean {
  try {
    const tracer = options.tracer !== undefined ? options.tracer : resolvePostgresTracer();
    if (!tracer) return false;

    // The session is shared by prototype across the top-level db AND every
    // transaction sub-session, so patching the prototype covers transactional
    // and RLS (`set_config`/`SET LOCAL`) queries too.
    const session = (db as { session?: DrizzleSessionLike } | null)?.session;
    if (!session || typeof session.prepareQuery !== 'function') return false;

    const proto = Object.getPrototypeOf(session) as
      | (DrizzleSessionLike & { [TRACED_MARK]?: boolean })
      | null;
    // If prepareQuery is an own property (unusual), patch the instance; else the
    // prototype shared across sessions.
    const target =
      proto && typeof proto.prepareQuery === 'function'
        ? proto
        : (session as DrizzleSessionLike & { [TRACED_MARK]?: boolean });
    if (target[TRACED_MARK]) return true; // already patched

    const originalPrepareQuery = target.prepareQuery;
    target.prepareQuery = function patchedPrepareQuery(this: unknown, ...args: unknown[]) {
      const prepared = originalPrepareQuery.apply(this, args);
      // args[0] is the Drizzle Query: { sql, params }.
      const sqlText = (args[0] as { sql?: unknown } | undefined)?.sql;
      return wrapPreparedQuery(prepared, sqlText, tracer);
    };
    target[TRACED_MARK] = true;
    return true;
  } catch {
    // Never let instrumentation break database creation.
    return false;
  }
}
