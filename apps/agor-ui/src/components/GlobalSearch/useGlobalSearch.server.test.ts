/**
 * Server half of global search: the debounced query also reads matching
 * sessions and branches from the daemon and fills them into the store, so a
 * row the store never loaded (Step 3: no global hydration) is found.
 */
import type { AgorClient, Artifact, Board, Branch, MCPServer, Session } from '@agor-live/client';
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { agorStore, useAgorStore } from '../../store/agorStore';
import { pinnedMembers } from '../../store/rowPins';
import { selectBranchById, selectSessionById } from '../../store/selectors';
import {
  deferred,
  fakeFeathersClient,
  ME,
  makeBranch,
  makeSession,
  withTestAuthority,
} from '../../test/harness';
import { useGlobalSearch } from './useGlobalSearch';

const session = (id: string, title: string, extra: Partial<Session> = {}) =>
  makeSession(id, 'br-1', {
    created_by: ME,
    title,
    last_updated: '2026-10-01T00:00:00.000Z',
    ...extra,
  });
const branch = (id: string, name: string) => makeBranch(id, { name });

function makeClient(answer: { sessions?: Session[]; branches?: Branch[] }) {
  const { client } = fakeFeathersClient({
    sessions: { find: () => answer.sessions ?? [] },
    branches: { find: () => ({ data: answer.branches ?? [] }) },
  });
  const finds = {
    sessions: client.service('sessions').find,
    branches: client.service('branches').find,
  };
  return { client, finds };
}

function renderSearch(client: AgorClient, query: string, ownedByMe = false) {
  return renderHook(() =>
    useGlobalSearch({
      client,
      query,
      ownedByMe,
      activeTypeChip: 'all',
      currentUserId: ME,
      sessionById: useAgorStore(selectSessionById),
      branchById: useAgorStore(selectBranchById),
      artifactById: new Map<string, Artifact>(),
      boardById: new Map<string, Board>(),
      mcpServerById: new Map<string, MCPServer>(),
    })
  );
}

withTestAuthority('me:member:1');
// First paint pending (the store's initial state) unless a test settles it.
beforeEach(() => agorStore.getState().setLoading(true));

describe('useGlobalSearch server results', () => {
  it('finds sessions and branches the store never loaded, joining no scope', async () => {
    const { client, finds } = makeClient({
      sessions: [session('s-remote', 'Fix login')],
      branches: [branch('br-remote', 'login-fix')],
    });
    const { result } = renderSearch(client, 'login');
    await waitFor(() => expect(result.current.counts.session).toBe(1));
    expect(result.current.results.session[0].item.session_id).toBe('s-remote');
    expect(result.current.results.branch.map((r) => r.item.branch_id)).toEqual(['br-remote']);
    expect(finds.sessions).toHaveBeenCalledWith({
      query: expect.objectContaining({ search: 'login', archived: false, lean: true }),
    });
    expect(finds.branches).toHaveBeenCalledWith({
      query: expect.objectContaining({ search: 'login', archived: false }),
    });
    expect(agorStore.getState().coverage.size).toBe(0);
  });

  it('shows local matches at once and narrows the server read to mine', async () => {
    agorStore.getState().applyMaps((maps) => ({
      ...maps,
      sessionById: new Map([['s-local', session('s-local', 'login page')]]),
    }));
    const { client, finds } = makeClient({ sessions: [] });
    const { result } = renderSearch(client, 'login', true);
    await waitFor(() => expect(result.current.counts.session).toBe(1));
    await waitFor(() =>
      expect(finds.sessions).toHaveBeenCalledWith({
        query: expect.objectContaining({ search: 'login', created_by: ME }),
      })
    );
    expect(result.current.counts.session).toBe(1);
  });

  it('sends the daemon at most its 8 distinct terms, and matches every term locally', async () => {
    const { client, finds } = makeClient({
      sessions: [
        session('s-all', 'alpha beta gamma delta epsilon zeta eta theta iota kappa'),
        session('s-eight', 'alpha beta gamma delta epsilon zeta eta theta'),
      ],
    });
    const { result } = renderSearch(
      client,
      'alpha beta gamma delta epsilon zeta eta theta iota kappa alpha'
    );
    await waitFor(() => expect(result.current.counts.session).toBe(1));
    for (const find of [finds.sessions, finds.branches]) {
      expect(find).toHaveBeenCalledWith({
        query: expect.objectContaining({ search: 'alpha beta gamma delta epsilon zeta eta theta' }),
      });
    }
    expect(result.current.results.session[0].item.session_id).toBe('s-all');
  });

  it('shows rows the daemon matched on fields only it searches (a repo name)', async () => {
    // The daemon also matches a branch's repo slug and name, path and ids.
    const { client } = makeClient({
      sessions: [session('s-remote', 'Fix login')],
      branches: [branch('br-remote', 'login-fix')],
    });
    const { result } = renderSearch(client, 'demo webapp');
    await waitFor(() =>
      expect(result.current.results.branch.map((r) => r.item.branch_id)).toEqual(['br-remote'])
    );
    expect(result.current.results.session.map((r) => r.item.session_id)).toEqual(['s-remote']);
  });
});

describe('parent-branch labels', () => {
  it('reads the parent branches of the shown results the store lacks', async () => {
    agorStore.getState().setLoading(false); // first paint settled
    const parent = branch('br-parent', 'parent-branch');
    const { client } = fakeFeathersClient({
      sessions: { find: () => [session('s-remote', 'Fix login', { branch_id: 'br-parent' })] },
      branches: { find: ({ query }) => (query.branch_id ? [parent] : { data: [] }) },
    });
    const { result } = renderSearch(client, 'login');
    await waitFor(() =>
      expect(result.current.results.session[0]?.parentBranch?.name).toBe('parent-branch')
    );
    expect(client.service('branches').find).toHaveBeenCalledWith({
      query: { branch_id: { $in: ['br-parent'] }, archived: false, $limit: 1 },
    });
  });

  it('pins its results while the search shows them; closing the search evicts them', async () => {
    const { client } = makeClient({
      sessions: [session('s-remote', 'Fix login', { created_by: 'user-other' })],
      branches: [branch('br-remote', 'login-fix')],
    });
    const { result, unmount } = renderSearch(client, 'login');
    await waitFor(() => expect(result.current.counts.session).toBe(1));
    expect(pinnedMembers.sessions?.has('s-remote')).toBe(true);
    unmount();
    expect(agorStore.getState().sessionById.has('s-remote')).toBe(false);
    expect(agorStore.getState().branchById.has('br-remote')).toBe(false);
  });

  it('a reply that lands after the search closed fills nothing', async () => {
    const reply = deferred();
    const { client } = fakeFeathersClient({
      sessions: {
        find: async () => {
          await reply.promise;
          return [session('s-late', 'Fix login', { created_by: 'user-other' })];
        },
      },
      branches: {
        find: async () => {
          await reply.promise;
          return { data: [branch('br-late', 'login-fix')] };
        },
      },
    });
    const { unmount } = renderSearch(client, 'login');
    await waitFor(() => expect(client.service('branches').find).toHaveBeenCalled());
    unmount();
    reply.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(agorStore.getState().sessionById.has('s-late')).toBe(false);
    expect(agorStore.getState().branchById.has('br-late')).toBe(false);
    expect(pinnedMembers.sessions?.has('s-late')).toBe(false);
  });
});
