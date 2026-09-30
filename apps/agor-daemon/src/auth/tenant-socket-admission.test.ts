import { AsyncLocalStorage } from 'node:async_hooks';
import { Forbidden, NotAuthenticated, Unavailable } from '@agor/core/feathers';
import { ENVIRONMENT_COMMAND_REPORT_SERVICE, TENANT_RESTRICTED_ERROR_CODE } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import {
  admitTenantSocketPacket,
  createOrderedTenantPacketGate,
  rejectTenantSocketPacket,
  restrictedSocketHandshakeError,
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

describe('ordered tenant packet gate', () => {
  it('dispatches admitted packets inside their own read scope, after earlier packets', async () => {
    const store = new AsyncLocalStorage<string>();
    const releases: Array<() => void> = [];
    const gate = createOrderedTenantPacketGate({
      needsAdmission: (packet) => packet[0] === 'create',
      admit: () => new Promise<void>((resolve) => releases.push(resolve)),
      scope: (work) => store.run(`scope:${releases.length}`, work),
    });
    const dispatched: Array<[unknown, string | undefined]> = [];
    const next = (label: unknown) => () => dispatched.push([label, store.getStore()]);
    gate(['create', 'a'], next('a'));
    gate(['create', 'b'], next('b'));
    gate(['raw'], next('raw'));
    releases[1]?.();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(dispatched).toEqual([]);
    releases[0]?.();
    await vi.waitFor(() => expect(dispatched).toHaveLength(3));
    expect(dispatched).toEqual([
      ['a', 'scope:0'],
      ['b', 'scope:1'],
      ['raw', undefined],
    ]);
    gate(['raw'], next('sync'));
    expect(dispatched.at(-1)).toEqual(['sync', undefined]);
  });

  it('rejects a never-settling admission after the bound so later packets still move', async () => {
    vi.useFakeTimers();
    try {
      const gate = createOrderedTenantPacketGate({
        needsAdmission: (packet) => packet[0] === 'create',
        admit: (packet) =>
          packet[1] === 'stuck' ? new Promise<void>(() => undefined) : Promise.resolve(),
        admissionTimeoutMs: 20,
      });
      const stuckAck = vi.fn();
      const dispatched: string[] = [];
      gate(['create', 'stuck', stuckAck], () => dispatched.push('stuck'));
      gate(['raw'], () => dispatched.push('raw'));
      gate(['create', 'ok', vi.fn()], () => dispatched.push('ok'));
      await vi.advanceTimersByTimeAsync(19);
      expect(dispatched).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(stuckAck).toHaveBeenCalledExactlyOnceWith(
        new Forbidden('Tenant access cannot be verified').toJSON()
      );
      expect(dispatched).toEqual(['raw', 'ok']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('disconnects once instead of queueing past the limit, and dispatches nothing after', async () => {
    const releases: Array<() => void> = [];
    const onOverflow = vi.fn();
    const gate = createOrderedTenantPacketGate({
      needsAdmission: (packet) => packet[0] === 'create',
      admit: () => new Promise<void>((resolve) => releases.push(resolve)),
      queueLimit: 2,
      onOverflow,
    });
    const dispatched: string[] = [];
    const acks = [vi.fn(), vi.fn(), vi.fn(), vi.fn()];
    for (const [index, ack] of acks.entries()) {
      gate(['create', index, ack], () => dispatched.push(String(index)));
    }
    expect(onOverflow).toHaveBeenCalledOnce();
    for (const release of releases) release();
    await vi.waitFor(() => expect(acks[1]).toHaveBeenCalled());
    expect(dispatched).toEqual([]);
    for (const ack of acks) expect(ack).toHaveBeenCalledOnce();
  });
});

describe('socket restriction monitor', () => {
  const warnings = () => vi.spyOn(console, 'warn').mockImplementation(() => undefined);

  it('does not let stalled tenant A block B or accumulate duplicate DB reads', async () => {
    vi.useFakeTimers();
    const warn = warnings();
    try {
      const observed: string[] = [];
      const observe = vi.fn(async (tenantId: string) => {
        if (tenantId === 'a') return new Promise<void>(() => undefined);
        observed.push(tenantId);
      });
      const monitor = new TenantSocketRestrictionMonitor(observe, { timeoutMs: 20 });
      for (let sweep = 0; sweep < 2; sweep++) {
        const checking = monitor.check(['a', 'b']);
        await vi.advanceTimersByTimeAsync(20);
        await checking;
      }
      expect(observed).toEqual(['b', 'b']);
      expect(observe.mock.calls.filter(([tenant]) => tenant === 'a')).toHaveLength(1);
      expect(warn).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(
        '[tenant.restriction] socket observation skipped reason=timeout suppressed=0'
      );
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it('abandons a wedged read once after two timeouts and never stacks another behind it', async () => {
    vi.useFakeTimers();
    const warn = warnings();
    try {
      const observe = vi.fn(() => new Promise<void>(() => undefined));
      const monitor = new TenantSocketRestrictionMonitor(observe, { timeoutMs: 20 });
      for (let sweep = 0; sweep < 6; sweep++) {
        const checking = monitor.check(['a']);
        await vi.advanceTimersByTimeAsync(20);
        await checking;
      }
      // The original read plus exactly one replacement; the abandoned one is still outstanding.
      expect(observe).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it('retires a persistently unverifiable tenant but keeps transient skips non-disruptive', async () => {
    const warn = warnings();
    try {
      let flakyFailed = false;
      const observe = vi.fn(async (tenantId: string) => {
        if (tenantId === 'down') throw new Error('unreadable');
        if (tenantId === 'flaky' && !flakyFailed) {
          flakyFailed = true;
          throw new Error('transient');
        }
      });
      const retireUnverifiable = vi.fn();
      const monitor = new TenantSocketRestrictionMonitor(observe, {
        timeoutMs: 20,
        retireUnverifiable,
        unverifiableLimit: 3,
      });
      for (let sweep = 0; sweep < 2; sweep++) await monitor.check(['down', 'flaky', 'open']);
      expect(retireUnverifiable).not.toHaveBeenCalled();
      await monitor.check(['down', 'flaky', 'open']);
      expect(retireUnverifiable).toHaveBeenCalledExactlyOnceWith('down');
      for (let sweep = 0; sweep < 5; sweep++) await monitor.check(['flaky', 'open']);
      expect(retireUnverifiable).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });

  it('skips on error and saturation with one rate-limited line per minute', async () => {
    vi.useFakeTimers();
    const warn = warnings();
    let now = 0;
    try {
      const observe = vi.fn((tenantId: string) =>
        tenantId === 'failing'
          ? Promise.reject(new Error('private detail'))
          : new Promise<void>(() => undefined)
      );
      const monitor = new TenantSocketRestrictionMonitor(observe, {
        timeoutMs: 20,
        now: () => now,
      });
      const tenants = ['failing', ...Array.from({ length: 20 }, (_, index) => `tenant-${index}`)];
      for (let sweep = 0; sweep < 2; sweep++) {
        const checking = monitor.check(tenants);
        await vi.advanceTimersByTimeAsync(100);
        await checking;
      }
      // Eight reads in flight cap the DB load; the rest are skipped, never retired.
      expect(observe.mock.calls.filter(([tenant]) => tenant !== 'failing')).toHaveLength(8);
      const lines = warn.mock.calls.map(([line]) => String(line));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/reason=(saturated|error) suppressed=0/);
      expect(lines.join('\n')).not.toContain('private detail');
      now = 60_000;
      const checking = monitor.check(tenants);
      await vi.advanceTimersByTimeAsync(100);
      await checking;
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn.mock.calls.at(-1)?.[0]).toMatch(
        /reason=(saturated|timeout|error) suppressed=[1-9]/
      );
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });
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

describe('restricted handshake rejection', () => {
  it('carries the stable code without controller, placement or revision detail', () => {
    const rejection = restrictedSocketHandshakeError(
      new Forbidden('Tenant access is restricted', { code: TENANT_RESTRICTED_ERROR_CODE })
    );
    expect(rejection).toMatchObject({
      message: 'Tenant access is restricted',
      data: { code: TENANT_RESTRICTED_ERROR_CODE },
    });
    expect(Object.keys(rejection!.data)).toEqual(['code']);
    expect(JSON.stringify(rejection!.data)).not.toMatch(/controller|placement|revision|operation/i);
  });

  it.each([
    new NotAuthenticated('Invalid or expired authentication token'),
    new Unavailable('Tenant access cannot be verified'),
    new Forbidden('Tenant access cannot be verified'),
    // Message text alone is never the signal; only the recorded code is.
    new Forbidden('Tenant access is restricted'),
    new Error('boom'),
    undefined,
  ])('never presents another handshake failure as a restriction: %s', (error) => {
    expect(restrictedSocketHandshakeError(error)).toBeNull();
  });
});
