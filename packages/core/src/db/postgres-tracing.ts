import type { DatadogTracer } from '../tracing/datadog';

export type { DatadogTracer };

/**
 * Datadog APM spans for PostgreSQL queries.
 *
 * dd-trace auto-instruments `pg` (node-postgres) but not `postgres.js`, which is
 * the driver Agor's Drizzle client uses — so DB queries are otherwise invisible
 * to APM. Rather than instrument postgres.js's lazy-thenable internals (which
 * also miss transaction-scoped clients), we patch the Drizzle chokepoint that
 * the builder, `db.execute`, relational (RQB) queries, and transactions all
 * flow through: `PgSession.prepareQuery(...)` →
 * `PgPreparedQuery.{execute,all,values}()`. This is the same driver-agnostic,
 * transaction/RLS-aware technique the community `@kubiks/otel-drizzle` /
 * `autotel-drizzle` packages use — but emitted via dd-trace's NATIVE tracer
 * (not OpenTelemetry, which dd-trace mis-handles at @opentelemetry/api > 1.4.1,
 * dd-trace-js#6882).
 *
 * Scope: the low-level `PgSession.query()` / `queryObjects()` methods call the
 * driver directly, bypassing `prepareQuery`. Agor's normal query paths do not
 * use them, so they are intentionally out of scope; the real-Drizzle regression
 * test asserts the covered paths and fails loudly if the chokepoint moves.
 *
 * Safety contract: this is best-effort and additive. Any failure to resolve the
 * tracer, reach the Drizzle internals, install the patch, OR run the per-query
 * wrapper leaves the query untouched — it can never break, slow, duplicate, or
 * change a query. Worst case is "no DB spans".
 */

/**
 * The methods on a Drizzle prepared query that actually run the SQL. `values`
 * is not present on every driver's prepared-query class (postgres.js currently
 * exposes `execute`/`all`); it is included for forward-compatibility and skipped
 * when absent.
 */
const PREPARED_EXECUTE_METHODS = ['execute', 'all', 'values'] as const;

/**
 * Prototypes we've already patched, tracked out-of-band so we never mutate the
 * Drizzle session object itself (a symbol mark could partially apply on a
 * sealed prototype, leaving it patched-but-unmarked).
 *
 * Idempotency is keyed to the session prototype and captures the FIRST tracer
 * for the life of the process. Agor has one process-wide Datadog tracer, so a
 * later call with a different tracer (only reachable via the test-only `tracer`
 * option) intentionally no-ops.
 */
const patchedSessionTargets = new WeakSet<object>();

/**
 * Collapse a Drizzle SQL string to a bounded span resource.
 *
 * Tradeoff (documented deliberately): Drizzle parameterizes normal queries
 * ($1, $2, …), so the text carries no literals and reads cleanly in Datadog —
 * the same "SQL as resource" convention dd-trace's own `pg` plugin uses. Two
 * known edges we accept for now: `sql.raw(...)` can embed literals (developer-
 * controlled, rare), and variable-length `IN (...)` lists produce distinct
 * resources (cardinality). Full obfuscation/normalization (`IN (?)`, literal
 * stripping) is a deliberate future enhancement, not done here to keep the shim
 * small and the SQL human-readable. Whitespace is collapsed and length capped.
 */
function toResource(sqlText: unknown): string {
  if (typeof sqlText !== 'string' || sqlText.length === 0) return 'postgres.query';
  const collapsed = sqlText.replace(/\s+/g, ' ').trim();
  return collapsed.length > 4096 ? `${collapsed.slice(0, 4096)}…` : collapsed;
}

function wrapPreparedQuery(prepared: unknown, sqlText: unknown, tracer: DatadogTracer): unknown {
  try {
    if (!prepared || typeof prepared !== 'object') return prepared;
    const resource = toResource(sqlText);
    for (const method of PREPARED_EXECUTE_METHODS) {
      const original = (prepared as Record<string, unknown>)[method];
      if (typeof original !== 'function') continue;
      const originalFn = original as (...a: unknown[]) => unknown;
      try {
        (prepared as Record<string, unknown>)[method] = function tracedExecute(
          this: unknown,
          ...args: unknown[]
        ) {
          // The query must run exactly once. `ran` distinguishes "tracer.trace
          // threw before running the query" (safe to run it untraced) from
          // "the query already ran and something after it threw" (propagate).
          let ran = false;
          const invoke = () => {
            ran = true;
            return originalFn.apply(this, args);
          };
          try {
            // dd-trace finishes the span when the returned promise settles and
            // tags any rejection automatically.
            return tracer.trace(
              'postgres.query',
              {
                resource,
                type: 'sql',
                tags: {
                  'db.system': 'postgresql',
                  'span.kind': 'client',
                  component: 'postgres.js',
                },
              },
              invoke
            );
          } catch (error) {
            if (ran) throw error; // the query itself ran; do not re-run it
            return invoke(); // instrumentation failed synchronously — run untraced
          }
        };
      } catch {
        // Non-extensible/frozen prepared query: leave this method untraced.
      }
    }
    return prepared;
  } catch {
    // Never let instrumentation break the query path.
    return prepared;
  }
}

interface DrizzleSessionLike {
  prepareQuery: (...args: unknown[]) => unknown;
}

/**
 * Patch a Drizzle postgres.js database so every query emits a `postgres.query`
 * span. Idempotent and best-effort — safe to call unconditionally.
 *
 * The tracer must be INJECTED (see options). `@agor/core` never resolves
 * dd-trace itself: the tracer is a runtime/daemon concern that may not be on
 * core's module-resolution path under single-step instrumentation, so the
 * daemon resolves it (via {@link resolveDatadogTracer} anchored in the daemon)
 * and threads it in through database creation. A missing tracer is a no-op.
 *
 * @param db      the Drizzle database returned by `drizzle-orm/postgres-js`
 * @param options.tracer  the resolved dd-trace tracer, or `null`/absent to no-op.
 * @returns `true` if instrumentation was installed, `false` otherwise.
 */
export function instrumentDrizzlePostgresForTracing(
  db: unknown,
  options: { tracer?: DatadogTracer | null } = {}
): boolean {
  try {
    const tracer = options.tracer ?? null;
    if (!tracer) return false;

    // The session is shared by prototype across the top-level db AND every
    // transaction sub-session, so patching the prototype covers transactional
    // and RLS (`set_config`/`SET LOCAL`) queries too.
    const session = (db as { session?: DrizzleSessionLike } | null)?.session;
    if (!session || typeof session.prepareQuery !== 'function') return false;

    const proto = Object.getPrototypeOf(session) as DrizzleSessionLike | null;
    // If prepareQuery is an own property (unusual), patch the instance; else the
    // prototype shared across sessions.
    const target: DrizzleSessionLike =
      proto && typeof proto.prepareQuery === 'function' ? proto : session;
    if (patchedSessionTargets.has(target)) return true; // already patched

    const originalPrepareQuery = target.prepareQuery;
    target.prepareQuery = function patchedPrepareQuery(this: unknown, ...args: unknown[]) {
      const prepared = originalPrepareQuery.apply(this, args);
      // args[0] is the Drizzle Query: { sql, params }.
      const sqlText = (args[0] as { sql?: unknown } | undefined)?.sql;
      return wrapPreparedQuery(prepared, sqlText, tracer);
    };
    // Mark only AFTER the reassignment succeeds — a frozen prototype throws on
    // assignment and lands in catch below, leaving the DB untouched (no partial
    // patch, nothing marked).
    patchedSessionTargets.add(target);
    return true;
  } catch {
    // Never let instrumentation break database creation.
    return false;
  }
}
