/**
 * Regression test for `goToSession` — fixates that the helper pushes the
 * `/s/<short>/` URL even when the target session is not (yet) in the
 * local `sessionById` map.
 *
 * Background: NewSessionModal's success handler routes through
 * `navigation.goToSession(newId)` immediately after `client.service('sessions').create()`
 * resolves. The socket-driven `sessionById` update may arrive a tick later,
 * so a strict `if (!session) return` guard inside `goToSession` would
 * silently strand the user on the prior URL — the very regression this
 * fix addresses. The lookup is now scoped to the same-URL recenter
 * fallback (where it actually matters) instead of gating the navigation.
 *
 * The same contract applies to `goToBranch` and `goToBoard` — used by the
 * post-create handlers in `App/App.tsx` (handleCreateBranch,
 * handleCreateTeammate, handleCreateBoardFromDialog) — so each helper
 * has its own race-condition test below.
 */

import type { Branch, Session } from '@agor-live/client';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { CanvasNavigationProvider } from '../contexts/CanvasNavigationContext';
import { useAppNavigation } from './useAppNavigation';

// A real UUIDv7. `shortId` strips hyphens and keeps the first
// SHORT_ID_LENGTH (24) hex chars, so the URL short form is the first
// 6 groups of hex digits concatenated.
const NEW_SESSION_ID = '019e9999-0000-7000-8000-000000000001';
const NEW_SESSION_SHORT = '019e99990000700080000000';
const EXISTING_BRANCH_ID = '019e8888-0000-7000-8000-000000000001';
const EXISTING_BOARD_ID = '019e7777-0000-7000-8000-000000000001';
const NEW_BRANCH_ID = '019e6666-0000-7000-8000-000000000001';
const NEW_BRANCH_SHORT = '019e66660000700080000000';
const NEW_BOARD_ID = '019e5555-0000-7000-8000-000000000001';
const NEW_BOARD_SHORT = '019e55550000700080000000';

function wrap(initialEntry = '/') {
  return ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={[initialEntry]}>
      <CanvasNavigationProvider>{children}</CanvasNavigationProvider>
    </MemoryRouter>
  );
}

/** Pull the current pathname out of MemoryRouter so we can assert on the
 *  side-effect of `goToSession` without coupling to the navigate mock. */
function useTestNav(opts: Parameters<typeof useAppNavigation>[0]) {
  const nav = useAppNavigation(opts);
  const location = useLocation();
  return { nav, pathname: location.pathname };
}

describe('useAppNavigation.goToSession', () => {
  it('pushes /s/<short>/ even when the session is NOT yet in sessionById (just-created race)', () => {
    // Empty maps simulate the moment between the create() promise
    // resolving and the socket `sessions.created` event populating
    // sessionById.
    const sessionById = new Map<string, Session>();
    const branchById = new Map<string, Branch>();

    const { result } = renderHook(
      () =>
        useTestNav({
          boardById: new Map(),
          sessionById,
          branchById,
          artifactById: new Map(),
        }),
      { wrapper: wrap('/b/somewhere/') }
    );

    expect(result.current.pathname).toBe('/b/somewhere/');

    act(() => {
      result.current.nav.goToSession(NEW_SESSION_ID);
    });

    // Must have navigated despite the session being absent from the map.
    expect(result.current.pathname).toBe(`/s/${NEW_SESSION_SHORT}/`);
  });

  it('still navigates when the session IS in sessionById (known-session click)', () => {
    const session = {
      session_id: NEW_SESSION_ID,
      branch_id: EXISTING_BRANCH_ID,
    } as Session;
    const branch = {
      branch_id: EXISTING_BRANCH_ID,
      board_id: EXISTING_BOARD_ID,
    } as Branch;

    const sessionById = new Map([[session.session_id, session]]);
    const branchById = new Map([[branch.branch_id, branch]]);

    const { result } = renderHook(
      () =>
        useTestNav({
          boardById: new Map(),
          sessionById,
          branchById,
          artifactById: new Map(),
        }),
      { wrapper: wrap('/b/somewhere/') }
    );

    act(() => {
      result.current.nav.goToSession(NEW_SESSION_ID);
    });

    expect(result.current.pathname).toBe(`/s/${NEW_SESSION_SHORT}/`);
  });

  it('does not blow up on same-URL re-click when session is unknown', () => {
    // Already on the target session URL but sessionById is empty (deep-link
    // load where data hasn't streamed in yet). The same-URL fallback used
    // to dereference `session.branch_id` — assert it's safe with a missing
    // session.
    const { result } = renderHook(
      () =>
        useTestNav({
          boardById: new Map(),
          sessionById: new Map(),
          branchById: new Map(),
          artifactById: new Map(),
        }),
      { wrapper: wrap(`/s/${NEW_SESSION_SHORT}/`) }
    );

    expect(() => {
      act(() => {
        result.current.nav.goToSession(NEW_SESSION_ID);
      });
    }).not.toThrow();

    // No navigation should have happened — already on this URL.
    expect(result.current.pathname).toBe(`/s/${NEW_SESSION_SHORT}/`);
  });
});

