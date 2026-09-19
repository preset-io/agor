import type { AgorClient, Branch } from '@agor-live/client';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { usePrimaryTeammate } from './usePrimaryTeammate';

const branchA = { branch_id: 'branch-a' } as Branch;
const branchB = { branch_id: 'branch-b' } as Branch;

function clientResolving(getPrimaryTeammate: () => Promise<Branch | null>) {
  return { service: () => ({ getPrimaryTeammate }) } as unknown as AgorClient;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

describe('usePrimaryTeammate', () => {
  it('resolves the caller primary teammate', async () => {
    const client = clientResolving(async () => branchA);
    const { result } = renderHook(() => usePrimaryTeammate(client, 'user-1', 0));
    expect(result.current.resolving).toBe(true);
    await waitFor(() => expect(result.current.branch).toBe(branchA));
    expect(result.current).toMatchObject({ resolving: false, failed: false });
  });

  it('does nothing without a client', () => {
    const { result } = renderHook(() => usePrimaryTeammate(null, 'user-1', 0));
    expect(result.current).toMatchObject({ branch: null, resolving: false, failed: false });
  });

  it('flags a failed resolve and keeps the last branch', async () => {
    const getPrimaryTeammate = vi
      .fn<() => Promise<Branch | null>>()
      .mockResolvedValueOnce(branchA)
      .mockRejectedValueOnce(new Error('offline'));
    const client = clientResolving(getPrimaryTeammate);
    const { result, rerender } = renderHook(
      ({ generation }) => usePrimaryTeammate(client, 'user-1', generation),
      { initialProps: { generation: 0 } }
    );
    await waitFor(() => expect(result.current.branch).toBe(branchA));
    rerender({ generation: 1 });
    await waitFor(() => expect(result.current.failed).toBe(true));
    expect(result.current).toMatchObject({ branch: branchA, resolving: false });
  });

  it.each([
    ['caller', { userId: 'user-2', generation: 0, refreshKey: false }],
    ['authentication generation', { userId: 'user-1', generation: 1, refreshKey: false }],
    ['refresh key', { userId: 'user-1', generation: 0, refreshKey: true }],
  ])('re-resolves when the %s changes and drops the superseded response', async (_, next) => {
    const first = deferred<Branch | null>();
    const getPrimaryTeammate = vi
      .fn<() => Promise<Branch | null>>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(branchB);
    const client = clientResolving(getPrimaryTeammate);
    const { result, rerender } = renderHook(
      (props) => usePrimaryTeammate(client, props.userId, props.generation, props.refreshKey),
      { initialProps: { userId: 'user-1', generation: 0, refreshKey: false } }
    );
    rerender(next);
    await waitFor(() => expect(result.current.branch).toBe(branchB));
    await act(async () => first.resolve(branchA));
    expect(result.current.branch).toBe(branchB);
    expect(getPrimaryTeammate).toHaveBeenCalledTimes(2);
  });

  it('is not current from the very render an identity change begins until the new answer lands', async () => {
    const next = deferred<Branch | null>();
    const getPrimaryTeammate = vi
      .fn<() => Promise<Branch | null>>()
      .mockResolvedValueOnce(branchA)
      .mockReturnValueOnce(next.promise);
    const client = clientResolving(getPrimaryTeammate);
    const renders: { generation: number; current: boolean }[] = [];
    const { result, rerender } = renderHook(
      ({ generation }) => {
        const teammate = usePrimaryTeammate(client, 'user-1', generation);
        renders.push({ generation, current: teammate.current });
        return teammate;
      },
      { initialProps: { generation: 0 } }
    );
    await waitFor(() => expect(result.current).toMatchObject({ branch: branchA, current: true }));

    rerender({ generation: 1 });
    expect(result.current.branch).toBe(branchA);
    expect(renders.filter((entry) => entry.generation === 1 && entry.current)).toEqual([]);

    await act(async () => next.resolve(branchB));
    expect(result.current).toMatchObject({ branch: branchB, current: true });
  });

  it('is not current after a failed resolve, and current again after an explicit pick', async () => {
    const client = clientResolving(async () => {
      throw new Error('offline');
    });
    const { result } = renderHook(() => usePrimaryTeammate(client, 'user-1', 0));
    await waitFor(() => expect(result.current.failed).toBe(true));
    expect(result.current.current).toBe(false);
    act(() => result.current.setBranch(branchA));
    expect(result.current).toMatchObject({ branch: branchA, current: true });
  });

  it('an explicit pick clears a failed resolve', async () => {
    const client = clientResolving(async () => {
      throw new Error('offline');
    });
    const { result } = renderHook(() => usePrimaryTeammate(client, 'user-1', 0));
    await waitFor(() => expect(result.current.failed).toBe(true));
    act(() => result.current.setBranch(branchA));
    expect(result.current).toMatchObject({ branch: branchA, failed: false });
  });

  it('an explicit pick supersedes a resolve still in flight', async () => {
    const pending = deferred<Branch | null>();
    const client = clientResolving(() => pending.promise);
    const { result } = renderHook(() => usePrimaryTeammate(client, 'user-1', 0));
    expect(result.current.resolving).toBe(true);
    act(() => result.current.setBranch(branchA));
    expect(result.current).toMatchObject({ branch: branchA, current: true, resolving: false });
    await act(async () => pending.resolve(branchB));
    expect(result.current).toMatchObject({ branch: branchA, current: true, resolving: false });
  });

  it('a manual refresh settling after unmount reports undefined', async () => {
    const pending = deferred<Branch | null>();
    const getPrimaryTeammate = vi
      .fn<() => Promise<Branch | null>>()
      .mockResolvedValueOnce(null)
      .mockReturnValueOnce(pending.promise);
    const client = clientResolving(getPrimaryTeammate);
    const { result, unmount } = renderHook(() => usePrimaryTeammate(client, 'user-1', 0));
    await waitFor(() => expect(result.current.resolving).toBe(false));

    let manual!: Promise<Branch | null | undefined>;
    act(() => {
      manual = result.current.refresh();
    });
    unmount();
    pending.resolve(branchA);
    await expect(manual).resolves.toBeUndefined();
  });

  it('drops an in-flight response once the client goes away', async () => {
    const pending = deferred<Branch | null>();
    const client = clientResolving(() => pending.promise);
    const { result, rerender } = renderHook(
      ({ current }: { current: AgorClient | null }) => usePrimaryTeammate(current, 'user-1', 0),
      { initialProps: { current: client as AgorClient | null } }
    );
    rerender({ current: null });
    await act(async () => pending.resolve(branchA));
    expect(result.current.branch).toBeNull();
  });

  it('a manual refresh in flight across an identity change reports undefined', async () => {
    const pending = deferred<Branch | null>();
    const getPrimaryTeammate = vi
      .fn<() => Promise<Branch | null>>()
      .mockResolvedValueOnce(null)
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(branchB);
    const client = clientResolving(getPrimaryTeammate);
    const { result, rerender } = renderHook(
      ({ generation }) => usePrimaryTeammate(client, 'user-1', generation),
      { initialProps: { generation: 0 } }
    );
    await waitFor(() => expect(result.current.resolving).toBe(false));

    let manual!: Promise<Branch | null | undefined>;
    act(() => {
      manual = result.current.refresh();
    });
    rerender({ generation: 1 });
    let refreshed: Branch | null | undefined = null;
    await act(async () => {
      pending.resolve(branchA);
      refreshed = await manual;
    });
    expect(refreshed).toBeUndefined();
    await waitFor(() => expect(result.current.branch).toBe(branchB));
  });

  it('refresh returns the branch, or undefined once superseded', async () => {
    const stale = deferred<Branch | null>();
    const getPrimaryTeammate = vi
      .fn<() => Promise<Branch | null>>()
      .mockResolvedValueOnce(null)
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce(branchB);
    const client = clientResolving(getPrimaryTeammate);
    const { result } = renderHook(() => usePrimaryTeammate(client, 'user-1', 0));
    await waitFor(() => expect(result.current.resolving).toBe(false));

    let staleResult: Branch | null | undefined = null;
    let freshResult: Branch | null | undefined = null;
    await act(async () => {
      const staleRefresh = result.current.refresh();
      freshResult = await result.current.refresh();
      stale.resolve(branchA);
      staleResult = await staleRefresh;
    });
    expect(freshResult).toBe(branchB);
    expect(staleResult).toBeUndefined();
    expect(result.current.branch).toBe(branchB);
  });
});
