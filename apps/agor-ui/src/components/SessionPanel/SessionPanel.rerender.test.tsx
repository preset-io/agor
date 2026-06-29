import type { Branch, Session, User } from '@agor-live/client';
import { act, render, waitFor } from '@testing-library/react';
import { App as AntdApp } from 'antd';
import { type ReactNode, useCallback, useLayoutEffect, useRef, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppActionsProvider } from '../../contexts/AppActionsContext';
import { ConnectionProvider } from '../../contexts/ConnectionContext';
import { EMPTY_MAPS } from '../../store/agorMaps';
import { sessionPatched } from '../../store/agorRealtimeActions';
import { agorStore } from '../../store/agorStore';
import { SessionPanel } from './index';

// ── Render counter ───────────────────────────────────────────────────────────
// ToolIcon is rendered inline in SessionPanel's header on every SessionPanel
// render, so mocking it to bump a counter is a faithful proxy for "did
// SessionPanel re-render?". The heavy children (content, footer controls,
// modals) are mocked to no-ops so the test isolates the memo + selector
// boundary rather than exercising the full conversation subtree.
let sessionPanelRenders = 0;

vi.mock('../ToolIcon', () => ({
  __esModule: true,
  ToolIcon: () => {
    sessionPanelRenders += 1;
    return <div data-testid="tool-icon" />;
  },
}));

// SessionPanelContent is independently memo'd and pulls in ConversationView /
// EmbeddedTerminal; stub it so the panel renders without that subtree.
vi.mock('./SessionPanelContent', () => ({
  __esModule: true,
  SessionPanelContent: () => <div data-testid="session-panel-content" />,
}));

// Footer + modal children that need wider context / a live client. None are
// under test here; stub them to keep the harness focused on SessionPanel.
vi.mock('./SessionAttachmentsDropdown', () => ({
  __esModule: true,
  SessionAttachmentsDropdown: () => null,
}));
vi.mock('./SessionMcpFooterControl', () => ({
  __esModule: true,
  SessionMcpFooterControl: () => null,
}));
vi.mock('./SessionRunSettingsPopover', () => ({
  __esModule: true,
  SessionRunSettingsPopover: () => null,
}));
vi.mock('../AutocompleteTextarea', () => ({
  __esModule: true,
  AutocompleteTextarea: () => null,
}));
vi.mock('../ForkSpawnModal/ForkSpawnModal', () => ({
  __esModule: true,
  ForkSpawnModal: () => null,
}));
vi.mock('../FileUpload', () => ({
  __esModule: true,
  FileUpload: () => null,
  FileUploadButton: () => null,
}));
vi.mock('../SessionIds', () => ({
  __esModule: true,
  SessionIdsButton: () => null,
  SessionIdsList: () => null,
}));
vi.mock('../MCPServer', () => ({
  __esModule: true,
  MCPServerPill: () => null,
}));
vi.mock('../metadata', () => ({
  __esModule: true,
  CreatedByTag: () => null,
}));

const SESSION_ID = 'sA';
const OTHER_SESSION_ID = 'sB';
const USER_ID = 'user-1';

const makeSession = (id: string, status: string): Session =>
  ({
    session_id: id,
    branch_id: 'A',
    status,
    agentic_tool: 'claude-code',
    archived: false,
    created_at: '2026-06-24T00:00:00.000Z',
    last_updated: '2026-06-24T00:00:00.000Z',
  }) as unknown as Session;

const sessionA = makeSession(SESSION_ID, 'running');
const branch = { branch_id: 'A', repo_id: 'repo-1', name: 'A' } as unknown as Branch;
const user = { user_id: USER_ID, name: 'User' } as unknown as User;

// Stable references for the parent-re-render guard. React.memo only bails when
// EVERY prop kept its identity, so these are module-level constants — a fresh
// inline value per render would itself defeat memo and mask whether prop
// stabilization is what protects the panel.
const EMPTY_MCP_IDS: string[] = [];
const CONNECTION_VALUE = {
  connected: true,
  connecting: false,
  outOfSync: false,
  capturedSha: null,
  currentSha: null,
};
const APP_ACTIONS = {};

function seedStore() {
  agorStore.setState({
    ...EMPTY_MAPS,
    userById: new Map([[USER_ID, user]]),
    sessionById: new Map([
      [SESSION_ID, sessionA],
      [OTHER_SESSION_ID, makeSession(OTHER_SESSION_ID, 'running')],
    ]),
  });
}

function renderPanel(ui: ReactNode) {
  return render(
    <AntdApp>
      <ConnectionProvider value={CONNECTION_VALUE}>
        <AppActionsProvider value={APP_ACTIONS}>{ui}</AppActionsProvider>
      </ConnectionProvider>
    </AntdApp>
  );
}

