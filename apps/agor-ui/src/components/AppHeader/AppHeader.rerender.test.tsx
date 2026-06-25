import type { Board, Repo, User } from '@agor-live/client';
import { act, render, waitFor } from '@testing-library/react';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_MAPS } from '../../store/agorMaps';
import { agorStore } from '../../store/agorStore';
import { AppHeader } from './AppHeader';

const mockNavigate = vi.hoisted(() => vi.fn());

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

vi.mock('../../contexts/ConnectionContext', () => ({
  useConnectionDisabled: () => false,
}));

// AppHeader's own render count. ConnectionStatus is rendered unconditionally on
// every AppHeader render and is NOT memoized in this mock, so its invocation
// count is a faithful proxy for how many times the memoized AppHeader rendered.
let headerRenders = 0;

vi.mock('../BoardSwitcher', () => ({
  BoardSwitcher: () => <div data-testid="board-switcher" />,
}));
vi.mock('../BrandLogo', () => ({
  BrandLogo: () => <div data-testid="brand-logo" />,
}));
vi.mock('../ConnectionStatus', () => ({
  ConnectionStatus: () => {
    headerRenders += 1;
    return null;
  },
}));
vi.mock('../GlobalSearch', () => ({
  GlobalSearch: () => <div data-testid="global-search" />,
}));
vi.mock('../GlobalUserMenu', () => ({
  GlobalUserMenu: () => <div data-testid="global-user-menu" />,
}));
vi.mock('../MarkdownRenderer', () => ({
  MarkdownRenderer: () => <div data-testid="markdown-renderer" />,
}));
vi.mock('../ThemeSwitcher', () => ({
  ThemeSwitcher: () => <div data-testid="theme-switcher" />,
}));
vi.mock('./GlobalPresenceFacepile', () => ({
  GlobalPresenceFacepile: () => <div data-testid="presence-facepile" />,
}));

const board = { board_id: 'board-1', name: 'Board', slug: 'board' } as unknown as Board;
const repo = { repo_id: 'repo-1', name: 'repo', slug: 'repo' } as unknown as Repo;

function renderHeader(node: React.ReactNode) {
  return render(
    <MemoryRouter basename="/ui" initialEntries={['/ui/']}>
      {node}
    </MemoryRouter>
  );
}

describe('AppHeader store-selector re-render isolation', () => {
  beforeEach(() => {
    headerRenders = 0;
    agorStore.setState({ ...EMPTY_MAPS });
  });

  it('a patch to a slice AppHeader does not select leaves the header un-rendered', async () => {
    renderHeader(<AppHeader />);

    await waitFor(() => {
      expect(headerRenders).toBeGreaterThanOrEqual(1);
    });
    const baseline = headerRenders;

    // Patch a slice AppHeader never selects (repos). zustand notifies every
    // subscriber, but each of AppHeader's selector slices keeps its reference,
    // so its subscriptions stay quiet and it does not re-render.
    act(() => {
      agorStore.setState({ repoById: new Map([[repo.repo_id, repo]]) });
    });

    expect(headerRenders).toBe(baseline);
  });

  it('a patch to a selected slice (boards) re-renders the header', async () => {
    renderHeader(<AppHeader />);

    await waitFor(() => {
      expect(headerRenders).toBeGreaterThanOrEqual(1);
    });
    const baseline = headerRenders;

    // Contrast: AppHeader subscribes to boardById (it derives the board list
    // from it), so a boards patch MUST wake the header — proving the
    // subscription is live and the isolation above is meaningful.
    act(() => {
      agorStore.setState({ boardById: new Map([[board.board_id, board]]) });
    });

    await waitFor(() => {
      expect(headerRenders).toBeGreaterThan(baseline);
    });
  });
});

// Mirror of App's `useStableCallback`: freeze a handler's identity across renders
// while delegating to the latest impl via a ref. This is the exact mechanism App
// uses to keep AppHeader's action handlers stable, so reproducing it here
// exercises the real prop-stabilization contract.
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

// Lets a test trigger a parent re-render without touching AppHeader's props.
let triggerParentRerender: () => void = () => {};

