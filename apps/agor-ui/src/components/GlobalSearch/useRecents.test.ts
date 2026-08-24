/**
 * Recents must not surface archived sessions.
 *
 * `useAgorData` deliberately keeps archived sessions in `sessionById` so a
 * direct `/s/<id>` link can still open an archived session's drawer, which
 * makes filtering each consumer's responsibility. Artifacts and boards already
 * filter here; sessions did not.
 */

import type { Artifact, Board, Branch, MCPServer, Session } from '@agor-live/client';
import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useRecents } from './useRecents';

const USER_ID = 'user-1';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    session_id: 'session-1',
    branch_id: 'branch-1',
    created_by: USER_ID,
    archived: false,
    title: 'Active session',
    last_updated: '2026-08-12T10:00:00.000Z',
    ...overrides,
  } as unknown as Session;
}

function renderRecents(sessions: Session[]) {
  return renderHook(() =>
    useRecents({
      currentUserId: USER_ID,
      sessionById: new Map(sessions.map((s) => [s.session_id, s])),
      branchById: new Map<string, Branch>(),
      artifactById: new Map<string, Artifact>(),
      boardById: new Map<string, Board>(),
      mcpServerById: new Map<string, MCPServer>(),
    })
  );
}

describe('useRecents', () => {
  it('omits archived sessions', () => {
    const { result } = renderRecents([
      makeSession({ session_id: 'active', title: 'Active session' }),
      makeSession({ session_id: 'gone', title: 'Archived session', archived: true }),
    ]);

    const ids = result.current.session.map((r) => (r.item as Session).session_id);

    expect(ids).toEqual(['active']);
  });

  it('does not let archived sessions consume a recents slot', () => {
    // RECENTS_SECTION_LIMIT is 3. Four archived sessions sort ahead of the one
    // active session, so filtering after the slice would return nothing.
    const sessions = [
      ...Array.from({ length: 4 }, (_, i) =>
        makeSession({
          session_id: `archived-${i}`,
          archived: true,
          last_updated: `2026-08-12T12:0${i}:00.000Z`,
        })
      ),
      makeSession({ session_id: 'active', last_updated: '2026-08-12T09:00:00.000Z' }),
    ];

    const { result } = renderRecents(sessions);

    expect(result.current.session.map((r) => (r.item as Session).session_id)).toEqual(['active']);
  });
});
