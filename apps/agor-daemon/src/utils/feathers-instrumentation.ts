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

/**
 * Server-authored, bounded reasons for service calls which otherwise look like
 * anonymous transport entrypoints in APM. Keep this list deliberately small:
 * values become Datadog tags, while resource IDs and user/tenant identifiers
 * must never enter tracing dimensions.
 */
export const FEATHERS_INSTRUMENTATION_REASONS = [
  'presence_cursor_admission',
  'session_stream_admission',
] as const;
export type FeathersInstrumentationReason = (typeof FEATHERS_INSTRUMENTATION_REASONS)[number];

/**
 * A symbol prevents a browser from forging an internal reason over REST or
 * Socket.IO serialization. It remains available when server code spreads the
 * params object into a nested Feathers call.
 */
export const FEATHERS_INSTRUMENTATION_REASON = Symbol('agor.feathersInstrumentationReason');

export function readFeathersInstrumentationReason(
  params: unknown
): FeathersInstrumentationReason | undefined {
  if (!params || typeof params !== 'object') return undefined;
  const reason = (params as { [FEATHERS_INSTRUMENTATION_REASON]?: unknown })[
    FEATHERS_INSTRUMENTATION_REASON
  ];
  return FEATHERS_INSTRUMENTATION_REASONS.includes(reason as FeathersInstrumentationReason)
    ? (reason as FeathersInstrumentationReason)
    : undefined;
}

const KNOWN_METHODS = ['create', 'find', 'get', 'patch', 'remove', 'update'];

/**
 * Custom methods whose APM attribution is operationally useful and strictly
 * bounded by a reviewed server registration. Do not accept arbitrary method
 * strings here: values become Datadog tags.
 */
const TAGGED_CUSTOM_METHODS: Readonly<Record<string, readonly string[]>> = {
  tasks: [
    'connectExecutor',
    'reportTerminationComplete',
    'reportRuntimeTelemetry',
    'reportSdkHealthFailure',
  ],
};

export function readTaggedFeathersCustomMethod(path: string, method: string): string | undefined {
  return TAGGED_CUSTOM_METHODS[path]?.includes(method) ? method : undefined;
}

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
