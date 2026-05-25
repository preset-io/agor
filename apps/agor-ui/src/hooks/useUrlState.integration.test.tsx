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
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { CanvasNavigationProvider } from '../contexts/CanvasNavigationContext';
import { type UseUrlStateOptions, useUrlState } from './useUrlState';

const SESSION_ID = '019e9999-0000-7000-8000-000000000001';
const SESSION_SHORT = '019e99990000700080000000';
const BRANCH_ID = '019e8888-0000-7000-8000-000000000001';
const BOARD_ID = '019e7777-0000-7000-8000-000000000001';

function HookHost({ options }: { options: UseUrlStateOptions }) {
  useUrlState(options);
  return null;
}

/** Mount HookHost inside the session-deep-link route so `useParams`
 *  inside `useUrlState` sees `sessionShortId`. Mirrors the routing
 *  shape declared in `apps/agor-ui/src/App.tsx`. */
function renderAt(pathname: string, options: UseUrlStateOptions) {
  const ui = (
    <MemoryRouter initialEntries={[pathname]}>
      <CanvasNavigationProvider>
        <Routes>
          <Route path="/s/:sessionShortId/" element={<HookHost options={options} />} />
          <Route path="/b/:boardParam/" element={<HookHost options={options} />} />
          <Route path="/*" element={<HookHost options={options} />} />
        </Routes>
      </CanvasNavigationProvider>
    </MemoryRouter>
  );
  return render(ui);
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
  it('does not fire onSessionChange while the session is missing from sessionById', () => {
    const onSessionChange = vi.fn();
    const onBoardChange = vi.fn();

    // URL points at /s/<short>/, but sessionById is empty (simulates the
    // window between create() resolving and the socket `created` event).
    renderAt(
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
  });

  it('fires onSessionChange once the session arrives in sessionById', () => {
    const onSessionChange = vi.fn();
    const onBoardChange = vi.fn();

    const initial = baseOptions({
      sessionById: new Map(),
      branchById: new Map(),
      onSessionChange,
      onBoardChange,
    });

    const { rerender } = renderAt(`/s/${SESSION_SHORT}/`, initial);
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
      rerender(
        <MemoryRouter initialEntries={[`/s/${SESSION_SHORT}/`]}>
          <CanvasNavigationProvider>
            <Routes>
              <Route path="/s/:sessionShortId/" element={<HookHost options={resolved} />} />
              <Route path="/b/:boardParam/" element={<HookHost options={resolved} />} />
              <Route path="/*" element={<HookHost options={resolved} />} />
            </Routes>
          </CanvasNavigationProvider>
        </MemoryRouter>
      );
    });

    expect(onSessionChange).toHaveBeenCalledWith(SESSION_ID);
  });
});
