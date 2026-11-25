import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionProvider } from '../../contexts/ConnectionContext';
import { ThemeProvider } from '../../contexts/ThemeContext';
import { agorStore } from '../../store/agorStore';
import { setRealtimeAuthorityScope } from '../../store/realtimeBatch';
import { OPEN_CREATE_FLOW_EVENT, requestShellPicker } from '../../utils/shellEvents';
import { MobileApp } from './MobileApp';

let boardSettingsHydrated: boolean | undefined;
vi.mock('./MobileBoardPage', () => ({
  MobileBoardPage: ({
    onOpenBranch,
    onNewSession,
    settingsHydrated,
  }: {
    settingsHydrated: boolean;
    onOpenBranch: (branchId: string, tab: string) => void;
    onNewSession: (branchId: string) => void;
  }) => {
    boardSettingsHydrated = settingsHydrated;
    return (
      <>
        <button type="button" onClick={() => onOpenBranch('branch-1', 'schedule')}>
          Open schedule
        </button>
        <button type="button" onClick={() => onNewSession('branch-1')}>
          New session
        </button>
      </>
    );
  },
}));

// The desktop dialog has its own suites; this captures what mobile hands it and submits for the branch.
const newSessionModal = vi.hoisted(() => ({ props: {} as Record<string, unknown> }));
vi.mock('../NewSessionModal', () => ({
  NewSessionModal: (props: {
    branchId: string;
    onCreate: (config: { branch_id: string; agent: string }) => Promise<unknown>;
  }) => {
    newSessionModal.props = props;
    return (
      <div data-testid="new-session-modal">
        <button
          type="button"
          onClick={() => void props.onCreate({ branch_id: props.branchId, agent: 'codex' })}
        >
          Create Session
        </button>
      </div>
    );
  },
}));

/** Submits the open new-session dialog. */
async function submitNewSession() {
  fireEvent.click(await screen.findByRole('button', { name: 'Create Session' }));
}

// Capture the props the sheet is actually handed, so a control that renders
// enabled but is wired to nothing fails here rather than silently on a phone.
let branchModalProps: Record<string, unknown> = {};
vi.mock('../BranchModal', () => ({
  BranchModal: (props: { open: boolean; defaultTab?: string }) => {
    branchModalProps = props as Record<string, unknown>;
    return props.open ? <div data-testid="branch-sheet">{props.defaultTab}</div> : null;
  },
}));

// Home is the shared HomePage (covered by its own suites); these cases drive the tab-bar Ask.
vi.mock('../HomePage', () => ({ HomePage: () => null }));

// Counts mounts so a test can prove the picker is re-created (keyed) per signed-in identity.
const teammatePicker = vi.hoisted(() => ({ mounts: 0, props: {} as Record<string, unknown> }));
vi.mock('../SettingsModal/PrimaryTeammatePicker', async () => {
  const { useEffect } = await import('react');
  return {
    PrimaryTeammatePicker: (props: Record<string, unknown>) => {
      teammatePicker.props = props;
      useEffect(() => {
        teammatePicker.mounts += 1;
      }, []);
      return <div data-testid="teammate-picker" />;
    },
  };
});

let sessionPageProps: Record<string, unknown> = {};
vi.mock('./SessionPage', () => ({
  SessionPage: (props: Record<string, unknown>) => {
    sessionPageProps = props;
    return <div data-testid="session-page" />;
  },
}));

// Required session handlers for the reused SessionPanel composer.
const sessionHandlers = {
  onCreateSession: vi.fn(async () => null),
  onForkSession: vi.fn(async () => {}),
  onBtwForkSession: vi.fn(async () => {}),
  onSpawnSession: vi.fn(async () => {}),
  onUpdateSession: vi.fn(),
  onDeleteSession: vi.fn(),
};

