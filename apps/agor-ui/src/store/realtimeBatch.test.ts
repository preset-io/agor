import type { Session } from '@agor-live/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bumpRevision,
  getLastAppliedRevision,
  getRevision,
  recordHydrationApply,
  resetHydrationRevisions,
} from './agorHydration';
import { sessionRemoved } from './agorRealtimeActions';
import { agorStore } from './agorStore';
import {
  captureSessionPatchCommit,
  discardRealtimeNow,
  enqueueSessionPatch,
  flushRealtimeNow,
  setRealtimeAuthorityScope,
  tombstoneSession,
  untombstoneSession,
} from './realtimeBatch';

const AUTHORITY = 'user-a:member:1';

// The keyed session-patch queue writes through the real store, so these are
// small integration tests: seed the store, drive the queue, assert the maps.

const makeSession = (overrides: Partial<Session> = {}): Session =>
  ({
    session_id: 's-1',
    branch_id: 'b-1',
    status: 'idle',
    archived: false,
    created_at: '2026-06-24T00:00:00.000Z',
    last_updated: '2026-06-24T00:00:00.000Z',
    ...overrides,
  }) as unknown as Session;

// Seed a session into both active maps (mirrors a `created` / hydrated row).
function seedSession(session: Session) {
  agorStore.getState().applyMaps((prev) => ({
    ...prev,
    sessionById: new Map(prev.sessionById).set(session.session_id, session),
    sessionsByBranch: new Map(prev.sessionsByBranch).set(session.branch_id, [session]),
  }));
}

beforeEach(() => {
  agorStore.getState().reset();
  resetHydrationRevisions();
  discardRealtimeNow();
  setRealtimeAuthorityScope(AUTHORITY);
});

afterEach(() => {
  vi.useRealTimers();
  setRealtimeAuthorityScope(null);
  discardRealtimeNow();
  agorStore.getState().reset();
  resetHydrationRevisions();
});

