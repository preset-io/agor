import type { AgorClient, Branch } from '@agor-live/client';
import { PAGINATION } from '@agor-live/client';
import { act, renderHook, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { cancelAllHydrations } from '../store/agorHydration';
import { agorStore } from '../store/agorStore';
import { MAX_ID_READ_ATTEMPTS } from '../store/idReads';
import { pinnedMembers } from '../store/rowPins';
import { makeBranch as branch, deferred, withTestAuthority } from '../test/harness';
import { useEnsureBranches } from './useEnsureRows';

function makeClient(known: Branch[]) {
  const find = vi.fn(async ({ query }: { query: { branch_id: { $in: string[] } } }) =>
    known.filter((b) => query.branch_id.$in.includes(b.branch_id))
  );
  return { client: { service: () => ({ find }) } as unknown as AgorClient, find };
}

withTestAuthority('me:member:1');

describe('useEnsureBranches', () => {
  it('reads the branches the store lacks by id, in chunks, and fills them with no scope', async () => {
    const ids = Array.from({ length: PAGINATION.MAX_ID_LIST + 1 }, (_, i) => `b-${i}`);
    const { client, find } = makeClient([branch('b-0'), branch(`b-${PAGINATION.MAX_ID_LIST}`)]);
    renderHook(() => useEnsureBranches(client, ids));
    await waitFor(() => expect(agorStore.getState().branchById.has('b-0')).toBe(true));
    await waitFor(() =>
      expect(agorStore.getState().branchById.has(`b-${PAGINATION.MAX_ID_LIST}`)).toBe(true)
    );
    expect(find).toHaveBeenCalledTimes(2);
    expect(find.mock.calls[0][0].query).toMatchObject({ archived: false });
    expect(agorStore.getState().coverage.size).toBe(0);
  });

  it('reads an id once, even when absent and asked for again', async () => {
    const { client, find } = makeClient([]);
    const { rerender } = renderHook(({ ids }) => useEnsureBranches(client, ids), {
      initialProps: { ids: ['gone'] },
    });
    await waitFor(() => expect(find).toHaveBeenCalledTimes(1));
    rerender({ ids: ['gone', 'new'] });
    await waitFor(() => expect(find).toHaveBeenCalledTimes(2));
    expect(find.mock.calls[1][0].query.branch_id.$in).toEqual(['new']);
  });

  it('forgets an absent id once no view asks for it, so it never grows with history', async () => {
    const { client, find } = makeClient([]);
    const { rerender } = renderHook(({ ids }) => useEnsureBranches(client, ids), {
      initialProps: { ids: ['gone-0'] },
    });
    await waitFor(() => expect(find).toHaveBeenCalledTimes(1));
    for (let i = 1; i < 5; i++) {
      rerender({ ids: [`gone-${i}`] });
      await waitFor(() => expect(find).toHaveBeenCalledTimes(i + 1));
    }
    // Asked for again after it was dropped: read again, not remembered as absent.
    rerender({ ids: ['gone-0'] });
    await waitFor(() => expect(find).toHaveBeenCalledTimes(6));
  });

  it('waits out a burst of id changes with a debounce', async () => {
    vi.useFakeTimers();
    const { client, find } = makeClient([]);
    const { rerender } = renderHook(({ ids }) => useEnsureBranches(client, ids, 500), {
      initialProps: { ids: ['a'] },
    });
    rerender({ ids: ['a', 'b'] });
    rerender({ ids: ['a', 'b', 'c'] });
    expect(find).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(find).toHaveBeenCalledTimes(1);
    expect(find.mock.calls[0][0].query.branch_id.$in).toEqual(['a', 'b', 'c']);
  });

  it('retries a failed read with backoff, a bounded number of times', async () => {
    vi.useFakeTimers();
    const { client, find } = makeClient([branch('b-1')]);
    const real = find.getMockImplementation();
    find.mockRejectedValueOnce(new Error('offline'));
    renderHook(() => useEnsureBranches(client, ['b-1']));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(find).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(find).toHaveBeenCalledTimes(2);
    expect(agorStore.getState().branchById.has('b-1')).toBe(true);

    find.mockImplementation(async () => {
      throw new Error('down');
    });
    renderHook(() => useEnsureBranches(client, ['b-2']));
    for (let i = 0; i < 2 * MAX_ID_READ_ATTEMPTS; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
    }
    expect(
      find.mock.calls.filter(([{ query }]) => query.branch_id.$in.includes('b-2'))
    ).toHaveLength(MAX_ID_READ_ATTEMPTS);
    find.mockImplementation(real as never);
  });

  it('a read that fails after the view unmounted is not retried', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { client, find } = makeClient([branch('b-1')]);
    const read = deferred<Branch[]>();
    find.mockImplementationOnce(() => read.promise);
    const { unmount } = renderHook(() => useEnsureBranches(client, ['b-1']));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(find).toHaveBeenCalledTimes(1);

    unmount();
    await act(async () => {
      read.reject(new Error('offline'));
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(find).toHaveBeenCalledTimes(1);
  });

  it('reads again when remounted after its reader was disposed', async () => {
    const { client } = makeClient([branch('b-1')]);
    // StrictMode unmounts and remounts every effect with the same refs.
    renderHook(() => useEnsureBranches(client, ['b-1']), { wrapper: StrictMode });
    await waitFor(() => expect(agorStore.getState().branchById.has('b-1')).toBe(true));
  });

  it('reads a row again once the store evicts it', async () => {
    const { client, find } = makeClient([branch('b-1')]);
    renderHook(() => useEnsureBranches(client, ['b-1']));
    await waitFor(() => expect(agorStore.getState().branchById.has('b-1')).toBe(true));
    act(() => agorStore.setState({ branchById: new Map() }));
    await waitFor(() => expect(find).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(agorStore.getState().branchById.has('b-1')).toBe(true));
  });

  it('reads an id again when its read was cancelled, never recording it absent', async () => {
    const { client, find } = makeClient([branch('b-1'), branch('b-2')]);
    const first = deferred<Branch[]>();
    find.mockImplementationOnce(() => first.promise);
    const { rerender } = renderHook(({ ids }) => useEnsureBranches(client, ids), {
      initialProps: { ids: ['b-1'] },
    });
    await waitFor(() => expect(find).toHaveBeenCalledTimes(1));
    // Hydration is cancelled under the same authority (a store remount).
    act(() => cancelAllHydrations());
    await act(async () => first.resolve([branch('b-1')]));
    rerender({ ids: ['b-1', 'b-2'] });
    await waitFor(() => expect(agorStore.getState().branchById.has('b-2')).toBe(true));
    await waitFor(() => expect(agorStore.getState().branchById.has('b-1')).toBe(true));
    expect(
      find.mock.calls.slice(1).some(([{ query }]) => query.branch_id.$in.includes('b-1'))
    ).toBe(true);
  });
});

describe('useEnsureBranches retention', () => {
  it('pins the rows it reads while mounted; unmounting evicts the ones nothing holds', async () => {
    const { client } = makeClient([branch('b-1')]);
    const { unmount } = renderHook(() => useEnsureBranches(client, ['b-1']));
    await waitFor(() => expect(agorStore.getState().branchById.has('b-1')).toBe(true));
    expect(pinnedMembers.branches?.has('b-1')).toBe(true);
    unmount();
    expect(pinnedMembers.branches?.has('b-1')).toBe(false);
    expect(agorStore.getState().branchById.has('b-1')).toBe(false);
  });

  it('a reply that lands after the view unmounted fills nothing', async () => {
    const { client, find } = makeClient([]);
    const answer = deferred<Branch[]>();
    find.mockImplementationOnce(() => answer.promise);
    const { unmount } = renderHook(() => useEnsureBranches(client, ['b-late']));
    await waitFor(() => expect(find).toHaveBeenCalledTimes(1));
    unmount();
    await act(async () => answer.resolve([branch('b-late')]));
    expect(agorStore.getState().branchById.has('b-late')).toBe(false);
    expect(pinnedMembers.branches?.has('b-late')).toBe(false);
  });
});
