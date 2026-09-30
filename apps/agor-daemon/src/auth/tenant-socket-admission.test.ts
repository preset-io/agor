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

  it('marks a persistently unverifiable tenant, never on a transient skip, and a read clears it', async () => {
    const warn = warnings();
    try {
      let down = true;
      let flakyFailed = false;
      const observe = vi.fn(async (tenantId: string) => {
        if (tenantId === 'down' && down) throw new Error('unreadable');
        if (tenantId === 'flaky' && !flakyFailed) {
          flakyFailed = true;
          throw new Error('transient');
        }
      });
      const monitor = new TenantSocketRestrictionMonitor(observe, {
        timeoutMs: 20,
        unverifiableLimit: 3,
      });
      for (let sweep = 0; sweep < 2; sweep++) await monitor.check(['down', 'flaky', 'open']);
      expect(monitor.isUnverified('down')).toBe(false);
      await monitor.check(['down', 'flaky', 'open']);
      expect(monitor.isUnverified('down')).toBe(true);
      for (let sweep = 0; sweep < 5; sweep++) await monitor.check(['down', 'flaky', 'open']);
      expect(monitor.isUnverified('flaky')).toBe(false);
      expect(monitor.isUnverified('open')).toBe(false);
      down = false;
      await monitor.check(['down', 'flaky', 'open']);
      await vi.waitFor(() => expect(monitor.isUnverified('down')).toBe(false));
    } finally {
      warn.mockRestore();
    }
  });

  it('never marks a tenant whose reads are slow but succeed after the timeout', async () => {
    vi.useFakeTimers();
    const warn = warnings();
    try {
      const observe = vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, 25)));
      const monitor = new TenantSocketRestrictionMonitor(observe, {
        timeoutMs: 20,
        unverifiableLimit: 3,
      });
      for (let sweep = 0; sweep < 6; sweep++) {
        const checking = monitor.check(['slow']);
        await vi.advanceTimersByTimeAsync(20);
        await checking;
        // The next tick starts after the late read settled, as with the 1 s interval.
        await vi.advanceTimersByTimeAsync(20);
      }
      expect(observe).toHaveBeenCalledTimes(6);
      expect(monitor.isUnverified('slow')).toBe(false);
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it('never counts saturation toward the streak', async () => {
    vi.useFakeTimers();
    const warn = warnings();
    try {
      const stuck = Array.from({ length: 8 }, (_, index) => `stuck-${index}`);
      const observe = vi.fn((tenantId: string) =>
        tenantId.startsWith('stuck') ? new Promise<void>(() => undefined) : Promise.resolve()
      );
      const monitor = new TenantSocketRestrictionMonitor(observe, {
        timeoutMs: 20,
        unverifiableLimit: 3,
      });
      for (let sweep = 0; sweep < 8; sweep++) {
        const checking = monitor.check([...stuck, 'starved']);
        await vi.advanceTimersByTimeAsync(40);
        await checking;
      }
      expect(observe.mock.calls.some(([tenant]) => tenant === 'starved')).toBe(false);
      expect(monitor.isUnverified('starved')).toBe(false);
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
      const monitor = new TenantSocketRestrictionMonitor(
        async () => {
          if (down) throw new Error('unreadable');
        },
        { timeoutMs: 20, unverifiableLimit: 2 }
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
      send('before');
      expect(admit).not.toHaveBeenCalled();
      for (let sweep = 0; sweep < 2; sweep++) await monitor.check(['a']);
      const refused = send('while-down');
      await vi.waitFor(() => expect(refused).toHaveBeenCalledWith(expect.any(Forbidden)));
      expect(admit).toHaveBeenCalledOnce();
      down = false;
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
