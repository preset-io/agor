/**
 * Global search must not surface archived sessions.
 *
 * Artifacts and boards are already filtered in this hook; sessions were not,
 * so an archived branch's sessions kept showing up in search results.
 */

import type { Artifact, Board, Branch, MCPServer, Session } from '@agor-live/client';
import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
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
  it('omits archived sessions from results', async () => {
    const { result } = renderSearch(
      [
        makeSession({ session_id: 'active', title: 'deploy pipeline' }),
        makeSession({ session_id: 'gone', title: 'deploy pipeline', archived: true }),
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
        makeSession({ session_id: 'active', title: 'deploy pipeline' }),
        makeSession({ session_id: 'gone', title: 'deploy pipeline', archived: true }),
      ],
      'deploy'
    );

    await waitFor(() => {
      expect(result.current.debouncedQuery).toBe('deploy');
    });

    expect(result.current.counts.session).toBe(1);
  });
});
