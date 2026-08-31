import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';
import type { ApmTraceServiceDepth } from '@agor/core/config';
import { type DatadogTracer, resolveDatadogTracer } from '@agor/core/tracing/datadog';
import type { HookContext } from '@agor/core/types';
import {
  type FeathersInstrumentationOptions,
  normalizeFeathersMethod,
  normalizeFeathersService,
  normalizeFeathersTransport,
  readFeathersInstrumentationReason,
  readTaggedFeathersCustomMethod,
} from '../utils/feathers-instrumentation.js';

type AroundNext = () => Promise<void>;

export type { DatadogTracer };

export interface FeathersTracingOptions extends FeathersInstrumentationOptions {
  /**
   * Inject the tracer (or `null` to force the passthrough) instead of resolving
   * the process-wide dd-trace singleton. Intended for tests.
   */
  tracer?: DatadogTracer | null;
  /**
   * Override tracer resolution (defaults to {@link resolveTracerModule}). Lets
   * tests exercise the enabled-but-unresolved warning path deterministically,
   * independent of whether dd-trace happens to be installed in the workspace.
   */
  resolveTracer?: () => DatadogTracer | null;
}

/**
 * Feathers `health` is a high-frequency probe whose latency is already captured
 * by the auto-instrumented `GET /health` Express span. A Feathers-layer span
 * adds cost without insight, so it is excluded by default at every depth.
 */
export const DEFAULT_EXCLUDED_SERVICE_PATHS = ['health'] as const;

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

/**
 * App-level `around` hook that wraps every Feathers service method in a
 * `feathers.request` APM span whose RESOURCE name is `<service>.<method>` (e.g.
 * `sessions.find`; the operation name is `feathers.request`). dd-trace has no
 * FeathersJS plugin, so without this the service calls that ride socket.io are
 * invisible to APM even though HTTP, Express, and Postgres are
 * auto-instrumented.
 *
 * The span inherits the ambient `agor-daemon` service and nests under the
 * active HTTP span, so child Postgres queries appear directly beneath the
 * service method that issued them — which is what surfaces N+1s and full scans.
 *
 * Depth controls cost vs. visibility:
 * - `off`        — returns a passthrough (callers should skip registering it).
 * - `entrypoint` — one span per external request; nested service-to-service
 *   fan-out is suppressed via a request-local scope (mirrors the metrics hook).
 * - `full`       — a span per invocation including nested calls; reveals the
 *   full fan-out at the cost of much higher span volume.
 *
 * Falls back to a passthrough when no tracer is loaded, warning once (unless a
 * tracer was explicitly injected) so an enabled-but-unresolved deployment is
 * loud rather than silently emitting nothing.
 */
export function createFeathersTracingHook(
  depth: ApmTraceServiceDepth,
  options: FeathersTracingOptions = {}
) {
  const passthrough = async (_context: HookContext, next: AroundNext): Promise<void> => next();
  if (depth === 'off') return passthrough;

  const tracer =
    options.tracer !== undefined
      ? options.tracer
      : (options.resolveTracer ?? resolveTracerModule)();
  if (!tracer) {
    // Only warn when we attempted real resolution (options.tracer === undefined),
    // never for tests that explicitly inject `null`.
    if (options.tracer === undefined) {
      console.warn(
        `[apm] metrics.apm.trace_services="${depth}" but no APM tracer is loaded ` +
          '(dd-trace / dd-trace-api not installed); Feathers service tracing is disabled.'
      );
    }
    return passthrough;
  }

  const excluded = new Set(options.excludedServicePaths ?? DEFAULT_EXCLUDED_SERVICE_PATHS);
  const { isInternalCall } = options;
  // Only `entrypoint` needs nesting suppression; `full` traces every call.
  const requestScope = depth === 'entrypoint' ? new AsyncLocalStorage<true>() : null;

  return async (context: HookContext, next: AroundNext): Promise<void> => {
    if (requestScope?.getStore() || excluded.has(context.path) || isInternalCall?.(context)) {
      await next();
      return;
    }

    const service = normalizeFeathersService(context.path);
    const method = normalizeFeathersMethod(context.method);
    const reason = readFeathersInstrumentationReason(context.params);
    const customMethod = readTaggedFeathersCustomMethod(context.path, context.method);
    const runTraced = () =>
      tracer.trace(
        'feathers.request',
        {
          resource: `${service}.${method}`,
          tags: {
            'feathers.service': service,
            'feathers.method': method,
            'feathers.transport':
              normalizeFeathersTransport(context.params?.provider) ?? 'internal',
            ...(reason ? { 'feathers.reason': reason } : {}),
            ...(customMethod ? { 'feathers.custom_method': customMethod } : {}),
            'span.kind': 'server',
          },
        },
        // dd-trace finishes the span and tags any thrown/rejected error itself.
        () => next()
      );

    if (requestScope) {
      await requestScope.run(true, runTraced);
    } else {
      await runTraced();
    }
  };
}
