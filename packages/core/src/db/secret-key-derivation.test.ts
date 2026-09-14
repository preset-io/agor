import { scrypt } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import type { DatadogTracer } from '../tracing/datadog';
import type { Database } from './client';
import { openBoundSecretAsync, sealBoundSecret } from './oauth-secret-envelope';
import { configureSecretKeyDerivationTracing, deriveSecretKeyAsync } from './secret-key-derivation';
import { getCurrentTenantId, runWithTenantContext, tenantDatabaseScope } from './tenant-context';

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, scrypt: vi.fn(actual.scrypt) };
});

afterEach(() => {
  configureSecretKeyDerivationTracing(null);
  vi.mocked(scrypt).mockReset();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it('retains authenticated envelope binding with tracing enabled', async () => {
  const actual = await vi.importActual<typeof import('node:crypto')>('node:crypto');
  vi.mocked(scrypt).mockImplementation(actual.scrypt);
  configureSecretKeyDerivationTracing({
    trace(_name, _options, fn) {
      return fn();
    },
  });
  const envelope = sealBoundSecret(
    'synthetic-token',
    'synthetic-master',
    'access-token',
    'tenant-a:row'
  );
  await expect(
    openBoundSecretAsync(envelope, 'synthetic-master', 'access-token', 'tenant-a:row')
  ).resolves.toBe('synthetic-token');
  await expect(
    openBoundSecretAsync(envelope, 'synthetic-master', 'access-token', 'tenant-b:row')
  ).rejects.toThrow();
});

it('records only bounded capacity/context tags and restores pending count after success or failure', async () => {
  const callbacks: ((error: Error | null, key: Buffer) => void)[] = [];
  vi.mocked(scrypt).mockImplementation(((
    _secret: unknown,
    _salt: unknown,
    _length: unknown,
    callback: (error: Error | null, key: Buffer) => void
  ) => {
    callbacks.push(callback);
  }) as typeof scrypt);
  const calls: Record<string, unknown>[] = [];
  const tracer: DatadogTracer = {
    trace(name, options, fn) {
      expect(name).toBe('crypto.scrypt');
      calls.push(options.tags!);
      return fn();
    },
  };
  vi.stubEnv('UV_THREADPOOL_SIZE', '8');
  configureSecretKeyDerivationTracing(tracer);
  const key = Buffer.alloc(32, 2);
  const first = runWithTenantContext('tenant-a', () =>
    tenantDatabaseScope.run(
      {
        kind: 'tenant',
        tenantId: 'tenant-a',
        transactionActive: true,
        db: {} as Database,
        postCommitCallbacks: [],
        afterCommitCallbacks: [],
      },
      async () => {
        const result = await deriveSecretKeyAsync(
          'sensitive-master',
          Buffer.from('sensitive-salt'),
          'legacy'
        );
        expect(getCurrentTenantId()).toBe('tenant-a');
        expect(() => runWithTenantContext('tenant-b', () => undefined)).toThrow(
          'Cannot enter tenant context'
        );
        return result;
      }
    )
  );
  const second = runWithTenantContext('tenant-b', () =>
    deriveSecretKeyAsync('another-master', Buffer.alloc(16), 'bound')
  );
  const failure = new Error('synthetic failure');
  const rejected = expect(second).rejects.toBe(failure);
  expect(calls).toEqual([
    {
      'crypto.envelope': 'legacy',
      'crypto.pending_at_submit': 0,
      'crypto.in_tenant_transaction': true,
      'crypto.configured_pool_size': 8,
    },
    {
      'crypto.envelope': 'bound',
      'crypto.pending_at_submit': 1,
      'crypto.in_tenant_transaction': false,
      'crypto.configured_pool_size': 8,
    },
  ]);
  callbacks[0](null, key);
  callbacks[1](failure, Buffer.alloc(0));
  await expect(first).resolves.toBe(key);
  await rejected;
  const third = deriveSecretKeyAsync('sensitive-master', Buffer.from('sensitive-salt'), 'legacy');
  expect(calls[2]['crypto.pending_at_submit']).toBe(0);
  callbacks[2](null, key);
  await third;
  expect(callbacks).toHaveLength(3); // No secret/key caching or deduplication.
  expect(JSON.stringify(calls)).not.toMatch(/sensitive|tenant-a|tenant-b|another-master/);
});

it('keeps the native KDF operational when disabled or when the tracer throws', async () => {
  const key = Buffer.alloc(32);
  vi.mocked(scrypt).mockImplementation(((
    _secret: unknown,
    _salt: unknown,
    _length: unknown,
    callback: (error: Error | null, key: Buffer) => void
  ) => {
    callback(null, key);
  }) as typeof scrypt);
  vi.mocked(scrypt).mockClear();
  configureSecretKeyDerivationTracing(null);
  await expect(deriveSecretKeyAsync('test', Buffer.alloc(16), 'legacy')).resolves.toBe(key);
  configureSecretKeyDerivationTracing({
    trace() {
      throw new Error('tracer unavailable');
    },
  });
  await expect(deriveSecretKeyAsync('test', Buffer.alloc(16), 'bound')).resolves.toBe(key);
  expect(scrypt).toHaveBeenCalledTimes(2);
});
