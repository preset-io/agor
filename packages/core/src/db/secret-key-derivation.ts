import { scrypt } from 'node:crypto';
import { type DatadogTracer, traceBestEffort } from '../tracing/datadog';
import { getCurrentTenantDatabaseScope } from './tenant-context';

interface DerivationTracing {
  tracer: DatadogTracer;
  pending: number;
  configuredPoolSize?: number;
}

let tracing: DerivationTracing | null = null;

/** Daemon startup only; shares the existing custom-APM gate and optional tracer. */
export function configureSecretKeyDerivationTracing(tracer: DatadogTracer | null): void {
  const configured = Number(process.env.UV_THREADPOOL_SIZE ?? 4);
  tracing = tracer
    ? {
        tracer,
        pending: 0,
        configuredPoolSize:
          Number.isSafeInteger(configured) && configured > 0 ? configured : undefined,
      }
    : null;
}

/**
 * One async KDF, unchanged cryptography. APM records submit-to-callback time,
 * not pure queue time: Node does not expose when the native worker starts.
 * Pending counts cover these Agor KDFs only, not other libuv work. They are
 * process-global capacity observations, never tenant authorization state.
 * No input, salt, key, plaintext, binding, or resource identity is tagged.
 */
export function deriveSecretKeyAsync(
  secret: string,
  salt: Buffer,
  envelope: 'legacy' | 'bound'
): Promise<Buffer> {
  const derive = () =>
    new Promise<Buffer>((resolve, reject) => {
      scrypt(secret, salt, 32, (error, key) => {
        if (error) reject(error);
        else resolve(key);
      });
    });
  const state = tracing;
  if (!state) return derive();
  const scope = getCurrentTenantDatabaseScope();
  return traceBestEffort(
    state.tracer,
    'crypto.scrypt',
    {
      'crypto.envelope': envelope,
      'crypto.pending_at_submit': state.pending,
      'crypto.in_tenant_transaction': scope?.kind === 'tenant' && scope.transactionActive,
      ...(state.configuredPoolSize === undefined
        ? {}
        : { 'crypto.configured_pool_size': state.configuredPoolSize }),
    },
    async () => {
      state.pending++;
      try {
        return await derive();
      } finally {
        state.pending--;
      }
    }
  );
}
