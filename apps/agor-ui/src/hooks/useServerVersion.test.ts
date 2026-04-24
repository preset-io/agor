import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEV_SHA, isOutOfSync, useServerVersion } from './useServerVersion';

describe('isOutOfSync', () => {
  it('returns false when either SHA is missing (unknown is never out-of-sync)', () => {
    expect(isOutOfSync(null, 'abc')).toBe(false);
    expect(isOutOfSync('abc', null)).toBe(false);
    expect(isOutOfSync(undefined, 'abc')).toBe(false);
    expect(isOutOfSync('abc', undefined)).toBe(false);
    expect(isOutOfSync('', 'abc')).toBe(false);
    expect(isOutOfSync('abc', '')).toBe(false);
  });

  it('returns false when either SHA is the dev sentinel', () => {
    expect(isOutOfSync(DEV_SHA, 'abc1234')).toBe(false);
    expect(isOutOfSync('abc1234', DEV_SHA)).toBe(false);
    expect(isOutOfSync(DEV_SHA, DEV_SHA)).toBe(false);
  });

  it('returns false when SHAs match', () => {
    expect(isOutOfSync('abc1234', 'abc1234')).toBe(false);
  });

  it('returns true ONLY when both SHAs are concrete and disagree', () => {
    expect(isOutOfSync('abc1234', 'def5678')).toBe(true);
  });
});

/**
 * Mock io client just enough to drive the `server-info` listener. The hook
 * only touches `client.io.on` / `client.io.off`, so we don't need socket.io.
 */
function makeMockClient() {
  const listeners = new Map<string, Array<(arg: unknown) => void>>();
  return {
    io: {
      on: vi.fn((event: string, fn: (arg: unknown) => void) => {
        const arr = listeners.get(event) ?? [];
        arr.push(fn);
        listeners.set(event, arr);
      }),
      off: vi.fn((event: string, fn: (arg: unknown) => void) => {
        const arr = listeners.get(event) ?? [];
        listeners.set(
          event,
          arr.filter((f) => f !== fn)
        );
      }),
      emit: (event: string, payload: unknown) => {
        for (const fn of listeners.get(event) ?? []) fn(payload);
      },
    },
  };
}

const TEST_URL = 'http://daemon.test:3030';

/**
 * Mock fetch with a resolvable promise. Returns a `respond` function the test
 * uses to deliver the /health body, plus a `reject` to simulate an unreachable
 * daemon. Tests that don't care about the fetch path can leave it pending.
 */
function mockFetch() {
  let resolve!: (value: unknown) => void;
  let reject!: (err: unknown) => void;
  const fetchSpy = vi.fn(
    () =>
      new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      })
  );
  vi.stubGlobal('fetch', fetchSpy);
  return {
    fetchSpy,
    respond: (body: { buildSha?: string }) =>
      resolve({ ok: true, json: () => Promise.resolve(body) }),
    fail: () => reject(new Error('fetch failed')),
  };
}

