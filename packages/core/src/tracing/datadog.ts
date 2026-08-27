/**
 * Shared Datadog APM tracer surface + optional-peer resolver.
 *
 * dd-trace ships no plugin for FeathersJS or postgres.js, so Agor instruments
 * both manually via dd-trace's native `tracer.trace()`. This module holds the
 * one tracer type and the one resolver both instrumentations use.
 *
 * IMPORTANT: `resolveDatadogTracer` takes an explicit `requireFn` and has no
 * default. The tracer is a runtime/daemon concern loaded by single-step
 * instrumentation (`NODE_OPTIONS`); it must be resolved from a module in the
 * process that actually has it on its resolution path (the daemon), NOT from
 * `@agor/core`, whose `createRequire` may not see it. Callers pass their own
 * `createRequire(import.meta.url)`.
 */

/** Minimal surface of the dd-trace singleton we depend on. */
export interface DatadogTracer {
  trace<T>(
    name: string,
    options: { resource?: string; type?: string; tags?: Record<string, unknown> },
    fn: () => T
  ): T;
}

/**
 * Resolve the process-wide APM tracer without initializing it. Optional runtime
 * dependency (never declared/bundled): present → used, absent → `null`. Tries
 * `dd-trace-api` (Datadog's single-step bridge) then `dd-trace`.
 *
 * @param requireFn a `createRequire(import.meta.url)` anchored in a module that
 *   can resolve dd-trace (i.e. the daemon).
 */
export function resolveDatadogTracer(requireFn: (id: string) => unknown): DatadogTracer | null {
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
