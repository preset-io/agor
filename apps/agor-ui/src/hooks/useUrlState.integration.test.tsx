/**
 * Integration tests for `useUrlState` covering the deferred-resolution
 * contract that the create-session fix depends on.
 *
 * When the URL is `/s/<short>/` but the target session hasn't landed in
 * `sessionById` yet (typical of "navigate to a just-created session
 * before the socket `created` event arrives"), the hook must:
 *
 *   1. NOT call `onSessionChange` (nothing to resolve to).
 *   2. NOT rewrite the URL via the state→URL self-heal (would otherwise
 *      drop the unresolved session segment and revert to `/b/<board>/`).
 *
 * Once the session arrives in the map on a subsequent render, the hook
 * must resolve the URL and fire `onSessionChange(<full id>)`.
 *
 * This is the load-bearing complement to `useAppNavigation.goToSession`
 * pushing the URL unconditionally — together they make the "create
 * session → navigate immediately" path safe.
 */

import type { Branch, Session } from '@agor-live/client';
import { act, render } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { CanvasNavigationProvider } from '../contexts/CanvasNavigationContext';
import { type UseUrlStateOptions, useUrlState } from './useUrlState';

const SESSION_ID = '019e9999-0000-7000-8000-000000000001';
const SESSION_SHORT = '019e99990000700080000000';
const OTHER_SESSION_ID = '019eaaaa-0000-7000-8000-000000000001';
const BRANCH_ID = '019e8888-0000-7000-8000-000000000001';
const BOARD_ID = '019e7777-0000-7000-8000-000000000001';

/** Read the live pathname out of MemoryRouter into a shared ref so
 *  tests can assert that the state→URL self-heal did NOT fire. */
function HookHost({
  options,
  pathRef,
}: {
  options: UseUrlStateOptions;
  pathRef: { current: string };
}) {
  useUrlState(options);
  pathRef.current = useLocation().pathname;
  return null;
}

/** Mount HookHost inside the session-deep-link route so `useParams`
 *  inside `useUrlState` sees `sessionShortId`. Mirrors the routing
 *  shape declared in `apps/agor-ui/src/App.tsx`. */
function renderAt(pathname: string, options: UseUrlStateOptions) {
  const pathRef = { current: pathname };
  const tree = (opts: UseUrlStateOptions) => (
    <MemoryRouter initialEntries={[pathname]}>
      <CanvasNavigationProvider>
        <Routes>
          <Route
            path="/s/:sessionShortId/"
            element={<HookHost options={opts} pathRef={pathRef} />}
          />
          <Route path="/b/:boardParam/" element={<HookHost options={opts} pathRef={pathRef} />} />
          <Route path="/*" element={<HookHost options={opts} pathRef={pathRef} />} />
        </Routes>
      </CanvasNavigationProvider>
    </MemoryRouter>
  );
  const { rerender } = render(tree(options));
  return { pathRef, rerender: (next: UseUrlStateOptions) => rerender(tree(next)) };
}

function baseOptions(overrides: Partial<UseUrlStateOptions> = {}): UseUrlStateOptions {
  return {
    currentBoardId: BOARD_ID,
    currentSessionId: null,
    boardById: new Map([[BOARD_ID, { board_id: BOARD_ID, slug: 'board' }]]),
    sessionById: new Map(),
    branchById: new Map(),
    artifactById: new Map(),
    onBoardChange: vi.fn(),
    onSessionChange: vi.fn(),
    ...overrides,
  };
}

describe('useUrlState — deferred session resolution', () => {
  it('does not fire onSessionChange OR rewrite the URL while the session is missing', () => {
    const onSessionChange = vi.fn();
    const onBoardChange = vi.fn();

    // URL points at /s/<short>/, but sessionById is empty (simulates the
    // window between create() resolving and the socket `created` event).
    const { pathRef } = renderAt(
      `/s/${SESSION_SHORT}/`,
      baseOptions({
        sessionById: new Map(),
        branchById: new Map(),
        onSessionChange,
        onBoardChange,
      })
    );

    expect(onSessionChange).not.toHaveBeenCalled();
    expect(onBoardChange).not.toHaveBeenCalled();
    // State→URL self-heal must NOT erase the unresolved session segment
    // back to /b/<board>/ — that was the original regression.
    expect(pathRef.current).toBe(`/s/${SESSION_SHORT}/`);
  });

  it('fires onSessionChange and preserves the URL once the session arrives in sessionById', () => {
    const onSessionChange = vi.fn();
    const onBoardChange = vi.fn();

    const initial = baseOptions({
      sessionById: new Map(),
      branchById: new Map(),
      onSessionChange,
      onBoardChange,
    });

    const { pathRef, rerender } = renderAt(`/s/${SESSION_SHORT}/`, initial);
    expect(onSessionChange).not.toHaveBeenCalled();

    // Socket `created` event lands: session + branch flow into the hook.
    const session = { session_id: SESSION_ID, branch_id: BRANCH_ID } as Session;
    const branch = { branch_id: BRANCH_ID, board_id: BOARD_ID } as Branch;
    const resolved = baseOptions({
      sessionById: new Map([[session.session_id, session]]),
      branchById: new Map([[branch.branch_id, branch]]),
      onSessionChange,
      onBoardChange,
    });

    act(() => {
      rerender(resolved);
    });

    expect(onSessionChange).toHaveBeenCalledWith(SESSION_ID);
    expect(pathRef.current).toBe(`/s/${SESSION_SHORT}/`);
  });

  it('explicit session URLs win over an already-selected/restored session', () => {
    const onSessionChange = vi.fn();
    const onBoardChange = vi.fn();

    const requestedSession = { session_id: SESSION_ID, branch_id: BRANCH_ID } as Session;
    const restoredSession = { session_id: OTHER_SESSION_ID, branch_id: BRANCH_ID } as Session;
    const branch = { branch_id: BRANCH_ID, board_id: BOARD_ID } as Branch;

    renderAt(
      `/s/${SESSION_SHORT}/`,
      baseOptions({
        currentSessionId: OTHER_SESSION_ID,
        sessionById: new Map([
          [requestedSession.session_id, requestedSession],
          [restoredSession.session_id, restoredSession],
        ]),
        branchById: new Map([[branch.branch_id, branch]]),
        onSessionChange,
        onBoardChange,
      })
    );

    expect(onSessionChange).toHaveBeenCalledWith(SESSION_ID);
    expect(onBoardChange).not.toHaveBeenCalled();
  });
});