describe('useServerVersion', () => {
  beforeEach(() => {
    mockFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('captures the first SHA on welcome event and stays stable across reconnects', () => {
    const client = makeMockClient();
    const { result } = renderHook(() => useServerVersion(client as never, TEST_URL));

    expect(result.current.capturedSha).toBeNull();
    expect(result.current.outOfSync).toBe(false);

    act(() => client.io.emit('server-info', { buildSha: 'abc1234' }));
    expect(result.current.capturedSha).toBe('abc1234');
    expect(result.current.currentSha).toBe('abc1234');
    expect(result.current.outOfSync).toBe(false);

    // Reconnect with same SHA — capture stays put, no banner.
    act(() => client.io.emit('server-info', { buildSha: 'abc1234' }));
    expect(result.current.capturedSha).toBe('abc1234');
    expect(result.current.outOfSync).toBe(false);
  });

  it('flips outOfSync true when a later handshake reports a different SHA', () => {
    const client = makeMockClient();
    const { result } = renderHook(() => useServerVersion(client as never, TEST_URL));

    act(() => client.io.emit('server-info', { buildSha: 'abc1234' }));
    expect(result.current.outOfSync).toBe(false);

    act(() => client.io.emit('server-info', { buildSha: 'def5678' }));
    expect(result.current.capturedSha).toBe('abc1234'); // baseline unchanged
    expect(result.current.currentSha).toBe('def5678');
    expect(result.current.outOfSync).toBe(true);
  });

  it('ignores welcome events without a buildSha', () => {
    const client = makeMockClient();
    const { result } = renderHook(() => useServerVersion(client as never, TEST_URL));

    act(() => client.io.emit('server-info', {}));
    act(() => client.io.emit('server-info', { buildSha: undefined }));
    expect(result.current.capturedSha).toBeNull();
    expect(result.current.outOfSync).toBe(false);
  });

  it('disables comparison when either side is the dev sentinel', () => {
    const client = makeMockClient();
    const { result } = renderHook(() => useServerVersion(client as never, TEST_URL));

    act(() => client.io.emit('server-info', { buildSha: 'dev' }));
    act(() => client.io.emit('server-info', { buildSha: 'abc1234' }));
    // Captured was 'dev' → comparison short-circuits to false.
    expect(result.current.outOfSync).toBe(false);
  });

  it('unsubscribes on unmount', () => {
    const client = makeMockClient();
    const { unmount } = renderHook(() => useServerVersion(client as never, TEST_URL));
    unmount();
    expect(client.io.off).toHaveBeenCalledWith('server-info', expect.any(Function));
  });

  it('still seeds capturedSha via /health when client is null', async () => {
    const fetchMock = mockFetch();
    const { result } = renderHook(() => useServerVersion(null, TEST_URL));

    expect(result.current.capturedSha).toBeNull();
    fetchMock.respond({ buildSha: 'health1234' });

    await waitFor(() => {
      expect(result.current.capturedSha).toBe('health1234');
    });
    expect(result.current.currentSha).toBe('health1234');
    expect(result.current.outOfSync).toBe(false);
    expect(fetchMock.fetchSpy).toHaveBeenCalledWith(
      `${TEST_URL}/health`,
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it('seeds the baseline from /health BEFORE the socket emits a different SHA (regression)', async () => {
    // The original bug: client was null on first render so the listener wasn't
    // attached, the welcome event fired and was missed, and the next welcome
    // event after a deploy was captured AS the baseline (no banner). The fetch
    // path means we now capture the pre-deploy SHA even with a null client.
    const fetchMock = mockFetch();
    const client = makeMockClient();
    const { result, rerender } = renderHook(
      ({ c }: { c: ReturnType<typeof makeMockClient> | null }) =>
        useServerVersion(c as never, TEST_URL),
      { initialProps: { c: null } }
    );

    fetchMock.respond({ buildSha: 'pre-deploy' });
    await waitFor(() => {
      expect(result.current.capturedSha).toBe('pre-deploy');
    });

    // Now the client comes alive (auth completed) and a reconnect emits the
    // post-deploy SHA. Banner should fire.
    rerender({ c: client });
    act(() => client.io.emit('server-info', { buildSha: 'post-deploy' }));

    expect(result.current.capturedSha).toBe('pre-deploy');
    expect(result.current.currentSha).toBe('post-deploy');
    expect(result.current.outOfSync).toBe(true);
  });

  it('handles /health fetch failures gracefully (no baseline, but no crash)', async () => {
    const fetchMock = mockFetch();
    const { result } = renderHook(() => useServerVersion(null, TEST_URL));

    fetchMock.fail();
    // Give the rejected promise a microtask to settle.
    await Promise.resolve();
    expect(result.current.capturedSha).toBeNull();
    expect(result.current.outOfSync).toBe(false);
  });

  it('polls /health on the configured interval and flips outOfSync on drift', async () => {
    // Drive each fetch with its own resolver so we can return different SHAs
    // across polls without races. Real socket reconnect is irrelevant here —
    // this exercises the poll-only path that catches deploys while the socket
    // stays connected.
    const responders: Array<(body: { buildSha: string }) => void> = [];
    const fetchSpy = vi.fn(
      () =>
        new Promise((resolve) => {
          responders.push((body) =>
            resolve({ ok: true, json: () => Promise.resolve(body) } as never)
          );
        })
    );
    vi.stubGlobal('fetch', fetchSpy);
    vi.useFakeTimers({ shouldAdvanceTime: true });

    try {
      const { result } = renderHook(() => useServerVersion(null, TEST_URL, 1000));

      // Initial fetch fires immediately on mount.
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      responders[0]({ buildSha: 'first-sha' });
      await waitFor(() => {
        expect(result.current.capturedSha).toBe('first-sha');
      });

      // Advance past the interval — the poll should fire a second fetch.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      responders[1]({ buildSha: 'second-sha' });
      await waitFor(() => {
        expect(result.current.currentSha).toBe('second-sha');
      });
      expect(result.current.capturedSha).toBe('first-sha');
      expect(result.current.outOfSync).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('disables polling when pollIntervalMs is 0', async () => {
    const fetchMock = mockFetch();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderHook(() => useServerVersion(null, TEST_URL, 0));
      // Initial fetch fires once.
      expect(fetchMock.fetchSpy).toHaveBeenCalledTimes(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(120_000);
      });
      // Still one — no interval was set up.
      expect(fetchMock.fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
