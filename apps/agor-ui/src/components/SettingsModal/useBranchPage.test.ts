/**
 * A Settings branch page stays consistent with realtime events: a patch that
 * lands while a re-read is in flight survives the older reply, and an event
 * that can change the page's membership or total (an off-page archive or
 * removal, a rename while searching) reads the page again.
 */
import type { Branch } from '@agor-live/client';
import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, it, type Mock } from 'vitest';
import { agorStore } from '@/store/agorStore';
import { setRealtimeAuthorityScope } from '@/store/realtimeBatch';
import { fakeFeathersClient, withTestAuthority } from '@/test/harness';
import { useBranchPage, useSessionCounts } from './useBranchPage';

const branch = (n: number, overrides: Partial<Branch> = {}) =>
  ({ branch_id: `branch-${n}`, name: `feature-${n}`, archived: false, ...overrides }) as Branch;

function makeClient(total = 25) {
  const page = () => ({
    total,
    data: Array.from({ length: 10 }, (_, i) => branch(i + 1)),
  });
  const fake = fakeFeathersClient({ branches: { find: page } });
  const find = fake.client.service('branches').find as unknown as Mock;
  const emit = (event: string, payload: unknown) =>
    act(() => fake.emit('branches', event, payload));
  return { client: fake.client, find, emit, page, setTotal: (n: number) => (total = n) };
}

withTestAuthority('me:member:1', { dataAuthority: false });

it('keeps a rename that lands while an older re-read is in flight', async () => {
  const { client, find, emit, page } = makeClient();
  const { result } = renderHook(() => useBranchPage(client, { archived: false }, 1, 10));
  await waitFor(() => expect(result.current.rows).toHaveLength(10));
  let resolveStale: (value: ReturnType<typeof page>) => void = () => {};
  find.mockImplementationOnce(() => new Promise((resolve) => (resolveStale = resolve)));
  emit('created', branch(99));
  await waitFor(() => expect(find).toHaveBeenCalledTimes(2));
  emit('patched', branch(1, { name: 'renamed-1' }));
  // The reply was read before the rename.
  await act(async () => resolveStale(page()));
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.rows[0].name).toBe('renamed-1');
});

it('reads the page again when a rename may move a row into or out of the search', async () => {
  const { client, find, emit } = makeClient();
  const { result } = renderHook(() => useBranchPage(client, { search: 'feature' }, 1, 10));
  await waitFor(() => expect(result.current.rows).toHaveLength(10));
  emit('patched', branch(1, { name: 'other' })); // on the page, out of the match
  await waitFor(() => expect(find).toHaveBeenCalledTimes(2));
  emit('patched', branch(42, { name: 'feature-42' })); // off the page, into the match
  await waitFor(() => expect(find).toHaveBeenCalledTimes(3));
});

it('reads the total again when an off-page row is archived or removed', async () => {
  const { client, find, emit, setTotal } = makeClient(25);
  const { result } = renderHook(() => useBranchPage(client, { archived: false }, 1, 10));
  await waitFor(() => expect(result.current.total).toBe(25));
  setTotal(24);
  emit('patched', branch(20, { archived: true }));
  await waitFor(() => expect(result.current.total).toBe(24));
  setTotal(23);
  emit('removed', branch(21));
  await waitFor(() => expect(result.current.total).toBe(23));
  expect(find).toHaveBeenCalledTimes(3);
});

it('patches an on-page row in place without reading again', async () => {
  const { client, find, emit } = makeClient();
  const { result } = renderHook(() => useBranchPage(client, { archived: false }, 1, 10));
  await waitFor(() => expect(result.current.rows).toHaveLength(10));
  emit('patched', branch(2, { name: 'renamed-2' }));
  expect(result.current.rows[1].name).toBe('renamed-2');
  await new Promise((resolve) => setTimeout(resolve, 600));
  expect(find).toHaveBeenCalledTimes(1);
});

function makeCountsClient() {
  let count = 3;
  const fake = fakeFeathersClient({
    'session-counts': {
      find: ({ query }) => [
        { id: query.group_by === 'board_id' ? 'board-1' : 'branch-1', session_count: count },
      ],
    },
  });
  return {
    client: fake.client,
    find: fake.client.service('session-counts').find as unknown as Mock,
    setCount: (n: number) => (count = n),
    emitSession: (event: string, payload: unknown) =>
      act(() => fake.emit('sessions', event, payload)),
    emitBranch: (event: string, payload: unknown) =>
      act(() => fake.emit('branches', event, payload)),
  };
}

