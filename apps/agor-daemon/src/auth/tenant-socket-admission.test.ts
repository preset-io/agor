import { Forbidden, Unavailable } from '@agor/core/feathers';
import { ENVIRONMENT_COMMAND_REPORT_SERVICE } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import {
  admitTenantSocketPacket,
  rejectTenantSocketPacket,
  TenantSocketRestrictionMonitor,
} from './tenant-socket-admission.js';

describe('restricted socket transport', () => {
  it.each([new Forbidden(), new Unavailable()])(
    'retains only executor safety RPCs when closed: %s',
    async (error) => {
      const assertAccess = vi.fn().mockRejectedValue(error);
      for (const packet of [
        ['getTerminationState', 'tasks'],
        ['reportTerminationComplete', 'tasks'],
        ['create', ENVIRONMENT_COMMAND_REPORT_SERVICE],
      ]) {
        await expect(
          admitTenantSocketPacket({ tenantId: 'a', executor: true, packet, assertAccess })
        ).resolves.toBeUndefined();
        await expect(
          admitTenantSocketPacket({ tenantId: 'a', executor: false, packet, assertAccess })
        ).rejects.toBe(error);
      }
      for (const packet of [
        ['get', 'tasks'],
        ['create', 'sessions'],
        ['terminal:input', {}],
        ['join', 'room'],
        ['presence:heartbeat', {}],
      ]) {
        await expect(
          admitTenantSocketPacket({ tenantId: 'a', executor: true, packet, assertAccess })
        ).rejects.toBe(error);
      }
    }
  );
  it('preserves unrestricted transport and verifies the bound tenant', async () => {
    const assertAccess = vi.fn().mockResolvedValue(undefined);
    await admitTenantSocketPacket({
      tenantId: 'neighbor',
      executor: false,
      packet: ['get', 'tasks'],
      assertAccess,
    });
    expect(assertAccess).toHaveBeenCalledWith('neighbor');
  });
});

it('does not let stalled tenant A block B or accumulate duplicate DB reads', async () => {
  vi.useFakeTimers();
  try {
    const assertAccess = vi.fn((tenantId: string) =>
      tenantId === 'a' ? new Promise<void>(() => {}) : Promise.reject(new Forbidden())
    );
    const monitor = new TenantSocketRestrictionMonitor(assertAccess, 20);
    const closeA = vi.fn();
    const closeB = vi.fn();
    const targets = new Map([
      ['a', closeA],
      ['b', closeB],
    ]);
    const first = monitor.check(targets);
    await vi.advanceTimersByTimeAsync(1);
    expect(closeB).toHaveBeenCalledOnce();
    expect(closeA).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20);
    await first;
    expect(closeA).toHaveBeenCalledOnce();
    const second = monitor.check(targets);
    await vi.advanceTimersByTimeAsync(20);
    await second;
    expect(assertAccess.mock.calls.filter(([tenant]) => tenant === 'a')).toHaveLength(1);
  } finally {
    vi.useRealTimers();
  }
});

it('caps underlying stalled reads across batches and repeated sweeps', async () => {
  vi.useFakeTimers();
  try {
    const assertAccess = vi.fn(() => new Promise<void>(() => {}));
    const monitor = new TenantSocketRestrictionMonitor(assertAccess, 20);
    const closes = Array.from({ length: 20 }, () => vi.fn());
    const targets = new Map(closes.map((close, index) => [`tenant-${index}`, close]));
    for (let sweep = 0; sweep < 2; sweep++) {
      const checking = monitor.check(targets);
      await vi.advanceTimersByTimeAsync(100);
      await checking;
      expect(assertAccess).toHaveBeenCalledTimes(8);
      for (const close of closes) expect(close).toHaveBeenCalledTimes(sweep + 1);
    }
  } finally {
    vi.useRealTimers();
  }
});

it('settles denied RPCs once without dispatch or leaking observation errors', () => {
  const ack = vi.fn();
  const next = vi.fn();
  rejectTenantSocketPacket(['get', 'tasks', 'id', {}, ack], next);
  expect(ack).toHaveBeenCalledExactlyOnceWith(
    new Forbidden('Tenant access cannot be verified').toJSON()
  );
  expect(next).not.toHaveBeenCalled();
});
it('rejects unacknowledged raw packets without dispatch', () => {
  const next = vi.fn();
  rejectTenantSocketPacket(['terminal:input', {}], next);
  expect(next).toHaveBeenCalledExactlyOnceWith(expect.any(Forbidden));
});
