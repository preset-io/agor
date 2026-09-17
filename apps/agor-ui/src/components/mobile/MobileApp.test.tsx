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
function renderMobileApp(
  initialPath = '/m/board/board-1',
  extraProps: Record<string, unknown> = {}
) {
  return render(
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

    // Sheet closes and the session opens on its own /m route.
    expect(screen.queryByTestId('branch-sheet')).not.toBeInTheDocument();
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

  it('starts Ask sessions with the caller saved agent defaults, like desktop quick compose', async () => {
    const onCreateSession = vi.fn(async () => null);
    const primary = { branch_id: 'branch-p', board_id: 'board-1', mcp_server_ids: ['branch-mcp'] };
    const client = { service: () => ({ getPrimaryTeammate: async () => primary }) };
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
