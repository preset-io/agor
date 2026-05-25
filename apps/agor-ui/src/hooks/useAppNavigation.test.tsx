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
