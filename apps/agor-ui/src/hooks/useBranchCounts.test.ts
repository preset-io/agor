/**
 * Branch-count badges read the per-board `branch-counts` aggregate, so they
 * are right with the store's branch map empty (Step 3), and re-read it,
 * debounced, after branch events.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { setRealtimeAuthorityScope } from '../store/realtimeBatch';
import { fakeFeathersClient, withTestAuthority } from '../test/harness';
import { SERVER_READ_DEBOUNCE_MS } from '../utils/debounceWithMaxWait';
import { useBranchCounts } from './useBranchCounts';

function makeClient() {
  let count = 2;
  const fake = fakeFeathersClient({
    'branch-counts': { find: () => [{ board_id: 'board-1', branch_count: count }] },
  });
  return {
    client: fake.client,
    find: fake.client.service('branch-counts').find as ReturnType<typeof vi.fn>,
    emit: (event: string) => fake.emit('branches', event),
    setCount: (n: number) => (count = n),
    listenerCount: () =>
      ['created', 'patched', 'updated', 'removed'].reduce(
        (sum, event) => sum + fake.listenerCount('branches', event),
        0
      ),
  };
}

withTestAuthority('user-1:member:1', { dataAuthority: false });

it('reads the per-board counts with the store empty', async () => {
  const { client } = makeClient();
  const { result } = renderHook(() => useBranchCounts(client));
  await waitFor(() => expect(result.current.get('board-1')).toBe(2));
});

it('re-reads once, debounced, after a burst of branch events', async () => {
  const { client, find, emit, setCount } = makeClient();
  const { result } = renderHook(() => useBranchCounts(client));
  await waitFor(() => expect(result.current.get('board-1')).toBe(2));
  vi.useFakeTimers();
  setCount(3);
  emit('created');
  emit('patched');
  emit('removed');
  expect(find).toHaveBeenCalledTimes(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(SERVER_READ_DEBOUNCE_MS);
  });
  expect(find).toHaveBeenCalledTimes(2);
  expect(result.current.get('board-1')).toBe(3);
});

it('reads nothing without a realtime authority, and unsubscribes on unmount', async () => {
  setRealtimeAuthorityScope(null);
  const { client, find, listenerCount } = makeClient();
  const { unmount } = renderHook(() => useBranchCounts(client));
  expect(find).not.toHaveBeenCalled();
  act(() => setRealtimeAuthorityScope('user-1:member:1'));
  await waitFor(() => expect(find).toHaveBeenCalledTimes(1));
  unmount();
  expect(listenerCount()).toBe(0);
});

it('never lets an older reply overwrite a newer one', async () => {
  const { client, find, emit } = makeClient();
  const { result } = renderHook(() => useBranchCounts(client));
  await waitFor(() => expect(result.current.get('board-1')).toBe(2));
  vi.useFakeTimers();
  // Each read captures the server count when it starts; replies land newest first.
  let server = 2;
  const pending: Array<() => void> = [];
  find.mockImplementation(() => {
    const snapshot = server;
    return new Promise((resolve) =>
      pending.push(() => resolve([{ board_id: 'board-1', branch_count: snapshot }]))
    );
  });
  server = 4;
  emit('patched');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  server = 5;
  emit('patched');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  while (pending.length > 0) {
    await act(async () => {
      for (const resolve of pending.splice(0).reverse()) resolve();
      await vi.advanceTimersByTimeAsync(5000);
    });
  }
  expect(result.current.get('board-1')).toBe(5);
});
