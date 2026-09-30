import type { AgorClient } from '@agor-live/client';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetAccessCacheForTests } from '../utils/accessCache';
import { useSessionAccess } from './useSessionAccess';

const session = { can: 'session', is_owner: false, source: 'others' };

/** Access reads that settle only when the test says so, keyed by branch id. */
function deferredReads() {
  const waiting = new Map<string, { resolve: (value: unknown) => void; reject: () => void }>();
  const find = vi.fn(
    ({ route }: { route: { id: string } }) =>
      new Promise((resolve, reject) =>
        waiting.set(route.id, { resolve, reject: () => reject(new Error('offline')) })
      )
  );
  const client = { service: () => ({ find }) } as unknown as AgorClient;
  return { client, find, waiting };
}

beforeEach(() => resetAccessCacheForTests());

describe('useSessionAccess', () => {
  it('keeps a failure through a grown id set until its re-read answers, which replaces it', async () => {
    const reads = deferredReads();
    const { result, rerender } = renderHook(
      ({ ids }) => useSessionAccess(reads.client, 'me', ids),
      { initialProps: { ids: ['a'] } }
    );
    await waitFor(() => expect(reads.waiting.has('a')).toBe(true));
    await act(async () => reads.waiting.get('a')?.reject());
    expect(result.current.failedIds.has('a')).toBe(true);
    reads.waiting.clear();

    rerender({ ids: ['a', 'b'] });
    expect(result.current.failed).toBe(1);
    await waitFor(() => expect(reads.waiting.size).toBe(2));
    await act(async () => reads.waiting.get('a')?.reject());
    expect(result.current.failedIds.has('a')).toBe(true);

    rerender({ ids: ['a', 'b', 'c'] });
    await waitFor(() => expect(reads.waiting.has('c')).toBe(true));
    expect(result.current.failed).toBe(1);
    await act(async () => {
      for (const read of reads.waiting.values()) read.resolve(session);
    });
    await waitFor(() => expect(result.current.access).toEqual({ a: true, b: true, c: true }));
    expect(result.current.failed).toBe(0);
    expect(result.current.failedIds.size).toBe(0);
  });

  it('drops a failure for an id that left the set, even when it comes back', async () => {
    const reads = deferredReads();
    const { result, rerender } = renderHook(
      ({ ids }) => useSessionAccess(reads.client, 'me', ids),
      { initialProps: { ids: ['a', 'b'] } }
    );
    await waitFor(() => expect(reads.waiting.size).toBe(2));
    await act(async () => reads.waiting.get('a')?.reject());
    expect(result.current.failedIds.has('a')).toBe(true);

    rerender({ ids: ['b'] });
    expect(result.current.failedIds.size).toBe(0);
    rerender({ ids: ['a', 'b'] });
    expect(result.current.failed).toBe(0);
    await act(async () => {
      for (const read of reads.waiting.values()) read.resolve(session);
    });
  });
});
