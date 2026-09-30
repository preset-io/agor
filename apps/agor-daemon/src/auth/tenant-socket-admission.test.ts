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
  tenantSocketPacketNeedsAdmission,
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
  it('dispatches executor safety packets without a read while an earlier read never settles', async () => {
    vi.useFakeTimers();
    try {
      const assertAccess = vi.fn(() => new Promise<void>(() => undefined));
      const gate = createOrderedTenantPacketGate({
        needsAdmission: (packet) =>
          tenantSocketPacketNeedsAdmission({
            executor: true,
            serviceCall: true,
            unverified: false,
            packet,
          }),
        admit: (packet) =>
          admitTenantSocketPacket({ tenantId: 'a', executor: true, packet, assertAccess }),
        admissionTimeoutMs: 20,
      });
      const dispatched: string[] = [];
      for (const method of ['reportRuntimeTelemetry', 'reportTerminationComplete']) {
        gate([method, 'tasks', {}, {}, vi.fn()], () => dispatched.push(method));
      }
      expect(dispatched).toEqual(['reportRuntimeTelemetry', 'reportTerminationComplete']);
      expect(assertAccess).not.toHaveBeenCalled();
      // Behind a stuck ordinary read they keep their place, and still settle once it is refused.
      const stuckAck = vi.fn();
      gate(['get', 'tasks', 'id', {}, stuckAck], () => dispatched.push('get'));
      gate(['reportRuntimeTelemetry', 'tasks', {}, {}, vi.fn()], () => dispatched.push('late'));
      await vi.advanceTimersByTimeAsync(20);
      expect(stuckAck).toHaveBeenCalledOnce();
      expect(dispatched.slice(2)).toEqual(['late']);
      expect(assertAccess).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

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

  it('refuses fast once timed-out reads still running reach the limit, without starting more', async () => {
    vi.useFakeTimers();
    try {
      const releases: Array<() => void> = [];
      const admit = vi.fn(() => new Promise<void>((resolve) => releases.push(resolve)));
      const gate = createOrderedTenantPacketGate({
        needsAdmission: () => true,
        admit,
        admissionTimeoutMs: 20,
        staleReadLimit: 2,
      });
      const acks = [vi.fn(), vi.fn(), vi.fn()];
      gate(['create', 0, acks[0]], vi.fn());
      gate(['create', 1, acks[1]], vi.fn());
      await vi.advanceTimersByTimeAsync(20);
      gate(['create', 2, acks[2]], vi.fn());
      expect(acks[2]).toHaveBeenCalledExactlyOnceWith(
        new Forbidden('Tenant access cannot be verified').toJSON()
      );
      expect(admit).toHaveBeenCalledTimes(2);
      releases[0]?.();
      await vi.advanceTimersByTimeAsync(0);
      const next = vi.fn();
      gate(['create', 3, vi.fn()], next);
      expect(admit).toHaveBeenCalledTimes(3);
      releases[2]?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(next).toHaveBeenCalledExactlyOnceWith();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shares one in-flight read across a burst of coalescing packets, never a settled one', async () => {
    const releases: Array<() => void> = [];
    const admit = vi.fn(() => new Promise<void>((resolve) => releases.push(resolve)));
    const gate = createOrderedTenantPacketGate({
      needsAdmission: () => true,
      coalesce: (packet) => packet[0] === 'raw',
      admit,
    });
    const dispatched: string[] = [];
    gate(['raw', 'a'], () => dispatched.push('a'));
    gate(['create', 'rpc', vi.fn()], () => dispatched.push('rpc'));
    gate(['raw', 'b'], () => dispatched.push('b'));
    gate(['raw', 'c'], () => dispatched.push('c'));
    expect(admit).toHaveBeenCalledTimes(2);
    for (const release of releases) release();
    await vi.waitFor(() => expect(dispatched).toEqual(['a', 'rpc', 'b', 'c']));
    gate(['raw', 'd'], () => dispatched.push('d'));
    expect(admit).toHaveBeenCalledTimes(3);
    releases[2]?.();
    await vi.waitFor(() => expect(dispatched.at(-1)).toBe('d'));
  });

  it('starts a fresh read for raw packets once the shared one has timed out', async () => {
    vi.useFakeTimers();
    try {
      const admit = vi
        .fn(() => Promise.resolve())
        .mockImplementationOnce(() => new Promise<void>(() => undefined));
      const gate = createOrderedTenantPacketGate({
        needsAdmission: () => true,
        coalesce: () => true,
        admit,
        admissionTimeoutMs: 20,
      });
      const dispatched: string[] = [];
      const send = (label: string) =>
        gate(['terminal:input', label], (error?: Error) => {
          if (!error) dispatched.push(label);
        });
      send('stuck');
      await vi.advanceTimersByTimeAsync(20);
      for (const label of ['a', 'b', 'c', 'd']) send(label);
      await vi.advanceTimersByTimeAsync(0);
      expect(dispatched).toEqual(['a', 'b', 'c', 'd']);
      expect(admit).toHaveBeenCalledTimes(2);
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

  /** Mirrors the daemon's 1 s interval, which skips a tick while a sweep is still running. */
  const tick = (monitor: TenantSocketRestrictionMonitor, tenants: string[]) => {
    let checking = false;
    const interval = setInterval(() => {
      if (checking) return;
      checking = true;
      void monitor.check(tenants).finally(() => {
        checking = false;
      });
    }, 1000);
    return () => clearInterval(interval);
  };
  const unverified = (monitor: TenantSocketRestrictionMonitor, tenants: string[]) =>
    tenants.filter((tenantId) => monitor.isUnverified(tenantId));

  it.each([1, 7, 8, 9, 20])(
    'marks all %i tenants with hung reads 10 s after admission, saturated ones included',
    async (count) => {
      vi.useFakeTimers();
      const warn = warnings();
      try {
        const tenants = Array.from({ length: count }, (_, index) => `tenant-${index}`);
        const monitor = new TenantSocketRestrictionMonitor(
          () => new Promise<void>(() => undefined)
        );
        for (const tenantId of tenants) monitor.admitted(tenantId);
        const stop = tick(monitor, tenants);
        await vi.advanceTimersByTimeAsync(9_999);
        expect(unverified(monitor, tenants)).toEqual([]);
        await vi.advanceTimersByTimeAsync(1);
        expect(unverified(monitor, tenants)).toEqual(tenants);
        stop();
      } finally {
        warn.mockRestore();
        vi.useRealTimers();
      }
    }
  );

  it('marks a readable tenant that eight hung reads keep from ever being read', async () => {
    vi.useFakeTimers();
    const warn = warnings();
    try {
      const tenants = [...Array.from({ length: 8 }, (_, index) => `stuck-${index}`), 'starved'];
      const observe = vi.fn((tenantId: string) =>
        tenantId.startsWith('stuck') ? new Promise<void>(() => undefined) : Promise.resolve()
      );
      const monitor = new TenantSocketRestrictionMonitor(observe);
      for (const tenantId of tenants) monitor.admitted(tenantId);
      const stop = tick(monitor, tenants);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(observe.mock.calls.some(([tenant]) => tenant === 'starved')).toBe(false);
      expect(monitor.isUnverified('starved')).toBe(true);
      stop();
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it('never marks tenants whose slow reads succeed while saturation defers them', async () => {
    vi.useFakeTimers();
    const warn = warnings();
    try {
      const tenants = Array.from({ length: 20 }, (_, index) => `tenant-${index}`);
      const observe = vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, 1500)));
      const monitor = new TenantSocketRestrictionMonitor(observe);
      for (const tenantId of tenants) monitor.admitted(tenantId);
      const stop = tick(monitor, tenants);
      for (let second = 0; second < 60; second++) {
        await vi.advanceTimersByTimeAsync(1000);
        expect(unverified(monitor, tenants)).toEqual([]);
      }
      expect(new Set(observe.mock.calls.map(([tenant]) => tenant))).toEqual(new Set(tenants));
      stop();
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it('never marks a tenant whose reads are slow but succeed after the timeout', async () => {
    vi.useFakeTimers();
    const warn = warnings();
    try {
      const observe = vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, 2500)));
      const monitor = new TenantSocketRestrictionMonitor(observe);
      monitor.admitted('slow');
      const stop = tick(monitor, ['slow']);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(observe.mock.calls.length).toBeGreaterThan(10);
      expect(monitor.isUnverified('slow')).toBe(false);
      stop();
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it('clears the mark only with a read started within the bound, never a late stale one', async () => {
    vi.useFakeTimers();
    const warn = warnings();
    try {
      const hung: Array<() => void> = [];
      let down = true;
      const observe = vi.fn(() =>
        down ? new Promise<void>((resolve) => hung.push(resolve)) : Promise.resolve()
      );
      const monitor = new TenantSocketRestrictionMonitor(observe);
      monitor.admitted('a');
      const stop = tick(monitor, ['a']);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(monitor.isUnverified('a')).toBe(true);
      // The first read (started at 1 s) and its one replacement settle late: their snapshots are over 10 s old.
      expect(hung).toHaveLength(2);
      for (const release of hung) release();
      await vi.advanceTimersByTimeAsync(0);
      expect(monitor.isUnverified('a')).toBe(true);
      down = false;
      await vi.advanceTimersByTimeAsync(1000);
      expect(monitor.isUnverified('a')).toBe(false);
      stop();
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it('reads the tenants saturation skipped first on the next sweep', async () => {
    vi.useFakeTimers();
    const warn = warnings();
    try {
      const tenants = Array.from({ length: 10 }, (_, index) => `tenant-${index}`);
      const observe = vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, 30)));
      const monitor = new TenantSocketRestrictionMonitor(observe, { timeoutMs: 20 });
      for (const tenantId of tenants) monitor.admitted(tenantId);
      // As in the daemon, a tick follows the handshake that admitted the tenant.
      await vi.advanceTimersByTimeAsync(1);
      for (let sweep = 0; sweep < 2; sweep++) {
        const checking = monitor.check(tenants);
        await vi.advanceTimersByTimeAsync(20);
        await checking;
        await vi.advanceTimersByTimeAsync(20);
      }
      const read = new Set(observe.mock.calls.map(([tenant]) => tenant));
      expect(read).toEqual(new Set(tenants));
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("gates an unverified tenant's raw packets through admission until a read succeeds", async () => {
    const warn = warnings();
    try {
      let down = true;
      let now = 0;
      const monitor = new TenantSocketRestrictionMonitor(
        async () => {
          if (down) throw new Error('unreadable');
        },
        { timeoutMs: 20, unverifiedAfterMs: 10, now: () => now }
      );
      const admit = vi.fn(async () => {
        if (down) throw new Error('unreadable');
      });
      const gate = createOrderedTenantPacketGate({
        needsAdmission: (packet) => packet[0] === 'create' || monitor.isUnverified('a'),
        admit,
      });
      const dispatched: string[] = [];
      const send = (label: string) => {
        const next = vi.fn((error?: Error) => {
          if (!error) dispatched.push(label);
        });
        gate(['terminal:input', label], next);
        return next;
      };
      monitor.admitted('a');
      send('before');
      expect(admit).not.toHaveBeenCalled();
      now = 5;
      await monitor.check(['a']);
      now = 10;
      const refused = send('while-down');
      await vi.waitFor(() => expect(refused).toHaveBeenCalledWith(expect.any(Forbidden)));
      expect(admit).toHaveBeenCalledOnce();
      down = false;
      now = 11;
      await monitor.check(['a']);
      await vi.waitFor(() => expect(monitor.isUnverified('a')).toBe(false));
      send('after');
      expect(dispatched).toEqual(['before', 'after']);
      expect(admit).toHaveBeenCalledOnce();
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
      const skipLines = () =>
        warn.mock.calls.map(([line]) => String(line)).filter((line) => line.includes('skipped'));
      const lines = skipLines();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/reason=(saturated|error) suppressed=0/);
      expect(lines.join('\n')).not.toContain('private detail');
      now = 60_000;
      const checking = monitor.check(tenants);
      await vi.advanceTimersByTimeAsync(100);
      await checking;
      expect(skipLines()).toHaveLength(2);
      expect(skipLines().at(-1)).toMatch(/reason=(saturated|timeout|error) suppressed=[1-9]/);
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
