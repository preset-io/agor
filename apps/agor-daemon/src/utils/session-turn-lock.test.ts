/**
 * Behavior tests for the per-session "turn" lock that gates idle → running
 * transitions across `/sessions/:id/prompt`, `/tasks/:id/run`, and the queue
 * processor. Pins the mutual-exclusion contract relied on by all three.
 */
import type { SessionID } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import { type SessionTurnLocks, withSessionTurnLock } from './session-turn-lock';

const SID = (s: string) => s as SessionID;

describe('withSessionTurnLock', () => {
  it('runs fn and releases the lock on success', async () => {
    const locks: SessionTurnLocks = new Map();
    const result = await withSessionTurnLock(locks, SID('s1'), async () => 'ok');
    expect(result).toBe('ok');
    expect(locks.size).toBe(0);
  });

  it('releases the lock when fn throws', async () => {
    const locks: SessionTurnLocks = new Map();
    await expect(
      withSessionTurnLock(locks, SID('s1'), async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    expect(locks.size).toBe(0);
  });

  it('serializes concurrent callers on the same session', async () => {
    const locks: SessionTurnLocks = new Map();
    const order: string[] = [];

    let releaseFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      withSessionTurnLock(locks, SID('s1'), async () => {
        order.push('first-start');
        resolve();
        await new Promise<void>((r) => {
          releaseFirst = r;
        });
        order.push('first-end');
      });
    });

    await firstStarted;

    // Second call should wait until first releases.
    const secondPromise = withSessionTurnLock(locks, SID('s1'), async () => {
      order.push('second');
    });

    // Give the event loop a tick — second must NOT have run yet.
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['first-start']);

    releaseFirst();
    await secondPromise;

    expect(order).toEqual(['first-start', 'first-end', 'second']);
    expect(locks.size).toBe(0);
  });

  it('does not block independent sessions', async () => {
    const locks: SessionTurnLocks = new Map();
    const order: string[] = [];

    let releaseS1!: () => void;
    const s1Started = new Promise<void>((resolve) => {
      withSessionTurnLock(locks, SID('s1'), async () => {
        order.push('s1-start');
        resolve();
        await new Promise<void>((r) => {
          releaseS1 = r;
        });
        order.push('s1-end');
      });
    });

    await s1Started;

    // s2 should run immediately even though s1 is locked.
    await withSessionTurnLock(locks, SID('s2'), async () => {
      order.push('s2');
    });

    expect(order).toEqual(['s1-start', 's2']);
    releaseS1();

    // Wait for s1 to finish so the test doesn't leak a pending lock.
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(locks.size).toBe(0);
  });

  it('chains correctly when a third waiter arrives during the second', async () => {
    const locks: SessionTurnLocks = new Map();
    const order: string[] = [];

    let releaseFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      withSessionTurnLock(locks, SID('s1'), async () => {
        order.push('first-start');
        resolve();
        await new Promise<void>((r) => {
          releaseFirst = r;
        });
        order.push('first-end');
      });
    });

    await firstStarted;

    // Second waiter.
    let releaseSecond!: () => void;
    const secondPromise = withSessionTurnLock(locks, SID('s1'), async () => {
      order.push('second-start');
      await new Promise<void>((r) => {
        releaseSecond = r;
      });
      order.push('second-end');
    });

    // Yield once so the second waiter's await hooks into first's promise
    // before the third arrives.
    await Promise.resolve();

    // Third waiter — must run after second.
    const thirdPromise = withSessionTurnLock(locks, SID('s1'), async () => {
      order.push('third');
    });

    releaseFirst();
    // Yield to let second start before releasing it.
    await new Promise<void>((r) => setTimeout(r, 0));
    releaseSecond();

    await secondPromise;
    await thirdPromise;

    expect(order).toEqual(['first-start', 'first-end', 'second-start', 'second-end', 'third']);
    expect(locks.size).toBe(0);
  });
});