describe('useAppNavigation.goToBranch', () => {
  it('pushes /w/<short>/ even when the branch is NOT yet in branchById (just-created race)', () => {
    // Mirror the create-session race: handleCreateBranch (in App/App.tsx)
    // calls navigation.goToBranch immediately after the create() promise
    // resolves, but the `branches.created` socket event may not have
    // populated branchById yet. The URL push must fire anyway —
    // useUrlState's URL→state effect re-runs when the branch lands in
    // the map and drives selection + cross-board recenter from there.
    const branchById = new Map<string, Branch>();

    const { result } = renderHook(
      () =>
        useTestNav({
          boardById: new Map(),
          branchById,
        }),
      { wrapper: wrap('/b/somewhere/') }
    );

    expect(result.current.pathname).toBe('/b/somewhere/');

    act(() => {
      result.current.nav.goToBranch(NEW_BRANCH_ID);
    });

    expect(result.current.pathname).toBe(`/w/${NEW_BRANCH_SHORT}/`);
  });

  it('still navigates when the branch IS in branchById', () => {
    const branch = {
      branch_id: NEW_BRANCH_ID,
      board_id: EXISTING_BOARD_ID,
    } as Branch;

    const branchById = new Map([[branch.branch_id, branch]]);

    const { result } = renderHook(
      () =>
        useTestNav({
          boardById: new Map(),
          branchById,
        }),
      { wrapper: wrap('/b/somewhere/') }
    );

    act(() => {
      result.current.nav.goToBranch(NEW_BRANCH_ID);
    });

    expect(result.current.pathname).toBe(`/w/${NEW_BRANCH_SHORT}/`);
  });
});

describe('useAppNavigation.goToBoard', () => {
  it('pushes /b/<short>/ even when the board is NOT yet in boardById (just-created race)', () => {
    // handleCreateBoardFromDialog (in App/App.tsx) calls
    // navigation.goToBoard immediately after the create() promise
    // resolves. The `boards.created` socket event may land later — the
    // URL must still flip so the user lands on the new board.
    const boardById = new Map<string, { board_id: string; slug?: string }>();

    const { result } = renderHook(
      () =>
        useTestNav({
          boardById,
        }),
      { wrapper: wrap('/b/somewhere/') }
    );

    act(() => {
      result.current.nav.goToBoard(NEW_BOARD_ID);
    });

    // No slug yet — buildBoardPath falls back to the short id.
    expect(result.current.pathname).toBe(`/b/${NEW_BOARD_SHORT}/`);
  });

  it('prefers the slug when the board IS in boardById', () => {
    const boardById = new Map<string, { board_id: string; slug?: string }>([
      [NEW_BOARD_ID, { board_id: NEW_BOARD_ID, slug: 'my-board' }],
    ]);

    const { result } = renderHook(
      () =>
        useTestNav({
          boardById,
        }),
      { wrapper: wrap('/b/somewhere/') }
    );

    act(() => {
      result.current.nav.goToBoard(NEW_BOARD_ID);
    });

    expect(result.current.pathname).toBe('/b/my-board/');
  });
});
