import type { AgorClient, Branch, Session, User } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppActionsProvider } from '../../contexts/AppActionsContext';
import { ConnectionProvider } from '../../contexts/ConnectionContext';
import { agorStore } from '../../store/agorStore';
import SessionPanel from './SessionPanel';

vi.mock('../AutocompleteTextarea', () => ({
  AutocompleteTextarea: () => <textarea aria-label="Prompt" />,
}));

vi.mock('../FileUpload', () => ({
  FileUpload: () => null,
  FileUploadButton: (props: { onClick?: () => void; disabled?: boolean }) => (
    <button type="button" disabled={props.disabled} onClick={props.onClick}>
      Upload Files
    </button>
  ),
}));

vi.mock('../ForkSpawnModal/ForkSpawnModal', () => ({
  ForkSpawnModal: () => null,
}));

vi.mock('../MCPServer', () => ({
  MCPServerPill: () => <span>MCP server</span>,
}));

vi.mock('../metadata', () => ({
  CreatedByTag: () => <span>Created by test user</span>,
}));

vi.mock('../Pill', () => ({
  ContextWindowPill: () => <span>Context window</span>,
  TimerPill: () => <span>Timer</span>,
  TokenCountPill: () => <span>Tokens</span>,
}));

vi.mock('../SessionIds', () => ({
  SessionIdsButton: () => <span>Session IDs</span>,
  SessionIdsList: () => <span>Session IDs List</span>,
}));

vi.mock('../ToolIcon', () => ({
  ToolIcon: () => <span>Tool icon</span>,
}));

vi.mock('./SessionAttachmentsDropdown', () => ({
  SessionAttachmentsDropdown: () => null,
}));

vi.mock('./SessionMcpFooterControl', () => ({
  SessionMcpFooterControl: () => null,
}));

vi.mock('./SessionPanelContent', () => ({
  SessionPanelContent: () => <div>Session content</div>,
}));

vi.mock('./SessionRunSettingsPopover', () => ({
  SessionRunSettingsPopover: () => null,
}));

vi.mock('../../hooks/useSharedReactiveSession', () => ({
  useSharedReactiveSession: () => ({ handle: null, state: { tasks: [] } }),
}));

const connected = {
  connected: true,
  connecting: false,
  outOfSync: false,
  capturedSha: null,
  currentSha: null,
};

const branch = {
  branch_id: 'branch-1',
  board_id: 'board-1',
  name: 'feature/onboarding',
  path: '/tmp/feature-onboarding',
  filesystem_status: 'ready',
  archived: false,
} as unknown as Branch;

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    session_id: 'session-1',
    branch_id: 'branch-1',
    title: 'Onboarding session',
    agentic_tool: 'claude-code-cli',
    status: 'idle',
    archived: false,
    created_by: 'user-1',
    created_at: '2026-06-24T00:00:00.000Z',
    last_updated: '2026-06-24T00:00:00.000Z',
    ...overrides,
  } as unknown as Session;
}

function makeClient(): {
  client: AgorClient;
  createMock: ReturnType<typeof vi.fn>;
  patchUserMock: ReturnType<typeof vi.fn>;
} {
  const createMock = vi.fn().mockResolvedValue({ queued: true, reason: 'manual' });
  const patchUserMock = vi.fn().mockResolvedValue({});
  const taskEvents = { on: vi.fn(), off: vi.fn() };
  const client = {
    service: vi.fn((name: string) => {
      if (name === 'tasks') return taskEvents;
      if (name === 'sessions/session-1/onboarding/trigger') {
        return { create: createMock };
      }
      if (name === 'users') {
        return { patch: patchUserMock };
      }
      return { create: createMock, find: vi.fn().mockResolvedValue({ data: [] }) };
    }),
  } as unknown as AgorClient;
  return { client, createMock, patchUserMock };
}

function makeUser(overrides: Partial<User> = {}): User {
  return {
    user_id: 'user-1',
    email: 'user-1@test.local',
    name: 'Test User',
    role: 'member',
    ...overrides,
  } as unknown as User;
}

function renderPanel({
  client,
  session = makeSession(),
  currentUserId,
}: {
  client: AgorClient | null;
  session?: Session;
  currentUserId?: string;
}) {
  return render(
    <ConnectionProvider value={connected}>
      <AppActionsProvider value={{}}>
        <AntApp>
          <SessionPanel
            client={client}
            session={session}
            branch={branch}
            currentUserId={currentUserId}
            open
            onClose={vi.fn()}
          />
        </AntApp>
      </AppActionsProvider>
    </ConnectionProvider>
  );
}