describe('realtimeBatch — keyed session-patch queue', () => {
  it('defers a queued patch until the queue is flushed', () => {
    seedSession(makeSession({ status: 'idle' }));

    bumpRevision('sessions');
    enqueueSessionPatch(AUTHORITY, makeSession({ status: 'running' }));
    // Not applied synchronously.
    expect(agorStore.getState().sessionById.get('s-1')).toMatchObject({ status: 'idle' });

    flushRealtimeNow(AUTHORITY);
    expect(agorStore.getState().sessionById.get('s-1')).toMatchObject({ status: 'running' });
  });

  it('coalesces a burst to the latest payload per id in ONE store write', () => {
    seedSession(makeSession({ status: 'idle' }));

    let notifies = 0;
    const unsub = agorStore.subscribe(() => {
      notifies += 1;
    });

    bumpRevision('sessions');
    enqueueSessionPatch(AUTHORITY, makeSession({ status: 'running' }));
    bumpRevision('sessions');
    enqueueSessionPatch(AUTHORITY, makeSession({ status: 'completed' }));
    bumpRevision('sessions');
    enqueueSessionPatch(
      AUTHORITY,
      makeSession({ status: 'idle', ready_for_prompt: true } as Partial<Session>)
    );

    flushRealtimeNow(AUTHORITY);
    unsub();

    // Only the latest payload lands, and the whole frame is a single notify.
    expect(agorStore.getState().sessionById.get('s-1')).toMatchObject({
      status: 'idle',
      ready_for_prompt: true,
    });
    expect(notifies).toBe(1);
  });

  it('a queued patch then a synchronous remove does not resurrect the session', () => {
    seedSession(makeSession({ status: 'running' }));

    // patched arrives (queued), then removed applies synchronously.
    bumpRevision('sessions');
    enqueueSessionPatch(AUTHORITY, makeSession({ status: 'running' }));

    tombstoneSession(AUTHORITY, 's-1');
    agorStore.getState().applyMaps((prev) => {
      const sessionById = new Map(prev.sessionById);
      sessionById.delete('s-1');
      const sessionsByBranch = new Map(prev.sessionsByBranch);
      sessionsByBranch.delete('b-1');
      return { ...prev, sessionById, sessionsByBranch };
    });

    flushRealtimeNow(AUTHORITY);

    // The tombstoned id is skipped — no resurrection in either map.
    expect(agorStore.getState().sessionById.has('s-1')).toBe(false);
    expect(agorStore.getState().sessionsByBranch.has('b-1')).toBe(false);
  });

  it('created clears a tombstone so a same-frame recreate+patch applies', () => {
    bumpRevision('sessions');
    enqueueSessionPatch(AUTHORITY, makeSession({ status: 'running' }));
    tombstoneSession(AUTHORITY, 's-1'); // remove
    untombstoneSession(AUTHORITY, 's-1'); // create clears the tombstone
    seedSession(makeSession({ status: 'running' }));
    bumpRevision('sessions');
    enqueueSessionPatch(AUTHORITY, makeSession({ status: 'completed' }));

    flushRealtimeNow(AUTHORITY);

    expect(agorStore.getState().sessionById.get('s-1')).toMatchObject({ status: 'completed' });
  });

  it('flushes via the setTimeout path when the tab is hidden (rAF paused)', () => {
    vi.useFakeTimers();
    // jsdom's `visibilityState` lives on Document.prototype; shadow it with an
    // own accessor and delete it after to fall back to the real getter.
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    try {
      seedSession(makeSession({ status: 'idle' }));

      bumpRevision('sessions');
      enqueueSessionPatch(AUTHORITY, makeSession({ status: 'running' }));
      // rAF would pause in a hidden tab; nothing applied yet.
      expect(agorStore.getState().sessionById.get('s-1')).toMatchObject({ status: 'idle' });

      vi.runOnlyPendingTimers();
      expect(agorStore.getState().sessionById.get('s-1')).toMatchObject({ status: 'running' });
    } finally {
      delete (document as { visibilityState?: unknown }).visibilityState;
    }
  });

  it('drops a queued patch subsumed by a later hydration apply', () => {
    seedSession(makeSession({ status: 'idle' }));

    // A patch is enqueued (stamped with the current revision)...
    bumpRevision('sessions');
    enqueueSessionPatch(AUTHORITY, makeSession({ status: 'running' }));

    // ...then a hydration applies a fresher snapshot proven quiet at-or-after
    // that revision. The queued patch is now stale.
    recordHydrationApply(['sessions'], [1]);

    flushRealtimeNow(AUTHORITY);

    // The stale patch is dropped — the hydrated (idle) state stands.
    expect(agorStore.getState().sessionById.get('s-1')).toMatchObject({ status: 'idle' });
  });

  it('discardRealtimeNow drops the pending queue without applying', () => {
    seedSession(makeSession({ status: 'idle' }));

    bumpRevision('sessions');
    enqueueSessionPatch(AUTHORITY, makeSession({ status: 'running' }));

    discardRealtimeNow();
    flushRealtimeNow(AUTHORITY); // nothing left to apply

    expect(agorStore.getState().sessionById.get('s-1')).toMatchObject({ status: 'idle' });
  });

  it('flushRealtimeNow is a no-op when the queue is empty', () => {
    expect(() => flushRealtimeNow(AUTHORITY)).not.toThrow();
  });

  it('discards the previous authority queue and makes its delayed cleanup a no-op', () => {
    seedSession(makeSession({ status: 'idle' }));
    bumpRevision('sessions');
    enqueueSessionPatch(AUTHORITY, makeSession({ status: 'running' }));

    const replacementAuthority = 'user-b:admin:2';
    setRealtimeAuthorityScope(replacementAuthority);
    agorStore.getState().resetMaps();

    // This is the old subscription's passive cleanup. It must neither apply A's
    // payload nor cancel/flush any work that B queues before its own cleanup.
    flushRealtimeNow(AUTHORITY);
    bumpRevision('sessions');
    enqueueSessionPatch(
      replacementAuthority,
      makeSession({ session_id: 's-b' as Session['session_id'], status: 'completed' })
    );
    flushRealtimeNow(AUTHORITY);

    expect(agorStore.getState().sessionById.has('s-1')).toBe(false);
    expect(agorStore.getState().sessionById.has('s-b')).toBe(false);

    flushRealtimeNow(replacementAuthority);
    expect(agorStore.getState().sessionById.get('s-b')).toMatchObject({ status: 'completed' });
  });
});

