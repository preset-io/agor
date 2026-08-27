import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';
import type { ApmTraceServiceDepth } from '@agor/core/config';
import type { HookContext } from '@agor/core/types';

type AroundNext = () => Promise<void>;

/** Minimal surface of the dd-trace singleton we depend on. */
export interface DatadogTracer {
  trace<T>(
    name: string,
    options: {
      resource?: string;
      tags?: Record<string, unknown>;
    },
    fn: () => Promise<T>
  ): Promise<T>;
}

export interface FeathersTracingOptions {
  /**
   * Inject the tracer (or `null` to force the passthrough) instead of resolving
   * the process-wide dd-trace singleton. Intended for tests.
   */
  tracer?: DatadogTracer | null;
}

const KNOWN_METHODS = ['create', 'find', 'get', 'patch', 'remove', 'update'];

/**
 * Feathers `health` is a high-frequency probe whose latency is already captured
 * by the auto-instrumented `GET /health` Express span. A Feathers-layer span
 * adds cost without adding insight, so it is skipped at every depth.
 */
const EXCLUDED_SERVICE_PATHS = new Set(['health']);

const requireFromDaemon = createRequire(import.meta.url);

/**
 * Resolve the process-wide dd-trace singleton without initializing it.
 *
 * The tracer is loaded ahead of application code by Datadog single-step
 * instrumentation (`NODE_OPTIONS`), so importing `dd-trace` here returns the
 * already-initialized instance. It is treated as an optional peer — exactly
 * like `hot-shots` for StatsD — so the daemon runs unchanged when APM is not
 * installed.
 */
function loadTracer(): DatadogTracer | null {
  try {
    const mod = requireFromDaemon('dd-trace') as { default?: DatadogTracer } & DatadogTracer;
    return mod.default ?? mod ?? null;
  } catch {
    return null;
  }
}

function normalizeMethod(method: string): string {
  return KNOWN_METHODS.includes(method) ? method : 'custom';
}

/**
 * App-level `around` hook that wraps every Feathers service method in a
 * `feathers.request` APM span, named `<service>.<method>` (e.g.
 * `sessions.find`). dd-trace has no FeathersJS plugin, so without this the
 * service calls that ride socket.io are invisible to APM even though HTTP,
 * Express, and Postgres are auto-instrumented.
 *
 * The span inherits the ambient `agor-daemon` service and nests under the
 * active HTTP span, so child Postgres queries appear directly beneath the
 * service method that issued them — which is what surfaces N+1s and full
 * scans.
 *
 * Depth controls cost vs. visibility:
 * - `off`     — returns a passthrough; nothing is registered.
 * - `entrypoint` — one span per external request; nested service-to-service
 *   fan-out is suppressed via a request-local scope (mirrors the metrics hook).
 * - `full`    — a span per invocation including nested calls; reveals the full
 *   fan-out at the cost of much higher span volume.
 *
 * Falls back to a passthrough when dd-trace is not loaded, so it is safe to
 * register unconditionally.
 */
export function createFeathersTracingHook(
  depth: ApmTraceServiceDepth,
  options: FeathersTracingOptions = {}
) {
  const passthrough = async (_context: HookContext, next: AroundNext): Promise<void> => next();
  if (depth === 'off') return passthrough;

  const tracer = options.tracer !== undefined ? options.tracer : loadTracer();
  if (!tracer) return passthrough;

  // Only `entrypoint` needs nesting suppression; `full` traces every call.
  const requestScope = depth === 'entrypoint' ? new AsyncLocalStorage<true>() : null;

  return async (context: HookContext, next: AroundNext): Promise<void> => {
    if (requestScope?.getStore() || EXCLUDED_SERVICE_PATHS.has(context.path)) {
      await next();
      return;
    }

    const runTraced = () =>
      tracer.trace(
        'feathers.request',
        {
          resource: `${context.path}.${normalizeMethod(context.method)}`,
          tags: {
            'feathers.service': context.path,
            'feathers.method': context.method,
            'feathers.transport': context.params?.provider ?? 'internal',
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
