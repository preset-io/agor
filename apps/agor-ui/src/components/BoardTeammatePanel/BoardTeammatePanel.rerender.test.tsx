import type { AgorClient, Board, Branch, Repo, User } from '@agor-live/client';
import { act, render, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_MAPS } from '../../store/agorMaps';
import { agorStore } from '../../store/agorStore';
import { BoardTeammatePanel } from './BoardTeammatePanel';

// BoardTeammatePanel renders the active tab's content. With activeTab="comments"
// the comments pane mounts CommentsPanel, mocked here to a bare render counter so
// its invocation count is a faithful proxy for how many times the (memoized)
// BoardTeammatePanel itself rendered.
let panelRenders = 0;

vi.mock('../CommentsPanel', () => ({
  CommentsPanel: () => {
    panelRenders += 1;
    return null;
  },
}));

const board = { board_id: 'board-1', name: 'Board', slug: 'board' } as unknown as Board;
const branch = {
  branch_id: 'branch-1',
  repo_id: 'repo-1',
  name: 'teammate',
  filesystem_status: 'ready',
  created_by: 'user-creator',
} as unknown as Branch;
const repo = { repo_id: 'repo-1', slug: 'preset-io/agor' } as unknown as Repo;
const owner = { user_id: 'user-owner', name: 'owner', role: 'member' } as unknown as User;

// A real (stable) client so the panel's owners effect actually runs: with
// `client={null}` it early-returns and the guard proves nothing about it.
const ownersFind = vi.fn(async () => [owner]);
const ownersService = { find: ownersFind, on: () => {}, off: () => {} };
const client = { service: () => ownersService } as unknown as AgorClient;

// Let the owners request settle so its state update is not miscounted as a
// re-render caused by the parent.
async function settleOwnersFetch() {
  await waitFor(() => {
    expect(ownersFind).toHaveBeenCalled();
  });
  await act(async () => {});
}

// Mirror of App's `useStableCallback`: freeze a handler's identity across renders
// while delegating to the latest impl via a ref. The inner App stabilizes the
// panel's callbacks the same way, so reproducing it exercises the real contract.
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

// Lets a test trigger a parent re-render without touching the panel's props.
let triggerParentRerender: () => void = () => {};

// The complete prop set App passes, minus the one callback the harness flips.
// Module-level so the identities stay stable across parent re-renders — the whole
// point of the guard is that NOTHING the panel receives churns, so React.memo can
// bail out. A reintroduced unstable prop here would start failing the bailout.
const noop = () => {};
const asyncNoop = async () => {};
const STABLE_PANEL_PROPS = {
  client,
  board,
  activeTab: 'comments' as const,
  onTabChange: noop,
  primaryTeammateBranch: branch,
  primaryTeammateRepo: repo,
  primaryTeammateInaccessible: false,
  currentUserId: 'u1',
  selectedSessionId: null,
  onCreateSession: noop,
  onForkSession: asyncNoop,
  onSpawnSession: asyncNoop,
  onArchiveOrDelete: noop,
  onOpenSettings: noop,
  onOpenSessionSettings: noop,
  onOpenTerminal: noop,
  onStartEnvironment: noop,
  onStopEnvironment: noop,
  onViewLogs: noop,
  onNukeEnvironment: noop,
  onExecuteScheduleNow: asyncNoop,
  onSendComment: noop,
  onReplyComment: noop,
  onResolveComment: noop,
  onToggleReaction: noop,
  onDeleteComment: noop,
  hoveredCommentId: null,
  selectedCommentId: null,
  onCollapse: noop,
} as const;

// Parent harness rendering the REAL memo'd BoardTeammatePanel the way App does.
// The flipped `onSessionClick` flows through `useStableCallback` when `stabilize`
// is true and is a fresh arrow otherwise, so the same harness proves both halves
// of the guard while every other prop stays referentially stable. A `useState`
// bump re-renders THIS parent without touching any prop value.
function ParentHarness({ stabilize }: { stabilize: boolean }) {
  const [, setTick] = useState(0);
  triggerParentRerender = () => setTick((tick) => tick + 1);

  const sessionImpl = (_sessionId: string) => {};
  const stableSession = useStableCallback(sessionImpl);
  const onSessionClick = stabilize ? stableSession : sessionImpl;

  return (
    <AntApp>
      <BoardTeammatePanel {...STABLE_PANEL_PROPS} onSessionClick={onSessionClick} />
    </AntApp>
  );
}

describe('BoardTeammatePanel memo + prop-stabilization re-render bailout', () => {
  beforeEach(() => {
    panelRenders = 0;
    triggerParentRerender = () => {};
    ownersFind.mockClear();
    agorStore.setState({ ...EMPTY_MAPS });
  });

  it('a parent re-render does not re-render the memo’d BoardTeammatePanel when props are stable', async () => {
    render(<ParentHarness stabilize={true} />);

    await waitFor(() => {
      expect(panelRenders).toBeGreaterThanOrEqual(1);
    });
    await settleOwnersFetch();
    const baseline = panelRenders;

    // Parent re-renders without changing any prop value or touching the store.
    // The memo bailout must keep the panel at its baseline render count; if
    // `React.memo` were removed this assertion would fail (count would climb).
    act(() => {
      triggerParentRerender();
    });

    expect(panelRenders).toBe(baseline);
  });

  it('a parent re-render DOES re-render BoardTeammatePanel when a prop identity churns', async () => {
    render(<ParentHarness stabilize={false} />);

    await waitFor(() => {
      expect(panelRenders).toBeGreaterThanOrEqual(1);
    });
    const baseline = panelRenders;

    // Contrast: a fresh `onSessionClick` each parent render defeats the memo, so
    // the panel must re-render — proving the bailout above is meaningful and not
    // just an artifact of the parent never re-rendering.
    act(() => {
      triggerParentRerender();
    });

    await waitFor(() => {
      expect(panelRenders).toBeGreaterThan(baseline);
    });
  });

  it('does not refetch branch owners when unrelated store slices churn', async () => {
    render(<ParentHarness stabilize={true} />);
    await settleOwnersFetch();
    expect(ownersFind).toHaveBeenCalledTimes(1);

    // A patched branch row hands out a new Branch identity, and the user map is
    // replaced wholesale on hydration. Neither changes who owns the branch, so
    // neither may re-fire the owners request.
    await act(async () => {
      agorStore.setState({
        branchById: new Map([[branch.branch_id, { ...branch }]]),
        userById: new Map([[owner.user_id, owner]]),
      });
    });

    expect(ownersFind).toHaveBeenCalledTimes(1);
  });
});