it('counts sessions again after a session create, archive or removal', async () => {
  const { client, setCount, emitSession } = makeCountsClient();
  const { result } = renderHook(() => useSessionCounts(client, 'branch_id'));
  await waitFor(() => expect(result.current.get('branch-1')).toBe(3));
  setCount(4);
  emitSession('created', { session_id: 's-4', branch_id: 'branch-1', archived: false });
  await waitFor(() => expect(result.current.get('branch-1')).toBe(4));
  setCount(3);
  emitSession('patched', { session_id: 's-4', branch_id: 'branch-1', archived: true });
  await waitFor(() => expect(result.current.get('branch-1')).toBe(3));
  setCount(2);
  emitSession('removed', { session_id: 's-3', branch_id: 'branch-1' });
  await waitFor(() => expect(result.current.get('branch-1')).toBe(2));
});

it('counts a board again after a branch moves, and after a reconnect', async () => {
  const { client, find, setCount, emitBranch } = makeCountsClient();
  const { result } = renderHook(() => useSessionCounts(client, 'board_id'));
  await waitFor(() => expect(result.current.get('board-1')).toBe(3));
  setCount(5);
  emitBranch('patched', { branch_id: 'branch-9', board_id: 'board-1' });
  await waitFor(() => expect(result.current.get('board-1')).toBe(5));
  setCount(6);
  act(() => setRealtimeAuthorityScope('me:member:2'));
  await waitFor(() => expect(result.current.get('board-1')).toBe(6));
  expect(find).toHaveBeenCalledTimes(3);
});

it('does not count again on a value-only session or branch patch once their membership is known', async () => {
  const session = { session_id: 's-1', branch_id: 'branch-1', branch_board_id: 'board-1' };
  const { client, find, emitSession, emitBranch } = makeCountsClient();
  const { result } = renderHook(() => useSessionCounts(client, 'board_id'));
  await waitFor(() => expect(result.current.get('board-1')).toBe(3));
  // First sight of each: membership unknown, so one count again for both.
  emitSession('patched', { ...session, archived: false, status: 'idle' });
  emitBranch('patched', branch(1, { board_id: 'board-1' } as Partial<Branch>));
  await waitFor(() => expect(find).toHaveBeenCalledTimes(2));
  await new Promise((resolve) => setTimeout(resolve, 600));
  emitSession('patched', { ...session, archived: false, status: 'running' });
  emitSession('patched', { ...session, archived: false, title: 'renamed' });
  emitBranch('patched', branch(1, { name: 'renamed', board_id: 'board-1' } as Partial<Branch>));
  await new Promise((resolve) => setTimeout(resolve, 600));
  expect(find).toHaveBeenCalledTimes(2);
  // An archive flip, then a branch move, each count again.
  emitSession('patched', { ...session, archived: true });
  await waitFor(() => expect(find).toHaveBeenCalledTimes(3));
  emitSession('patched', { ...session, archived: true, title: 'archived' });
  emitBranch('patched', branch(1, { board_id: 'board-2' } as Partial<Branch>));
  await waitFor(() => expect(find).toHaveBeenCalledTimes(4));
  await new Promise((resolve) => setTimeout(resolve, 600));
  expect(find).toHaveBeenCalledTimes(4);
});

it('a partial value-only patch never hides a later partial archive', async () => {
  agorStore.setState({
    sessionById: new Map([
      ['s-1', { session_id: 's-1', branch_id: 'branch-1', archived: false } as never],
    ]),
  });
  const { client, find, setCount, emitSession } = makeCountsClient();
  const { result } = renderHook(() => useSessionCounts(client, 'branch_id'));
  await waitFor(() => expect(result.current.get('branch-1')).toBe(3));
  emitSession('patched', { session_id: 's-1', status: 'running' });
  await new Promise((resolve) => setTimeout(resolve, 600));
  const reads = find.mock.calls.length;
  setCount(2);
  emitSession('patched', { session_id: 's-1', archived: true });
  await waitFor(() => expect(result.current.get('branch-1')).toBe(2));
  expect(find.mock.calls.length).toBe(reads + 1);
});

it('merges partial patches into what it knows of a session', async () => {
  const { client, find, emitSession } = makeCountsClient();
  const { result } = renderHook(() => useSessionCounts(client, 'branch_id'));
  await waitFor(() => expect(result.current.get('branch-1')).toBe(3));
  emitSession('created', { session_id: 's-5', branch_id: 'branch-1', archived: false });
  await waitFor(() => expect(find).toHaveBeenCalledTimes(2));
  // Value-only and unchanged count fields: no read.
  emitSession('patched', { session_id: 's-5', status: 'running' });
  emitSession('patched', { session_id: 's-5', archived: false });
  await new Promise((resolve) => setTimeout(resolve, 600));
  expect(find).toHaveBeenCalledTimes(2);
  // A partial archive still knows the session's branch.
  emitSession('patched', { session_id: 's-5', archived: true });
  await waitFor(() => expect(find).toHaveBeenCalledTimes(3));
});
