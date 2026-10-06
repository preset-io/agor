/**
 * Server half of global search: the debounced query also reads matching
 * sessions and branches from the daemon and fills them into the store, so a
 * row the store never loaded (Step 3: no global hydration) is found.
 */
import type { AgorClient, Artifact, Board, Branch, MCPServer, Session } from '@agor-live/client';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetHydrationRevisions } from '../../store/agorHydration';
import { agorStore, useAgorStore } from '../../store/agorStore';
import { discardRealtimeNow, setRealtimeAuthorityScope } from '../../store/realtimeBatch';
import { pinnedMembers } from '../../store/rowPins';
import { selectBranchById, selectSessionById } from '../../store/selectors';
import { useGlobalSearch } from './useGlobalSearch';

const ME = 'user-me';
const session = (id: string, title: string, extra: Partial<Session> = {}) =>
  ({
    session_id: id,
    branch_id: 'br-1',
    created_by: ME,
    archived: false,
    title,
    genealogy: { children: [] },
    last_updated: '2026-10-01T00:00:00.000Z',
    ...extra,
  }) as unknown as Session;
const branch = (id: string, name: string) =>
  ({ branch_id: id, board_id: 'board-1', name, archived: false }) as Branch;

function makeClient(answer: { sessions?: Session[]; branches?: Branch[] }) {
  const finds: Record<string, ReturnType<typeof vi.fn>> = {};
  const client = {
    service: (name: string) => {
      finds[name] ??= vi.fn(async () =>
        name === 'sessions' ? (answer.sessions ?? []) : { data: answer.branches ?? [] }
      );
      return { find: finds[name] };
    },
  } as unknown as AgorClient;
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

beforeEach(() => {
  discardRealtimeNow();
  setRealtimeAuthorityScope('me:member:1');
});
afterEach(() => {
  cleanup();
  setRealtimeAuthorityScope(null);
  agorStore.getState().reset();
  resetHydrationRevisions();
});

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
    const branchesFind = vi.fn(async ({ query }: { query: Record<string, unknown> }) =>
      query.branch_id ? [parent] : { data: [] }
    );
    const client = {
      service: (name: string) => ({
        find:
          name === 'sessions'
            ? async () => [session('s-remote', 'Fix login', { branch_id: 'br-parent' })]
            : branchesFind,
      }),
    } as unknown as AgorClient;
    const { result } = renderSearch(client, 'login');
    await waitFor(() =>
      expect(result.current.results.session[0]?.parentBranch?.name).toBe('parent-branch')
    );
    expect(branchesFind).toHaveBeenCalledWith({
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
    let answer: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const rows = {
      sessions: [session('s-late', 'Fix login', { created_by: 'user-other' })],
      branches: [branch('br-late', 'login-fix')],
    };
    const finds = {
      sessions: vi.fn(async () => {
        await gate;
        return rows.sessions;
      }),
      branches: vi.fn(async () => {
        await gate;
        return { data: rows.branches };
      }),
    };
    const client = {
      service: (name: 'sessions' | 'branches') => ({ find: finds[name] }),
    } as unknown as AgorClient;
    const { unmount } = renderSearch(client, 'login');
    await waitFor(() => expect(finds.branches).toHaveBeenCalled());
    unmount();
    answer();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(agorStore.getState().sessionById.has('s-late')).toBe(false);
    expect(agorStore.getState().branchById.has('br-late')).toBe(false);
    expect(pinnedMembers.sessions?.has('s-late')).toBe(false);
  });
});
