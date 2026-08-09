import type { ResolvedRedisSettings } from '@agor/core/config';
import { describe, expect, it, vi } from 'vitest';
import {
  FEATHERS_RELAY_EVENT,
  isRealtimeRelayEnvelope,
  RedisRealtimeRuntime,
  redisAdapterKey,
} from './redis-realtime';

describe('isRealtimeRelayEnvelope', () => {
  it('accepts the minimal versioned tenant envelope', () => {
    expect(
      isRealtimeRelayEnvelope({
        version: 1,
        tenantId: 'tenant-a',
        path: 'boards',
        event: 'patched',
        data: { board_id: 'board-a' },
      })
    ).toBe(true);
  });

  it.each([
    null,
    { version: 2, tenantId: 'tenant-a', path: 'boards', event: 'patched', data: {} },
    { version: 1, tenantId: '', path: 'boards', event: 'patched', data: {} },
    { version: 1, tenantId: 'tenant-a', path: '', event: 'patched', data: {} },
    {
      version: 1,
      tenantId: 'tenant-a',
      path: 'boards',
      event: 'patched',
      method: 'x'.repeat(129),
      data: {},
    },
    {
      version: 1,
      tenantId: 'tenant-a',
      path: 'boards',
      event: 'patched',
      data: 'x'.repeat(512 * 1024 + 1),
    },
  ])('rejects malformed/unversioned Redis input', (value) => {
    expect(isRealtimeRelayEnvelope(value)).toBe(false);
  });
});

it('isolates independent deployment namespaces', () => {
  expect(redisAdapterKey('prod-blue')).not.toBe(redisAdapterKey('prod-green'));
});

it('listens for server-side Feathers relays on the adapter root namespace', async () => {
  let listener: ((value: unknown) => void) | undefined;
  const namespace = {
    on: vi.fn((event: string, handler: (value: unknown) => void) => {
      if (event === FEATHERS_RELAY_EVENT) listener = handler;
    }),
  };
  const runtime = new RedisRealtimeRuntime(
    {
      url: 'redis://127.0.0.1:6379/0',
      keyPrefix: 'unit-test',
      connectTimeoutMs: 100,
      startupTimeoutMs: 100,
      requestTimeoutMs: 100,
      reconnectBaseDelayMs: 10,
      reconnectMaxDelayMs: 20,
    } satisfies ResolvedRedisSettings,
    { instanceId: 'daemon-b', bootId: 'boot-b' }
  );
  runtime.attach({ of: vi.fn(() => namespace) } as never);
  const handler = vi.fn();
  runtime.setRelayHandler(handler);
  const envelope = {
    version: 1 as const,
    tenantId: 'tenant-a',
    path: 'boards',
    event: 'created',
    data: { board_id: 'board-a' },
  };

  listener?.(envelope);
  await Promise.resolve();

  expect(namespace.on).toHaveBeenCalledWith(FEATHERS_RELAY_EVENT, expect.any(Function));
  expect(handler).toHaveBeenCalledWith(envelope);
});
