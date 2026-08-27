import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import type { HookContext } from '@agor/core/types';
import {
  type FeathersInstrumentationOptions,
  normalizeFeathersMethod as normalizeMethod,
  normalizeFeathersService as normalizeService,
  normalizeFeathersTransport as normalizeTransport,
} from '../utils/feathers-instrumentation.js';
import type { DaemonMetrics } from './types.js';

type AroundNext = () => Promise<void>;

type FeathersMetricsOptions = FeathersInstrumentationOptions;

function errorStatus(error: unknown): string | number {
  if (!error || typeof error !== 'object') return 'error';
  const candidate = (error as { code?: unknown }).code;
  return typeof candidate === 'number' && Number.isInteger(candidate) ? candidate : 'error';
}

/**
 * Outermost external Feathers call instrumentation. Request-local nesting
 * suppresses ordinary service fan-out; callers can additionally classify
 * framework internals that enter independently with an external provider.
 */
export function createFeathersMetricsHook(
  metrics: DaemonMetrics,
  options: FeathersMetricsOptions = {}
) {
  if (!metrics.enabled) return async (_context: HookContext, next: AroundNext) => next();
  const requestScope = new AsyncLocalStorage<true>();

  return async (context: HookContext, next: AroundNext): Promise<void> => {
    // App-level hooks also wrap service-to-service calls. Agor often preserves
    // the caller's params (including provider) through that fan-out, so
    // provider alone cannot distinguish a new transport request. Every
    // top-level invocation establishes a request-local scope; nested calls and
    // detached work they spawn inherit it and are internal by definition.
    if (requestScope.getStore()) {
      await next();
      return;
    }

    await requestScope.run(true, async () => {
      const transport = normalizeTransport(context.params?.provider);
      if (
        !transport ||
        options.excludedServicePaths?.includes(context.path) ||
        options.isInternalCall?.(context)
      ) {
        await next();
        return;
      }

      const startedAt = performance.now();
      let outcome = 'success';
      let statusCode: string | number = 'ok';
      try {
        await next();
      } catch (error) {
        outcome = 'error';
        statusCode = errorStatus(error);
        throw error;
      } finally {
        const tags = {
          service: normalizeService(context.path),
          method: normalizeMethod(context.method),
          transport,
          outcome,
          status_code: statusCode,
        };
        metrics.increment('feathers.requests', 1, tags);
        metrics.distribution(
          'feathers.request.duration_ms',
          Math.max(0, performance.now() - startedAt),
          tags
        );
      }
    });
  };
}