describe('SessionPanel store-selector re-render isolation', () => {
  beforeEach(() => {
    sessionPanelRenders = 0;
    agorStore.setState({ ...EMPTY_MAPS });
    seedStore();
  });

  it('a session:patched for an unrelated session does not re-render the panel', async () => {
    renderPanel(
      <SessionPanel
        client={null}
        session={sessionA}
        branch={branch}
        currentUserId={USER_ID}
        sessionMcpServerIds={EMPTY_MCP_IDS}
        open={true}
        onClose={() => {}}
      />
    );

    await waitFor(() => expect(sessionPanelRenders).toBeGreaterThanOrEqual(1));
    const baseline = sessionPanelRenders;

    // Patch a DIFFERENT session. SessionPanel doesn't subscribe to `sessionById`
    // at all (session arrives as a prop), so this store change leaves every
    // selected slice's reference untouched — the subscriptions stay quiet.
    act(() => {
      sessionPatched(makeSession(OTHER_SESSION_ID, 'completed'));
    });

    expect(sessionPanelRenders).toBe(baseline);
  });

  it('a patch to a slice SessionPanel DOES select (userById) re-renders it', async () => {
    renderPanel(
      <SessionPanel
        client={null}
        session={sessionA}
        branch={branch}
        currentUserId={USER_ID}
        sessionMcpServerIds={EMPTY_MCP_IDS}
        open={true}
        onClose={() => {}}
      />
    );

    await waitFor(() => expect(sessionPanelRenders).toBeGreaterThanOrEqual(1));
    const baseline = sessionPanelRenders;

    // Contrast case: SessionPanel subscribes to `userById`, so replacing that
    // map's reference must wake its selector subscription. This proves the
    // selector is genuinely wired (and that the isolation above is real, not a
    // dead subscription).
    act(() => {
      agorStore.setState({
        userById: new Map<string, User>([[USER_ID, { ...user, name: 'Renamed' } as User]]),
      });
    });

    await waitFor(() => expect(sessionPanelRenders).toBeGreaterThan(baseline));
  });

  it('a patch to an unrelated slice (mcpServerById churn aside) leaves the panel quiet', async () => {
    renderPanel(
      <SessionPanel
        client={null}
        session={sessionA}
        branch={branch}
        currentUserId={USER_ID}
        sessionMcpServerIds={EMPTY_MCP_IDS}
        open={true}
        onClose={() => {}}
      />
    );

    await waitFor(() => expect(sessionPanelRenders).toBeGreaterThanOrEqual(1));
    const baseline = sessionPanelRenders;

    // Patch a slice SessionPanel never selects (branchById). zustand notifies
    // every subscriber, but the panel's selector slices keep their references,
    // so it does not re-render.
    act(() => {
      agorStore.setState({
        branchById: new Map<string, Branch>([['A', { ...branch, name: 'A2' } as Branch]]),
      });
    });

    expect(sessionPanelRenders).toBe(baseline);
  });
});

// Mirror of AppContent's `useStableCallback`: freeze a handler's identity across
// renders while delegating to the latest impl via a ref. This is the exact
// mechanism AppContent uses to keep SessionPanel's `onClose` stable, so
// reproducing it here exercises the real prop-stabilization contract.
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

// Lets a test trigger a parent re-render without touching SessionPanel's props.
let triggerParentRerender: () => void = () => {};

// Parent harness that renders the REAL memo'd SessionPanel the way AppContent
// does: the close handler flows through `useStableCallback` so its identity is
// frozen. A `useState` bump (driven from the test) re-renders THIS parent; the
// `stabilize` flag toggles whether the handler is stabilized so the same harness
// proves both halves of the guard.
function ParentHarness({ stabilize }: { stabilize: boolean }) {
  const [, setTick] = useState(0);
  triggerParentRerender = () => setTick((tick) => tick + 1);

  // Fresh identity on every parent render (mirrors AppContent's plain-const
  // handlers). When `stabilize` is true we freeze it through useStableCallback;
  // when false we pass it straight through so memo sees a new prop each render.
  const closeImpl = () => {};
  const stableClose = useStableCallback(closeImpl);
  const onClose = stabilize ? stableClose! : closeImpl;

  return (
    <SessionPanel
      client={null}
      session={sessionA}
      branch={branch}
      currentUserId={USER_ID}
      sessionMcpServerIds={EMPTY_MCP_IDS}
      open={true}
      onClose={onClose}
    />
  );
}

describe('SessionPanel memo + handler-stabilization re-render bailout', () => {
  beforeEach(() => {
    sessionPanelRenders = 0;
    triggerParentRerender = () => {};
    agorStore.setState({ ...EMPTY_MAPS });
    seedStore();
  });

  it('a parent re-render does not re-render the memo’d SessionPanel when handlers are stabilized', async () => {
    renderPanel(<ParentHarness stabilize={true} />);

    await waitFor(() => expect(sessionPanelRenders).toBeGreaterThanOrEqual(1));
    const baseline = sessionPanelRenders;

    // Re-render the PARENT. Every SessionPanel prop kept its identity (session,
    // branch, the stabilized close handler, EMPTY_MCP_IDS), so React.memo bails
    // out and the panel stays put.
    act(() => {
      triggerParentRerender();
    });

    // Regression guard: FAILS if `React.memo(SessionPanel)` is removed (parent
    // re-render always re-renders the panel) OR if the close handler is
    // destabilized (a fresh prop identity defeats the shallow memo).
    expect(sessionPanelRenders).toBe(baseline);
  });

  it('a parent re-render DOES re-render the panel when a handler identity is not stabilized', async () => {
    // Contrast case proving the guard above is meaningful: the same parent,
    // passing a fresh-identity close handler each render, breaks the memo
    // shallow compare — so the bailout genuinely depends on stabilization.
    renderPanel(<ParentHarness stabilize={false} />);

    await waitFor(() => expect(sessionPanelRenders).toBeGreaterThanOrEqual(1));
    const baseline = sessionPanelRenders;

    act(() => {
      triggerParentRerender();
    });

    await waitFor(() => expect(sessionPanelRenders).toBeGreaterThan(baseline));
  });
});
