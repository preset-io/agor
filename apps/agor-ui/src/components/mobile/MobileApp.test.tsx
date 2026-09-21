import { DEFAULT_AGENTIC_TOOL_NAME } from '@agor-live/client';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '../../contexts/ThemeContext';
import { USER_DEFAULT_AGENTIC_CONFIGURATION } from '../AgenticToolConfigurationPicker/useAgenticConfigurationSources';
import { MobileApp } from './MobileApp';

vi.mock('./MobileBoardPage', () => ({
  MobileBoardPage: ({
    onOpenBranch,
  }: {
    onOpenBranch: (branchId: string, tab: string) => void;
  }) => (
    <button type="button" onClick={() => onOpenBranch('branch-1', 'schedule')}>
      Open schedule
    </button>
  ),
}));

// Capture the props the sheet is actually handed, so a control that renders
// enabled but is wired to nothing fails here rather than silently on a phone.
let branchModalProps: Record<string, unknown> = {};
vi.mock('../BranchModal', () => ({
  BranchModal: (props: { open: boolean; defaultTab?: string }) => {
    branchModalProps = props as Record<string, unknown>;
    return props.open ? <div data-testid="branch-sheet">{props.defaultTab}</div> : null;
  },
}));

vi.mock('./MobileNavTree', () => ({ MobileNavTree: () => null }));

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
  await waitFor(() => expect(onCreateSession).toHaveBeenCalledTimes(1));
  return { view, props, finish: () => act(async () => resolve({ sessionId: 'session-new' })) };
}

describe('MobileApp branch actions', () => {
  it('wires board branch actions to the requested bottom sheet tab', () => {
    renderMobileApp();

    fireEvent.click(screen.getByRole('button', { name: 'Open schedule' }));
    expect(screen.getByTestId('branch-sheet')).toHaveTextContent('schedule');
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

    // Sheet closes and the session opens on its own /m route, a full-screen sub-view with no tab bar.
    expect(screen.queryByTestId('branch-sheet')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Ask your primary assistant' })
    ).not.toBeInTheDocument();
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

  it('hides the tab bar on a full-screen session detail route', () => {
    renderMobileApp('/m/session/session-1');
    expect(
      screen.queryByRole('button', { name: 'Ask your primary assistant' })
    ).not.toBeInTheDocument();
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
    await waitFor(() => expect(onCreateSession).toHaveBeenCalledTimes(1));

    // Both Ask surfaces are refused while the first creation is pending (the Home one reads "loading Ask").
    fireEvent.click(screen.getByRole('button', { name: 'Ask your primary assistant' }));
    fireEvent.click(screen.getByRole('button', { name: /Ask$/ }));
    await act(async () => {});
    expect(onCreateSession).toHaveBeenCalledTimes(1);

    // A creation that yields no session (failure already surfaced) releases Ask again.
    await act(async () => resolve(null));
    fireEvent.click(screen.getByRole('button', { name: 'Ask your primary assistant' }));
    await waitFor(() => expect(onCreateSession).toHaveBeenCalledTimes(2));
  });

  it('accepts a new Ask tap after an identity change dropped the pending creation', async () => {
    const { view, props } = await askWithPendingCreation();
    view.rerender(mobileAppTree('/m', { ...props, authGeneration: 1 }));
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Ask your primary assistant' }));
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
    expect(onCreateSession).not.toHaveBeenCalled();

    await act(async () => resolveNext({ ...primaryBranch, branch_id: 'branch-q' }));
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

  it('starts Ask sessions with the caller saved agent defaults, like desktop quick compose', async () => {
    const onCreateSession = vi.fn(async () => null);
    const client = primaryClient;
    // No primary-tool preference, so the caller resolves to the default tool.
    const user = {
      user_id: 'user-1',
      default_mcp_server_ids: ['user-mcp'],
      default_agentic_config: {
        [DEFAULT_AGENTIC_TOOL_NAME]: {
          permissionMode: 'acceptEdits',
          modelConfig: { model: 'saved-model' },
        },
      },
    };
    renderMobileApp('/m', { client, user, onCreateSession });
    await act(async () => {});

    fireEvent.click(screen.getByRole('button', { name: 'Ask your primary assistant' }));

    await waitFor(() => expect(onCreateSession).toHaveBeenCalledTimes(1));
    expect(onCreateSession.mock.calls[0]).toEqual([
      expect.objectContaining({
        branch_id: 'branch-p',
        agent: DEFAULT_AGENTIC_TOOL_NAME,
        permissionMode: 'acceptEdits',
        modelConfig: { model: 'saved-model' },
        mcpServerIds: ['branch-mcp'],
        agenticToolPresetId: USER_DEFAULT_AGENTIC_CONFIGURATION,
      }),
      'board-1',
    ]);
  });
});
