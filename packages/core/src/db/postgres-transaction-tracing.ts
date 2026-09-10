import { performance } from 'node:perf_hooks';
import { type DatadogTracer, setSpanTag, traceBestEffort } from '../tracing/datadog';

const installed = new WeakSet<object>();

/**
 * Instrument the raw root database, not a tenant proxy or a shared prototype.
 * postgres.js executes BEGIN before invoking Drizzle's transaction callback;
 * prepareQuery instrumentation cannot see that acquisition/BEGIN interval.
 * Nested savepoints are not new pool acquisitions and are not wrapped here.
 */
export function instrumentPostgresTransactions(
  db: unknown,
  tracer: DatadogTracer,
  poolMax?: number
): void {
  try {
    if (!db || typeof db !== 'object' || installed.has(db)) return;
    const target = db as { transaction?: (...args: unknown[]) => unknown };
    const original = target.transaction;
    if (typeof original !== 'function') return;
    target.transaction = function (this: unknown, ...args: unknown[]) {
      const callback = args[0];
      if (typeof callback !== 'function') return original.apply(this, args);
      const tags = {
        'db.system': 'postgresql',
        ...(poolMax === undefined ? {} : { 'db.pool.max': poolMax }),
      };
      return traceBestEffort(tracer, 'postgres.transaction', tags, (span) => {
        const started = performance.now();
        return original.apply(this, [
          function (this: unknown, ...callbackArgs: unknown[]) {
            // Includes pool queueing, establishing a connection and BEGIN (and
            // Drizzle transaction setup). It is NOT pure server lock wait.
            setSpanTag(span, 'db.transaction.acquire_ms', performance.now() - started);
            return traceBestEffort(tracer, 'postgres.transaction.work', tags, () =>
              callback.apply(this, callbackArgs)
            );
          },
          ...args.slice(1),
        ]);
      });
    };
    installed.add(db);
  } catch {
    // A frozen/incompatible handle only loses this optional instrumentation.
  }
}