// Stable identities for every NON-flipped AppHeader prop, mirroring App's render
// site: handlers are frozen (App routes them through useStableCallback) and the
// scalar props are constants. Module-level so they keep their identity across
// parent re-renders — the whole point of the guard is that NOTHING AppHeader
// receives churns, so React.memo can bail out.
const HARNESS_USER = { user_id: 'u1', name: 'User', email: 'u@example.test' } as unknown as User;
const noop = () => {};

// The complete prop set App passes, minus the one handler the harness flips. If a
// future change reintroduces an unstable prop here (e.g. a fresh array), the
// all-stable assertion below starts failing — that's the regression this guards.
const STABLE_HEADER_PROPS = {
  user: HARNESS_USER,
  presenceClient: null,
  currentUserId: 'u1',
  connected: true,
  connecting: false,
  onMenuClick: noop,
  onCommentsClick: noop,
  onEventStreamClick: noop,
  onUserSettingsClick: noop,
  onThemeEditorClick: noop,
  onLogout: noop,
  onRetryConnection: noop,
  currentBoardName: 'Board',
  currentBoardIcon: '📋',
  unreadCommentsCount: 0,
  eventStreamEnabled: true,
  hasUserMentions: false,
  currentBoardId: 'board-1',
  onBoardChange: noop,
  onHomeClick: noop,
  onUserClick: noop,
  instanceLabel: 'Test Instance',
} as const;

// Parent harness that renders the REAL memo'd AppHeader the way App does, with
// the FULL prop set. One handler (`onSettingsClick`) flows through
// `useStableCallback` when `stabilize` is true and is passed as a fresh arrow
// otherwise — so the same harness proves both halves of the guard while every
// other prop stays referentially stable. A `useState` bump re-renders THIS
// parent without touching any prop value.
function ParentHarness({ stabilize }: { stabilize: boolean }) {
  const [, setTick] = useState(0);
  triggerParentRerender = () => setTick((tick) => tick + 1);

  // Fresh identity on every parent render unless we freeze it via
  // useStableCallback (mirrors App's plain-const → stabilized handlers).
  const settingsImpl = () => {};
  const stableSettings = useStableCallback(settingsImpl);
  const onSettingsClick = stabilize ? stableSettings : settingsImpl;

  return (
    <MemoryRouter basename="/ui" initialEntries={['/ui/']}>
      <AppHeader {...STABLE_HEADER_PROPS} onSettingsClick={onSettingsClick} />
    </MemoryRouter>
  );
}

describe('AppHeader memo + handler-stabilization re-render bailout', () => {
  beforeEach(() => {
    headerRenders = 0;
    triggerParentRerender = () => {};
    agorStore.setState({ ...EMPTY_MAPS });
  });

  it('a parent re-render does not re-render the memo’d AppHeader when handlers are stabilized', async () => {
    render(<ParentHarness stabilize={true} />);

    await waitFor(() => {
      expect(headerRenders).toBeGreaterThanOrEqual(1);
    });
    const baseline = headerRenders;

    // Re-render the PARENT. Every AppHeader prop kept its identity (the
    // stabilized settings handler), so React.memo bails out and the header
    // stays put.
    act(() => {
      triggerParentRerender();
    });

    // Regression guard: FAILS if `memo(AppHeaderInner)` is removed (parent
    // re-render always re-renders the header) OR if the handler is destabilized
    // (a fresh prop identity defeats the shallow memo).
    expect(headerRenders).toBe(baseline);
  });

  it('a parent re-render DOES re-render the header when a handler identity is not stabilized', async () => {
    // Contrast case: proves the guard above is meaningful. The same parent,
    // passing a fresh-identity settings handler each render, breaks the memo
    // shallow compare — so the bailout genuinely depends on stabilization.
    render(<ParentHarness stabilize={false} />);

    await waitFor(() => {
      expect(headerRenders).toBeGreaterThanOrEqual(1);
    });
    const baseline = headerRenders;

    act(() => {
      triggerParentRerender();
    });

    await waitFor(() => {
      expect(headerRenders).toBeGreaterThan(baseline);
    });
  });
});
