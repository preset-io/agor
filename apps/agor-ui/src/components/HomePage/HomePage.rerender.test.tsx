import type { Board, Session } from '@agor-live/client';
import { act, render, waitFor } from '@testing-library/react';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_MAPS } from '../../store/agorMaps';
import { agorStore } from '../../store/agorStore';
import { HomePage } from './HomePage';

// HomePage renders its sections unconditionally. HomeBoardsSection is mocked to a
// bare render counter so its invocation count is a faithful proxy for how many
// times HomePage itself rendered.
let homeRenders = 0;

vi.mock('./HomeBoardsSection', () => ({
  HomeBoardsSection: () => {
    homeRenders += 1;
    return null;
  },
}));
vi.mock('./HomeSessionsSection', () => ({
  HomeSessionsSection: () => null,
}));
vi.mock('./HomeActivitySection', () => ({
  HomeActivitySection: () => null,
}));
vi.mock('./HomeKnowledgeSection', () => ({
  HomeKnowledgeSection: () => null,
}));

const board = { board_id: 'board-1', name: 'Board', slug: 'board' } as unknown as Board;

const session = {
  session_id: 'session-1',
  status: 'completed',
  archived: false,
  genealogy: {},
  agentic_tool: 'claude',
  last_updated: '2026-07-01T10:00:00.000Z',
} as unknown as Session;

function renderHome() {
  return render(
    <MemoryRouter basename="/ui" initialEntries={['/ui/']}>
      <HomePage
        client={null}
        onBoardClick={() => {}}
        onBranchClick={() => {}}
        onSessionClick={() => {}}
        onOpenCreateDialog={() => {}}
        onOpenSettings={() => {}}
      />
    </MemoryRouter>
  );
}

describe('HomePage store-selector re-render isolation', () => {
  beforeEach(() => {
    homeRenders = 0;
    agorStore.setState({ ...EMPTY_MAPS });
  });

  it('a patch to a slice HomePage does not select leaves it un-rendered', async () => {
    renderHome();

    await waitFor(() => {
      expect(homeRenders).toBeGreaterThanOrEqual(1);
    });
    const baseline = homeRenders;

    // Patch a slice HomePage never selects (comments). zustand notifies every
    // subscriber, but each of HomePage's selected slices keeps its reference, so
    // its subscriptions stay quiet and it does not re-render.
    act(() => {
      agorStore.setState({ commentById: new Map([['c-1', { board_id: 'board-1' } as never]]) });
    });

    expect(homeRenders).toBe(baseline);
  });

  it('a session patch does not re-render HomePage', async () => {
    // Seed BEFORE the baseline so the patch below flips nothing derived
    // anywhere in the subtree (e.g. the onboarding gate's "hasSessions").
    agorStore.setState({ sessionById: new Map([[session.session_id, session]]) });
    renderHome();

    await waitFor(() => {
      expect(homeRenders).toBeGreaterThanOrEqual(1);
    });
    const baseline = homeRenders;

    // A streaming-style patch: same session, new object identity. HomePage
    // selects no session-shaped slice (sections subscribe themselves), so the
    // page must stay quiet.
    act(() => {
      agorStore.setState({
        sessionById: new Map([
          [session.session_id, { ...session, description: 'streamed token' } as Session],
        ]),
      });
    });

    expect(homeRenders).toBe(baseline);
  });

  it('a patch to a selected slice (boards) re-renders HomePage', async () => {
    renderHome();

    await waitFor(() => {
      expect(homeRenders).toBeGreaterThanOrEqual(1);
    });
    const baseline = homeRenders;

    // Contrast: HomePage subscribes to boardById (it derives the boards section
    // from it), so a boards patch MUST wake it — proving the subscription is
    // live and the isolation above is meaningful.
    act(() => {
      agorStore.setState({ boardById: new Map([[board.board_id, board]]) });
    });

    await waitFor(() => {
      expect(homeRenders).toBeGreaterThan(baseline);
    });
  });
});

// Mirror of App's `useStableCallback`: freeze a handler's identity across renders
// while delegating to the latest impl via a ref. App stabilizes HomePage's
// callbacks the same way, so reproducing it exercises the real contract.
function useStableCallback<TFn extends (...args: never[]) => unknown>(
  callback: TFn | undefined
): TFn | undefined {
  const callbackRef = useRef(callback);
  useLayoutEffect(() => {
    callbackRef.current = callback;
  });
  const stable = useCallback(((...args: never[]) => callbackRef.current?.(...args)) as TFn, []);
  return callback ? stable : undefined;
}

// Lets a test trigger a parent re-render without touching HomePage's props.
let triggerParentRerender: () => void = () => {};

// The complete prop set App passes, minus the one callback the harness flips.
// Module-level so the identities stay stable across parent re-renders — the
// whole point of the guard is that NOTHING HomePage receives churns, so
// React.memo can bail out. A reintroduced unstable prop here (e.g. a fresh
// array) would start failing the stable-props bailout below.
const noop = () => {};
const EMPTY_RECENT: string[] = [];
const STABLE_HOME_PROPS = {
  client: null,
  connected: true,
  recentBoardIds: EMPTY_RECENT,
  currentUserId: 'u1',
  onBoardClick: noop,
  onBranchClick: noop,
  onOpenCreateDialog: noop,
  onOpenSettings: noop,
} as const;

// Parent harness rendering the REAL memo'd HomePage the way App does. The
// flipped `onSessionClick` flows through `useStableCallback` when `stabilize` is
// true and is a fresh arrow otherwise, so the same harness proves both halves of
// the guard while every other prop stays referentially stable. A `useState` bump
// re-renders THIS parent without touching any prop value.
function ParentHarness({ stabilize }: { stabilize: boolean }) {
  const [, setTick] = useState(0);
  triggerParentRerender = () => setTick((tick) => tick + 1);

  const sessionImpl = () => {};
  const stableSession = useStableCallback(sessionImpl);
  const onSessionClick = stabilize ? stableSession : sessionImpl;

  return (
    <MemoryRouter basename="/ui" initialEntries={['/ui/']}>
      <HomePage {...STABLE_HOME_PROPS} onSessionClick={onSessionClick} />
    </MemoryRouter>
  );
}

describe('HomePage memo + prop-stabilization re-render bailout', () => {
  beforeEach(() => {
    homeRenders = 0;
    triggerParentRerender = () => {};
    agorStore.setState({ ...EMPTY_MAPS });
  });

  it('a parent re-render does not re-render the memo’d HomePage when props are stable', async () => {
    render(<ParentHarness stabilize={true} />);

    await waitFor(() => {
      expect(homeRenders).toBeGreaterThanOrEqual(1);
    });
    const baseline = homeRenders;

    // Parent re-renders without changing any prop value or touching the store.
    // The memo bailout must keep HomePage at its baseline render count; if
    // `React.memo` were removed this assertion would fail (count would climb).
    act(() => {
      triggerParentRerender();
    });

    expect(homeRenders).toBe(baseline);
  });

  it('a parent re-render DOES re-render HomePage when a prop identity churns', async () => {
    render(<ParentHarness stabilize={false} />);

    await waitFor(() => {
      expect(homeRenders).toBeGreaterThanOrEqual(1);
    });
    const baseline = homeRenders;

    // Contrast: a fresh `onSessionClick` each parent render defeats the memo, so
    // HomePage must re-render — proving the bailout above is meaningful and not
    // just an artifact of the parent never re-rendering.
    act(() => {
      triggerParentRerender();
    });

    await waitFor(() => {
      expect(homeRenders).toBeGreaterThan(baseline);
    });
  });
});
