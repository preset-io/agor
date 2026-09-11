import { describe, expect, it } from 'vitest';
import {
  type AutoZoneObserverInput,
  type AutoZoneObserverLockManager,
  autoZoneObserverSignature,
  changedAutoZoneObserverIds,
  holdAutoZoneObserverLease,
} from './autoZoneObserver';

const zone = (overrides: Partial<AutoZoneObserverInput> = {}): AutoZoneObserverInput => ({
  zoneId: 'zone-b',
  width: 620,
  height: 500,
  layout: {
    mode: 'auto',
    preset: 'grid',
    sortBy: 'updated',
    sortDirection: 'desc',
    gap: 24,
    autoResizeHeight: true,
    resize: 'height',
    onOverflow: 'report',
  },
  children: [
    { id: 'child-b', x: 20, y: 220, width: 380, height: 100, sortData: ['B', 2] },
    { id: 'child-a', x: 20, y: 100, width: 500, height: 240, sortData: ['A', 1] },
  ],
  ...overrides,
});

describe('Auto Zone observer signatures', () => {
  it('normalizes grid noise and child order but detects a material size change', () => {
    const baseline = autoZoneObserverSignature(zone());
    expect(
      autoZoneObserverSignature(
        zone({
          width: 621.9,
          height: 500.2,
          children: [...zone().children].reverse().map((child) => ({
            ...child,
            x: child.x + 0.4,
            y: child.y + 0.4,
            width: child.width - 0.4,
            height: child.height - 0.4,
          })),
        })
      )
    ).toBe(baseline);

    expect(
      autoZoneObserverSignature(
        zone({
          children: zone().children.map((child) =>
            child.id === 'child-a' ? { ...child, height: child.height + 20 } : child
          ),
        })
      )
    ).not.toBe(baseline);
  });

  it('schedules only the zone whose normalized inputs changed', () => {
    const a = zone({ zoneId: 'zone-a' });
    const b = zone({ zoneId: 'zone-b' });
    const initial = changedAutoZoneObserverIds([b, a], new Map());
    expect([...initial.changedIds]).toEqual(['zone-a', 'zone-b']);

    const next = changedAutoZoneObserverIds(
      [{ ...b, children: b.children.map((child) => ({ ...child, y: child.y + 20 })) }, a],
      initial.signatures
    );
    expect([...next.changedIds]).toEqual(['zone-b']);
  });

  it('canonicalizes policy defaults and detects sorting metadata changes', () => {
    const baseline = autoZoneObserverSignature(zone({ layout: { mode: 'auto' } as never }));
    expect(
      autoZoneObserverSignature(
        zone({
          layout: {
            mode: 'auto',
            preset: 'grid',
            sortBy: 'position',
            sortDirection: 'asc',
            autoResizeHeight: false,
            resize: 'fixed',
            onOverflow: 'report',
          },
        })
      )
    ).toBe(baseline);

    expect(
      autoZoneObserverSignature(
        zone({
          layout: { mode: 'auto' } as never,
          children: zone().children.map((child) =>
            child.id === 'child-a' ? { ...child, sortData: ['A', 99] } : child
          ),
        })
      )
    ).not.toBe(baseline);
  });
});

describe('Auto Zone observer ownership', () => {
  it('holds one queued tab lease until abort, then transfers ownership', async () => {
    let tail = Promise.resolve();
    const locks: AutoZoneObserverLockManager = {
      request: async (_name, options, callback) => {
        const previous = tail;
        let release!: () => void;
        tail = new Promise<void>((resolve) => {
          release = resolve;
        });
        await previous;
        if (!options.signal.aborted) await callback();
        release();
      },
    };
    const first = new AbortController();
    const second = new AbortController();
    const events: string[] = [];
    const firstLease = holdAutoZoneObserverLease(locks, 'board-1', first.signal, (owned) =>
      events.push(`first:${owned}`)
    );
    const secondLease = holdAutoZoneObserverLease(locks, 'board-1', second.signal, (owned) =>
      events.push(`second:${owned}`)
    );

    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(['first:true']);
    first.abort();
    await firstLease;
    await Promise.resolve();
    expect(events).toEqual(['first:true', 'first:false', 'second:true']);
    second.abort();
    await secondLease;
    expect(events).toEqual(['first:true', 'first:false', 'second:true', 'second:false']);
  });
});
