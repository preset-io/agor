import { performance } from 'node:perf_hooks';
import type { HookContext } from '@agor/core/types';
import type { DaemonMetrics } from './types.js';

type AroundNext = () => Promise<void>;

function normalizeTransport(provider: unknown): 'rest' | 'socketio' | 'other' | undefined {
  if (provider === undefined || provider === null) return undefined;
  if (provider === 'rest' || provider === 'socketio') return provider;
  return 'other';
}

function normalizeMethod(method: string): string {
  return ['create', 'find', 'get', 'patch', 'remove', 'update'].includes(method)
    ? method
    : 'custom';
}

function normalizeService(path: string): string {
  return /^[a-zA-Z0-9_/-]{1,100}$/.test(path) ? path : 'other';
}

function errorStatus(error: unknown): string | number {
  if (!error || typeof error !== 'object') return 'error';
  const candidate = (error as { code?: unknown }).code;
  return typeof candidate === 'number' && Number.isInteger(candidate) ? candidate : 'error';
}

/**
 * External Feathers call instrumentation. Internal service calls have no
 * provider and are skipped so one user request is not recursively counted.
 */
export function createFeathersMetricsHook(metrics: DaemonMetrics) {
  if (!metrics.enabled) return async (_context: HookContext, next: AroundNext) => next();

  return async (context: HookContext, next: AroundNext): Promise<void> => {
    const transport = normalizeTransport(context.params?.provider);
    if (!transport) {
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
  };
}
