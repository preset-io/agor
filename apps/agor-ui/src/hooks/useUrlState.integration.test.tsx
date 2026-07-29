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
import {
  CanvasNavigationProvider,
  type RecenterMapFn,
  useRegisterRecenter,
} from '../contexts/CanvasNavigationContext';
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
  recenter,
}: {
  options: UseUrlStateOptions;
  pathRef: { current: string };
  recenter?: RecenterMapFn;
}) {
  // Register a recenter impl so the camera channel isn't a no-op — lets
  // tests assert whether session URLs fire (or suppress) a recenter.
  useRegisterRecenter(recenter ?? (() => true));
  useUrlState(options);
  pathRef.current = useLocation().pathname;
  return null;
}

/** Mount HookHost inside the session-deep-link route so `useParams`
 *  inside `useUrlState` sees `sessionShortId`. Mirrors the routing
 *  shape declared in `apps/agor-ui/src/App.tsx`. */
function renderAt(pathname: string, options: UseUrlStateOptions, recenter?: RecenterMapFn) {
  const pathRef = { current: pathname };
  const tree = (opts: UseUrlStateOptions) => (
    <MemoryRouter initialEntries={[pathname]}>
      <CanvasNavigationProvider>
        <Routes>
          <Route
            path="/s/:sessionShortId/"
            element={<HookHost options={opts} pathRef={pathRef} recenter={recenter} />}
          />
          <Route
            path="/b/:boardParam/"
            element={<HookHost options={opts} pathRef={pathRef} recenter={recenter} />}
          />
          <Route
            path="/w/:branchShortId/"
            element={<HookHost options={opts} pathRef={pathRef} recenter={recenter} />}
          />
          <Route
            path="/*"
            element={<HookHost options={opts} pathRef={pathRef} recenter={recenter} />}
          />
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

  it('opens a direct session URL even when the session branch is not in active branchById', () => {
    const onSessionChange = vi.fn();
    const onBoardChange = vi.fn();
    const session = { session_id: SESSION_ID, branch_id: BRANCH_ID, archived: true } as Session;

    const { pathRef } = renderAt(
      `/s/${SESSION_SHORT}/`,
      baseOptions({
        sessionById: new Map([[session.session_id, session]]),
        branchById: new Map(),
        onSessionChange,
        onBoardChange,
      })
    );

    expect(onSessionChange).toHaveBeenCalledWith(SESSION_ID);
    expect(onBoardChange).not.toHaveBeenCalled();
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

describe('useUrlState — navigating away from a session clears selection', () => {
  // Covers the mechanism `App.tsx`'s handleQuickStartSession relies on:
  // clicking "Add session" while a different session is open calls
  // `navigation.goToBranch(branchId)` specifically so the URL stops
  // pointing at a session — this is what lets `selectedSessionId` (and
  // therefore the render ternary that prefers an open SessionPanel over
  // the tile picker) actually clear. Without this, "Add session" was a
  // silent no-op whenever a session was already open.
  it('fires onSessionChange(null) when the URL moves from a session to a branch', () => {
    const onSessionChange = vi.fn();
    const onBoardChange = vi.fn();
    const branch = { branch_id: BRANCH_ID, board_id: BOARD_ID } as Branch;

    // Landing directly on a branch URL while app state still thinks a
    // session is selected (from before the navigation) mirrors what a
    // fresh render sees the instant goToBranch's history push commits.
    renderAt(`/w/${BRANCH_ID}/`, {
      ...baseOptions({
        currentSessionId: SESSION_ID,
        branchById: new Map([[branch.branch_id, branch]]),
        onSessionChange,
        onBoardChange,
      }),
    });

    expect(onSessionChange).toHaveBeenCalledWith(null);
  });

  it('does not fire onSessionChange when no session was selected to begin with', () => {
    const onSessionChange = vi.fn();
    const onBoardChange = vi.fn();
    const branch = { branch_id: BRANCH_ID, board_id: BOARD_ID } as Branch;

    renderAt(`/w/${BRANCH_ID}/`, {
      ...baseOptions({
        currentSessionId: null,
        branchById: new Map([[branch.branch_id, branch]]),
        onSessionChange,
        onBoardChange,
      }),
    });

    expect(onSessionChange).not.toHaveBeenCalled();
  });
});

describe('useUrlState — session selection recenters onto the session row', () => {
  const OTHER_BOARD_ID = '019e6666-0000-7000-8000-000000000001';

  it('recenters with the session sub-target on same-board selection (not the bare card)', () => {
    vi.useFakeTimers();
    try {
      const recenter = vi.fn<RecenterMapFn>(() => true);
      const session = { session_id: SESSION_ID, branch_id: BRANCH_ID } as Session;
      const branch = { branch_id: BRANCH_ID, board_id: BOARD_ID } as Branch;

      // currentBoardId === the session's board → same-board selection.
      // The recenter must carry the session id so the canvas aims at the
      // session's row inside the card instead of jerking to the card head
      // (the reported bug), plus `ensureVisible` so the pan is conditional
      // — the camera holds still when the row is already on screen.
      renderAt(
        `/s/${SESSION_SHORT}/`,
        baseOptions({
          currentBoardId: BOARD_ID,
          sessionById: new Map([[session.session_id, session]]),
          branchById: new Map([[branch.branch_id, branch]]),
        }),
        recenter
      );

      // Drain the ~50ms deferred-recenter timer.
      act(() => {
        vi.advanceTimersByTime(100);
      });

      expect(recenter).toHaveBeenCalledWith(BRANCH_ID, {
        sessionId: SESSION_ID,
        ensureVisible: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('recenters with the session sub-target when a session link switches boards', () => {
    vi.useFakeTimers();
    try {
      const recenter = vi.fn<RecenterMapFn>(() => true);
      const session = { session_id: SESSION_ID, branch_id: BRANCH_ID } as Session;
      const branch = { branch_id: BRANCH_ID, board_id: BOARD_ID } as Branch;

      // currentBoardId differs from the session's board → cross-board hop,
      // so the user needs the camera to land on the session's row on the
      // board they just landed on.
      renderAt(
        `/s/${SESSION_SHORT}/`,
        baseOptions({
          currentBoardId: OTHER_BOARD_ID,
          boardById: new Map([
            [BOARD_ID, { board_id: BOARD_ID, slug: 'board' }],
            [OTHER_BOARD_ID, { board_id: OTHER_BOARD_ID, slug: 'other' }],
          ]),
          sessionById: new Map([[session.session_id, session]]),
          branchById: new Map([[branch.branch_id, branch]]),
        }),
        recenter
      );

      act(() => {
        vi.advanceTimersByTime(100);
      });

      expect(recenter).toHaveBeenCalledWith(BRANCH_ID, {
        sessionId: SESSION_ID,
        ensureVisible: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