beforeEach(() => {
  agorStore.getState().reset();
});

describe('SessionPanel onboarding re-entry affordance', () => {
  it('shows the Setup guide button for the session owner', () => {
    const { client } = makeClient();
    renderPanel({ client, currentUserId: 'user-1' });

    expect(screen.getByRole('img', { name: 'compass' })).toBeInTheDocument();
  });

  it('hides the Setup guide button when viewing someone else session', () => {
    const { client } = makeClient();
    renderPanel({ client, currentUserId: 'user-2' });

    expect(screen.queryByRole('img', { name: 'compass' })).not.toBeInTheDocument();
  });

  it('hides the Setup guide button when there is no known current user', () => {
    const { client } = makeClient();
    renderPanel({ client });

    expect(screen.queryByRole('img', { name: 'compass' })).not.toBeInTheDocument();
  });

  it('triggers onboarding with reason manual when clicked', async () => {
    const { client, createMock } = makeClient();
    renderPanel({ client, currentUserId: 'user-1' });

    fireEvent.click(screen.getByRole('img', { name: 'compass' }).closest('button')!);

    await waitFor(() => {
      expect(createMock).toHaveBeenCalledWith({ reason: 'manual' });
    });
  });
});

const BANNER_TEXT = /New here\? Use the Setup guide/;

describe('SessionPanel discovery banner', () => {
  it('shows the banner when this is the only session the user has ever created', () => {
    const { client } = makeClient();
    agorStore
      .getState()
      .setMap('sessionById', new Map([[makeSession().session_id, makeSession()]]));
    agorStore.getState().setMap('userById', new Map([['user-1', makeUser()]]));
    renderPanel({ client, currentUserId: 'user-1' });

    expect(screen.getByText(BANNER_TEXT)).toBeInTheDocument();
  });

  it('hides the banner when the user already has other sessions', () => {
    const { client } = makeClient();
    const first = makeSession({ session_id: 'session-0' });
    const current = makeSession();
    agorStore.getState().setMap(
      'sessionById',
      new Map([
        [first.session_id, first],
        [current.session_id, current],
      ])
    );
    agorStore.getState().setMap('userById', new Map([['user-1', makeUser()]]));
    renderPanel({ client, currentUserId: 'user-1' });

    expect(screen.queryByText(BANNER_TEXT)).not.toBeInTheDocument();
  });

  it('hides the banner once already dismissed', () => {
    const { client } = makeClient();
    agorStore
      .getState()
      .setMap('sessionById', new Map([[makeSession().session_id, makeSession()]]));
    agorStore
      .getState()
      .setMap(
        'userById',
        new Map([['user-1', makeUser({ preferences: { setupGuideBannerDismissed: true } })]])
      );
    renderPanel({ client, currentUserId: 'user-1' });

    expect(screen.queryByText(BANNER_TEXT)).not.toBeInTheDocument();
  });

  it('hides the banner when there is no known current user', () => {
    const { client } = makeClient();
    agorStore
      .getState()
      .setMap('sessionById', new Map([[makeSession().session_id, makeSession()]]));
    renderPanel({ client });

    expect(screen.queryByText(BANNER_TEXT)).not.toBeInTheDocument();
  });

  it('persists dismissal to user preferences and hides immediately on close', async () => {
    const { client, patchUserMock } = makeClient();
    agorStore
      .getState()
      .setMap('sessionById', new Map([[makeSession().session_id, makeSession()]]));
    agorStore.getState().setMap('userById', new Map([['user-1', makeUser()]]));
    const { container } = renderPanel({ client, currentUserId: 'user-1' });

    expect(screen.getByText(BANNER_TEXT)).toBeInTheDocument();
    const closeIcon = container.querySelector('.ant-alert-close-icon');
    expect(closeIcon).toBeTruthy();
    fireEvent.click(closeIcon!);

    expect(screen.queryByText(BANNER_TEXT)).not.toBeInTheDocument();
    await waitFor(() => {
      expect(patchUserMock).toHaveBeenCalledWith('user-1', {
        preferences: { setupGuideBannerDismissed: true },
      });
    });
  });
});
