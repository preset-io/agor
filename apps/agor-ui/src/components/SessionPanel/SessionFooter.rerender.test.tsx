import type { Branch, Session, Task, User } from '@agor-live/client';
import { act, render, waitFor } from '@testing-library/react';
import { App as AntdApp } from 'antd';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppActionsProvider } from '../../contexts/AppActionsContext';
import { ConnectionProvider } from '../../contexts/ConnectionContext';
import { EMPTY_MAPS } from '../../store/agorMaps';
import { agorStore } from '../../store/agorStore';

// ── Render counters ──────────────────────────────────────────────────────────
// ToolIcon renders inline in SessionPanel's header on every panel render;
// SessionFooter is replaced by a memoized counting stub that sees the EXACT
// props SessionPanel passes. Together they pin the contract: reactive-session
// notifies that don't change footer-relevant data re-render the panel but must
// leave every footer prop identity-stable, so the memo boundary holds.
let sessionPanelRenders = 0;
let sessionFooterRenders = 0;

vi.mock('../ToolIcon', () => ({
  __esModule: true,
  ToolIcon: () => {
    sessionPanelRenders += 1;
    return <div data-testid="tool-icon" />;
  },
}));

vi.mock('./SessionFooter', async () => {
  const React = await import('react');
  return {
    __esModule: true,
    SessionFooter: React.memo(() => {
      sessionFooterRenders += 1;
      return <div data-testid="session-footer" />;
    }),
  };
});

// Controlled reactive-session feed (SessionPanel subscribes for `tasks`).
// Emitting a fresh state object mirrors what every streaming chunk notify
// does to the panel.
let emitReactiveState: (state: unknown) => void = () => {};
let initialReactiveState: unknown = null;

vi.mock('../../hooks/useSharedReactiveSession', async () => {
  const React = await import('react');
  return {
    useSharedReactiveSession: () => {
      const [state, setState] = React.useState(initialReactiveState);
      emitReactiveState = setState;
      return { handle: null, state };
    },
  };
});

// Heavy children not under test — same stubs as SessionPanel.rerender.test.tsx.
vi.mock('./SessionPanelContent', () => ({
  __esModule: true,
  SessionPanelContent: () => <div data-testid="session-panel-content" />,
}));
vi.mock('./SessionAttachmentsDropdown', () => ({
  __esModule: true,
  SessionAttachmentsDropdown: () => null,
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

import { SessionPanel } from './index';

const SESSION_ID = 'sA';
const USER_ID = 'user-1';

const session = {
  session_id: SESSION_ID,
  branch_id: 'A',
  status: 'running',
  agentic_tool: 'claude-code',
  archived: false,
  created_at: '2026-07-01T00:00:00.000Z',
  last_updated: '2026-07-01T00:00:00.000Z',
} as unknown as Session;

const branch = { branch_id: 'A', repo_id: 'repo-1', name: 'A' } as unknown as Branch;
const user = { user_id: USER_ID, name: 'User' } as unknown as User;

const EMPTY_MCP_IDS: string[] = [];
const CONNECTION_VALUE = {
  connected: true,
  connecting: false,
  outOfSync: false,
  capturedSha: null,
  currentSha: null,
};
const APP_ACTIONS = {};

function makeTask(id: string, overrides: Record<string, unknown> = {}): Task {
  return {
    task_id: id,
    session_id: SESSION_ID,
    status: 'running',
    full_prompt: 'prompt',
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    git_state: {},
    ...overrides,
  } as unknown as Task;
}

function makeReactiveState(tasks: Task[]): unknown {
  return {
    sessionId: SESSION_ID,
    tasks,
    messagesByTask: new Map(),
    streamingMessages: new Map(),
    loadedTaskIds: new Set(),
    loading: false,
    error: null,
    terminal: false,
    lastSyncedAt: null,
  };
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

describe('SessionFooter re-render isolation from streaming notifies', () => {
  beforeEach(() => {
    sessionPanelRenders = 0;
    sessionFooterRenders = 0;
    agorStore.setState({ ...EMPTY_MAPS, userById: new Map([[USER_ID, user]]) });
  });

  it('a reactive notify that keeps `tasks` identity re-renders the panel but not the footer', async () => {
    const tasks = [makeTask('task-1')];
    initialReactiveState = makeReactiveState(tasks);

    renderPanel(
      <SessionPanel
        client={null}
        session={session}
        branch={branch}
        currentUserId={USER_ID}
        sessionMcpServerIds={EMPTY_MCP_IDS}
        open={true}
        onClose={() => {}}
      />
    );

    await waitFor(() => expect(sessionFooterRenders).toBeGreaterThanOrEqual(1));
    const panelBaseline = sessionPanelRenders;
    const footerBaseline = sessionFooterRenders;

    // Streaming chunk: fresh state object, same tasks array — the only slice
    // of reactive state the panel derives footer props from.
    act(() => {
      emitReactiveState(makeReactiveState(tasks));
    });

    expect(sessionPanelRenders).toBeGreaterThan(panelBaseline);
    expect(sessionFooterRenders).toBe(footerBaseline);
  });

  it('a notify that changes task token usage DOES re-render the footer', async () => {
    initialReactiveState = makeReactiveState([makeTask('task-1')]);

    renderPanel(
      <SessionPanel
        client={null}
        session={session}
        branch={branch}
        currentUserId={USER_ID}
        sessionMcpServerIds={EMPTY_MCP_IDS}
        open={true}
        onClose={() => {}}
      />
    );

    await waitFor(() => expect(sessionFooterRenders).toBeGreaterThanOrEqual(1));
    const footerBaseline = sessionFooterRenders;

    // Contrast case proving the counter is wired: a task patch that lands new
    // token usage replaces the tasks array → tokenBreakdown changes → the
    // footer legitimately re-renders.
    act(() => {
      emitReactiveState(
        makeReactiveState([
          makeTask('task-1', {
            normalized_sdk_response: {
              tokenUsage: {
                totalTokens: 100,
                inputTokens: 60,
                outputTokens: 40,
                cacheReadTokens: 0,
                cacheCreationTokens: 0,
              },
              costUsd: 0.01,
            },
          }),
        ])
      );
    });

    await waitFor(() => expect(sessionFooterRenders).toBeGreaterThan(footerBaseline));
  });
});
