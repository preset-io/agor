import type { Session } from '@agor-live/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bumpRevision, recordHydrationApply, resetHydrationRevisions } from './agorHydration';
import { agorStore } from './agorStore';
import {
  discardRealtimeNow,
  enqueueSessionPatch,
  flushRealtimeNow,
  tombstoneSession,
  untombstoneSession,
} from './realtimeBatch';

// The keyed session-patch queue writes through the real store, so these are
// small integration tests: seed the store, drive the queue, assert the maps.

const makeSession = (overrides: Partial<Session> = {}): Session =>
  ({
    session_id: 's-1',
    branch_id: 'b-1',
    status: 'idle',
    archived: false,
    created_at: '2026-06-24T00:00:00.000Z',
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
});

afterEach(() => {
  vi.useRealTimers();
  discardRealtimeNow();
  agorStore.getState().reset();
  resetHydrationRevisions();
});

describe('realtimeBatch — keyed session-patch queue', () => {
  it('defers a queued patch until the queue is flushed', () => {
    seedSession(makeSession({ status: 'idle' }));

    bumpRevision('sessions');
    enqueueSessionPatch(makeSession({ status: 'running' }));
    // Not applied synchronously.
    expect(agorStore.getState().sessionById.get('s-1')).toMatchObject({ status: 'idle' });

    flushRealtimeNow();
    expect(agorStore.getState().sessionById.get('s-1')).toMatchObject({ status: 'running' });
  });

  it('coalesces a burst to the latest payload per id in ONE store write', () => {
    seedSession(makeSession({ status: 'idle' }));

    let notifies = 0;
    const unsub = agorStore.subscribe(() => {
      notifies += 1;
    });

    bumpRevision('sessions');
    enqueueSessionPatch(makeSession({ status: 'running' }));
    bumpRevision('sessions');
    enqueueSessionPatch(makeSession({ status: 'thinking' }));
    bumpRevision('sessions');
    enqueueSessionPatch(
      makeSession({ status: 'idle', ready_for_prompt: true } as Partial<Session>)
    );

    flushRealtimeNow();
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
    enqueueSessionPatch(makeSession({ status: 'running' }));

    tombstoneSession('s-1');
    agorStore.getState().applyMaps((prev) => {
      const sessionById = new Map(prev.sessionById);
      sessionById.delete('s-1');
      const sessionsByBranch = new Map(prev.sessionsByBranch);
      sessionsByBranch.delete('b-1');
      return { ...prev, sessionById, sessionsByBranch };
    });

    flushRealtimeNow();

    // The tombstoned id is skipped — no resurrection in either map.
    expect(agorStore.getState().sessionById.has('s-1')).toBe(false);
    expect(agorStore.getState().sessionsByBranch.has('b-1')).toBe(false);
  });

  it('created clears a tombstone so a same-frame recreate+patch applies', () => {
    bumpRevision('sessions');
    enqueueSessionPatch(makeSession({ status: 'running' }));
    tombstoneSession('s-1'); // remove
    untombstoneSession('s-1'); // create clears the tombstone
    seedSession(makeSession({ status: 'running' }));
    bumpRevision('sessions');
    enqueueSessionPatch(makeSession({ status: 'thinking' }));

    flushRealtimeNow();

    expect(agorStore.getState().sessionById.get('s-1')).toMatchObject({ status: 'thinking' });
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
      enqueueSessionPatch(makeSession({ status: 'running' }));
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
    enqueueSessionPatch(makeSession({ status: 'running' }));

    // ...then a hydration applies a fresher snapshot proven quiet at-or-after
    // that revision. The queued patch is now stale.
    recordHydrationApply(['sessions'], [1]);

    flushRealtimeNow();

    // The stale patch is dropped — the hydrated (idle) state stands.
    expect(agorStore.getState().sessionById.get('s-1')).toMatchObject({ status: 'idle' });
  });

  it('discardRealtimeNow drops the pending queue without applying', () => {
    seedSession(makeSession({ status: 'idle' }));

    bumpRevision('sessions');
    enqueueSessionPatch(makeSession({ status: 'running' }));

    discardRealtimeNow();
    flushRealtimeNow(); // nothing left to apply

    expect(agorStore.getState().sessionById.get('s-1')).toMatchObject({ status: 'idle' });
  });

  it('flushRealtimeNow is a no-op when the queue is empty', () => {
    expect(() => flushRealtimeNow()).not.toThrow();
  });
});