// Mount exactly as production does: MobileApp lives under a `/m/*` parent route,
// so its inner routes are descendant (relative) routes. Rendering at the root
// would hide the /m nesting bugs.
function mobileAppTree(initialPath: string, extraProps: Record<string, unknown>) {
  return (
    <ThemeProvider>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route
            path="/m/*"
            element={
              <MobileApp
                client={null}
                authGeneration={0}
                onSendComment={vi.fn()}
                onOpenWorkspaceSettings={vi.fn()}
                onOpenUserSettings={vi.fn()}
                {...sessionHandlers}
                {...extraProps}
              />
            }
          />
        </Routes>
      </MemoryRouter>
    </ThemeProvider>
  );
}

function renderMobileApp(
  initialPath = '/m/board/board-1',
  extraProps: Record<string, unknown> = {}
) {
  return render(mobileAppTree(initialPath, extraProps));
}

const primaryBranch = {
  branch_id: 'branch-p',
  board_id: 'board-1',
  mcp_server_ids: ['branch-mcp'],
};
const primaryClient = { service: () => ({ getPrimaryTeammate: async () => primaryBranch }) };

/** Taps Ask with a session creation that stays in flight until `resolve` is called. */
async function askWithPendingCreation(extraProps: Record<string, unknown> = {}) {
  let resolve!: (result: { sessionId: string }) => void;
  const onCreateSession = vi.fn(
    () => new Promise<{ sessionId: string }>((done) => (resolve = done))
  );
  const props = {
    client: primaryClient,
    user: { user_id: 'user-1' },
    onCreateSession,
    ...extraProps,
  };
  const view = render(mobileAppTree('/m', props));
  await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: 'Ask your primary assistant' }));
  await submitNewSession();
  await waitFor(() => expect(onCreateSession).toHaveBeenCalledTimes(1));
  return { view, props, finish: () => act(async () => resolve({ sessionId: 'session-new' })) };
}

