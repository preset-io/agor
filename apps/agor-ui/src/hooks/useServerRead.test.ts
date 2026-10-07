/**
 * `useServerRead` timing, on a fake clock: a burst of invalidations reads
 * once, a sustained burst still reads within the max wait, one read is in
 * flight at a time with one trailing read, and a failed read retries a
 * bounded number of times.
 */
import { act, renderHook } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { MAX_ID_READ_ATTEMPTS } from '../store/idReads';
import { deferred, fakeFeathersClient, withTestAuthority } from '../test/harness';
import { SERVER_READ_DEBOUNCE_MS, SERVER_READ_MAX_WAIT_MS } from '../utils/debounceWithMaxWait';
import { useServerRead } from './useServerRead';

withTestAuthority();

const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

function mountRead(read: () => Promise<number>) {
  vi.useFakeTimers();
  const { client } = fakeFeathersClient();
  const spy = vi.fn(read);
  const view = renderHook(() => useServerRead(client, 'key', spy));
  return { ...view, read: spy };
}

it('reads once for a burst of invalidations, after the debounce', async () => {
  const { result, read } = mountRead(async () => 1);
  await advance(0);
  expect(read).toHaveBeenCalledTimes(1);
  for (let i = 0; i < 5; i++) act(() => result.current.invalidate());
  await advance(SERVER_READ_DEBOUNCE_MS - 1);
  expect(read).toHaveBeenCalledTimes(1);
  await advance(1);
  expect(read).toHaveBeenCalledTimes(2);
});

it('reads within the max wait while invalidations keep arriving', async () => {
  const { result, read } = mountRead(async () => 1);
  await advance(0);
  for (let elapsed = 0; elapsed < SERVER_READ_MAX_WAIT_MS; elapsed += 100) {
    act(() => result.current.invalidate());
    await advance(100);
  }
  expect(read).toHaveBeenCalledTimes(2);
});

it('keeps one read in flight and follows it with one trailing read', async () => {
  const gate = deferred<number>();
  let reads = 0;
  const { result, read } = mountRead(() => (++reads === 1 ? gate.promise : Promise.resolve(2)));
  await advance(0);
  for (let i = 0; i < 3; i++) act(() => result.current.refresh());
  expect(read).toHaveBeenCalledTimes(1);
  await act(async () => gate.resolve(1));
  await advance(0);
  expect(read).toHaveBeenCalledTimes(2);
  expect(result.current.data).toBe(2);
});

it('retries a failed read with backoff, a bounded number of times', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { result, read } = mountRead(async () => {
    throw new Error('down');
  });
  await advance(10 * 60_000);
  expect(read).toHaveBeenCalledTimes(MAX_ID_READ_ATTEMPTS);
  expect(result.current.data).toBe(undefined);
});
