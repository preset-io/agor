import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
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

describe('useServerVersion', () => {
  it('captures the first SHA on welcome event and stays stable across reconnects', () => {
    const client = makeMockClient();
    const { result } = renderHook(() => useServerVersion(client as never));

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
    const { result } = renderHook(() => useServerVersion(client as never));

    act(() => client.io.emit('server-info', { buildSha: 'abc1234' }));
    expect(result.current.outOfSync).toBe(false);

    act(() => client.io.emit('server-info', { buildSha: 'def5678' }));
    expect(result.current.capturedSha).toBe('abc1234'); // baseline unchanged
    expect(result.current.currentSha).toBe('def5678');
    expect(result.current.outOfSync).toBe(true);
  });

  it('ignores welcome events without a buildSha', () => {
    const client = makeMockClient();
    const { result } = renderHook(() => useServerVersion(client as never));

    act(() => client.io.emit('server-info', {}));
    act(() => client.io.emit('server-info', { buildSha: undefined }));
    expect(result.current.capturedSha).toBeNull();
    expect(result.current.outOfSync).toBe(false);
  });

  it('disables comparison when either side is the dev sentinel', () => {
    const client = makeMockClient();
    const { result } = renderHook(() => useServerVersion(client as never));

    act(() => client.io.emit('server-info', { buildSha: 'dev' }));
    act(() => client.io.emit('server-info', { buildSha: 'abc1234' }));
    // Captured was 'dev' → comparison short-circuits to false.
    expect(result.current.outOfSync).toBe(false);
  });

  it('unsubscribes on unmount', () => {
    const client = makeMockClient();
    const { unmount } = renderHook(() => useServerVersion(client as never));
    unmount();
    expect(client.io.off).toHaveBeenCalledWith('server-info', expect.any(Function));
  });

  it('is a no-op when client is null', () => {
    const { result } = renderHook(() => useServerVersion(null));
    expect(result.current.capturedSha).toBeNull();
    expect(result.current.currentSha).toBeNull();
    expect(result.current.outOfSync).toBe(false);
  });
});