describe('MobileApp branch actions', () => {
  beforeEach(() => {
    agorStore.getState().reset();
    agorStore.getState().setAgenticToolSettings([]);
  });

  it.each(['Ask your primary assistant'])(
    'holds %s until current workspace tool settings hydrate',
    async (action) => {
      agorStore.getState().resetMaps();
      const onCreateSession = vi.fn(async () => null);
      renderMobileApp('/m/board/board-1', {
        client: primaryClient,
        user: { user_id: 'user-1', primary_agentic_tool: 'claude-code' },
        onCreateSession,
      });
      await act(async () => {});
      expect(boardSettingsHydrated).toBe(false);
      const button = screen.getByRole('button', { name: action });
      expect(button).toHaveClass('ant-btn-loading');
      fireEvent.click(button);
      await act(async () => {});
      expect(screen.queryByTestId('new-session-modal')).not.toBeInTheDocument();
      act(() =>
        agorStore.getState().setAgenticToolSettings([
          {
            tool: 'claude-code',
            enabled: false,
            deployment_available: true,
            resolution_policy: 'user_preferred',
            inline_configuration_allowed: true,
            connection: {},
          },
        ])
      );
      expect(boardSettingsHydrated).toBe(true);
      expect(button).not.toHaveClass('ant-btn-loading');
      fireEvent.click(button);
      await submitNewSession();
      await waitFor(() => expect(onCreateSession).toHaveBeenCalledTimes(1));
      expect(onCreateSession).toHaveBeenCalledWith(
        expect.objectContaining({ branch_id: 'branch-p' }),
        'board-1'
      );
      act(() => agorStore.getState().resetMaps());
      expect(boardSettingsHydrated).toBe(false);
      expect(button).toHaveClass('ant-btn-loading');
      fireEvent.click(button);
      await act(async () => {});
      expect(screen.queryByTestId('new-session-modal')).not.toBeInTheDocument();
    }
  );

  it('rechecks hydration when a mobile primary pick resumes Ask', async () => {
    const onCreateSession = vi.fn(async () => null);
    const client = { service: () => ({ getPrimaryTeammate: async () => null }) };
    renderMobileApp('/m', { client, user: { user_id: 'user-1' }, onCreateSession });
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Ask your primary assistant' }));
    await screen.findByTestId('teammate-picker');
    act(() => agorStore.getState().resetMaps());
    const pick = teammatePicker.props.onPicked as (branch: typeof primaryBranch) => void;
    act(() => pick(primaryBranch));
    await act(async () => {});
    expect(screen.queryByTestId('new-session-modal')).not.toBeInTheDocument();
    expect(onCreateSession).not.toHaveBeenCalled();
  });

  it('wires board branch actions to the requested bottom sheet tab', () => {
    renderMobileApp();

    fireEvent.click(screen.getByRole('button', { name: 'Open schedule' }));
    expect(screen.getByTestId('branch-sheet')).toHaveTextContent('schedule');
  });

  it('opens the desktop new-session dialog for a board branch, so the provider and model can be chosen', async () => {
    const branch = { branch_id: 'branch-1', board_id: 'board-2', name: 'Fix it' };
    agorStore.setState({ branchById: new Map([['branch-1', branch as never]]) });
    const onCreateSession = vi.fn(async () => ({ sessionId: 'session-new' }));
    const user = { user_id: 'user-1' };
    renderMobileApp('/m/board/board-1', { user, onCreateSession });

    fireEvent.click(screen.getByRole('button', { name: 'New session' }));
    expect(screen.getByTestId('new-session-modal')).toBeInTheDocument();
    expect(newSessionModal.props).toMatchObject({
      fullScreen: true,
      branchId: 'branch-1',
      branch,
      currentUser: user,
    });
    // Nothing is created until the dialog submits its chosen configuration.
    expect(onCreateSession).not.toHaveBeenCalled();

    const config = { branch_id: 'branch-1', agent: 'codex', agenticToolPresetId: 'preset-1' };
    const onCreate = newSessionModal.props.onCreate as (c: typeof config) => Promise<unknown>;
    await act(async () => {
      await expect(onCreate(config)).resolves.toEqual({ sessionId: 'session-new' });
    });
    expect(onCreateSession).toHaveBeenCalledWith(config, 'board-2');
    expect(screen.queryByTestId('new-session-modal')).not.toBeInTheDocument();
    expect(screen.getByTestId('session-page')).toBeInTheDocument();
  });

  it("reads the opened branch's active sessions for the sheet, as desktop does", async () => {
    setRealtimeAuthorityScope('user-1:member:1');
    agorStore.setState({
      branchById: new Map([['branch-1', { branch_id: 'branch-1', repo_id: 'repo-1' } as never]]),
    });
    const session = { session_id: 's1', branch_id: 'branch-1', title: 'Fix it' };
    const findAll = vi.fn(async () => [session]);
    const client = {
      service: () => ({ getPrimaryTeammate: async () => null, findAll, on() {}, off() {} }),
    };
    try {
      renderMobileApp('/m/board/board-1', { client, user: { user_id: 'user-1' } });
      fireEvent.click(screen.getByRole('button', { name: 'Open schedule' }));
      await waitFor(() => expect(branchModalProps.sessions).toEqual([session]));
      expect(findAll).toHaveBeenCalledWith({
        query: { branch_id: 'branch-1', archived: false, $sort: { created_at: -1 } },
      });
    } finally {
      setRealtimeAuthorityScope(null);
      agorStore.getState().reset();
    }
  });

  it('hands the bottom sheet the same edit handlers as the desktop modal', () => {
    const handlers = {
      onUpdateBranch: vi.fn(),
      onUpdateRepo: vi.fn(),
      onArchiveOrDeleteBranch: vi.fn(),
      onExecuteScheduleNow: vi.fn(),
    };

    renderMobileApp('/m/board/board-1', handlers);

    fireEvent.click(screen.getByRole('button', { name: 'Open schedule' }));

    expect(branchModalProps.onUpdateBranch).toBe(handlers.onUpdateBranch);
    expect(branchModalProps.onUpdateRepo).toBe(handlers.onUpdateRepo);
    expect(branchModalProps.onArchiveOrDelete).toBe(handlers.onArchiveOrDeleteBranch);
    expect(branchModalProps.onExecuteScheduleNow).toBe(handlers.onExecuteScheduleNow);
    expect(typeof branchModalProps.onSessionClick).toBe('function');
  });

  it('navigates session links to the mobile session route', () => {
    renderMobileApp();

    fireEvent.click(screen.getByRole('button', { name: 'Open schedule' }));
    const onSessionClick = branchModalProps.onSessionClick as (id: string) => void;
    act(() => onSessionClick('session-9'));

    // Sheet closes and the session opens on its own full-screen /m route. The
    // docked tab bar stays visible on the sub-view (Ask remains reachable).
    expect(screen.queryByTestId('branch-sheet')).not.toBeInTheDocument();
    expect(screen.getByTestId('session-page')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ask your primary assistant' })).toBeInTheDocument();
  });

  it('renders board content under the /m/* descendant route', () => {
    renderMobileApp('/m/board/board-1');
    // Regression: relative descendant routes must match, not blank out.
    expect(screen.getByRole('button', { name: 'Open schedule' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ask your primary assistant' })).toBeInTheDocument();
  });

  it('keeps the tab bar on /m/sessions (not treated as session detail)', () => {
    renderMobileApp('/m/sessions');
    // Regression: `/m/sessions` must not be classified as `/m/session/` detail,
    // which would hide the whole nav shell.
    expect(screen.getByRole('button', { name: 'Ask your primary assistant' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Home' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Board' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'More' })).toBeInTheDocument();
  });

  it('lands on Home with the tab bar at /m', () => {
    renderMobileApp('/m');
    expect(screen.getByRole('button', { name: 'Ask your primary assistant' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Home' })).toHaveAttribute('aria-current', 'page');
  });

  it('keeps the docked tab bar on a full-screen session detail route', () => {
    renderMobileApp('/m/session/session-1');
    // The bar is visible on every /m screen; on a sub-view no tab is force-active.
    expect(screen.getByRole('button', { name: 'Ask your primary assistant' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Home' })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('button', { name: 'Board' })).not.toHaveAttribute('aria-current');
  });

  it('surfaces the shared connect-AI banner on Home', () => {
    renderMobileApp('/m', { topBanner: <div>AI not connected</div> });
    expect(screen.getByText('AI not connected')).toBeInTheDocument();
  });

  it('hides the banner on the full-screen session view (its composer owns credentials)', () => {
    renderMobileApp('/m/session/session-1', { topBanner: <div>AI not connected</div> });
    expect(screen.queryByText('AI not connected')).not.toBeInTheDocument();
  });

  it('hands the session page the same settings handlers as the desktop modal', () => {
    const handlers = { onUpdateSessionMcpServers: vi.fn(), onUpdateSessionEnvSelections: vi.fn() };
    renderMobileApp('/m/session/session-1', handlers);
    expect(sessionPageProps.onUpdateSessionMcpServers).toBe(handlers.onUpdateSessionMcpServers);
    expect(sessionPageProps.onUpdateSessionEnvSelections).toBe(
      handlers.onUpdateSessionEnvSelections
    );
  });

  it('opens the new session once Ask creation settles', async () => {
    const { finish } = await askWithPendingCreation();
    await finish();
    expect(screen.getByTestId('session-page')).toBeInTheDocument();
  });

  it('refuses a repeated Ask tap while a creation is pending, then accepts one after it settles', async () => {
    let resolve!: (result: null) => void;
    const onCreateSession = vi.fn(() => new Promise<null>((done) => (resolve = done)));
    render(
      mobileAppTree('/m', { client: primaryClient, user: { user_id: 'user-1' }, onCreateSession })
    );
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Ask your primary assistant' }));
    await submitNewSession();
    await waitFor(() => expect(onCreateSession).toHaveBeenCalledTimes(1));

    // A repeated tap is refused while the first creation is pending.
    fireEvent.click(screen.getByRole('button', { name: 'Ask your primary assistant' }));
    await act(async () => {});
    expect(onCreateSession).toHaveBeenCalledTimes(1);

    // A creation that yields no session (failure already surfaced) releases Ask again.
    await act(async () => resolve(null));
    fireEvent.click(screen.getByRole('button', { name: 'Ask your primary assistant' }));
    await submitNewSession();
    await waitFor(() => expect(onCreateSession).toHaveBeenCalledTimes(2));
  });

  it('accepts a new Ask tap after an identity change dropped the pending creation', async () => {
    const { view, props } = await askWithPendingCreation();
    view.rerender(mobileAppTree('/m', { ...props, authGeneration: 1 }));
    await act(async () => {});
    // The dialog opened for the previous identity is gone.
    expect(screen.queryByTestId('new-session-modal')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Ask your primary assistant' }));
    await submitNewSession();
    await waitFor(() => expect(props.onCreateSession).toHaveBeenCalledTimes(2));
  });

  it('drops an Ask creation that settles after the signed-in identity changed', async () => {
    const { view, props, finish } = await askWithPendingCreation();
    view.rerender(mobileAppTree('/m', { ...props, authGeneration: 1 }));
    await finish();
    expect(screen.queryByTestId('session-page')).not.toBeInTheDocument();
  });

  it('drops an Ask creation when the authentication generation is no longer current', async () => {
    const { finish } = await askWithPendingCreation({
      isAuthenticationGenerationCurrent: () => false,
    });
    await finish();
    expect(screen.queryByTestId('session-page')).not.toBeInTheDocument();
  });

  it('never targets a previous caller primary branch while the new caller resolve is in flight', async () => {
    let resolveNext!: (branch: typeof primaryBranch) => void;
    const getPrimaryTeammate = vi
      .fn()
      .mockResolvedValueOnce(primaryBranch)
      .mockReturnValue(new Promise((done) => (resolveNext = done)));
    const onCreateSession = vi.fn(async () => null);
    const props = {
      client: { service: () => ({ getPrimaryTeammate }) },
      user: { user_id: 'user-1' },
      onCreateSession,
    };
    const view = render(mobileAppTree('/m', props));
    await act(async () => {});
    // Precondition: the first caller's branch really is held, so the assertions below cannot pass vacuously.
    fireEvent.click(screen.getByRole('button', { name: 'Ask your primary assistant' }));
    await submitNewSession();
    await waitFor(() => expect(onCreateSession).toHaveBeenCalledTimes(1));
    expect(onCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ branch_id: 'branch-p' }),
      'board-1'
    );
    onCreateSession.mockClear();

    view.rerender(
      mobileAppTree('/m', { ...props, user: { user_id: 'user-2' }, authGeneration: 1 })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Ask your primary assistant' }));
    await act(async () => {});
    expect(screen.queryByTestId('new-session-modal')).not.toBeInTheDocument();

    await act(async () => resolveNext({ ...primaryBranch, branch_id: 'branch-q' }));
    await submitNewSession();
    await waitFor(() => expect(onCreateSession).toHaveBeenCalledTimes(1));
    expect(onCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ branch_id: 'branch-q' }),
      'board-1'
    );
  });

  it('scopes the primary-teammate picker to the signed-in identity', async () => {
    const client = { service: () => ({ getPrimaryTeammate: async () => null }) };
    const props = { client, user: { user_id: 'user-1' }, authGeneration: 3 };
    const view = render(mobileAppTree('/m', props));
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Ask your primary assistant' }));
    await screen.findByTestId('teammate-picker');
    expect(teammatePicker.props).toMatchObject({
      currentUserId: 'user-1',
      authenticationGeneration: 3,
    });

    const mountsBefore = teammatePicker.mounts;
    view.rerender(mobileAppTree('/m', { ...props, authGeneration: 4 }));
    await waitFor(() => expect(teammatePicker.mounts).toBe(mountsBefore + 1));
    expect(teammatePicker.props).toMatchObject({ authenticationGeneration: 4 });
  });

  it('opens the shared create-teammate flow from the Ask sheet, as desktop does', async () => {
    const onOpenWorkspaceSettings = vi.fn();
    const client = { service: () => ({ getPrimaryTeammate: async () => null }) };
    render(
      mobileAppTree('/m', {
        client,
        user: { user_id: 'user-1', role: 'member' },
        onOpenWorkspaceSettings,
      })
    );
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Ask your primary assistant' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Create a new teammate' }));
    expect(await screen.findByText('New AI teammate')).toBeInTheDocument();
    // Not the Settings teammates tab, whose create button the phone shell had left unwired.
    expect(onOpenWorkspaceSettings).not.toHaveBeenCalled();
  });

  it('offers no create link to viewers, who cannot create teammates', async () => {
    const client = { service: () => ({ getPrimaryTeammate: async () => null }) };
    render(mobileAppTree('/m', { client, user: { user_id: 'user-1', role: 'viewer' } }));
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Ask your primary assistant' }));
    await screen.findByTestId('teammate-picker');
    expect(screen.queryByRole('button', { name: 'Create a new teammate' })).not.toBeInTheDocument();
  });

  it("opens the shared create-teammate flow for Settings' Create AI teammate", async () => {
    render(mobileAppTree('/m', { user: { user_id: 'user-1', role: 'member' } }));
    act(() => requestShellPicker(OPEN_CREATE_FLOW_EVENT, 'teammate'));
    expect(await screen.findByText('New AI teammate')).toBeInTheDocument();
  });

  it('opens the new-session dialog on the primary branch from Ask, so the provider and model can be chosen', async () => {
    const onCreateSession = vi.fn(async () => null);
    const user = { user_id: 'user-1' };
    renderMobileApp('/m', { client: primaryClient, user, onCreateSession });
    await act(async () => {});

    fireEvent.click(screen.getByRole('button', { name: 'Ask your primary assistant' }));

    expect(await screen.findByTestId('new-session-modal')).toBeInTheDocument();
    expect(newSessionModal.props).toMatchObject({
      fullScreen: true,
      branchId: 'branch-p',
      branch: primaryBranch,
      currentUser: user,
    });
    expect(onCreateSession).not.toHaveBeenCalled();
  });
});

const ONLINE = {
  connected: true,
  connecting: false,
  authGeneration: 1,
  outOfSync: false,
  capturedSha: null as string | null,
  currentSha: null as string | null,
};

describe('MobileApp connection banner', () => {
  it.each([
    {
      state: { connected: false, connecting: true },
      text: 'Reconnecting to Agor…',
      action: 'Reconnect',
    },
    {
      state: { connected: false },
      text: "Lost connection to Agor. You can't make changes until it's back.",
      action: 'Reconnect',
    },
    {
      state: { outOfSync: true, capturedSha: 'abc123', currentSha: 'def456' },
      text: "Agor was updated since this tab opened. Reload to get the latest version, but anything you haven't saved will be lost. (abc123 → def456)",
      action: 'Reload page',
    },
  ])('shows "$text"', ({ state, text, action }) => {
    const onRetryConnection = vi.fn();
    render(
      <ConnectionProvider value={{ ...ONLINE, ...state }}>
        {mobileAppTree('/m', { onRetryConnection })}
      </ConnectionProvider>
    );
    expect(screen.getByText(text)).toBeInTheDocument();
    if (action) expect(screen.getByRole('button', { name: action })).toBeInTheDocument();
    if (action === 'Reconnect') {
      fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
      expect(onRetryConnection).toHaveBeenCalledTimes(1);
    }
  });

  it('shows nothing while connected', () => {
    render(<ConnectionProvider value={ONLINE}>{mobileAppTree('/m', {})}</ConnectionProvider>);
    expect(screen.queryByText(/Agor/)).not.toBeInTheDocument();
  });
});

describe('MobileApp Ask with a failed primary lookup', () => {
  it('reports the failure instead of offering the picker, and Try again starts the session', async () => {
    const getPrimaryTeammate = vi.fn().mockRejectedValue(new Error('Request timed out'));
    const onCreateSession = vi.fn(async () => ({ sessionId: 'session-new' }));
    const client = { service: () => ({ getPrimaryTeammate }) };
    render(
      <ConnectionProvider value={ONLINE}>
        {mobileAppTree('/m', { client, user: { user_id: 'user-1' }, onCreateSession })}
      </ConnectionProvider>
    );
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Ask your primary assistant' }));

    expect(await screen.findByText("Couldn't load your primary assistant.")).toBeInTheDocument();
    expect(screen.queryByTestId('teammate-picker')).not.toBeInTheDocument();

    getPrimaryTeammate.mockResolvedValue(primaryBranch);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await submitNewSession();
    await waitFor(() => expect(onCreateSession).toHaveBeenCalledTimes(1));
  });
});