describe('confirmed mutation patches', () => {
  it('rereads returned IDs, commits once, drains older queued state and invalidates hydration', async () => {
    const root = makeSession();
    const child = makeSession({ session_id: 'child' as Session['session_id'] });
    seedSession(root);
    seedSession(child);
    const commit = captureSessionPatchCommit();
    bumpRevision('sessions');
    enqueueSessionPatch(AUTHORITY, child);
    const revisionBefore = getRevision('sessions');
    const notified = vi.fn();
    const unsubscribe = agorStore.subscribe(notified);
    const archived = [root, child].map((session) => ({ ...session, archived: true }));
    const refetch = vi.fn(async (id) => archived.find((row) => row.session_id === id)!);
    await commit(archived, refetch);
    expect(refetch).toHaveBeenCalledWith(root.session_id);
    expect(refetch).toHaveBeenCalledWith(child.session_id);
    expect(getRevision('sessions')).toBeGreaterThan(revisionBefore);
    expect(notified).toHaveBeenCalledTimes(1);
    expect(agorStore.getState().sessionById.size).toBe(0);
    expect(agorStore.getState().sessionsByBranch.size).toBe(0);
    flushRealtimeNow(AUTHORITY);
    expect(notified).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('does not reread or apply a response captured with no authority', async () => {
    setRealtimeAuthorityScope(null);
    const commit = captureSessionPatchCommit();
    setRealtimeAuthorityScope(AUTHORITY);
    seedSession(makeSession());
    const refetch = vi.fn();
    await commit([makeSession({ archived: true })], refetch);
    expect(refetch).not.toHaveBeenCalled();
    expect(agorStore.getState().sessionById.has('s-1')).toBe(true);
  });

  it.each(['queued', 'applied', 'hydrated'] as const)(
    'preserves a newer %s restore against an older archive response regardless of timestamps',
    async (delivery) => {
      seedSession(makeSession());
      const commit = captureSessionPatchCommit();
      const restored = makeSession({ title: 'Restored', branch_id: 'b-2' as Session['branch_id'] });
      bumpRevision('sessions');
      enqueueSessionPatch(AUTHORITY, restored);
      if (delivery === 'applied') flushRealtimeNow(AUTHORITY);
      if (delivery === 'hydrated') {
        agorStore.getState().resetMaps();
        seedSession(restored);
        recordHydrationApply(['sessions'], [getRevision('sessions')]);
      }
      // An old response can even carry a larger timestamp than the restore.
      await commit(
        [makeSession({ archived: true, last_updated: '2026-06-25T00:00:00.000Z' })],
        async () => restored
      );
      flushRealtimeNow(AUTHORITY);
      expect(agorStore.getState().sessionById.get('s-1')).toEqual(restored);
      expect(agorStore.getState().sessionsByBranch.has('b-1')).toBe(false);
      expect(agorStore.getState().sessionsByBranch.get('b-2')).toEqual([restored]);
    }
  );

  it.each(['event', 'hydration', 'confirmation'] as const)(
    'retries a read raced by %s, never applying its stale snapshot',
    async (race) => {
      const initial = makeSession();
      const archived = { ...initial, archived: true };
      const restored: Session = { ...initial, title: 'Restored' };
      seedSession(initial);
      const commit = captureSessionPatchCommit();
      const refetch = vi
        .fn(async () => restored)
        .mockImplementationOnce(async () => {
          if (race === 'event') {
            bumpRevision('sessions');
            enqueueSessionPatch(AUTHORITY, restored);
          } else if (race === 'hydration') {
            seedSession(restored);
            recordHydrationApply(['sessions'], [getRevision('sessions')]);
          } else {
            await captureSessionPatchCommit()([restored], async () => restored);
          }
          return archived;
        });
      await commit([archived], refetch);
      expect(refetch).toHaveBeenCalledTimes(2);
      expect(agorStore.getState().sessionById.get('s-1')).toEqual(restored);
    }
  );

  it.each([false, true])(
    'does not resurrect a removed row after tombstone flush=%s',
    async (flushed) => {
      const session = makeSession();
      seedSession(session);
      const commit = captureSessionPatchCommit();
      tombstoneSession(AUTHORITY, session.session_id);
      sessionRemoved(session);
      if (flushed) flushRealtimeNow(AUTHORITY);
      const refetch = vi.fn(async () => session);
      await commit([session], refetch);
      flushRealtimeNow(AUTHORITY);
      expect(refetch).not.toHaveBeenCalled();
      expect(agorStore.getState().sessionById.size).toBe(0);
      expect(agorStore.getState().sessionsByBranch.size).toBe(0);
    }
  );

  it('does not freshen a queued row subsumed by hydration that removed it', async () => {
    const session = makeSession();
    seedSession(session);
    const commit = captureSessionPatchCommit();
    bumpRevision('sessions');
    enqueueSessionPatch(AUTHORITY, session);
    agorStore.getState().resetMaps();
    recordHydrationApply(['sessions'], [getRevision('sessions')]);
    const refetch = vi.fn();
    await commit([session], refetch);
    expect(refetch).not.toHaveBeenCalled();
    expect(agorStore.getState().sessionById.size).toBe(0);
  });

  it('does not resurrect a queued-only row when an unchanged empty hydration lands during the read', async () => {
    const session = makeSession();
    bumpRevision('sessions');
    enqueueSessionPatch(AUTHORITY, session);
    const refetch = vi.fn(async () => {
      // A quiet empty snapshot subsumes this queued event without replacing
      // either map reference (buildSessionMaps preserves equal maps).
      recordHydrationApply(['sessions'], [getRevision('sessions')]);
      return session;
    });
    await captureSessionPatchCommit()([session], refetch);
    flushRealtimeNow(AUTHORITY);
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(agorStore.getState().sessionById.size).toBe(0);
  });

  it.each([false, true])(
    'backs off repeated races and stops on authority cancellation=%s',
    async (cancel) => {
      vi.useFakeTimers();
      const session = makeSession();
      seedSession(session);
      let calls = 0;
      const refetch = vi.fn(async () => {
        if (++calls <= 5) bumpRevision('sessions');
        return { ...session, archived: true };
      });
      const request = captureSessionPatchCommit()([session], refetch);
      await vi.advanceTimersByTimeAsync(0);
      expect(refetch).toHaveBeenCalledTimes(4);
      if (cancel) setRealtimeAuthorityScope('tenant-b:user-b:2');
      await vi.advanceTimersByTimeAsync(200);
      expect(refetch).toHaveBeenCalledTimes(cancel ? 4 : 5);
      await vi.advanceTimersByTimeAsync(400);
      await request;
      expect(refetch).toHaveBeenCalledTimes(cancel ? 4 : 6);
      expect(agorStore.getState().sessionById.has(session.session_id)).toBe(cancel);
    }
  );

  it('terminates sustained unrelated streaming without applying any raced archive snapshot', async () => {
    vi.useFakeTimers();
    const session = makeSession();
    const unrelated = makeSession({ session_id: 'streaming' as Session['session_id'] });
    seedSession(session);
    const refetch = vi.fn(async () => {
      bumpRevision('sessions');
      enqueueSessionPatch(AUTHORITY, unrelated);
      flushRealtimeNow(AUTHORITY);
      return { ...session, archived: true };
    });
    const request = captureSessionPatchCommit()([session], refetch);
    const exhausted = expect(request).rejects.toThrow('attempts exhausted');
    await vi.runAllTimersAsync();
    await exhausted;
    expect(refetch).toHaveBeenCalledTimes(6);
    expect(agorStore.getState().sessionById.get(session.session_id)).toEqual(session);
    expect(agorStore.getState().sessionById.get(unrelated.session_id)).toEqual(unrelated);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refetch).toHaveBeenCalledTimes(6);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('hands slots to a small overlapping confirmation before a large one drains', async () => {
    vi.useFakeTimers();
    const rows = Array.from({ length: 45 }, (_, index) =>
      makeSession({ session_id: `row-${index}` as Session['session_id'] })
    );
    rows.forEach(seedSession);
    let active = 0;
    let peak = 0;
    const refetch = vi.fn(async (id: Session['session_id']) => {
      peak = Math.max(peak, ++active);
      await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
      active--;
      return { ...rows.find((row) => row.session_id === id)!, archived: true };
    });
    const large = captureSessionPatchCommit()(rows.slice(0, 44), refetch);
    const small = captureSessionPatchCommit()([rows[44]], refetch);
    // Attach rejection handling immediately, including on the broken limiter.
    const settled = Promise.allSettled([large, small]);
    await vi.advanceTimersByTimeAsync(2_000);
    const mapsAtTwoSeconds = agorStore.getState().sessionById;
    const callsAtTwoSeconds = refetch.mock.calls.length;

    await vi.advanceTimersByTimeAsync(8_000);
    const callsAtDeadline = refetch.mock.calls.length;
    await vi.runAllTimersAsync();
    expect(await settled).toEqual([
      { status: 'rejected', reason: new Error('Session confirmation budget exhausted') },
      { status: 'fulfilled', value: undefined },
    ]);
    expect(mapsAtTwoSeconds.has(rows[44].session_id)).toBe(false);
    expect(mapsAtTwoSeconds.size).toBe(44);
    expect(callsAtTwoSeconds).toBeLessThan(44);
    expect(refetch).toHaveBeenCalledTimes(callsAtDeadline);
    // B's apply raced A's snapshot; A must never apply its partial result.
    expect(agorStore.getState().sessionById.size).toBe(44);
    expect(peak).toBe(4);
    expect(active).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('caps GET concurrency across overlapping large confirmations', async () => {
    vi.useFakeTimers();
    const rows = Array.from({ length: 12 }, (_, index) =>
      makeSession({
        session_id: `row-${index}` as Session['session_id'],
      })
    );
    rows.forEach(seedSession);
    let active = 0;
    let peak = 0;
    const refetch = vi.fn(async (id: Session['session_id']) => {
      peak = Math.max(peak, ++active);
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      active--;
      return { ...rows.find((row) => row.session_id === id)!, archived: true };
    });
    const first = captureSessionPatchCommit()(rows.slice(0, 6), refetch);
    const second = captureSessionPatchCommit()(rows.slice(6), refetch);
    expect(refetch).toHaveBeenCalledTimes(4);
    await vi.runAllTimersAsync();
    await Promise.all([first, second]);
    expect(peak).toBe(4);
    expect(active).toBe(0);
    expect(agorStore.getState().sessionById.size).toBe(0);
    expect(agorStore.getState().sessionsByBranch.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['deadline', 'authority'] as const)(
    'stops hung workers and queued work on %s, including late transport settlement',
    async (reason) => {
      vi.useFakeTimers();
      const rows = Array.from({ length: 12 }, (_, index) =>
        makeSession({
          session_id: `row-${index}` as Session['session_id'],
        })
      );
      rows.forEach(seedSession);
      const originalMaps = agorStore.getState().sessionById;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const refetch = vi.fn(async (id: Session['session_id']) => {
        await gate;
        return { ...rows.find((row) => row.session_id === id)!, archived: true };
      });
      const first = captureSessionPatchCommit()(rows, refetch);
      // All of this invocation's workers must wait for shared slots.
      const second = captureSessionPatchCommit()(rows, refetch);
      const settled = Promise.allSettled([first, second]);
      expect(refetch).toHaveBeenCalledTimes(4);
      if (reason === 'authority') {
        setRealtimeAuthorityScope('tenant-b:user-b:2');
        // Returning to the old scope must not revive old reads (ABA).
        setRealtimeAuthorityScope(AUTHORITY);
      } else {
        await vi.advanceTimersByTimeAsync(10_000);
      }
      const results = await settled; // No transport response is required to terminate.
      expect(results.map((result) => result.status)).toEqual(
        reason === 'authority' ? ['fulfilled', 'fulfilled'] : ['rejected', 'rejected']
      );
      expect(refetch).toHaveBeenCalledTimes(4);
      // A new live invocation must still wait for the cancelled transports,
      // then receive a slot without launching any of the cancelled waiters.
      let releaseCurrent!: (session: Session) => void;
      const currentRefetch = vi.fn(
        () =>
          new Promise<Session>((resolve) => {
            releaseCurrent = resolve;
          })
      );
      const current = captureSessionPatchCommit()([rows[0]], currentRefetch);
      await vi.advanceTimersByTimeAsync(0);
      expect(currentRefetch).not.toHaveBeenCalled();
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(refetch).toHaveBeenCalledTimes(4);
      expect(currentRefetch).toHaveBeenCalledTimes(1);
      expect(agorStore.getState().sessionById).toBe(originalMaps);
      releaseCurrent({ ...rows[0], archived: true });
      await current;
      expect(agorStore.getState().sessionById.has(rows[0].session_id)).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it('does not discard unrelated queued patches or advance the full hydration watermark', async () => {
    const session = makeSession();
    seedSession(session);
    const unrelated = makeSession({ session_id: 'unrelated' as Session['session_id'] });
    bumpRevision('sessions');
    enqueueSessionPatch(AUTHORITY, unrelated);
    const watermark = getLastAppliedRevision('sessions');
    await captureSessionPatchCommit()([session], async () => ({ ...session, archived: true }));
    expect(getLastAppliedRevision('sessions')).toBe(watermark);
    expect(agorStore.getState().sessionById.get(unrelated.session_id)).toEqual(unrelated);
    expect(agorStore.getState().sessionById.has(session.session_id)).toBe(false);
  });

  it.each(['resolve', 'reject'] as const)(
    'ignores a refetch that %s after authority replacement',
    async (outcome) => {
      const session = makeSession();
      seedSession(session);
      const refetch = vi.fn(async () => {
        setRealtimeAuthorityScope('tenant-b:user-b:2');
        if (outcome === 'reject') throw new Error('old authority failed');
        return { ...session, archived: true };
      });
      await captureSessionPatchCommit()([session], refetch);
      expect(refetch).toHaveBeenCalledTimes(1);
      expect(agorStore.getState().sessionById.get(session.session_id)).toEqual(session);
    }
  );

  it('applies no mutation payload when refetch fails', async () => {
    const session = makeSession();
    seedSession(session);
    await expect(
      captureSessionPatchCommit()([{ ...session, archived: true }], async () => {
        throw new Error('Offline');
      })
    ).rejects.toThrow('Offline');
    expect(agorStore.getState().sessionById.get(session.session_id)).toEqual(session);
  });
});
