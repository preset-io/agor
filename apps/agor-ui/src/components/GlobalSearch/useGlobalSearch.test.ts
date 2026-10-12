/**
 * Global search must not surface archived sessions.
 *
 * Artifacts and boards are already filtered in this hook; sessions were not,
 * so an archived branch's sessions kept showing up in search results.
 */

import type { Artifact, Board, Branch, MCPServer, Session, SessionID } from '@agor-live/client';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SEARCH_DEBOUNCE_MS } from './types';
import { useGlobalSearch } from './useGlobalSearch';

const USER_ID = 'user-1';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    session_id: 'session-1',
    branch_id: 'branch-1',
    created_by: USER_ID,
    archived: false,
    title: 'deploy pipeline',
    agentic_tool: 'claude-code',
    last_updated: '2026-08-12T10:00:00.000Z',
    ...overrides,
  } as unknown as Session;
}

function renderSearch(sessions: Session[], query: string) {
  return renderHook(() =>
    useGlobalSearch({
      query,
      ownedByMe: false,
      activeTypeChip: 'all',
      currentUserId: USER_ID,
      sessionById: new Map(sessions.map((s) => [s.session_id, s])),
      branchById: new Map<string, Branch>(),
      artifactById: new Map<string, Artifact>(),
      boardById: new Map<string, Board>(),
      mcpServerById: new Map<string, MCPServer>(),
    })
  );
}

describe('useGlobalSearch', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('debounces the latest query, flushes it, and cancels superseded/unmounted timers', () => {
    vi.useFakeTimers();
    const input = {
      query: '',
      ownedByMe: false,
      activeTypeChip: 'all' as const,
      sessionById: new Map([['session-1', makeSession()]]),
      branchById: new Map<string, Branch>(),
      artifactById: new Map<string, Artifact>(),
      boardById: new Map<string, Board>(),
      mcpServerById: new Map<string, MCPServer>(),
    };
    const { result, rerender, unmount } = renderHook(useGlobalSearch, { initialProps: input });
    rerender({ ...input, query: 'stale' });
    act(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS - 1));
    expect(result.current.debouncedQuery).toBe('');
    rerender({ ...input, query: 'deploy' });
    act(() => result.current.flush());
    expect(result.current.debouncedQuery).toBe('deploy');
    expect(result.current.counts.session).toBe(1);
    act(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS));
    expect(result.current.debouncedQuery).toBe('deploy');
    rerender({ ...input, query: 'pending' });
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not return a prior tenant scope after its supplied maps are replaced', () => {
    const input = {
      query: 'deploy',
      ownedByMe: false,
      activeTypeChip: 'all' as const,
      sessionById: new Map([
        ['tenant-a-session', makeSession({ session_id: 'tenant-a-session' as SessionID })],
      ]),
      branchById: new Map<string, Branch>(),
      artifactById: new Map<string, Artifact>(),
      boardById: new Map<string, Board>(),
      mcpServerById: new Map<string, MCPServer>(),
    };
    // The authenticated data layer supplies the scope; the hook must never
    // search a captured old map, even with the same query and owner filter off.
    const { result, rerender } = renderHook(useGlobalSearch, { initialProps: input });
    expect(result.current.counts.session).toBe(1);
    rerender({ ...input, sessionById: new Map() });
    act(() => result.current.flush());
    expect(result.current.results.session).toEqual([]);
    expect(result.current.counts.session).toBe(0);
  });

  it('omits archived sessions from results', async () => {
    const { result } = renderSearch(
      [
        makeSession({ session_id: 'active' as SessionID, title: 'deploy pipeline' }),
        makeSession({ session_id: 'gone' as SessionID, title: 'deploy pipeline', archived: true }),
      ],
      'deploy'
    );

    await waitFor(() => {
      expect(result.current.debouncedQuery).toBe('deploy');
    });

    const ids = result.current.results.session.map((r) => (r.item as Session).session_id);

    expect(ids).toEqual(['active']);
  });

  it('does not count archived sessions in the chip badge', async () => {
    const { result } = renderSearch(
      [
        makeSession({ session_id: 'active' as SessionID, title: 'deploy pipeline' }),
        makeSession({ session_id: 'gone' as SessionID, title: 'deploy pipeline', archived: true }),
      ],
      'deploy'
    );

    await waitFor(() => {
      expect(result.current.debouncedQuery).toBe('deploy');
    });

    expect(result.current.counts.session).toBe(1);
  });
});
