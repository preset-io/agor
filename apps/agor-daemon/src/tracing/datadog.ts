import { createRequire } from 'node:module';
import { type DatadogTracer, resolveDatadogTracer } from '@agor/core/tracing/datadog';

const requireFromDaemon = createRequire(import.meta.url);

/**
 * Resolve the process-wide APM tracer without initializing it.
 *
 * The tracer is preloaded ahead of application code by Datadog single-step
 * instrumentation (`NODE_OPTIONS`). It is an OPTIONAL runtime dependency that
 * Agor never declares as a hard dep or bundles (declaring it as a peer makes
 * pnpm auto-install its native modules, defeating the point). So this returns
 * `null` unless the operator has installed `dd-trace` — or the lightweight
 * `dd-trace-api` bridge — into the daemon's module tree, or single-step
 * provides it. `dd-trace-api` is tried first because it is Datadog's supported
 * entry point for custom instrumentation under single-step; both expose the
 * same `tracer.trace()` surface. Treated like `hot-shots` for StatsD: present →
 * used, absent → no-op (loudly, at registration).
 */
export function resolveTracerModule(
  requireFn: (id: string) => unknown = requireFromDaemon
): DatadogTracer | null {
  return resolveDatadogTracer(requireFn);
}
