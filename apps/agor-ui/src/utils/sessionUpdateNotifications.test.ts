import type { Session, SessionID } from '@agor-live/client';
import { describe, expect, it, vi } from 'vitest';
import {
  type LatestSessionUpdateRequests,
  runSessionUpdateWithLatestNotification,
} from './sessionUpdateNotifications';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

const session = (id: string) => ({ session_id: id }) as Session;

describe('runSessionUpdateWithLatestNotification', () => {
  it('notifies only for the latest out-of-order completion on one session', async () => {
    const first = deferred<Session | null>();
    const second = deferred<Session | null>();
    const updateSession = vi
      .fn<(sessionId: SessionID, updates: Partial<Session>) => Promise<Session | null>>()
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
    const first = deferred<Session | null>();
    const second = deferred<Session | null>();
    const updateSession = vi
      .fn<(sessionId: SessionID, updates: Partial<Session>) => Promise<Session | null>>()
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

    second.resolve(null);
    await retry;
    expect(showError).toHaveBeenCalledOnce();
    expect(showSuccess).not.toHaveBeenCalled();

    first.resolve(session('session-1'));
    await firstRun;
    expect(showError).toHaveBeenCalledOnce();
    expect(showSuccess).not.toHaveBeenCalled();
  });

  it('suppresses completion feedback after its authority is invalidated', async () => {
    const pending = deferred<Session | null>();
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
