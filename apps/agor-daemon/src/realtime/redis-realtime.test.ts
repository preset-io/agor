import type { ResolvedRedisSettings } from '@agor/core/config';
import {
  isRealtimeRelayEnvelope,
  REALTIME_RELAY_EVENT,
  REALTIME_RELAY_VERSION,
} from '@agor/core/realtime';
import { describe, expect, it, vi } from 'vitest';
import {
  RedisRealtimeRuntime,
  redisAdapterKey,
  redisRealtimeClientOptions,
} from './redis-realtime';

const settings = {
  url: 'redis://127.0.0.1:6379/0',
  keyPrefix: 'unit-test',
  connectTimeoutMs: 100,
  startupTimeoutMs: 100,
  requestTimeoutMs: 100,
  reconnectBaseDelayMs: 10,
  reconnectMaxDelayMs: 20,
} satisfies ResolvedRedisSettings;

describe('isRealtimeRelayEnvelope', () => {
  it('accepts the minimal versioned tenant envelope', () => {
    expect(
      isRealtimeRelayEnvelope({
        version: REALTIME_RELAY_VERSION,
        tenantId: 'tenant-a',
        path: 'boards',
        event: 'patched',
        data: { board_id: 'board-a' },
      })
    ).toBe(true);
  });

  it('accepts a bounded authorization snapshot only for a branch removal', () => {
    expect(
      isRealtimeRelayEnvelope({
        version: REALTIME_RELAY_VERSION,
        tenantId: 'tenant-a',
        path: 'branches',
        event: 'removed',
        data: { branch_id: 'branch-a' },
        branchRemovalVisibility: {
          branchId: 'branch-a',
          mode: 'explicitUsers',
          userIds: ['user-a'],
        },
      })
    ).toBe(true);
  });

  it.each([
    null,
    { version: 1, tenantId: 'tenant-a', path: 'boards', event: 'patched', data: {} },
    { version: REALTIME_RELAY_VERSION, tenantId: '', path: 'boards', event: 'patched', data: {} },
    { version: REALTIME_RELAY_VERSION, tenantId: 'tenant-a', path: '', event: 'patched', data: {} },
    {
      version: REALTIME_RELAY_VERSION,
      tenantId: 'tenant-a',
      path: 'boards',
      event: 'patched',
      method: 'x'.repeat(129),
      data: {},
    },
    {
      version: REALTIME_RELAY_VERSION,
      tenantId: 'tenant-a',
      path: 'boards',
      event: 'patched',
      data: 'x'.repeat(512 * 1024 + 1),
    },
    {
      version: REALTIME_RELAY_VERSION,
      tenantId: 'tenant-a',
      path: 'branches',
      event: 'removed',
      data: { branch_id: 'branch-a' },
    },
    {
      version: REALTIME_RELAY_VERSION,
      tenantId: 'tenant-a',
      path: 'branches',
      event: 'patched',
      data: { branch_id: 'branch-a' },
      branchRemovalVisibility: {
        branchId: 'branch-a',
        mode: 'explicitUsers',
        userIds: ['user-a'],
      },
    },
    {
      version: REALTIME_RELAY_VERSION,
      tenantId: 'tenant-a',
      path: 'branches',
      event: 'removed',
      data: { branch_id: 'branch-a' },
      branchRemovalVisibility: {
        branchId: 'branch-a',
        mode: 'explicitUsers',
        userIds: [42],
      },
    },
  ])('rejects malformed/unversioned Redis input', (value) => {
    expect(isRealtimeRelayEnvelope(value)).toBe(false);
  });
});

it('isolates independent deployment namespaces', () => {
  expect(redisAdapterKey('prod-blue')).not.toBe(redisAdapterKey('prod-green'));
});

it('fails publisher commands during outages without weakening subscriber recovery', () => {
  expect(redisRealtimeClientOptions(settings, 'publisher')).toMatchObject({
    enableOfflineQueue: false,
    autoResendUnfulfilledCommands: false,
    maxRetriesPerRequest: 1,
    autoResubscribe: false,
  });
  expect(redisRealtimeClientOptions(settings, 'subscriber')).toMatchObject({
    autoResubscribe: true,
    maxRetriesPerRequest: null,
  });
});

it('listens for server-side Feathers relays on the adapter root namespace', async () => {
  let listener: ((value: unknown) => void) | undefined;
  const namespace = {
    on: vi.fn((event: string, handler: (value: unknown) => void) => {
      if (event === REALTIME_RELAY_EVENT) listener = handler;
    }),
  };
  const runtime = new RedisRealtimeRuntime(settings, { instanceId: 'daemon-b', bootId: 'boot-b' });
  runtime.attach({ of: vi.fn(() => namespace) } as never);
  const handler = vi.fn();
  runtime.setRelayHandler(handler);
  const envelope = {
    version: REALTIME_RELAY_VERSION,
    tenantId: 'tenant-a',
    path: 'boards',
    event: 'created',
    data: { board_id: 'board-a' },
  };

  listener?.(envelope);
  await Promise.resolve();

  expect(namespace.on).toHaveBeenCalledWith(REALTIME_RELAY_EVENT, expect.any(Function));
  expect(handler).toHaveBeenCalledWith(envelope);
});
