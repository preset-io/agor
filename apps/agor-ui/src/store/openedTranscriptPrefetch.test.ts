import type { AgorClient } from '@agor-live/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OPENED_TRANSCRIPT_REACTIVE_OPTIONS,
  prefetchOpenedTranscript,
} from './openedTranscriptPrefetch';

const reactive = vi.hoisted(() => ({
  ready: vi.fn<() => Promise<void>>(),
  retainReactiveSession: vi.fn(),
  releaseReactiveSession: vi.fn(),
}));
vi.mock('@agor-live/client', () => ({
  retainReactiveSession: reactive.retainReactiveSession,
  releaseReactiveSession: reactive.releaseReactiveSession,
}));

const client = {} as AgorClient;
const SESSION_ID = '01a0dc28-31f3-71d9-bee6-d301b0524806';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('prefetchOpenedTranscript', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    reactive.retainReactiveSession.mockReset().mockReturnValue({ ready: reactive.ready });
    reactive.releaseReactiveSession.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('retains the same shared handle the session panel uses', () => {
    reactive.ready.mockReturnValue(new Promise(() => {}));
    prefetchOpenedTranscript(client, SESSION_ID);

    expect(reactive.retainReactiveSession).toHaveBeenCalledWith(
      client,
      SESSION_ID,
      OPENED_TRANSCRIPT_REACTIVE_OPTIONS
    );
    expect(OPENED_TRANSCRIPT_REACTIVE_OPTIONS).toEqual({ taskHydration: 'lean' });
  });

  it('is ready when the first page lands, then releases after the adoption grace', async () => {
    const page = deferred();
    reactive.ready.mockReturnValue(page.promise);
    const prefetch = prefetchOpenedTranscript(client, SESSION_ID, {
      timeoutMs: 1_000,
      adoptionGraceMs: 5_000,
    });
    const onReady = vi.fn();
    void prefetch.ready.then(onReady);

    page.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(onReady).toHaveBeenCalled();
    expect(reactive.releaseReactiveSession).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(reactive.releaseReactiveSession).toHaveBeenCalledTimes(1);
    prefetch.release();
    expect(reactive.releaseReactiveSession).toHaveBeenCalledTimes(1);
  });

  it('stops holding the workspace after the timeout even if the page never lands', async () => {
    reactive.ready.mockReturnValue(new Promise(() => {}));
    const prefetch = prefetchOpenedTranscript(client, SESSION_ID, { timeoutMs: 1_000 });
    const onReady = vi.fn();
    void prefetch.ready.then(onReady);

    await vi.advanceTimersByTimeAsync(999);
    expect(onReady).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onReady).toHaveBeenCalled();
  });

  it('treats a failed load as ready and releases early exactly once', async () => {
    reactive.ready.mockRejectedValue(new Error('denied'));
    const prefetch = prefetchOpenedTranscript(client, SESSION_ID);

    await expect(prefetch.ready).resolves.toBeUndefined();
    prefetch.release();
    prefetch.release();
    await vi.runAllTimersAsync();
    expect(reactive.releaseReactiveSession).toHaveBeenCalledTimes(1);
  });

  it('never blocks the load when the handle cannot be retained', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    reactive.retainReactiveSession.mockImplementation(() => {
      throw new Error('no socket');
    });
    const prefetch = prefetchOpenedTranscript(client, SESSION_ID);

    await expect(prefetch.ready).resolves.toBeUndefined();
    prefetch.release();
    expect(reactive.releaseReactiveSession).not.toHaveBeenCalled();
  });
});
