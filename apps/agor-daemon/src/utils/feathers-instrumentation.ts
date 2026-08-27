import type { HookContext } from '@agor/core/types';

/**
 * Shared classification/normalization for Feathers service-call instrumentation.
 *
 * Both the StatsD metrics hook (`metrics/feathers.ts`) and the APM tracing hook
 * (`tracing/feathers.ts`) wrap every service method and need identical answers
 * for "which transport / method / service is this, and should it be
 * instrumented at all". Keeping that logic here stops the two hooks from
 * drifting (e.g. one bounding tag cardinality while the other emits raw values).
 */

export type FeathersTransport = 'rest' | 'socketio' | 'mcp' | 'other';

const KNOWN_METHODS = ['create', 'find', 'get', 'patch', 'remove', 'update'];

/**
 * Map a Feathers `params.provider` to a bounded transport label. Returns
 * `undefined` for internal (no-provider) calls; callers decide whether to skip
 * them (metrics) or label them `internal` (tracing).
 */
export function normalizeFeathersTransport(provider: unknown): FeathersTransport | undefined {
  if (provider === undefined || provider === null) return undefined;
  if (provider === 'rest' || provider === 'socketio' || provider === 'mcp') return provider;
  return 'other';
}

/** Bound method names to the known Feathers set, collapsing custom methods. */
export function normalizeFeathersMethod(method: string): string {
  return KNOWN_METHODS.includes(method) ? method : 'custom';
}

/** Bound the service path to a safe, low-cardinality identifier. */
export function normalizeFeathersService(path: string): string {
  return /^[a-zA-Z0-9_/-]{1,100}$/.test(path) ? path : 'other';
}

/**
 * Options shared by the Feathers instrumentation hooks for deciding which calls
 * to skip entirely.
 */
export interface FeathersInstrumentationOptions {
  /** Service paths never instrumented (e.g. the high-frequency `health` probe). */
  excludedServicePaths?: readonly string[];
  /**
   * Classify framework-internal calls that enter with an external provider (e.g.
   * the authentication serialized-entity lookup) so they can be skipped.
   */
  isInternalCall?: (context: HookContext) => boolean;
}
