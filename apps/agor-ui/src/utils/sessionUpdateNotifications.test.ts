import type { Session, SessionID } from '@agor-live/client';
import { describe, expect, it, vi } from 'vitest';
import {
  type LatestSessionUpdateRequests,
  runSessionUpdateWithLatestNotification,
} from './sessionUpdateNotifications';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

const session = (id: string) => ({ session_id: id }) as Session;

describe('runSessionUpdateWithLatestNotification', () => {
  it('notifies only for the latest out-of-order completion on one session', async () => {
    const first = deferred<Session>();
    const second = deferred<Session>();
    const updateSession = vi
      .fn<(sessionId: SessionID, updates: Partial<Session>) => Promise<Session>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const latestRequests: LatestSessionUpdateRequests = new Map();
    const showSuccess = vi.fn();
    const showError = vi.fn();
    const authority = { isCurrent: () => true };
    const options = { latestRequests, authority, updateSession, showSuccess, showError };

    const firstRun = runSessionUpdateWithLatestNotification({
      ...options,
      sessionId: 'session-1' as SessionID,
      updates: { title: 'first' },
    });
    const secondRun = runSessionUpdateWithLatestNotification({
      ...options,
      sessionId: 'session-1' as SessionID,
      updates: { title: 'second' },
    });

    second.resolve(session('session-1'));
    await secondRun;
    expect(showSuccess).toHaveBeenCalledOnce();
    expect(showError).not.toHaveBeenCalled();

    first.resolve(session('session-1'));
    await firstRun;
    expect(showSuccess).toHaveBeenCalledOnce();
    expect(showError).not.toHaveBeenCalled();
  });

  it('reports only the latest failure and ignores a superseded success', async () => {
    const first = deferred<Session>();
    const second = deferred<Session>();
    const updateSession = vi
      .fn<(sessionId: SessionID, updates: Partial<Session>) => Promise<Session>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const latestRequests: LatestSessionUpdateRequests = new Map();
    const showSuccess = vi.fn();
    const showError = vi.fn();
    const authority = { isCurrent: () => true };
    const options = { latestRequests, authority, updateSession, showSuccess, showError };

    const firstRun = runSessionUpdateWithLatestNotification({
      ...options,
      sessionId: 'session-1' as SessionID,
      updates: { title: 'first' },
    });
    const retry = runSessionUpdateWithLatestNotification({
      ...options,
      sessionId: 'session-1' as SessionID,
      updates: { title: 'retry' },
    });

    second.reject(new Error('Permission denied'));

    await retry;
    expect(showError).toHaveBeenCalledExactlyOnceWith(
      "Couldn't update the session. (Permission denied)"
    );
    expect(showSuccess).not.toHaveBeenCalled();

    first.resolve(session('session-1'));
    await firstRun;
    expect(showError).toHaveBeenCalledExactlyOnceWith(
      "Couldn't update the session. (Permission denied)"
    );
    expect(showSuccess).not.toHaveBeenCalled();
  });

  it('suppresses completion feedback after its authority is invalidated', async () => {
    const pending = deferred<Session>();
    let current = true;
    const showSuccess = vi.fn();
    const showError = vi.fn();
    const run = runSessionUpdateWithLatestNotification({
      sessionId: 'session-1' as SessionID,
      updates: { title: 'obsolete' },
      latestRequests: new Map(),
      authority: { isCurrent: () => current },
      updateSession: vi.fn(() => pending.promise),
      showSuccess,
      showError,
    });

    current = false;
    pending.resolve(session('session-1'));
    await run;

    expect(showSuccess).not.toHaveBeenCalled();
    expect(showError).not.toHaveBeenCalled();
  });

  it('keeps concurrent notifications for different sessions independent', async () => {
    const updateSession = vi.fn(async (sessionId: SessionID) => session(sessionId));
    const showSuccess = vi.fn();
    const showError = vi.fn();
    const latestRequests: LatestSessionUpdateRequests = new Map();
    const authority = { isCurrent: () => true };

    await Promise.all([
      runSessionUpdateWithLatestNotification({
        sessionId: 'session-1' as SessionID,
        updates: { title: 'one' },
        latestRequests,
        authority,
        updateSession,
        showSuccess,
        showError,
      }),
      runSessionUpdateWithLatestNotification({
        sessionId: 'session-2' as SessionID,
        updates: { title: 'two' },
        latestRequests,
        authority,
        updateSession,
        showSuccess,
        showError,
      }),
    ]);

    expect(updateSession).toHaveBeenCalledTimes(2);
    expect(showSuccess).toHaveBeenCalledTimes(2);
    expect(showError).not.toHaveBeenCalled();
  });

  it.each(['authority-change', 'newer-request'] as const)(
    'does not expose a stale rejection after %s',
    async (invalidatedBy) => {
      const pending = deferred<Session>();
      let current = true;
      const latestRequests: LatestSessionUpdateRequests = new Map();
      const showSuccess = vi.fn();
      const showError = vi.fn();
      const options = {
        sessionId: 'session-1' as SessionID,
        updates: { title: 'obsolete' },
        latestRequests,
        authority: { isCurrent: () => current },
        showSuccess,
        showError,
      };
      const run = runSessionUpdateWithLatestNotification({
        ...options,
        updateSession: () => pending.promise,
      });
      if (invalidatedBy === 'authority-change') current = false;
      else {
        await runSessionUpdateWithLatestNotification({
          ...options,
          updateSession: async () => session('session-1'),
        });
      }

      pending.reject(new Error('Previous authority private error'));
      await expect(run).resolves.toBeUndefined();
      expect(showError).not.toHaveBeenCalled();
      expect(showSuccess).toHaveBeenCalledTimes(invalidatedBy === 'newer-request' ? 1 : 0);
    }
  );

  it('does not dispatch an update for obsolete authority', async () => {
    const updateSession = vi.fn();
    const latestRequests: LatestSessionUpdateRequests = new Map();
    await runSessionUpdateWithLatestNotification({
      sessionId: 'session-1' as SessionID,
      updates: { title: 'obsolete' },
      latestRequests,
      authority: { isCurrent: () => false },
      updateSession,
      showSuccess: vi.fn(),
      showError: vi.fn(),
    });
    expect(updateSession).not.toHaveBeenCalled();
    expect(latestRequests.size).toBe(0);
  });

  it('keeps separate tab-local request fences independent for the same session', async () => {
    const updateSession = vi.fn(async (sessionId: SessionID) => session(sessionId));
    const showSuccess = vi.fn();
    const showError = vi.fn();
    const authority = { isCurrent: () => true };
    const shared = {
      sessionId: 'session-1' as SessionID,
      updates: { title: 'tab action' },
      authority,
      updateSession,
      showSuccess,
      showError,
    };

    await Promise.all([
      runSessionUpdateWithLatestNotification({ ...shared, latestRequests: new Map() }),
      runSessionUpdateWithLatestNotification({ ...shared, latestRequests: new Map() }),
    ]);

    expect(updateSession).toHaveBeenCalledTimes(2);
    expect(showSuccess).toHaveBeenCalledTimes(2);
    expect(showError).not.toHaveBeenCalled();
  });
});
